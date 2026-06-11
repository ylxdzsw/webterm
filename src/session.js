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
    const args = opts.args || parseArgs(process.env.WEBTERM_ARGS) || ['-l'];
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
  }

  getOrCreate(id, opts) {
    let s = this.sessions.get(id);
    if (!s) {
      s = new Session(id, opts);
      this.sessions.set(id, s);
    }
    return s;
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  // Tear down the existing session (if any) and start a fresh shell.
  restart(id, opts) {
    const old = this.sessions.get(id);
    if (old) old.destroy();
    const s = new Session(id, opts);
    this.sessions.set(id, s);
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

function parseArgs(s) {
  if (!s) return null;
  return s.split(' ').filter(Boolean);
}

module.exports = { Session, SessionManager };
