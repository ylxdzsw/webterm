'use strict';

const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { frame } = require('./protocol');

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const SCROLLBACK = 5000;
const MAX_READ_ROWS = 1000;

// The single persistent terminal session owned by this server process.
//
// The session owns a PTY (running the server-configured program, default
// "$SHELL -l") and a *headless* xterm.js instance that continuously consumes
// the PTY output. The headless terminal is what makes browser reconnects
// clean: at any moment we can ask the SerializeAddon for a string of escape
// sequences that recreates the current screen (colors, cursor, modes,
// scrollback). So every browser connection is a disposable view: on connect we
// replay the serialized snapshot, then stream live output. There is exactly one
// resume path, and it never desyncs terminal modes the way replaying from an
// arbitrary byte offset would.
//
// Lifecycle is bound to the program: when the program exits the session ends,
// and the server process exits with it (see `onExit`). Persistence across
// browser disconnects still holds — browsers come and go while the PTY (and
// thus this process) keeps running; only the program exiting ends it. Under
// systemd this lets the unit's cgroup reap every descendant on exit; under
// socket activation the next request spawns a fresh process with a fresh shell.
class Session {
  constructor(opts = {}) {
    this.cols = opts.cols || DEFAULT_COLS;
    this.rows = opts.rows || DEFAULT_ROWS;
    this.bytes = 0; // total output bytes produced (informational seq for clients)
    this._pendingHeadlessWrites = 0; // in-flight headless.write callbacks
    this.subscribers = new Set();
    this.ended = false;
    this.exitCode = null;
    this.title = ''; // last OSC 0/2 title the program set, if any
    this.onExit = null; // server-supplied hook fired once the program exits

    this.headless = new Terminal({
      cols: this.cols,
      rows: this.rows,
      allowProposedApi: true,
      scrollback: SCROLLBACK,
    });
    this.serializer = new SerializeAddon();
    this.headless.loadAddon(this.serializer);
    // Programs advertise a title via OSC 0/1/2; xterm parses it for us. We use
    // it to set the browser tab title of the attached view.
    this.headless.onTitleChange((t) => {
      this.title = typeof t === 'string' ? t.slice(0, 256) : '';
      const line = frame({ t: 'title', title: this.title });
      for (const sub of this.subscribers) sub.send(line);
    });

    const resolved = resolveShell();
    this.command = resolved.command;

    const env = {
      ...process.env,
      // Make full-screen TUIs (opencode, claude code, vim, htop, ...) behave:
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'C.UTF-8',
      SHELL: resolved.file,
    };

    try {
      this.pty = pty.spawn(resolved.file, resolved.args, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: os.homedir(),
        env,
      });
    } catch (e) {
      const detail = e && e.message ? `: ${e.message}` : '';
      throw new Error(`Failed to start login shell ${JSON.stringify(resolved.file)}${detail}`);
    }

