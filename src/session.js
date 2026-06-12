'use strict';

const os = require('os');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { frame } = require('./protocol');

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const SCROLLBACK = parseInt(process.env.WEBTERM_SCROLLBACK || '2000', 10);

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
    this.subscribers = new Set();
    this.ended = false;
    this.exitCode = null;
    this.createdAt = Date.now();
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

    const resolved = resolveCommand();
    this.command = resolved.command;

    const env = Object.assign({}, process.env, {
      // Make full-screen TUIs (opencode, claude code, vim, htop, ...) behave:
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.WEBTERM_LANG || process.env.LANG || 'C.UTF-8',
    });
    // Don't leak our own config knobs into the child shell.
    delete env.WEBTERM_TOKEN;

    this.pty = pty.spawn(resolved.file, resolved.args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: process.env.WEBTERM_CWD || os.homedir(),
      env,
    });

    this.pty.onData((data) => this._onData(data));
    this.pty.onExit((e) => this._onExit(e && e.exitCode != null ? e.exitCode : 0));
  }

  _onData(data) {
    this.headless.write(data);
    this.bytes += Buffer.byteLength(data, 'utf8');
    const line = frame({
      t: 'o',
      seq: this.bytes,
      d: Buffer.from(data, 'utf8').toString('base64'),
    });
    for (const sub of this.subscribers) sub.send(line);
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
    try {
      this.headless.dispose();
    } catch (e) {
      /* ignore */
    }
    if (this.onExit) {
      try {
        this.onExit(code);
      } catch (e) {
        /* ignore */
      }
    }
  }

  // String of escape sequences that recreates the current screen.
  snapshot() {
    try {
      return this.serializer.serialize();
    } catch (e) {
      return '';
    }
  }

  addSubscriber(sub) {
    this.subscribers.add(sub);
  }

  removeSubscriber(sub) {
    this.subscribers.delete(sub);
  }

  write(str) {
    if (!this.ended && str) this.pty.write(str);
  }

  resize(cols, rows) {
    cols = clamp(parseInt(cols, 10), 1, 1000);
    rows = clamp(parseInt(rows, 10), 1, 1000);
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

// The server-configured program. With no overrides this is "$SHELL -l". There
// is no per-session command anymore: every server runs one shell.
function defaultCommand() {
  const file = process.env.WEBTERM_CMD || process.env.SHELL || 'bash';
  return [file, ...defaultArgs()].join(' ');
}

function defaultArgs() {
  // An explicitly-set WEBTERM_ARGS (even empty) wins over the "-l" default, so
  // `WEBTERM_CMD=opencode` + `WEBTERM_ARGS=` launches bare `opencode`.
  if (process.env.WEBTERM_ARGS === undefined) return ['-l'];
  return process.env.WEBTERM_ARGS.split(' ').filter(Boolean);
}

function resolveCommand() {
  const file = process.env.WEBTERM_CMD || process.env.SHELL || 'bash';
  return { file, args: defaultArgs(), command: defaultCommand() };
}

module.exports = { Session };
