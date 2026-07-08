'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
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

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC_ROUTES = new Map([
  ['/', path.join(PUBLIC_DIR, 'index.html')],
  ['/index.html', path.join(PUBLIC_DIR, 'index.html')],
  ['/app.js', path.join(PUBLIC_DIR, 'app.js')],
  ['/style.css', path.join(PUBLIC_DIR, 'style.css')],
  ['/favicon.svg', path.join(PUBLIC_DIR, 'favicon.svg')],
  ['/vendor/xterm.js', path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js')],
  ['/vendor/xterm.css', path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css')],
  [
    '/vendor/addon-fit.js',
    path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'),
  ],
]);

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

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

function applyDefaultHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
}

function send(res, status, headers, body) {
  applyDefaultHeaders(res);
  res.writeHead(status, headers);
  res.end(body);
}

function sendJsonFrame(res, body, status = 200) {
  send(
    res,
    status,
    { 'Content-Type': 'application/json; charset=utf-8' },
    frame(body)
  );
}

function sendText(res, body, status = 200) {
  send(res, status, { 'Content-Type': 'text/plain; charset=utf-8' }, body);
}

function sendNotFound(res) {
  sendText(res, 'Not found', 404);
}

function sendMethodNotAllowed(res) {
  sendText(res, 'Method not allowed', 405);
}

function parseTailRows(value, fallback = 200) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0) return fallback;
  return Math.min(parsed, MAX_READ_ROWS);
}

function requestUrl(req) {
  const rawUrl = req.url || '/';
  return new URL(rawUrl, 'http://localhost');
}

function serveStatic(req, res, pathname) {
  const file = STATIC_ROUTES.get(pathname);
  if (!file) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendMethodNotAllowed(res);
    return true;
  }

  fs.readFile(file, (err, body) => {
    if (err) {
      sendNotFound(res);
      return;
    }

    applyDefaultHeaders(res);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES.get(path.extname(file)) || 'application/octet-stream',
      'Content-Length': body.length,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(body);
  });
  return true;
}

function readBody(req, { limit, validateContentType }, callback) {
  const contentType = req.headers['content-type'] || '';
  if (validateContentType && !validateContentType(contentType)) {
    callback(null, null, 'unsupported media type');
    req.resume();
    return;
  }

  const chunks = [];
  let bytes = 0;
  let done = false;

  function finish(err, body, errorCode) {
    if (done) return;
    done = true;
    callback(err, body, errorCode);
  }

  req.on('data', (chunk) => {
    if (done) return;
    bytes += chunk.length;
    if (bytes > limit) {
      finish(null, null, 'payload too large');
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => finish(null, Buffer.concat(chunks)));
  req.on('error', (err) => finish(err));
}

function handleSnapshot(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendMethodNotAllowed(res);
    return;
  }
  sendText(res, req.method === 'HEAD' ? '' : session.visibleText());
}

function handleState(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendMethodNotAllowed(res);
    return;
  }
  const body = JSON.stringify(session.describeState(parseTailRows(url.searchParams.get('tailRows'))));
  send(
    res,
    200,
    { 'Content-Type': 'application/json; charset=utf-8' },
    req.method === 'HEAD' ? '' : body
  );
}

function handleStream(req, res, url) {
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res);
    return;
  }

  // Let the client provide its initial viewport on the stream request itself.
  // That avoids a separate pre-stream resize round trip while preserving a
  // correctly-sized first snapshot.
  session.resize(url.searchParams.get('cols'), url.searchParams.get('rows'));

  applyDefaultHeaders(res);
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

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

  attached = session.attachSubscriber(sub, ({ snapshot, markSnapshotSent, release }) => {
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
    markSnapshotSent();
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
}

function handleInput(req, res) {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res);
    return;
  }
  if (session.ended) {
    sendJsonFrame(res, { t: 'ack', ok: false, error: 'ended' }, 409);
    return;
  }

  readBody(
    req,
    {
      limit: 1024 * 1024,
      validateContentType: (contentType) => contentType.includes('application/octet-stream'),
    },
    (err, body, errorCode) => {
      if (err) {
        sendJsonFrame(res, { t: 'ack', ok: false, error: 'bad request' }, 400);
        return;
      }
      if (errorCode === 'unsupported media type') {
        sendJsonFrame(res, { t: 'ack', ok: false, error: errorCode }, 415);
        return;
      }
      if (errorCode === 'payload too large') {
        sendJsonFrame(res, { t: 'ack', ok: false, error: errorCode }, 413);
        return;
      }
      if (Buffer.isBuffer(body) && body.length) {
        session.write(body.toString('utf8'));
      }
      sendJsonFrame(res, { t: 'ack', ok: true, seq: session.bytes });
    }
  );
}

function handleResize(req, res) {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res);
    return;
  }
  if (session.ended) {
    sendJsonFrame(res, { t: 'ack', ok: false, error: 'ended' }, 409);
    return;
  }

  readBody(
    req,
    {
      limit: 1024,
      validateContentType: (contentType) => {
        if (!contentType) return true;
        return contentType.includes('application/json');
      },
    },
    (err, body, errorCode) => {
      if (err) {
        sendJsonFrame(res, { t: 'ack', ok: false, error: 'bad request' }, 400);
        return;
      }
      if (errorCode === 'unsupported media type') {
        sendJsonFrame(res, { t: 'ack', ok: false, error: errorCode }, 415);
        return;
      }
      if (errorCode === 'payload too large') {
        sendJsonFrame(res, { t: 'ack', ok: false, error: errorCode }, 413);
        return;
      }

      let parsed = {};
      if (body && body.length) {
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          sendJsonFrame(res, { t: 'ack', ok: false, error: 'bad json' }, 400);
          return;
        }
      }

      const { cols, rows } = parsed || {};
      session.resize(cols, rows);
      sendJsonFrame(res, { t: 'ack', ok: true, cols: session.cols, rows: session.rows });
    }
  );
}

function handleRequest(req, res) {
  const url = requestUrl(req);
  const pathname = url.pathname;

  if (pathname === '/api/snapshot') {
    handleSnapshot(req, res);
    return;
  }
  if (pathname === '/api/state') {
    handleState(req, res, url);
    return;
  }
  if (pathname === '/api/stream') {
    handleStream(req, res, url);
    return;
  }
  if (pathname === '/api/input') {
    handleInput(req, res);
    return;
  }
  if (pathname === '/api/resize') {
    handleResize(req, res);
    return;
  }
  if (serveStatic(req, res, pathname)) return;

  sendNotFound(res);
}

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

const server = http.createServer(handleRequest);
const listenOpts = fd != null ? { fd } : { host: DEV_HOST, port: PORT };
server.listen(listenOpts, () => {
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

module.exports = { handleRequest, server, session };
