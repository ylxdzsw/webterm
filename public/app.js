'use strict';

// Browser side of the web terminal.
//
// Each page is bound to exactly one shell — the single session owned by the
// server process behind this URL. There is no lobby and no session id: the
// server runs one program, and this page is a disposable view of it.
//
//   Output: one long-lived streaming fetch (GET api/stream) read incrementally.
//   Input:  coalesced POST api/input requests (raw UTF-8 body, keep-alive, ordered).
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
// The corporate proxy intercepts outbound API calls and may replace the
// response with an HTML "acknowledge" page or redirect to another origin until
// the user clicks through. Detection is entirely on the client: every
// legitimate reply begins with MAGIC_PREFIX; if the response is anything else,
// we stop and ask the user to refresh.

const MAGIC_PREFIX = '{"m":"WT1"';
const INPUT_FLUSH_MS = 8;
// Keystrokes: flush after INPUT_FLUSH_MS idle, or at least every INPUT_BURST_MAX_MS
// during continuous typing (whichever comes first).
const INPUT_BURST_MAX_MS = 33;
// Motion-only SGR reports: leading-edge flush at this interval during drag/hover.
const MOUSE_MOTION_FLUSH_MS = 33;
const RESIZE_DEBOUNCE_MS = 150;
const MAX_RECONNECT_ATTEMPTS = 4;
const NOTIFICATION_COOLDOWN_MS = 5000;

// SGR mouse: ESC [ < Pb ; Px ; Py M|m  (1006/1016). Pb has bit 5 set on MOVE.
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

