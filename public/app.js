'use strict';

// Browser side of the web terminal.
//
// A page first shows a *lobby*: the list of running sessions to attach to, plus
// a form to create a new one. Once attached, the page is bound to that one
// session for its lifetime:
//
//   Output: one long-lived streaming fetch (GET /api/stream) read incrementally.
//   Input:  coalesced POST /api/input requests (keep-alive, ordered).
//   Resize: debounced POST /api/resize.
//
// When the session's program exits, we show a Restart button (recreates a fresh
// session with the same id + command). Sessions are in-memory on the server: a
// session that has exited is gone, so reloading a page whose session no longer
// exists is a 404 and drops back to the lobby.
//
// The corporate proxy occasionally hijacks every request to this domain with an
// HTML "acknowledge" page until the user clicks through it in the browser. We
// detect that by checking that responses begin with the magic prefix; if not,
// we stop and show instructions plus a Reconnect button. Because the app stays
// loaded in memory, the user can acknowledge in another tab and reconnect
// without a full page reload (which would itself be hijacked).

const MAGIC_PREFIX = '{"m":"WT1"';
const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const INPUT_FLUSH_MS = 8;
const RESIZE_DEBOUNCE_MS = 150;

const els = {
  terminal: document.getElementById('terminal'),
  status: document.getElementById('status'),
  overlay: document.getElementById('overlay'),
  overlayTitle: document.getElementById('overlay-title'),
  overlayBody: document.getElementById('overlay-body'),
  overlayActions: document.getElementById('overlay-actions'),
  lobby: document.getElementById('lobby'),
  lobbyList: document.getElementById('lobby-list'),
  lobbyEmpty: document.getElementById('lobby-empty'),
  lobbyCreate: document.getElementById('lobby-create'),
  createCommand: document.getElementById('create-command'),
  createId: document.getElementById('create-id'),
  createError: document.getElementById('create-error'),
  createBtn: document.getElementById('create-btn'),
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
  const label = title || currentSession || '';
  document.title = label ? 'webterm — ' + label : 'webterm';
}

// ---------------------------------------------------------------- connection state
let currentSession = null; // session id this page is attached to (null = lobby)
let currentCommand = ''; // command of the attached session (for Restart)
let abort = null; // AbortController for the active stream
let connected = false; // stream is open and reading
let connecting = false; // a connect() attempt is in flight (guards against overlap)
let manualStop = false; // suppress auto-reconnect (nag / exit / showing lobby)
let reconnectDelay = 1000;
let reconnectTimer = null;
let knownIds = new Set(); // ids from the last session list (for id-preview dedupe)

function urlSession() {
  return new URLSearchParams(location.search).get('session');
}

function api(path) {
  const sep = path.includes('?') ? '&' : '?';
  return path + sep + 'session=' + encodeURIComponent(currentSession || '');
}

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
          resume();
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
        resume();
      },
    },
  ]);
}

// Resume after a recoverable interruption (nag / auth): reconnect to the
// attached session, or re-open the lobby if we weren't attached.
function resume() {
  if (currentSession) connect();
  else refreshAndRoute();
}

function showRestart(code) {
  setStatus('session ended', 'err');
  const cmd = currentCommand ? ' (<code>' + escapeHtml(currentCommand) + '</code>)' : '';
  showOverlay(
    'Session ended',
    'The program exited (code ' + code + '). Restart it with the same command' + cmd + '?',
    [
      {
        label: 'Restart',
        onClick: restartSession,
      },
    ]
  );
}

async function restartSession() {
  setOverlayError('');
  try {
    const r = await fetch('/api/sessions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ id: currentSession, command: currentCommand }),
    });
    if (r.status === 401) return showAuthError();
    const txt = await r.text();
    if (!isOurs(txt)) return nagDetected();
    const msg = JSON.parse(txt);
    if (msg.ok || msg.error === 'exists') {
      // Created, or someone already recreated this id — either way attach.
      term.reset();
      hideOverlay();
      manualStop = false;
      connect();
      return;
    }
    setOverlayError(createErrorText(msg.error));
  } catch (e) {
    setOverlayError('Network error; try again.');
  }
}

