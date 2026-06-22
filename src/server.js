'use strict';

const path = require('path');
const express = require('express');
const { Session, MAX_READ_ROWS } = require('./session');
const { frame } = require('./protocol');
const { createStreamSubscriber, parseBufferLimit } = require('./stream-subscriber');

// WEBTERM_DEV_PORT: escape hatch for local development.
// When set to a port number, forces insecure TCP listening on localhost.
// Production MUST use systemd socket activation behind nginx (leave this unset).
const DEV_PORT_STR = process.env.WEBTERM_DEV_PORT;
const DEV_MODE = DEV_PORT_STR != null && DEV_PORT_STR.trim() !== '';
const DEV_HOST = '127.0.0.1';
const PORT = DEV_MODE ? Number.parseInt(DEV_PORT_STR, 10) : 0;
const KEEPALIVE_MS = Number.parseInt(process.env.WEBTERM_KEEPALIVE_MS || '15000', 10);
const SUBSCRIBER_BUFFER_BYTES = parseBufferLimit(process.env.WEBTERM_SUBSCRIBER_BUFFER_BYTES);
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

// systemd socket-activation hand-off. When the unit is started by an incoming
// connection, systemd passes the already-listening socket(s) as fds starting
// at 3, advertised via LISTEN_FDS and addressed to us via LISTEN_PID. If that
// matches, we listen on the inherited fd instead of binding a port — this is
// how `webterm@N.socket` (a unix socket) reaches this process. With no socket
// activation (plain `npm start`), we fall back to localhost:PORT and serve a
// single shell at `/`.
const SD_LISTEN_FDS_START = 3;
function socketActivationFd() {
  const n = Number.parseInt(process.env.LISTEN_FDS || '0', 10);
  if (!Number.isFinite(n) || n < 1) return null;
  const pidEnv = process.env.LISTEN_PID;
  if (pidEnv && Number.parseInt(pidEnv, 10) !== process.pid) return null;
  // We only ever configure a single socket per service instance.
  return SD_LISTEN_FDS_START;
}

// The one session this process owns. Created up front so the first request can
// stream immediately and `/api/snapshot` is always ready.
const session = new Session();
// When the program exits, the session ends and so does this process. Under
// systemd the unit goes inactive and its cgroup is reaped; the matching socket
// unit re-activates a fresh process on the next request.
session.onExit = (code) => {
  setImmediate(() => process.exit(code ? 1 : 0));
};

const app = express();
app.disable('x-powered-by');
app.disable('etag');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  next();
});

function jsonFrame(res, body, status = 200) {
  return res.status(status).type('application/json').send(frame(body));
}

function parseTailRows(value, fallback = 200) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0) return fallback;
  return Math.min(parsed, MAX_READ_ROWS);
}

// --- Static UI. xterm assets are served locally so we never depend on a CDN
// that the proxy would hijack. Behind nginx the per-slot path prefix (`/N/`) is
// stripped before requests reach us, so everything here is served from the root
// either way.
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

app.get('/api/snapshot', (req, res) => {
  res.type('text/plain; charset=utf-8').send(session.visibleText());
});

// Structured terminal state for debugging and tests.
app.get('/api/state', (req, res) => {
  res.json(session.describeState(parseTailRows(req.query.tailRows)));
});

