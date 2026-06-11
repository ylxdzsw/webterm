'use strict';

const os = require('os');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { frame } = require('./protocol');

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const SCROLLBACK = parseInt(process.env.WEBTERM_SCROLLBACK || '2000', 10);

// A persistent terminal session.
//
// The session owns a PTY (running the user's shell / TUI app) and a *headless*
// xterm.js instance that continuously consumes the PTY output. The headless
// terminal is what makes browser reconnects clean: at any moment we can ask the
// SerializeAddon for a string of escape sequences that recreates the current
// screen (colors, cursor, modes, scrollback). So every browser connection is a
// disposable view: on connect we replay the serialized snapshot, then stream
// live output. There is exactly one resume path, and it never desyncs terminal
// modes the way replaying from an arbitrary byte offset would.
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

    this.headless = new Terminal({
      cols: this.cols,
      rows: this.rows,
      allowProposedApi: true,
      scrollback: SCROLLBACK,
    });
    this.serializer = new SerializeAddon();
    this.headless.loadAddon(this.serializer);

    const shell =
      opts.cmd || process.env.WEBTERM_CMD || process.env.SHELL || 'bash';
    // An explicitly-set WEBTERM_ARGS (even empty) wins over the "-l" default,
    // so `WEBTERM_CMD=opencode` + `WEBTERM_ARGS=` launches bare `opencode`.
    const args = opts.args || envArgs();
    const env = Object.assign({}, process.env, {
      // Make full-screen TUIs (opencode, claude code, vim, htop, ...) behave:
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.WEBTERM_LANG || process.env.LANG || 'C.UTF-8',
    });
    // Don't leak our own config knobs into the child shell.
    delete env.WEBTERM_TOKEN;

    this.pty = pty.spawn(shell, args, {
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
    this.ended = true;
    this.exitCode = code;
    const line = frame({ t: 'exit', code });
    for (const sub of this.subscribers) {
      sub.send(line);
      sub.end();
    }
    this.subscribers.clear();
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

  // Gracefully end this session: tell attached viewers (so they don't sit on a
  // frozen "connected" stream), close their HTTP responses, then tear down. A
  // `bye` frame asks the client to reconnect (e.g. after a restart) rather than
  // treating it as a terminal exit.
  shutdown(reason) {
    this.ended = true;
    const line = frame({ t: 'bye', reason: reason || 'shutdown' });
    for (const sub of this.subscribers) {
      sub.send(line);
      sub.end();
    }
    this.subscribers.clear();
    this.destroy();
  }

  destroy() {
    try {
      this.pty.kill();
    } catch (e) {
      /* ignore */
    }
    try {
      this.headless.dispose();
    } catch (e) {
      /* ignore */
    }
    this.subscribers.clear();
  }
}

// Owns the set of live sessions, keyed by id. Sessions live independently of
// any HTTP connection: browsers come and go, the PTY keeps running.
class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.maxSessions = Math.max(1, parseInt(process.env.WEBTERM_MAX_SESSIONS || '8', 10));
  }

  // Returns the existing session, or creates one if under the cap. Returns null
  // when a new session would exceed WEBTERM_MAX_SESSIONS (prevents a single
  // token from spawning unbounded shells via arbitrary ?session= values).
  getOrCreate(id, opts) {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    if (this.sessions.size >= this.maxSessions) return null;
    const s = new Session(id, opts);
    this.sessions.set(id, s);
    return s;
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  // Whether (re)creating this id is allowed under the cap. Existing ids are
  // always allowed (replacement doesn't grow the map).
  canCreate(id) {
    return this.sessions.has(id) || this.sessions.size < this.maxSessions;
  }

  // Replace the session with a fresh shell, notifying any attached viewers of
  // the old one so they reconnect instead of freezing.
  restart(id, opts) {
    const old = this.sessions.get(id);
    const s = new Session(id, opts);
    this.sessions.set(id, s);
    if (old) old.shutdown('restart');
    return s;
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

function envArgs() {
  if (process.env.WEBTERM_ARGS === undefined) return ['-l'];
  return process.env.WEBTERM_ARGS.split(' ').filter(Boolean);
}

module.exports = { Session, SessionManager };
