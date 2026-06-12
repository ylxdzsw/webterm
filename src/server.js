'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { SessionManager, ID_RE } = require('./session');
const { frame, MAGIC_PREFIX } = require('./protocol');

const HOST = process.env.WEBTERM_HOST || '127.0.0.1';
const PORT = parseInt(process.env.WEBTERM_PORT || '8080', 10);
const KEEPALIVE_MS = parseInt(process.env.WEBTERM_KEEPALIVE_MS || '15000', 10);

// Auth token. If not provided, generate one and print it so the operator can
// copy it into the browser. The whole point of this app is to expose a shell,
// so an unauthenticated endpoint would be an open root shell to the internet.
//
// Rules:
//   - WEBTERM_TOKEN entirely unset  -> generate a random one-off token (local
//     convenience; printed on startup).
//   - WEBTERM_TOKEN set but empty/blank or a known placeholder -> refuse to
//     start (fail closed). This prevents deploy templates from shipping a
//     working weak secret.
const PLACEHOLDER_TOKENS = new Set([
  'change-me-to-a-long-random-string',
  'change-me',
  'changeme',
  'token',
  'secret',
  'password',
]);

let TOKEN = process.env.WEBTERM_TOKEN;
if (TOKEN === undefined) {
  TOKEN = crypto.randomBytes(24).toString('base64url');
  console.log('\n  No WEBTERM_TOKEN set. Generated a one-off token for this run:');
  console.log('  WEBTERM_TOKEN=' + TOKEN + '\n');
} else {
  TOKEN = TOKEN.trim();
  if (!TOKEN) {
    console.error(
      'FATAL: WEBTERM_TOKEN is set but empty. Provide a strong token, e.g.:\n' +
        '  WEBTERM_TOKEN=$(openssl rand -base64 32)'
    );
    process.exit(1);
  }
  if (PLACEHOLDER_TOKENS.has(TOKEN.toLowerCase())) {
    console.error(
      'FATAL: WEBTERM_TOKEN is a placeholder value. Set a real random token, e.g.:\n' +
        '  WEBTERM_TOKEN=$(openssl rand -base64 32)'
    );
    process.exit(1);
  }
  if (TOKEN.length < 16) {
    console.warn(
      'WARNING: WEBTERM_TOKEN is shorter than 16 characters; use a longer random value.'
    );
  }
}

const manager = new SessionManager();

const app = express();
app.disable('x-powered-by');
app.disable('etag');

function checkToken(provided) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function auth(req, res, next) {
  // Header-only: never accept the token via query string, which would leak it
  // into proxy/access logs, browser history, and Referer headers.
  let tok = null;
  const h = req.get('authorization');
  if (h && h.startsWith('Bearer ')) tok = h.slice(7);
  if (!checkToken(tok)) {
    return res
      .status(401)
      .type('application/json')
      .send(frame({ t: 'error', ok: false, error: 'unauthorized' }));
  }
  next();
}

function sessionIdFrom(req) {
  const s = req.query.session;
  if (typeof s === 'string' && ID_RE.test(s)) return s;
  return null;
}

// --- Static UI (no auth: it contains no secrets; the token is entered by the
// user and sent on the API calls). xterm assets are served locally so we never
// depend on a CDN that the proxy would hijack.
app.use('/', express.static(path.join(__dirname, '..', 'public')));
app.use(
  '/vendor/xterm.js',
  express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'))
);
app.use(
  '/vendor/xterm.css',
  express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'))
);
app.use(
  '/vendor/addon-fit.js',
  express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'))
);

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/api/health', (req, res) => {
  res.type('application/json').send(frame({ t: 'health', ok: true }));
});

// --- Session registry. The lobby lists these and creates/kills them; the
// stream/input/resize endpoints only operate on sessions that already exist.

app.get('/api/sessions', auth, (req, res) => {
  res
    .type('application/json')
    .send(frame({ t: 'sessions', ok: true, sessions: manager.list(), max: manager.maxSessions }));
});

// Create a session. Body: { command?: string, id?: string }. An empty/omitted
// command launches the server default ("$SHELL -l"); an omitted id is derived
// from the command (program name + sequence). Returns the created session info.
app.post('/api/sessions', auth, express.json({ limit: '4kb' }), (req, res) => {
  const body = req.body || {};
  const command = typeof body.command === 'string' ? body.command : '';
  const id = typeof body.id === 'string' ? body.id : undefined;
  const r = manager.create({ id, command });
  if (!r.ok) {
    const status = r.error === 'too-many' ? 503 : r.error === 'exists' ? 409 : 400;
    return res
      .status(status)
      .type('application/json')
      .send(frame({ t: 'created', ok: false, error: r.error }));
  }
  res.type('application/json').send(frame({ t: 'created', ok: true, session: r.session.info() }));
});

