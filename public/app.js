'use strict';

// Browser side of the web terminal.
//
// Each page is bound to exactly one shell — the single session owned by the
// server process behind this URL. There is no lobby and no session id: the
// server runs one program, and this page is a disposable view of it.
//
//   Output: one long-lived streaming fetch (GET api/stream) read incrementally.
//   Input:  coalesced POST api/input requests (keep-alive, ordered).
//   Resize: debounced POST api/resize.
//
// All API URLs are *relative* to the page. Served directly (local dev) the page
// is at `/` and hits `/api/stream`; behind nginx the page is at `/<slot>/` and
// hits `/<slot>/api/stream`, which nginx strips to `/api/stream` for the right
// backend. The client never needs to know its slot.
//
// When the program exits, the session (and its server process) is gone, so we
// show a Reload button that reloads the page — behind socket activation that
// spawns a fresh shell. Browser disconnects do not end the session: while the
// program runs the server keeps it alive and reconnects replay a snapshot.
//
// The corporate proxy occasionally hijacks every request to this domain with an
// HTML "acknowledge" page until the user clicks through it in the browser. We
// detect that by checking that responses begin with the magic prefix; if not,
// we stop and show instructions plus a Reconnect button. Because the app stays
// loaded in memory, the user can acknowledge in another tab and reconnect
// without a full page reload (which would itself be hijacked).

const MAGIC_PREFIX = '{"m":"WT1"';
const INPUT_FLUSH_MS = 8;
const RESIZE_DEBOUNCE_MS = 150;

const els = {
  terminal: document.getElementById('terminal'),
  status: document.getElementById('status'),
  overlay: document.getElementById('overlay'),
  overlayTitle: document.getElementById('overlay-title'),
  overlayBody: document.getElementById('overlay-body'),
  overlayActions: document.getElementById('overlay-actions'),
};

// ---------------------------------------------------------------- token
function getToken() {
  let t = localStorage.getItem('webterm_token');
  if (!t) {
    t = window.prompt('Access token for this terminal:') || '';
    if (t) localStorage.setItem('webterm_token', t.trim());
  }
  return (t || '').trim();
}
function clearToken() {
  localStorage.removeItem('webterm_token');
}
function authHeaders() {
  return { Authorization: 'Bearer ' + getToken() };
}