const els = {
  terminal: document.getElementById('terminal'),
  status: document.getElementById('status'),
  overlay: document.getElementById('overlay'),
  overlayTitle: document.getElementById('overlay-title'),
  overlayBody: document.getElementById('overlay-body'),
  overlayActions: document.getElementById('overlay-actions'),
  overlayDismiss: document.getElementById('overlay-dismiss'),
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

// ---------------------------------------------------------------- desktop notifications
let lastNotificationAt = 0;
let notificationPermissionRequest = null;
let notificationPromptAttempted = false;

function notificationsSupported() {
  return typeof window.Notification === 'function';
}

function pageInactiveForNotification() {
  return document.hidden || !document.hasFocus();
}

async function notificationPermission() {
  if (!notificationsSupported()) return 'denied';
  if (window.Notification.permission !== 'default') return window.Notification.permission;
  if (notificationPromptAttempted) return 'default';
  if (typeof window.Notification.requestPermission !== 'function') return 'denied';
  notificationPromptAttempted = true;
  if (!notificationPermissionRequest) {
    notificationPermissionRequest = window.Notification.requestPermission()
      .catch(() => 'denied')
      .finally(() => {
        notificationPermissionRequest = null;
      });
  }
  return notificationPermissionRequest;
}

async function triggerTerminalNotification(body) {
  if (!pageInactiveForNotification()) return false;

  const now = Date.now();
  if (now - lastNotificationAt < NOTIFICATION_COOLDOWN_MS) return false;
  lastNotificationAt = now;

  const permission = await notificationPermission();
  if (permission !== 'granted') return false;

  try {
    const text = String(body || '').trim() || 'Terminal needs attention';
    new window.Notification('Webterm', {
      body: text,
      icon: 'favicon.svg',
      tag: 'webterm-terminal-alert',
    });
    return true;
  } catch (e) {
    return false;
  }
}

function handleOsc9(data) {
  const text = String(data || '').trim();
  if (!text) return false;

  // OSC 9 has several terminal-specific subcommands. Treat bare payloads as
  // notifications, but ignore common non-notification forms like cwd/progress.
  const subcommand = /^(\d+);/.exec(text);
  if (subcommand && (subcommand[1] === '4' || subcommand[1] === '9')) return false;

  triggerTerminalNotification(subcommand ? text.slice(subcommand[0].length) : text);
  return false;
}

term.onBell(() => {
  triggerTerminalNotification('Terminal needs attention');
});

if (term.parser && typeof term.parser.registerOscHandler === 'function') {
  term.parser.registerOscHandler(9, handleOsc9);
}

// Ctrl+C copies when text is selected, then clears selection; a second Ctrl+C
// sends SIGINT. Ctrl+V uses the browser paste event (bracketed paste, etc.).
// Cmd+C on macOS is handled by xterm's native copy listener.
function copyTerminalSelection() {
  if (!term.hasSelection()) return false;
  const textarea = term.element.querySelector('.xterm-helper-textarea');
  if (!textarea) return false;
  const saved = textarea.value;
  textarea.value = term.getSelection();
  textarea.select();
  document.execCommand('copy');
  textarea.value = saved;
  term.clearSelection();
  return true;
}

term.attachCustomKeyEventHandler((ev) => {
  if (ev.type !== 'keydown') return true;

  const ctrlOnly = ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey;
  const enterOnly = ev.key === 'Enter' && !ev.ctrlKey && !ev.metaKey && !ev.altKey;

  if (ctrlOnly && ev.code === 'KeyC' && copyTerminalSelection()) {
    ev.preventDefault();
    return false;
  }

  if (ctrlOnly && ev.code === 'KeyV') {
    return false;
  }

  if (enterOnly && !ev.shiftKey) {
    ev.preventDefault();
    queueImmediateInput('\r');
    return false;
  }

  if (enterOnly && ev.shiftKey) {
    ev.preventDefault();
    queueImmediateInput('\x1b[13;2u');
    return false;
  }

  return true;
});

// ---------------------------------------------------------------- status / overlay
let statusHideTimer = null;

function setStatus(text, kind) {
  if (statusHideTimer) {
    clearTimeout(statusHideTimer);
    statusHideTimer = null;
  }
  if (!text) {
    if (sessionEnded) return;
    els.status.classList.add('hidden');
    return;
  }
  els.status.textContent = text;
  els.status.className = 'status ' + (kind || '');
  els.status.classList.remove('hidden');
}

let overlayKind = null; // null | 'session-ended' | ...

function textParagraph(text) {
  const p = document.createElement('p');
  p.textContent = text;
  return p;
}

function normalizeBodyNodes(body) {
  const parts = Array.isArray(body) ? body : [body];
  return parts.map((part) => {
    if (part instanceof Node) return part;
    return textParagraph(String(part || ''));
  });
}

function showOverlay(title, body, actions, kind) {
  overlayKind = kind || null;
  els.overlayTitle.textContent = title;
  els.overlayBody.replaceChildren(...normalizeBodyNodes(body));
  els.overlayActions.replaceChildren();
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
  if (overlayKind === 'session-ended') {
    els.overlayDismiss.classList.remove('hidden');
  } else {
    els.overlayDismiss.classList.add('hidden');
  }
  els.overlay.classList.remove('hidden');
}
function hideOverlay() {
  els.overlay.classList.add('hidden');
  els.overlayDismiss.classList.add('hidden');
  overlayKind = null;
}

function dismissSessionEndedOverlay() {
  if (overlayKind !== 'session-ended') return;
  hideOverlay();
  setStatus('session ended — reload for a new shell', 'err');
}

function setDocTitle(title) {
  document.title = title || 'Webterm';
}

// ---------------------------------------------------------------- connection state
let abort = null; // AbortController for the active stream
let connected = false; // stream is open and reading
let connecting = false; // a connect() attempt is in flight (guards against overlap)
let manualStop = false; // suppress auto-reconnect (refresh prompt / exit)
let sessionEnded = false; // PTY exited; terminal is read-only until reload
let reconnectDelay = 1000;
let reconnectTimer = null;
let reconnectAttempts = 0;

function isOurs(text) {
  return typeof text === 'string' && text.startsWith(MAGIC_PREFIX);
}

function isRedirectHijack(resp) {
  if (!resp) return false;
  if (resp.type === 'opaqueredirect') return true;
  return resp.status >= 300 && resp.status < 400;
}

function hasJsonContentType(resp) {
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  return ct.includes('application/json');
}

function hasStreamContentType(resp) {
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  return ct.includes('application/x-ndjson');
}

function stopAndShowRefresh(title, bodyContent, statusText) {
  manualStop = true;
  connected = false;
  connecting = false;
  clearReconnect();
  if (abort) abort.abort();
  setStatus(statusText || 'refresh required', 'warn');
  showOverlay(title, bodyContent, [
    {
      label: 'Refresh',
      onClick: () => location.reload(),
    },
  ]);
}

// The proxy can replace API responses with a reminder page or redirect them to
// another origin. Either way the browser received a reply, but not our
// protocol, so the only reliable recovery is a full refresh.
async function checkClientResponse(resp, opts) {
  const silent = opts && opts.silent;
  if (isRedirectHijack(resp)) {
    if (!silent) unexpectedResponseDetected();
    return false;
  }
  if (!hasJsonContentType(resp)) {
    if (!silent) unexpectedResponseDetected();
    return false;
  }
  const text = await safeText(resp);
  if (!isOurs(text)) {
    if (!silent) unexpectedResponseDetected();
    return false;
  }
  let msg;
  try {
    msg = JSON.parse(text);
  } catch (e) {
    if (!silent) unexpectedResponseDetected();
    return false;
  }
  if (!msg || msg.m !== 'WT1') {
    if (!silent) unexpectedResponseDetected();
    return false;
  }
  if (resp.status === 401) {
    if (!silent) showAuthError();
    return false;
  }
  return { status: resp.status, msg };
}

function unexpectedResponseDetected() {
  stopAndShowRefresh(
    'Refresh required',
    [
      'The network returned an unexpected response for this terminal. Refresh this page.',
      'If your network shows an acknowledgement page, complete it and then return here.',
    ],
    'refresh required'
  );
}

function connectionLostDetected() {
  stopAndShowRefresh(
    'Connection lost',
    "We couldn't reconnect to this terminal after several attempts. Refresh this page to try again.",
    'connection lost'
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
  if (statusHideTimer) {
    clearTimeout(statusHideTimer);
    statusHideTimer = null;
  }
  els.status.classList.add('hidden');
  showOverlay(
    'Session ended',
    'The program exited (code ' +
      code +
      '). Reload to start a fresh shell. You can dismiss this to scroll and copy the output.',
    [
      {
        label: 'Reload',
        onClick: () => location.reload(),
      },
    ],
    'session-ended'
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
      redirect: 'manual',
    });
  } catch (e) {
    connecting = false;
    return scheduleReconnect();
  }

  if (isRedirectHijack(resp)) {
    connecting = false;
    return unexpectedResponseDetected();
  }
  if (resp.status === 401) {
    connecting = false;
    const txt = await safeText(resp);
    if (!isOurs(txt)) return unexpectedResponseDetected();
    return showAuthError();
  }
  if (!hasStreamContentType(resp)) {
    connecting = false;
    return unexpectedResponseDetected();
  }
  if (!resp.ok || !resp.body) {
    // Non-OK or empty body: the replacement page is usually HTML, not our stream.
    connecting = false;
    const txt = await safeText(resp);
    if (!isOurs(txt)) return unexpectedResponseDetected();
    return scheduleReconnect();
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let gotMagic = false;
  connected = true;
  connecting = false;
  reconnectAttempts = 0;
  reconnectDelay = 1000;
  setStatus('connected', 'ok');
  statusHideTimer = setTimeout(() => {
    statusHideTimer = null;
    setStatus('');
  }, 1200);
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
            return unexpectedResponseDetected();
          }
          continue;
        }
        if (!buf.startsWith(MAGIC_PREFIX)) {
          connected = false;
          return unexpectedResponseDetected();
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
      sessionEnded = true;
      term.options.disableStdin = true;
      term.options.cursorBlink = false;
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
  reconnectAttempts += 1;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    return connectionLostDetected();
  }
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
// Input is sent as short POSTs, but coalesced *self-clocked* to the network.
// We keep at most one request in flight, and normal terminal data typed while
// it is in flight accumulates into ordered queue segments. Boundary inputs
// such as physical Enter are their own segment, which prevents text+Enter from
// looking like one paste-like burst to programs running in the PTY. Keeping
// exactly one request in flight also preserves keystroke ordering without input
// sequence numbers, even if the proxy/connection pool would otherwise reorder
// concurrent requests.
let inputSegments = [];
let inputMotionTimer = null;
let inputIdleTimer = null;
let inputBurstTimer = null;
let inputInFlight = false;