// Kill and remove a session. Body: { id }.
app.post('/api/sessions/close', auth, express.json({ limit: '1kb' }), (req, res) => {
  const body = req.body || {};
  const id = typeof body.id === 'string' && ID_RE.test(body.id) ? body.id : null;
  const ok = id ? manager.close(id) : false;
  res.type('application/json').send(frame({ t: 'closed', ok }));
});

// --- Output channel: a single long-lived chunked HTTP/1.1 response.
// First frame is `hello` (carries the MAGIC_PREFIX so the client can detect the
// nag page), immediately followed by an `o` frame containing the serialized
// screen snapshot, then live output. Keepalive frames prevent idle timeouts.
// Attaches only; a missing/unknown session id is a 404 (the client returns to
// the lobby), so the stream never silently spawns a shell.
app.get('/api/stream', auth, (req, res) => {
  const id = sessionIdFrom(req);
  const session = id ? manager.get(id) : null;
  if (!session || session.ended) {
    return res
      .status(404)
      .type('application/json')
      .send(frame({ t: 'error', ok: false, error: 'not-found' }));
  }

  res.status(200);
  res.set({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, no-transform',
    'X-Accel-Buffering': 'no', // nginx: do not buffer this response
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const sub = {
    send(line) {
      try {
        res.write(line);
      } catch (e) {
        /* peer gone */
      }
    },
    end() {
      try {
        res.end();
      } catch (e) {
        /* ignore */
      }
    },
  };

  // Atomic snapshot + subscribe: both run synchronously in this tick, so no PTY
  // output can slip in between (no gap, no duplication).
  const snap = session.snapshot();
  session.addSubscriber(sub);

  res.write(
    frame({
      t: 'hello',
      seq: session.bytes,
      cols: session.cols,
      rows: session.rows,
      command: session.command,
      title: session.title,
      ended: session.ended,
    })
  );
  if (snap && snap.length) {
    res.write(
      frame({
        t: 'o',
        seq: session.bytes,
        snapshot: true,
        d: Buffer.from(snap, 'utf8').toString('base64'),
      })
    );
  }
  if (session.ended) {
    res.write(frame({ t: 'exit', code: session.exitCode }));
    session.removeSubscriber(sub);
    return res.end();
  }

  const ka = setInterval(() => sub.send(frame({ t: 'k', seq: session.bytes })), KEEPALIVE_MS);

  req.on('close', () => {
    clearInterval(ka);
    session.removeSubscriber(sub);
  });
});

// --- Input channel: short POSTs carrying base64(UTF-8) keystrokes. The browser
// reuses the connection (keep-alive) and coalesces rapid keystrokes. A missing
// session is a 404 (it exited/was killed); the client returns to the lobby.
app.post('/api/input', auth, express.json({ limit: '1mb' }), (req, res) => {
  const id = sessionIdFrom(req);
  const session = id ? manager.get(id) : null;
  if (!session || session.ended) {
    return res
      .status(404)
      .type('application/json')
      .send(frame({ t: 'ack', ok: false, error: 'not-found' }));
  }
  const d = req.body && req.body.d;
  if (typeof d === 'string' && d.length) {
    session.write(Buffer.from(d, 'base64').toString('utf8'));
  }
  res.type('application/json').send(frame({ t: 'ack', ok: true, seq: session.bytes }));
});

app.post('/api/resize', auth, express.json({ limit: '1kb' }), (req, res) => {
  const id = sessionIdFrom(req);
  const session = id ? manager.get(id) : null;
  if (!session || session.ended) {
    return res
      .status(404)
      .type('application/json')
      .send(frame({ t: 'ack', ok: false, error: 'not-found' }));
  }
  const { cols, rows } = req.body || {};
  session.resize(cols, rows);
  res
    .type('application/json')
    .send(frame({ t: 'ack', ok: true, cols: session.cols, rows: session.rows }));
});

const server = app.listen(PORT, HOST, () => {
  console.log(`webterm listening on http://${HOST}:${PORT}`);
  console.log('Reverse-proxy this with TLS (nginx) and open it in your browser.');
});

// Keep long-lived streaming responses from being killed by Node's default
// header/socket timeouts.
server.headersTimeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 75000;

function shutdown() {
  manager.destroyAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, server, manager, MAGIC_PREFIX };
