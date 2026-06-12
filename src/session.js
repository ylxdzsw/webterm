'use strict';

const os = require('os');
const path = require('path');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { frame } = require('./protocol');

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const SCROLLBACK = parseInt(process.env.WEBTERM_SCROLLBACK || '2000', 10);

// Session ids appear in URLs and are used as map keys, so keep them short and
// URL/filesystem-safe. Shared with the client (it validates overrides too).
const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

// A persistent terminal session.
//
// The session owns a PTY (running the user's shell / chosen program) and a
// *headless* xterm.js instance that continuously consumes the PTY output. The
// headless terminal is what makes browser reconnects clean: at any moment we
// can ask the SerializeAddon for a string of escape sequences that recreates
// the current screen (colors, cursor, modes, scrollback). So every browser
// connection is a disposable view: on connect we replay the serialized
// snapshot, then stream live output. There is exactly one resume path, and it
// never desyncs terminal modes the way replaying from an arbitrary byte offset
// would.
//
// The server holds many of these at once, keyed by id (see SessionManager).
// Sessions live independently of any HTTP connection: browsers come and go,
// the PTY keeps running. A session ends only when its program exits (or it is
// killed), at which point the manager prunes it.
class Session {
  constructor(id, opts = {}) {
    this.id = id;
    this.cols = opts.cols || DEFAULT_COLS;
    this.rows = opts.rows || DEFAULT_ROWS;
    this.bytes = 0; // total output bytes produced (informational seq for clients)
    this.subscribers = new Set();
    this.ended = false;
    this.exitCode = null;
    this.createdAt = Date.now();
    this.title = ''; // last OSC 0/2 title the program set, if any
    this.onEnd = null; // manager-supplied hook to prune this session on exit

    this.headless = new Terminal({
      cols: this.cols,
      rows: this.rows,
      allowProposedApi: true,
      scrollback: SCROLLBACK,
    });
    this.serializer = new SerializeAddon();
    this.headless.loadAddon(this.serializer);
    // Programs advertise a title via OSC 0/1/2; xterm parses it for us. We use
    // it to label sessions in the lobby (more meaningful than the id) and to
    // set the browser tab title of the attached view.
    this.headless.onTitleChange((t) => {
      this.title = typeof t === 'string' ? t.slice(0, 256) : '';
      const line = frame({ t: 'title', title: this.title });
      for (const sub of this.subscribers) sub.send(line);
    });

    // Resolve what to actually run. An explicit command is parsed by the shell
    // (quoting/globbing), with `exec` so the target program *replaces* sh and
    // becomes the PTY's foreground process (correct signals, title, exit code).
    // No command -> the server-configured default ("$SHELL -l").
    const resolved = resolveCommand(opts.command);
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
      cwd: opts.cwd || process.env.WEBTERM_CWD || os.homedir(),
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
    // Notify attached viewers so they show Restart (this also covers a kill:
    // close() signals the process group, whose exit lands here).
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
    // Prune ourselves from the manager: an exited session is gone for good
    // (the client offers Restart, which creates a fresh one with the same id).
    if (this.onEnd) {
      try {
        this.onEnd();
      } catch (e) {
        /* ignore */
      }
    }
  }

  info() {
    return {
      id: this.id,
      command: this.command,
      title: this.title,
      cols: this.cols,
      rows: this.rows,
      viewers: this.subscribers.size,
      createdAt: this.createdAt,
      bytes: this.bytes,
    };
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

  // Tear down the session. If it is still running we signal the whole process
  // group (the PTY child is a session/group leader), so backgrounded or forked
  // children don't linger — a plain pty.kill() only targets the direct child.
  // The resulting PTY exit runs _onExit(), which notifies attached viewers and
  // disposes the headless terminal.
  destroy() {
    if (!this.ended) {
      const pid = this.pty && this.pty.pid;
      let killed = false;
      if (pid) {
        try {
          process.kill(-pid, 'SIGKILL');
          killed = true;
        } catch (e) {
          /* group may already be gone; fall back below */
        }
      }
      if (!killed) {
        try {
          this.pty.kill();
        } catch (e) {
          /* ignore */
        }
      }
      return;
    }
    try {
      this.headless.dispose();
    } catch (e) {
      /* ignore */
    }
  }
}

// Owns the set of live sessions, keyed by id. A session exists iff its program
// is running: it is created explicitly (the lobby's "New session") and pruned
// when its program exits or it is killed.
class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.maxSessions = Math.max(1, parseInt(process.env.WEBTERM_MAX_SESSIONS || '8', 10));
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  list() {
    return [...this.sessions.values()].map((s) => s.info());
  }

  _track(id, session) {
    // Identity check so a stale exit from a replaced session can't delete the
    // entry that now belongs to a newer session with the same id.
    session.onEnd = () => {
      if (this.sessions.get(id) === session) this.sessions.delete(id);
    };
    this.sessions.set(id, session);
  }

  // Create a new session. Returns { ok:true, session } or { ok:false, error }.
  //   - id given     -> must be valid and free (else 'bad-id' / 'exists')
  //   - id omitted   -> derived from the command (program name + sequence)
  // Refuses to exceed WEBTERM_MAX_SESSIONS ('too-many').
  create({ id, command } = {}) {
    if (id != null && id !== '') {
      if (!ID_RE.test(id)) return { ok: false, error: 'bad-id' };
      if (this.sessions.has(id)) return { ok: false, error: 'exists' };
    } else {
      id = deriveId(command, (cand) => this.sessions.has(cand));
    }
    if (this.sessions.size >= this.maxSessions) return { ok: false, error: 'too-many' };
    const session = new Session(id, { command });
    this._track(id, session);
    return { ok: true, session };
  }

  // Kill and remove a session. Returns whether one existed.
  close(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    session.destroy();
    return true;
  }

  destroyAll() {
    for (const s of this.sessions.values()) s.destroy();
    this.sessions.clear();
  }
}

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(lo, Math.min(hi, n));
}

// The server-configured default program, used when no command is given.
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

function resolveCommand(command) {
  const cmd = (command || '').trim();
  if (cmd) {
    return { file: '/bin/sh', args: ['-c', 'exec ' + cmd], command: cmd };
  }
  const file = process.env.WEBTERM_CMD || process.env.SHELL || 'bash';
  return { file, args: defaultArgs(), command: defaultCommand() };
}

// Default session id from a command: the program's base name plus a sequential
// suffix to disambiguate duplicates (e.g. "bash", "bash-2"). Naming only — the
// command itself is run via resolveCommand(), so this heuristic split is safe.
function deriveId(command, taken) {
  const src = (command || '').trim() || defaultCommand();
  const first = src.split(/\s+/)[0] || 'session';
  let base = path.basename(first).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60);
  if (!base) base = 'session';
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const cand = base + '-' + n;
    if (!taken(cand)) return cand;
  }
}

module.exports = { Session, SessionManager, ID_RE };