function setOverlayError(text) {
  // Append/replace a small error line inside the overlay body.
  let line = els.overlayBody.querySelector('.err-text');
  if (!text) {
    if (line) line.remove();
    return;
  }
  if (!line) {
    line = document.createElement('p');
    line.className = 'err-text';
    els.overlayBody.appendChild(line);
  }
  line.textContent = text;
}

// ---------------------------------------------------------------- lobby
function showLobby() {
  manualStop = true;
  connected = false;
  connecting = false;
  clearReconnect();
  currentSession = null;
  currentCommand = '';
  setStatus('');
  hideOverlay();
  setDocTitle('');
  els.lobby.classList.remove('hidden');
  els.createCommand.focus();
}

function hideLobby() {
  els.lobby.classList.add('hidden');
}

async function loadSessions() {
  let r;
  try {
    r = await fetch('/api/sessions', { headers: authHeaders(), cache: 'no-store' });
  } catch (e) {
    return null; // network error; caller retries
  }
  if (r.status === 401) {
    showAuthError();
    return null;
  }
  const txt = await safeText(r);
  if (!isOurs(txt)) {
    nagDetected();
    return null;
  }
  try {
    return JSON.parse(txt);
  } catch (e) {
    return null;
  }
}

// Fetch the session list and either attach (if the URL names a live session) or
// show the lobby. The single entry point for (re)entering the lobby flow.
async function refreshAndRoute() {
  const data = await loadSessions();
  if (!data) {
    if (els.overlay.classList.contains('hidden')) {
      // Pure network error (no nag/auth overlay shown): retry shortly.
      setStatus('reconnecting…', 'warn');
      setTimeout(refreshAndRoute, 1500);
    }
    return;
  }
  renderSessions(data.sessions || [], data.max || 0);
  const want = urlSession();
  if (want && (data.sessions || []).some((s) => s.id === want)) {
    attach(want);
  } else {
    if (want) history.replaceState({}, '', location.pathname);
    showLobby();
  }
}

function renderSessions(sessions, max) {
  knownIds = new Set(sessions.map((s) => s.id));
  els.lobbyList.innerHTML = '';
  els.lobbyEmpty.classList.toggle('hidden', sessions.length > 0);
  for (const s of sessions) els.lobbyList.appendChild(sessionRow(s));

  const atCapacity = max && sessions.length >= max;
  els.createBtn.disabled = !!atCapacity;
  if (atCapacity) {
    setCreateError('At capacity (' + max + ' sessions). Kill one to create another.');
  } else {
    setCreateError('');
  }
  updateIdPreview();
}

function sessionRow(s) {
  const li = document.createElement('li');
  li.className = 'session-row';

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.title = 'Attach to ' + s.id;

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = s.id;
  if (s.title && s.title !== s.id) {
    const t = document.createElement('span');
    t.className = 'title';
    t.textContent = ' — ' + s.title;
    name.appendChild(t);
  }

  const sub = document.createElement('div');
  sub.className = 'sub';
  const viewers = s.viewers ? '  ·  ' + s.viewers + ' viewer' + (s.viewers === 1 ? '' : 's') : '';
  sub.textContent = (s.command || '') + viewers;

  meta.appendChild(name);
  meta.appendChild(sub);
  meta.addEventListener('click', () => attach(s.id));

  const kill = document.createElement('button');
  kill.className = 'secondary';
  kill.textContent = 'Kill';
  let armed = false;
  let armTimer = null;
  kill.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      kill.textContent = 'Confirm';
      kill.className = 'danger';
      armTimer = setTimeout(() => {
        armed = false;
        kill.textContent = 'Kill';
        kill.className = 'secondary';
      }, 3000);
      return;
    }
    if (armTimer) clearTimeout(armTimer);
    kill.disabled = true;
    killSession(s.id);
  });

  li.appendChild(meta);
  li.appendChild(kill);
  return li;
}

async function killSession(id) {
  try {
    const r = await fetch('/api/sessions/close', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ id }),
    });
    if (r.status === 401) return showAuthError();
    const txt = await r.text();
    if (!isOurs(txt)) return nagDetected();
  } catch (e) {
    /* ignore; refresh below reflects reality */
  }
  refreshLobby();
}

// Refresh just the lobby list (we are already in the lobby).
async function refreshLobby() {
  const data = await loadSessions();
  if (!data) return;
  renderSessions(data.sessions || [], data.max || 0);
}

