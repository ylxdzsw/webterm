'use strict';

// Browser side of the web terminal.
//
// Output: one long-lived streaming fetch (GET /api/stream) read incrementally.
// Input:  coalesced POST /api/input requests (keep-alive, ordered).
// Resize: debounced POST /api/resize.
//
// The corporate proxy occasionally hijacks every request to this domain with an
// HTML "acknowledge" page until the user clicks through it in the browser. We
// detect that by checking that responses begin with the magic prefix; if not,
// we stop and show instructions plus a Reconnect button. Because the app stays
// loaded in memory, the user can acknowledge in another tab and reconnect
// without a full page reload (which would itself be hijacked).

const MAGIC_PREFIX = '{"m":"WT1"';
const SESSION = new URLSearchParams(location.search).get('session') || 'default';
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
term.focus();

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

// ---------------------------------------------------------------- connection state
let abort = null; // AbortController for the active stream
let connected = false; // stream is open and reading
let connecting = false; // a connect() attempt is in flight (guards against overlap)
let manualStop = false; // true when a nag was detected; suppress auto-reconnect
let reconnectDelay = 1000;
let reconnectTimer = null;

function api(path) {
  return path + (path.includes('?') ? '&' : '?') + 'session=' + encodeURIComponent(SESSION);
}

function nagDetected() {
  manualStop = true;
  connected = false;
  connecting = false;
  clearReconnect();
  if (abort) abort.abort();
  setStatus('blocked', 'warn');
  const origin = location.origin + '/';
  showOverlay(
    'Corporate reminder page detected',
    'A request was hijacked by the network acknowledgement page. To continue:' +
      '<ol>' +
      '<li>Open <a href="' +
      origin +
      '" target="_blank" rel="noopener" style="color:var(--accent)">' +
      origin +
      '</a> in a new tab and click <b>Acknowledged</b>.</li>' +
      '<li>Come back here and press <b>Reconnect</b> (no reload needed — your session is intact).</li>' +
      '</ol>',
    [
      { label: 'Open acknowledge page', href: origin, secondary: true },
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

function showDisconnected(msg) {
  setStatus('reconnecting…', 'warn');
}

function showAuthError() {
  manualStop = true;
  connected = false;
  connecting = false;
  clearReconnect();
  if (abort) abort.abort();
  setStatus('unauthorized', 'err');
  showOverlay(
    'Unauthorized',
    'The access token was rejected. Enter it again to continue.',
    [
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
    ]
  );
}

function showSessionEnded(code) {
  setStatus('session ended', 'err');
  showOverlay(
    'Session ended',
    'The shell exited (code ' + code + '). Start a fresh shell?',
    [
      {
        label: 'Restart shell',
        onClick: async () => {
          try {
            const r = await fetch(api('/api/restart'), {
              method: 'POST',
              headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
              body: '{}',
            });
            const txt = await r.text();
            if (!isOurs(txt)) return nagDetected();
          } catch (e) {
            /* fall through to reconnect */
          }
          term.reset();
          hideOverlay();
          connect();
        },
      },
    ]
  );
}

function isOurs(text) {
  return typeof text === 'string' && text.startsWith(MAGIC_PREFIX);
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

  // Tear down any previous stream before starting a new one.
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
    resp = await fetch(api('/api/stream'), {
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
  if (resp.status === 503) {
    connecting = false;
    manualStop = true;
    clearReconnect();
    if (abort) abort.abort();
    setStatus('at capacity', 'err');
    showOverlay(
      'Server at capacity',
      'Too many terminal sessions are open on the server. Close some and reconnect.',
      [
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
    return;
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
  // Re-sync size now that the session is guaranteed to exist (resize no longer
  // creates sessions, so the pre-stream resize is a no-op for brand-new ones).
  sendResize(true);

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      if (!gotMagic) {
        // Tolerate the prefix arriving across multiple chunks.
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
      // Fresh view of an existing session: clear and let the snapshot repaint.
      term.reset();
      break;
    case 'o':
      term.write(b64ToStr(msg.d));
      break;
    case 'k':
      break; // keepalive
    case 'bye':
      // Server is replacing this session (e.g. restart). Drop and reconnect to
      // the new one; aborting ends the read loop, which schedules a reconnect.
      reconnectDelay = 1000;
      if (abort) abort.abort();
      break;
    case 'exit':
      connected = false;
      connecting = false;
      manualStop = true;
      clearReconnect();
      if (abort) abort.abort();
      showSessionEnded(msg.code);
      break;
    default:
      break;
  }
}

function scheduleReconnect() {
  if (manualStop || connected || connecting) return;
  clearReconnect();
  showDisconnected();
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
let inputBuf = '';
let inputTimer = null;
let inputSending = Promise.resolve();

term.onData((data) => {
  inputBuf += data;
  if (inputTimer == null) {
    inputTimer = setTimeout(flushInput, INPUT_FLUSH_MS);
  }
});

function flushInput() {
  inputTimer = null;
  if (!inputBuf) return;
  const payload = inputBuf;
  inputBuf = '';
  // Serialize sends so keystrokes stay in order even under coalescing.
  inputSending = inputSending.then(() => sendInput(payload));
}

async function sendInput(payload) {
  if (manualStop) return;
  try {
    const r = await fetch(api('/api/input'), {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      keepalive: false,
      body: JSON.stringify({ d: strToB64(payload) }),
    });
    if (r.status === 401) return showAuthError();
    const txt = await r.text();
    if (!isOurs(txt)) return nagDetected();
  } catch (e) {
    // Network blip: the output stream's reconnect logic will recover; the key
    // press is lost but the user is about to stop anyway if this was the nag.
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
    const r = await fetch(api('/api/resize'), {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify(dims),
    });
    if (r.status === 401) {
      if (!silent) showAuthError();
      return;
    }
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
connect();