function clearInputTimers() {
  if (inputMotionTimer != null) {
    clearTimeout(inputMotionTimer);
    inputMotionTimer = null;
  }
  if (inputIdleTimer != null) {
    clearTimeout(inputIdleTimer);
    inputIdleTimer = null;
  }
  if (inputBurstTimer != null) {
    clearTimeout(inputBurstTimer);
    inputBurstTimer = null;
  }
}

term.onData((data) => {
  queueNormalInput(data);
});

function queueNormalInput(data) {
  if (!data) return;
  const last = inputSegments[inputSegments.length - 1];
  if (last && !last.immediate) {
    last.data = compactMouseMotion(last.data + data);
  } else {
    inputSegments.push({ data: compactMouseMotion(data), immediate: false });
  }
  scheduleFlush();
}

function queueImmediateInput(data) {
  if (!data) return;
  inputSegments.push({ data, immediate: true });
  flushInput();
}

function isSgrMotion(seq) {
  const m = SGR_MOUSE_RE.exec(seq);
  if (!m) return false;
  return (parseInt(m[1], 10) & 32) !== 0 && m[4] === 'M';
}

function isMotionOnlyPending() {
  return (
    inputSegments.length === 1 &&
    !inputSegments[0].immediate &&
    inputSegments[0].data.length > 0 &&
    isSgrMotion(inputSegments[0].data)
  );
}