function createErrorText(error) {
  switch (error) {
    case 'too-many':
      return 'Server is at capacity. Kill a session and try again.';
    case 'exists':
      return 'That session id is already in use.';
    case 'bad-id':
      return 'Invalid session id (use letters, digits, _ . - ; up to 64).';
    default:
      return 'Could not create the session.';
  }
}

function setCreateError(text) {
  els.createError.textContent = text || '';
  els.createError.classList.toggle('hidden', !text);
}

// Mirror the server's id derivation for the Advanced field placeholder.
function deriveIdPreview(command) {
  const cmd = (command || '').trim();
  if (!cmd) return '';
  const first = cmd.split(/\s+/)[0] || '';
  let base = baseName(first).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60);
  if (!base) return '';
  if (!knownIds.has(base)) return base;
  for (let n = 2; ; n++) {
    const cand = base + '-' + n;
    if (!knownIds.has(cand)) return cand;
  }
}

function baseName(p) {
  const trimmed = p.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

function updateIdPreview() {
  const preview = deriveIdPreview(els.createCommand.value);
  els.createId.placeholder = preview || '(auto)';
}

async function createSession(command, idOverride) {
  setCreateError('');
  els.createBtn.disabled = true;
  const body = { command };
  if (idOverride) body.id = idOverride;
  let r;
  try {
    r = await fetch('/api/sessions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify(body),
    });
  } catch (e) {
    els.createBtn.disabled = false;
    setCreateError('Network error; try again.');
    return;
  }
  if (r.status === 401) return showAuthError();
  const txt = await safeText(r);
  if (!isOurs(txt)) return nagDetected();
  let msg;
  try {
    msg = JSON.parse(txt);
  } catch (e) {
    els.createBtn.disabled = false;
    setCreateError('Unexpected server response.');
    return;
  }
  if (!msg.ok) {
    els.createBtn.disabled = false;
    setCreateError(createErrorText(msg.error));
    refreshLobby();
    return;
  }
  els.createBtn.disabled = false;
  els.createCommand.value = '';
  els.createId.value = '';
  attach(msg.session.id);
}

els.lobbyCreate.addEventListener('submit', (e) => {
  e.preventDefault();
  const command = els.createCommand.value;
  const idOverride = els.createId.value.trim();
  if (idOverride && !ID_RE.test(idOverride)) {
    setCreateError('Invalid session id (use letters, digits, _ . - ; up to 64).');
    return;
  }
  createSession(command, idOverride);
});
els.createCommand.addEventListener('input', updateIdPreview);

// ---------------------------------------------------------------- attach / output stream
function attach(id) {
  currentSession = id;
  manualStop = false;
  history.replaceState({}, '', '?session=' + encodeURIComponent(id));
  hideLobby();
  hideOverlay();
  setDocTitle('');
  fitAddon.fit();
  term.focus();
  connect();
}

// Drop the current session and return to the lobby (e.g. it was killed/exited
// out from under us, so the stream 404s).
function backToLobby() {
  manualStop = true;
  if (abort) abort.abort();
  connected = false;
  connecting = false;
  clearReconnect();
  currentSession = null;
  currentCommand = '';
  history.replaceState({}, '', location.pathname);
  refreshAndRoute();
}

async function connect() {
  if (!currentSession) return;
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
  if (resp.status === 404) {
    // Session no longer exists (exited or killed). Back to the lobby.
    connecting = false;
    return backToLobby();
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
      currentCommand = typeof msg.command === 'string' ? msg.command : currentCommand;
      setDocTitle(msg.title || '');
      // Fresh view of an existing session: clear and let the snapshot repaint.
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
      showRestart(msg.code);
      break;
    default:
      break;
  }
}

function scheduleReconnect() {
  if (manualStop || connected || connecting || !currentSession) return;
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
  if (!currentSession) return;
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
  if (manualStop || !currentSession) return;
  try {
    const r = await fetch(api('/api/input'), {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      keepalive: false,
      body: JSON.stringify({ d: strToB64(payload) }),
    });
    if (r.status === 401) return showAuthError();
    if (r.status === 404) return; // session gone; the stream loop handles the return-to-lobby
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
  if (!currentSession) return;
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
    if (r.status === 404) return;
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
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
refreshAndRoute();