// ---------------------------------------------------------------- terminal
const term = new Terminal({
  cursorBlink: true,
  allowProposedApi: true,
  scrollback: 5000,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 14,
  theme: { background: '#0b0e14', foreground: '#c9d1d9' },
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(els.terminal);
fitAddon.fit();

// ---------------------------------------------------------------- status / overlay
function setStatus(text, kind) {
  if (!text) {
    els.status.classList.add('hidden');
    return;
  }
  els.status.textContent = text;
  els.status.className = 'status ' + (kind || '');
}

function showOverlay(title, bodyHtml, actions) {
  els.overlayTitle.textContent = title;
  els.overlayBody.innerHTML = bodyHtml;
  els.overlayActions.innerHTML = '';
  for (const a of actions) {
    let node;
    if (a.href) {
      node = document.createElement('a');
      node.href = a.href;
      node.target = '_blank';
      node.rel = 'noopener';
      node.className = 'btn' + (a.secondary ? ' secondary' : '');
    } else {
      node = document.createElement('button');
      if (a.secondary) node.className = 'secondary';
      node.addEventListener('click', a.onClick);
    }
    node.textContent = a.label;
    els.overlayActions.appendChild(node);
  }
  els.overlay.classList.remove('hidden');
}
function hideOverlay() {
  els.overlay.classList.add('hidden');
}

function setDocTitle(title) {
  document.title = title ? 'webterm — ' + title : 'webterm';
}

// ---------------------------------------------------------------- connection state
let abort = null; // AbortController for the active stream
let connected = false; // stream is open and reading
let connecting = false; // a connect() attempt is in flight (guards against overlap)
let manualStop = false; // suppress auto-reconnect (nag / exit)
let reconnectDelay = 1000;
let reconnectTimer = null;

function isOurs(text) {
  return typeof text === 'string' && text.startsWith(MAGIC_PREFIX);
}

function nagDetected() {
  manualStop = true;
  connected = false;
  connecting = false;
  clearReconnect();
  if (abort) abort.abort();
  setStatus('blocked', 'warn');
  const here = location.href;
  showOverlay(
    'Corporate reminder page detected',
    'A request was hijacked by the network acknowledgement page. To continue:' +
      '<ol>' +
      '<li>Open <a href="' +
      here +
      '" target="_blank" rel="noopener" style="color:var(--accent)">this page</a>' +
      ' in a new tab and click <b>Acknowledged</b>.</li>' +
      '<li>Come back here and press <b>Reconnect</b> (no reload needed — your session is intact).</li>' +
      '</ol>',
    [
      { label: 'Open acknowledge page', href: here, secondary: true },
      {
        label: 'Reconnect',
        onClick: () => {
          hideOverlay();
          manualStop = false;
          connect();
        },
      },
    ]
  );
}

function showAuthError() {
  manualStop = true;
  connected = false;
  connecting = false;
  clearReconnect();
  if (abort) abort.abort();
  setStatus('unauthorized', 'err');
  showOverlay('Unauthorized', 'The access token was rejected. Enter it again to continue.', [
    {
      label: 'Enter token',
      onClick: () => {
        clearToken();
        getToken();
        hideOverlay();
        manualStop = false;
        connect();
      },
    },
  ]);
}

// The program exited: the server process is gone. Reloading the page spawns a
// fresh shell (under socket activation) or reconnects once the unit is back.
function showReload(code) {
  setStatus('session ended', 'err');
  showOverlay(
    'Session ended',
    'The program exited (code ' + code + '). Reload to start a fresh shell.',
    [
      {
        label: 'Reload',
        onClick: () => location.reload(),
      },
    ]
  );
}

// ---------------------------------------------------------------- output stream
async function connect() {
  // Guard against overlapping attempts: set `connecting` synchronously before
  // any await so a second call (e.g. a stale reconnect timer) bails out.
  if (connected || connecting) return;
  connecting = true;
  manualStop = false;
  clearReconnect();
  hideOverlay();
  setStatus('connecting…', '');

  if (abort) {
    try {
      abort.abort();
    } catch (e) {
      /* ignore */
    }
  }

  // Make the backend PTY match our viewport before we snapshot/stream so the
  // first paint is at the right size.
  await sendResize(true);
  if (manualStop) {
    connecting = false;
    return;
  }

  abort = new AbortController();
  const myAbort = abort;
  let resp;
  try {
    resp = await fetch('api/stream', {
      headers: authHeaders(),
      signal: myAbort.signal,
      cache: 'no-store',
    });
  } catch (e) {
    connecting = false;
    return scheduleReconnect();
  }

  if (resp.status === 401) {
    connecting = false;
    return showAuthError();
  }
  if (!resp.ok || !resp.body) {
    // A non-OK response with HTML is almost certainly the nag page.
    connecting = false;
    const txt = await safeText(resp);
    if (!isOurs(txt)) return nagDetected();
    return scheduleReconnect();
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let gotMagic = false;
  connected = true;
  connecting = false;
  reconnectDelay = 1000;
  setStatus('connected', 'ok');
  setTimeout(() => setStatus(''), 1200);
  sendResize(true);

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      if (!gotMagic) {
        if (buf.length < MAGIC_PREFIX.length) {
          if (!MAGIC_PREFIX.startsWith(buf)) {
            connected = false;
            return nagDetected();
          }
          continue;
        }
        if (!buf.startsWith(MAGIC_PREFIX)) {
          connected = false;
          return nagDetected();
        }
        gotMagic = true;
      }

      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) handleFrame(line);
      }
    }
  } catch (e) {
    /* network error / aborted */
  }

  connected = false;
  if (!manualStop) scheduleReconnect();
}