function hasPendingInput() {
  return inputSegments.some((segment) => segment.data.length > 0);
}

function isImmediatePending() {
  return inputSegments.length > 0 && inputSegments[0].immediate;
}

// Drop redundant intermediate positions from a run of SGR motion reports.
// Clicks, releases, and wheel events are left intact.
function compactMouseMotion(buf) {
  if (buf.indexOf('\x1b[<') < 0) return buf;
  let out = '';
  let i = 0;
  while (i < buf.length) {
    const start = buf.indexOf('\x1b[<', i);
    if (start < 0) {
      out += buf.slice(i);
      break;
    }
    out += buf.slice(i, start);
    const rest = buf.slice(start);
    const m = SGR_MOUSE_RE.exec(rest);
    if (!m) {
      out += buf[start];
      i = start + 1;
      continue;
    }
    const seq = m[0];
    if (!isSgrMotion(seq)) {
      out += seq;
      i = start + seq.length;
      continue;
    }
    const pb = m[1];
    let last = seq;
    let j = start + seq.length;
    while (j < buf.length) {
      const nm = SGR_MOUSE_RE.exec(buf.slice(j));
      if (!nm || nm[1] !== pb || !isSgrMotion(nm[0])) break;
      last = nm[0];
      j += nm[0].length;
    }
    out += last;
    i = j;
  }
  return out;
}

function scheduleFlush() {
  // While a POST is in flight, just accumulate; the in-flight request's
  // completion handler will drain whatever piled up in ordered follow-up
  // segments.
  if (inputInFlight) return;
  if (!hasPendingInput()) return;
  if (isImmediatePending()) {
    clearInputTimers();
    flushInput();
    return;
  }
  if (isMotionOnlyPending()) {
    if (inputIdleTimer != null || inputBurstTimer != null) {
      if (inputIdleTimer != null) {
        clearTimeout(inputIdleTimer);
        inputIdleTimer = null;
      }
      if (inputBurstTimer != null) {
        clearTimeout(inputBurstTimer);
        inputBurstTimer = null;
      }
    }
    if (inputMotionTimer != null) return;
    inputMotionTimer = setTimeout(flushInput, MOUSE_MOTION_FLUSH_MS);
    return;
  }
  if (inputMotionTimer != null) {
    clearTimeout(inputMotionTimer);
    inputMotionTimer = null;
  }
  // Hybrid: 8ms idle (trailing) or 33ms from first key in burst (leading cap).
  if (inputBurstTimer == null) {
    inputBurstTimer = setTimeout(flushInput, INPUT_BURST_MAX_MS);
  }
  if (inputIdleTimer != null) clearTimeout(inputIdleTimer);
  inputIdleTimer = setTimeout(flushInput, INPUT_FLUSH_MS);
}

function flushInput() {
  clearInputTimers();
  if (inputInFlight || !hasPendingInput()) return;
  const segment = inputSegments.shift();
  const payload = segment.immediate ? segment.data : compactMouseMotion(segment.data);
  if (!payload) {
    if (hasPendingInput()) scheduleFlush();
    return;
  }
  inputInFlight = true;
  sendInput(payload).finally(() => {
    inputInFlight = false;
    // Anything typed during the round-trip is now coalesced into ordered
    // follow-up segments.
    if (hasPendingInput()) {
      if (isImmediatePending()) flushInput();
      else scheduleFlush();
    }
  });
}

async function sendInput(payload) {
  if (manualStop) return;
  try {
    const r = await fetch('api/input', {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/octet-stream; charset=utf-8' },
        authHeaders()
      ),
      keepalive: false,
      body: new TextEncoder().encode(payload),
      redirect: 'manual',
    });
    await checkClientResponse(r);
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
      redirect: 'manual',
    });
    await checkClientResponse(r, { silent });
  } catch (e) {
    /* ignore; stream reconnect handles recovery */
  }
}

window.addEventListener('resize', scheduleResize);

// ---------------------------------------------------------------- base64 (UTF-8 safe, output stream only)
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

// ---------------------------------------------------------------- session-ended dismiss
els.overlayDismiss.addEventListener('click', dismissSessionEndedOverlay);

els.overlay.addEventListener('click', (ev) => {
  if (ev.target === els.overlay) dismissSessionEndedOverlay();
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && overlayKind === 'session-ended') {
    ev.preventDefault();
    dismissSessionEndedOverlay();
  }
});

// ---------------------------------------------------------------- go
getToken();
term.focus();
connect();
