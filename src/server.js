'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { SessionManager } = require('./session');
const { frame, MAGIC_PREFIX } = require('./protocol');

const HOST = process.env.WEBTERM_HOST || '127.0.0.1';
const PORT = parseInt(process.env.WEBTERM_PORT || '8080', 10);
const KEEPALIVE_MS = parseInt(process.env.WEBTERM_KEEPALIVE_MS || '15000', 10);
const DEFAULT_SESSION = process.env.WEBTERM_SESSION || 'default';

// Auth token. If not provided, generate one and print it so the operator can
// copy it into the browser. The whole point of this app is to expose a shell,
// so an unauthenticated endpoint would be an open root shell to the internet.
let TOKEN = process.env.WEBTERM_TOKEN || '';
if (!TOKEN) {
  TOKEN = crypto.randomBytes(24).toString('base64url');
  console.log('\n  No WEBTERM_TOKEN set. Generated a one-off token for this run:');
  console.log('  WEBTERM_TOKEN=' + TOKEN + '\n');
}

const manager = new SessionManager();
// Start the default session eagerly so the shell is alive and persistent from
// process start, independent of whether a browser is currently attached.
manager.getOrCreate(DEFAULT_SESSION);

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
  let tok = null;
  const h = req.get('authorization');
  if (h && h.startsWith('Bearer ')) tok = h.slice(7);
  if (!tok && typeof req.query.token === 'string') tok = req.query.token;
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
  if (typeof s === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(s)) return s;
  return DEFAULT_SESSION;
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

// --- Output channel: a single long-lived chunked HTTP/1.1 response.
// First frame is `hello` (carries the MAGIC_PREFIX so the client can detect the
// nag page), immediately followed by an `o` frame containing the serialized
// screen snapshot, then live output. Keepalive frames prevent idle timeouts.
app.get('/api/stream', auth, (req, res) => {
  const session = manager.getOrCreate(sessionIdFrom(req));

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
// reuses the connection (keep-alive) and coalesces rapid keystrokes.
app.post('/api/input', auth, express.json({ limit: '1mb' }), (req, res) => {
  const session = manager.get(sessionIdFrom(req));
  if (!session || session.ended) {
    return res.type('application/json').send(frame({ t: 'ack', ok: false, error: 'no-session' }));
  }
  const d = req.body && req.body.d;
  if (typeof d === 'string' && d.length) {
    session.write(Buffer.from(d, 'base64').toString('utf8'));
  }
  res.type('application/json').send(frame({ t: 'ack', ok: true, seq: session.bytes }));
});

app.post('/api/resize', auth, express.json({ limit: '1kb' }), (req, res) => {
  const session = manager.getOrCreate(sessionIdFrom(req));
  const { cols, rows } = req.body || {};
  session.resize(cols, rows);
  res
    .type('application/json')
    .send(frame({ t: 'ack', ok: true, cols: session.cols, rows: session.rows }));
});

app.post('/api/restart', auth, express.json({ limit: '1kb' }), (req, res) => {
  const id = sessionIdFrom(req);
  const session = manager.restart(id);
  res
    .type('application/json')
    .send(frame({ t: 'ack', ok: true, restarted: true, cols: session.cols, rows: session.rows }));
});

const server = app.listen(PORT, HOST, () => {
  console.log(`webterm listening on http://${HOST}:${PORT}  (session "${DEFAULT_SESSION}")`);
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