// --- Output channel: a single long-lived chunked HTTP/1.1 response.
// First frame is `hello`, immediately followed by an `o` frame containing the
// serialized screen snapshot, then live output. Keepalive frames prevent idle
// timeouts.
app.get('/api/stream', (req, res) => {
  res.status(200);
  res.set({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, no-transform',
    'X-Accel-Buffering': 'no', // nginx: do not buffer this response
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  let attached = null;
  let ka = null;
  let closed = false;

  function cleanup() {
    if (closed) return;
    closed = true;
    if (ka) clearInterval(ka);
    if (attached) session.removeSubscriber(attached);
  }

  const sub = createStreamSubscriber(res, {
    maxBufferBytes: SUBSCRIBER_BUFFER_BYTES,
    onClose: cleanup,
  });

  attached = session.attachSubscriber(sub, ({ snapshot, release }) => {
    if (closed) return;

    sub.send(
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
    if (snapshot && snapshot.length) {
      sub.send(
        frame({
          t: 'o',
          seq: session.bytes,
          snapshot: true,
          d: Buffer.from(snapshot, 'utf8').toString('base64'),
        })
      );
    }
    if (session.ended) {
      sub.send(frame({ t: 'exit', code: session.exitCode }));
      release();
      sub.end();
      return;
    }

    release();
    ka = setInterval(() => sub.send(frame({ t: 'k', seq: session.bytes })), KEEPALIVE_MS);
  });
  if (closed) session.removeSubscriber(attached);

  req.on('close', () => {
    sub.close();
  });
});

// --- Input channel: short POSTs carrying raw UTF-8 bytes. The browser reuses the
// connection (keep-alive) and coalesces rapid keystrokes / mouse motion.
app.post('/api/input', express.raw({ type: 'application/octet-stream', limit: '1mb' }), (req, res) => {
  if (session.ended) {
    return jsonFrame(res, { t: 'ack', ok: false, error: 'ended' }, 409);
  }
  const ct = req.get('content-type') || '';
  if (!ct.includes('application/octet-stream')) {
    return jsonFrame(res, { t: 'ack', ok: false, error: 'unsupported media type' }, 415);
  }
  if (Buffer.isBuffer(req.body) && req.body.length) {
    session.write(req.body.toString('utf8'));
  }
  jsonFrame(res, { t: 'ack', ok: true, seq: session.bytes });
});

app.post('/api/resize', express.json({ limit: '1kb' }), (req, res) => {
  if (session.ended) {
    return jsonFrame(res, { t: 'ack', ok: false, error: 'ended' }, 409);
  }
  const { cols, rows } = req.body || {};
  session.resize(cols, rows);
  jsonFrame(res, { t: 'ack', ok: true, cols: session.cols, rows: session.rows });
});

const fd = DEV_MODE ? null : socketActivationFd();

if (!DEV_MODE && fd == null) {
  console.error('FATAL: No socket activation detected and WEBTERM_DEV_PORT not set.');
  console.error('In production, use systemd socket activation.');
  console.error('For local development, set WEBTERM_DEV_PORT to a port number.');
  process.exit(1);
}

if (DEV_MODE) {
  console.error('╔══════════════════════════════════════════════════════════════════════════╗');
  console.error('║                                                                          ║');
  console.error('║  WARNING: INSECURE DEV MODE ACTIVE                                       ║');
  console.error('║                                                                          ║');
  console.error('║  webterm is listening on TCP on localhost only.                          ║');
  console.error('║  This exposes a SHELL to anyone who can reach this server.               ║');
  console.error('║                                                                          ║');
  console.error('║  This mode is FOR LOCAL DEVELOPMENT ONLY.                                ║');
  console.error('║  DO NOT USE IN PRODUCTION OR ON PUBLICLY ACCESSIBLE NETWORKS.            ║');
  console.error('║                                                                          ║');
  console.error('║  In production:                                                          ║');
  console.error('║    1. Do NOT set WEBTERM_DEV_PORT                                        ║');
  console.error('║    2. Use systemd socket activation (unix sockets)                       ║');
  console.error('║    3. Put nginx in front                                                 ║');
  console.error('║                                                                          ║');
  console.error('╚══════════════════════════════════════════════════════════════════════════╝');
  console.error('');
}

const listenOpts = fd != null ? { fd } : { host: DEV_HOST, port: PORT };
const server = app.listen(listenOpts, () => {
  if (fd != null) {
    console.log(`webterm listening on inherited socket activation fd ${fd}`);
  } else {
    console.error(`webterm listening on http://${DEV_HOST}:${PORT} [INSECURE DEV MODE]`);
  }
});

// Keep long-lived streaming responses from being killed by Node's default
// header/socket timeouts.
server.headersTimeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 75000;

function shutdown() {
  session.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, server, session };