    this.pty.onData((data) => this._onData(data));
    this.pty.onExit((e) => this._onExit(e && e.exitCode != null ? e.exitCode : 0));
  }

  _onData(data) {
    if (!data) return;
    this.bytes += Buffer.byteLength(data, 'utf8');
    this._pendingHeadlessWrites++;
    this.headless.write(data, () => {
      this._pendingHeadlessWrites--;
      const line = frame({
        t: 'o',
        seq: this.bytes,
        d: Buffer.from(data, 'utf8').toString('base64'),
      });
      for (const sub of this.subscribers) sub.send(line);
    });
  }

  _onExit(code) {
    if (this.ended) return;
    this.ended = true;
    this.exitCode = code;
    // Notify attached viewers (they show a Reload prompt), then let the server
    // tear the whole process down.
    const line = frame({ t: 'exit', code });
    for (const sub of this.subscribers) {
      sub.send(line);
      sub.end();
    }
    this.subscribers.clear();
    if (this.onExit) {
      try {
        this.onExit(code);
      } catch (e) {
        /* ignore */
      }
    }
  }

  // Attach a disposable browser stream view. Live output is buffered until the
  // caller sends the initial hello/snapshot frames, so reconnects cannot miss
  // bytes while xterm's parser catches up.
  attachSubscriber(sub, onReady) {
    const attached = {
      buffering: true,
      snapshotSent: false,
      buffer: [],
      send(line) {
        if (!this.buffering) {
          sub.send(line);
          return;
        }
        // Output parsed before the snapshot frame is replayed on the client.
        if (this.snapshotSent) {
          this.buffer.push(line);
        }
      },
      end() {
        sub.end();
      },
      markSnapshotSent() {
        this.snapshotSent = true;
      },
      release() {
        this.buffering = false;
        for (const line of this.buffer) sub.send(line);
        this.buffer = [];
      },
    };

    this.subscribers.add(attached);
    this._whenHeadlessDrained(() => {
      if (!this.subscribers.has(attached)) return;
      onReady({
        snapshot: this.snapshot(),
        markSnapshotSent: () => attached.markSnapshotSent(),
        release: () => attached.release(),
      });
    });
    return attached;
  }

  // Wait until every queued headless write has been parsed so snapshots and
  // live frames cannot diverge (which would drop lines on reconnect).
  _whenHeadlessDrained(cb) {
    const tick = () => {
      if (this._pendingHeadlessWrites > 0) {
        this.headless.write('', tick);
        return;
      }
      this.headless.write('', cb);
    };
    // Defer one tick so output that lands during attach setup is counted.
    process.nextTick(tick);
  }

  // String of escape sequences that recreates the current screen.
  snapshot() {
    try {
      return this.serializer.serialize();
    } catch (e) {
      return '';
    }
  }

  visibleText() {
    return this.getViewportRows(this.headless.buffer.active)
      .map((row) => row.text)
      .join('\n');
  }

  describeState(normalTailRows) {
    const active = this.headless.buffer.active;
    const normal = this.headless.buffer.normal;
    const tailCount = clampRowCount(normalTailRows);

    return {
      title: this.title,
      command: this.command,
      ended: this.ended,
      exitCode: this.exitCode,
      cols: this.cols,
      rows: this.rows,
      activeBuffer: active.type,
      cursor: {
        x: active.cursorX,
        y: active.cursorY,
      },
      buffers: {
        active: {
          type: active.type,
          length: active.length,
          baseY: active.baseY,
          viewportY: active.viewportY,
          rows: this.getViewportRows(active),
        },
        normal: {
          type: normal.type,
          length: normal.length,
          baseY: normal.baseY,
          viewportY: normal.viewportY,
          tailRows: this.getTailRows(normal, tailCount),
        },
      },
    };
  }

  getViewportRows(buffer) {
    const start = clamp(buffer.viewportY, 0, buffer.length);
    return this.getBufferRows(buffer, start, this.rows);
  }

  getTailRows(buffer, count) {
    const safeCount = clampRowCount(count);
    const start = Math.max(0, buffer.length - safeCount);
    return this.getBufferRows(buffer, start, safeCount);
  }

  getBufferRows(buffer, start, count) {
    const safeStart = clamp(Number.parseInt(start, 10), 0, buffer.length);
    const safeEnd = clamp(safeStart + clampRowCount(count), safeStart, buffer.length);
    const rows = [];
    for (let i = safeStart; i < safeEnd; i++) {
      rows.push(describeBufferLine(buffer.getLine(i), i));
    }
    return rows;
  }

  removeSubscriber(sub) {
    this.subscribers.delete(sub);
  }

  write(str) {
    if (!this.ended && str) this.pty.write(str);
  }

  resize(cols, rows) {
    cols = clamp(Number.parseInt(cols, 10), 1, 1000);
    rows = clamp(Number.parseInt(rows, 10), 1, 1000);
    if (!cols || !rows) return;
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    if (this.ended) return;
    try {
      this.pty.resize(cols, rows);
    } catch (e) {
      /* pty may have just exited */
    }
    try {
      this.headless.resize(cols, rows);
    } catch (e) {
      /* ignore */
    }
  }

  // Best-effort synchronous teardown for process shutdown. Signals the whole
  // process group (the PTY child is a session/group leader) so backgrounded or
  // forked children don't linger. Under systemd this is a belt-and-suspenders
  // measure: the unit's cgroup teardown is the authoritative cleanup.
  destroy() {
    if (this.ended) return;
    const pid = this.pty && this.pty.pid;
    if (pid) {
      try {
        process.kill(-pid, 'SIGKILL');
        return;
      } catch (e) {
        /* group may already be gone; fall back below */
      }
    }
    try {
      this.pty.kill();
    } catch (e) {
      /* ignore */
    }
  }
}

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(lo, Math.min(hi, n));
}

function clampRowCount(n) {
  const value = Number.parseInt(n, 10);
  if (!Number.isFinite(value) || value < 0) return 0;
  return clamp(value, 0, MAX_READ_ROWS);
}

function describeBufferLine(line, index) {
  if (!line) {
    return { index, wrapped: false, text: '' };
  }
  return {
    index,
    wrapped: line.isWrapped,
    text: line.translateToString(true),
  };
}

// Always run the account's login shell from passwd, not the parent process's
// inherited SHELL environment variable. If it is unset or unusable, fail
// clearly instead of guessing.
function resolveShell(deps = { fs, os }) {
  let info;
  try {
    info = deps.os.userInfo();
  } catch (e) {
    const detail = e && e.message ? `: ${e.message}` : '';
    throw new Error(`Failed to resolve login shell from passwd${detail}`);
  }

  const file = typeof info.shell === 'string' ? info.shell.trim() : '';
  if (!file) {
    throw new Error(`Login shell is missing in passwd for user ${JSON.stringify(info.username || String(info.uid))}`);
  }

  try {
    deps.fs.accessSync(file, deps.fs.constants.X_OK);
  } catch (e) {
    const detail = e && e.message ? `: ${e.message}` : '';
    throw new Error(`Login shell ${JSON.stringify(file)} is not executable${detail}`);
  }

  const args = ['-l'];
  return { file, args, command: [file, ...args].join(' ') };
}

module.exports = { Session, resolveShell, MAX_READ_ROWS };