function handleFrame(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    return; // ignore unparseable noise
  }
  if (!msg || msg.m !== 'WT1') return;

  switch (msg.t) {
    case 'hello':
      setDocTitle(msg.title || '');
      // Fresh view of the session: clear and let the snapshot repaint.
      term.reset();
      break;
    case 'o':
      term.write(b64ToStr(msg.d));
      break;
    case 'title':
      setDocTitle(msg.title || '');
      break;
    case 'k':
      break; // keepalive
    case 'exit':
      connected = false;
      connecting = false;
      manualStop = true;
      clearReconnect();
      if (abort) abort.abort();
      showReload(msg.code);
      break;
    default:
      break;
  }
}

function scheduleReconnect() {
  if (manualStop || connected || connecting) return;
  clearReconnect();
  setStatus('reconnecting…', 'warn');
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// ---------------------------------------------------------------- input
//
// Input is sent as short POSTs, but coalesced *self-clocked* to the network:
// we keep at most one request in flight, and everything typed while it is in
// flight accumulates into a single buffer that is sent as one POST the moment
// the previous one returns. So a burst typed during one proxy round-trip
// collapses to ~one request per round-trip (fast link -> small frequent
// batches; slow link -> fewer, larger batches), instead of one request per
// 8ms window queued behind each other. Keeping exactly one request in flight
// also preserves keystroke ordering without input sequence numbers, even if
// the proxy/connection pool would otherwise reorder concurrent requests.
let inputBuf = '';
let inputTimer = null;
let inputInFlight = false;

term.onData((data) => {
  inputBuf += data;
  scheduleFlush();
});

function scheduleFlush() {
  // While a POST is in flight, just accumulate; the in-flight request's
  // completion handler will drain whatever piled up in one follow-up POST.
  if (inputInFlight || inputTimer != null) return;
  // A tiny debounce still coalesces simultaneous keystrokes (e.g. a paste or
  // an escape sequence) into the first batch even on a zero-latency link.
  inputTimer = setTimeout(flushInput, INPUT_FLUSH_MS);
}

function flushInput() {
  inputTimer = null;
  if (inputInFlight || !inputBuf) return;
  const payload = inputBuf;
  inputBuf = '';
  inputInFlight = true;
  sendInput(payload).finally(() => {
    inputInFlight = false;
    // Anything typed during the round-trip is now coalesced into one POST.
    if (inputBuf) flushInput();
  });
}

async function sendInput(payload) {
  if (manualStop) return;
  try {
    const r = await fetch('api/input', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      keepalive: false,
      body: JSON.stringify({ d: strToB64(payload) }),
    });
    if (r.status === 401) return showAuthError();
    if (r.status === 409) return; // session ended; the stream loop shows Reload
    const txt = await r.text();
    if (!isOurs(txt)) return nagDetected();
  } catch (e) {
    /* network blip; the output stream's reconnect logic recovers */
  }
}

// ---------------------------------------------------------------- resize
let resizeTimer = null;
function scheduleResize() {
  fitAddon.fit();
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => sendResize(false), RESIZE_DEBOUNCE_MS);
}

async function sendResize(silent) {
  const dims = { cols: term.cols, rows: term.rows };
  try {
    const r = await fetch('api/resize', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify(dims),
    });
    if (r.status === 401) {
      if (!silent) showAuthError();
      return;
    }
    if (r.status === 409) return;
    const txt = await r.text();
    if (!isOurs(txt) && !silent) nagDetected();
  } catch (e) {
    /* ignore; stream reconnect handles recovery */
  }
}

window.addEventListener('resize', scheduleResize);

// ---------------------------------------------------------------- base64 (UTF-8 safe)
function strToB64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
function b64ToStr(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

async function safeText(resp) {
  try {
    return await resp.text();
  } catch (e) {
    return '';
  }
}

// ---------------------------------------------------------------- go
getToken();
term.focus();
connect();
