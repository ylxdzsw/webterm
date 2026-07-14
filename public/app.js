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
// program runs the server keeps it alive and reconnects replay the snapshot.
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
const TOUCH_SCROLL_START_PX = 10;
const TOUCH_SCROLL_SPEED = 6;
const TOUCH_WHEEL_EVENTS_PER_FRAME = 24;
const TOUCH_MOMENTUM_MIN_VELOCITY = 0.08;
const TOUCH_MOMENTUM_STOP_VELOCITY = 0.08;
const TOUCH_MOMENTUM_DECAY_PER_FRAME = 0.95;
const TOUCH_MOMENTUM_MAX_MS = 900;
const TOUCH_DOUBLE_TAP_TIMEOUT_MS = 300;
const TOUCH_DOUBLE_TAP_SLOP_PX = 40;
const DESKTOP_TERMINAL_FONT_SIZE = 14;
const PHONE_TERMINAL_FONT_SIZE = 12;
const PHONE_TERMINAL_MAX_WIDTH = 700;

// SGR mouse: ESC [ < Pb ; Px ; Py M|m  (1006/1016). Pb has bit 5 set on MOVE.
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

const els = {
  terminal: document.getElementById('terminal'),
  terminalFit: document.getElementById('terminal-fit'),
  mobileKeys: document.getElementById('mobile-keys'),
  status: document.getElementById('status'),
  overlay: document.getElementById('overlay'),
  overlayTitle: document.getElementById('overlay-title'),
  overlayBody: document.getElementById('overlay-body'),
  overlayActions: document.getElementById('overlay-actions'),
  overlayDismiss: document.getElementById('overlay-dismiss'),
};

// ---------------------------------------------------------------- terminal
const term = new Terminal({
  cursorBlink: true,
  allowProposedApi: true,
  scrollback: 5000,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: terminalFontSize(),
  theme: { background: '#0b0e14', foreground: '#c9d1d9' },
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);

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
  } catch {
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

term.parser?.registerOscHandler?.(9, handleOsc9);

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
  clearTimeout(statusHideTimer);
  statusHideTimer = null;
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
let hasReceivedHello = false;
let scrollAnchor = null; // preserved across reconnect snapshot replay

function isOurs(text) {
  return typeof text === 'string' && text.startsWith(MAGIC_PREFIX);
}

function isRedirectHijack(resp) {
  return resp?.type === 'opaqueredirect' || (resp?.status >= 300 && resp.status < 400);
}

function hasContentType(resp, expected) {
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  return ct.includes(expected);
}

function hasJsonContentType(resp) {
  return hasContentType(resp, 'application/json');
}

function hasStreamContentType(resp) {
  return hasContentType(resp, 'application/x-ndjson');
}

function stopAndShowRefresh(title, bodyContent, statusText) {
  manualStop = true;
  connected = false;
  connecting = false;
  clearReconnect();
  abort?.abort();
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
async function checkClientResponse(resp, { silent = false } = {}) {
  const invalidResponse = () => {
    if (!silent) unexpectedResponseDetected();
    return false;
  };

  if (isRedirectHijack(resp)) return invalidResponse();
  if (!hasJsonContentType(resp)) return invalidResponse();
  const text = await safeText(resp);
  if (!isOurs(text)) return invalidResponse();
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return invalidResponse();
  }
  if (!msg || msg.m !== 'WT1') return invalidResponse();
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

// The program exited: the server process is gone. Reloading the page spawns a
// fresh shell (under socket activation) or reconnects once the unit is back.
function showReload(code) {
  clearTimeout(statusHideTimer);
  statusHideTimer = null;
  els.status.classList.add('hidden');
  showOverlay(
    'Session ended',
    `The program exited (code ${code}). Reload to start a fresh shell. You can dismiss this to scroll and copy the output.`,
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

  abort?.abort();

  abort = new AbortController();
  const myAbort = abort;
  const streamSize = terminalSize();
  let resp;
  try {
    resp = await fetch(initialStreamUrl(streamSize), {
      signal: myAbort.signal,
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    connecting = false;
    return scheduleReconnect();
  }

  if (isRedirectHijack(resp)) {
    connecting = false;
    return unexpectedResponseDetected();
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
  if (term.cols !== streamSize.cols || term.rows !== streamSize.rows) {
    sendResize(true);
  }

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
  } catch {
    /* network error / aborted */
  }

  connected = false;
  if (!manualStop) scheduleReconnect();
}

function terminalSize() {
  return { cols: term.cols, rows: term.rows };
}

function initialStreamUrl(size) {
  const params = new URLSearchParams({
    cols: String(size.cols),
    rows: String(size.rows),
  });
  return 'api/stream?' + params.toString();
}

function handleFrame(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore unparseable noise
  }
  if (!msg || msg.m !== 'WT1') return;

  switch (msg.t) {
    case 'hello':
      setDocTitle(msg.title || '');
      // Fresh view of the session: clear and let the snapshot repaint.
      if (hasReceivedHello) {
        scrollAnchor = captureScrollAnchor();
      }
      term.reset();
      hasReceivedHello = true;
      break;
    case 'o': {
      const data = b64ToStr(msg.d);
      if (msg.snapshot) {
        term.write(data, () => {
          if (scrollAnchor) {
            restoreScrollAnchor(scrollAnchor);
            scrollAnchor = null;
          } else {
            term.scrollToBottom();
          }
        });
      } else {
        term.write(data);
      }
      break;
    }
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
      abort?.abort();
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
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

// Remember how far the viewport was from the live bottom so reconnect replay
// can restore scroll position instead of jumping to the top of scrollback.
function captureScrollAnchor() {
  const b = term.buffer.active;
  return { offsetFromBase: b.baseY - b.viewportY };
}

function restoreScrollAnchor(anchor) {
  if (!anchor) return;
  const b = term.buffer.active;
  const line = Math.max(0, b.baseY - anchor.offsetFromBase);
  term.scrollToLine(line);
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
  clearTimeout(inputMotionTimer);
  clearTimeout(inputIdleTimer);
  clearTimeout(inputBurstTimer);
  inputMotionTimer = inputIdleTimer = inputBurstTimer = null;
}

term.onData((data) => {
  queueNormalInput(data);
});

const VIRTUAL_KEY_INPUT = Object.freeze({
  tab: '\t',
  esc: '\x1b',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  left: '\x1b[D',
  down: '\x1b[B',
  up: '\x1b[A',
  right: '\x1b[C',
  'page-up': '\x1b[5~',
  'page-down': '\x1b[6~',
  home: '\x1b[H',
  end: '\x1b[F',
});

// Keep taps on virtual keys from moving focus (and thus toggling the soft
// keyboard). The click still fires; only the focus change is suppressed.
els.mobileKeys.addEventListener('pointerdown', (ev) => {
  const button = ev.target.closest('button');
  if (button && !button.hasAttribute('data-keyboard')) ev.preventDefault();
});

els.mobileKeys.addEventListener('click', async (ev) => {
  const button = ev.target.closest('button');
  if (!button || !els.mobileKeys.contains(button)) return;
  if (button.hasAttribute('data-keyboard')) {
    ev.preventDefault();
    term.focus();
    scrollPageToBottomForKeyboard();
    return;
  }
  if (button.hasAttribute('data-paste')) {
    ev.preventDefault();
    try {
      const text = await navigator.clipboard.readText();
      if (text) term.paste(text);
    } catch {
      setStatus('paste unavailable', 'warn');
      // Auto-dismiss this transient failure. setStatus clears statusHideTimer on
      // every call, so if any newer status supersedes it before this fires, the
      // timer is cancelled and we never clobber that newer message.
      statusHideTimer = setTimeout(() => {
        statusHideTimer = null;
        setStatus('');
      }, 2500);
    }
    return;
  }
  const data = VIRTUAL_KEY_INPUT[button.dataset.input];
  if (!data) return;
  ev.preventDefault();
  queueImmediateInput(data);
});

function queueNormalInput(data) {
  if (!data) return;
  const last = inputSegments.at(-1);
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

function scrollPageToBottomForKeyboard() {
  const scroll = () => {
    window.scrollTo({ left: 0, top: document.documentElement.scrollHeight, behavior: 'auto' });
  };
  scroll();
  requestAnimationFrame(scroll);
  // Correct once when the keyboard first changes the visual viewport. Further
  // delayed scrolls can pan iOS after the keyboard has visibly settled, which
  // changes terminal geometry and makes xterm redraw several times.
  const viewport = window.visualViewport;
  if (viewport) {
    viewport.addEventListener('resize', scroll, { once: true });
    window.setTimeout(() => viewport.removeEventListener('resize', scroll), 500);
  }
}

function isSgrMotion(seq) {
  const m = SGR_MOUSE_RE.exec(seq);
  if (!m) return false;
  return (Number.parseInt(m[1], 10) & 32) !== 0 && m[4] === 'M';
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
    clearTimeout(inputIdleTimer);
    clearTimeout(inputBurstTimer);
    inputIdleTimer = inputBurstTimer = null;
    if (inputMotionTimer != null) return;
    inputMotionTimer = setTimeout(flushInput, MOUSE_MOTION_FLUSH_MS);
    return;
  }
  clearTimeout(inputMotionTimer);
  inputMotionTimer = null;
  // Hybrid: 8ms idle (trailing) or 33ms from first key in burst (leading cap).
  if (inputBurstTimer == null) {
    inputBurstTimer = setTimeout(flushInput, INPUT_BURST_MAX_MS);
  }
  clearTimeout(inputIdleTimer);
  inputIdleTimer = setTimeout(flushInput, INPUT_FLUSH_MS);
}

function flushInput() {
  clearInputTimers();
  if (inputInFlight || !hasPendingInput()) return;
  const segment = inputSegments.shift();
  // Non-immediate segments are already compacted incrementally in
  // queueNormalInput as data is appended, so no re-compaction is needed here.
  const payload = segment.data;
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

async function postApi(path, body, contentType, silent = false) {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
      redirect: 'manual',
    });
    await checkClientResponse(response, { silent });
  } catch {
    /* the output stream's reconnect logic recovers network failures */
  }
}

function sendInput(payload) {
  if (manualStop) return Promise.resolve();
  return postApi('api/input', new TextEncoder().encode(payload), 'application/octet-stream; charset=utf-8');
}

// ---------------------------------------------------------------- resize
let resizeTimer = null;
function scheduleResize() {
  const nextFontSize = terminalFontSize();
  if (term.options.fontSize !== nextFontSize) term.options.fontSize = nextFontSize;
  fitAddon.fit();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => sendResize(false), RESIZE_DEBOUNCE_MS);
}

function sendResize(silent) {
  return postApi('api/resize', JSON.stringify(terminalSize()), 'application/json', silent);
}

window.addEventListener('resize', scheduleResize);
window.visualViewport?.addEventListener('resize', scheduleResize);

// On iOS Safari the soft keyboard can both shrink and pan the visual viewport.
// Fixed elements use layout-viewport coordinates, so move the terminal's top
// edge with the pan as well as lifting its bottom edge above the keyboard.
// This keeps a short terminal history, whose cursor is near row zero, visible.
function updateKeyboardInset() {
  const vv = window.visualViewport;
  if (!vv) return;
  const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--keyboard-inset', inset.toFixed(2) + 'px');
  rootStyle.setProperty('--visual-viewport-offset-top', vv.offsetTop.toFixed(2) + 'px');
  if (inset > 0) rootStyle.setProperty('--mobile-key-bottom-gap', '6px');
  else rootStyle.removeProperty('--mobile-key-bottom-gap');
}
window.visualViewport?.addEventListener('resize', updateKeyboardInset);
window.visualViewport?.addEventListener('scroll', updateKeyboardInset);
updateKeyboardInset();

function observeTerminalSize() {
  if (typeof ResizeObserver !== 'function') return;
  const observer = new ResizeObserver((entries) => {
    if (entries[0]?.contentRect.height > 0) scheduleResize();
  });
  observer.observe(els.terminalFit);
}

// ---------------------------------------------------------------- mobile touch scroll
// xterm already knows how to turn wheel input into local scrollback, SGR wheel
// reports, or alt-buffer arrow fallback. On touch devices we only bridge a
// vertical finger drag into that same path.
function initMobileTouchScroll() {
  if (!shouldEnableMobileTouchScroll()) return;
  if (typeof window.WheelEvent !== 'function') return;
  if (!term.element) return;

  let gesture = null;
  let momentumFrame = null;
  let lastTap = null;
  let tapFocusTimer = null;
  const opts = { passive: false, capture: true };

  term.element.addEventListener('touchstart', onTouchStart, opts);
  term.element.addEventListener('touchmove', onTouchMove, opts);
  term.element.addEventListener('touchend', onTouchEnd, opts);
  term.element.addEventListener('touchcancel', onTouchCancel, opts);

  function onTouchStart(ev) {
    stopMomentum();
    if (ev.touches.length !== 1) {
      gesture = null;
      lastTap = null;
      cancelPendingTapFocus();
      return;
    }
    const touch = ev.touches[0];
    const now = touchEventTime(ev);
    const doubleTapCandidate = isDoubleTapCandidate(touch, now);
    suppressTerminalTouch(ev);
    if (doubleTapCandidate) {
      cancelPendingTapFocus();
    }
    gesture = {
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastY: touch.clientY,
      startAt: now,
      lastAt: now,
      velocityY: 0,
      remainderY: 0,
      scrolling: false,
      doubleTapCandidate,
      point: touchWheelPoint(touch),
    };
  }

  function onTouchMove(ev) {
    if (!gesture) return;
    if (ev.touches.length !== 1) {
      gesture = null;
      lastTap = null;
      cancelPendingTapFocus();
      return;
    }

    const touch = ev.touches[0];
    const totalX = touch.clientX - gesture.startX;
    const totalY = touch.clientY - gesture.startY;
    gesture.lastX = touch.clientX;

    if (!gesture.scrolling) {
      if (Math.max(Math.abs(totalX), Math.abs(totalY)) < TOUCH_SCROLL_START_PX) return;
      if (Math.abs(totalY) <= Math.abs(totalX)) return;
      gesture.scrolling = true;
      lastTap = null;
      cancelPendingTapFocus();
    }

    if (ev.cancelable) ev.preventDefault();
    ev.stopPropagation();

    const deltaY = touch.clientY - gesture.lastY;
    gesture.lastY = touch.clientY;
    gesture.point = touchWheelPoint(touch);
    const now = touchEventTime(ev);
    const elapsed = Math.max(1, now - gesture.lastAt);
    gesture.lastAt = now;
    gesture.velocityY = gesture.velocityY * 0.35 + (deltaY / elapsed) * 0.65;
    if (!deltaY) return;

    emitTouchScroll(gesture, deltaY);
  }

  function onTouchEnd(ev) {
    if (gesture && !gesture.scrolling) suppressTerminalTouch(ev);
    if (gesture && gesture.scrolling && ev.cancelable) ev.preventDefault();
    if (ev.touches.length === 0) {
      if (gesture && gesture.scrolling) {
        startMomentum(gesture);
        lastTap = null;
      } else if (gesture && isTapGesture(gesture)) {
        const endedAt = touchEventTime(ev);
        if (gesture.doubleTapCandidate && isDoubleTapTiming(gesture.startAt)) {
          cancelPendingTapFocus();
          lastTap = null;
          queueImmediateInput(VIRTUAL_KEY_INPUT.tab);
        } else {
          lastTap = { at: endedAt, x: gesture.lastX, y: gesture.lastY };
          scheduleTapFocus();
        }
      } else {
        lastTap = null;
        cancelPendingTapFocus();
      }
      gesture = null;
    }
  }

  function onTouchCancel() {
    stopMomentum();
    gesture = null;
    lastTap = null;
    cancelPendingTapFocus();
  }

  function suppressTerminalTouch(ev) {
    if (els.mobileKeys && els.mobileKeys.contains(ev.target)) return;
    if (ev.cancelable) ev.preventDefault();
    ev.stopPropagation();
  }

  function isTapGesture(state) {
    return (
      !state.scrolling &&
      Math.max(Math.abs(state.lastX - state.startX), Math.abs(state.lastY - state.startY)) <=
        TOUCH_SCROLL_START_PX
    );
  }

  function isDoubleTapCandidate(touch, now) {
    if (!lastTap) return false;
    const elapsed = now - lastTap.at;
    if (elapsed < 0 || elapsed > TOUCH_DOUBLE_TAP_TIMEOUT_MS) return false;
    const dx = touch.clientX - lastTap.x;
    const dy = touch.clientY - lastTap.y;
    return dx * dx + dy * dy <= TOUCH_DOUBLE_TAP_SLOP_PX * TOUCH_DOUBLE_TAP_SLOP_PX;
  }

  function isDoubleTapTiming(now) {
    if (!lastTap) return false;
    const elapsed = now - lastTap.at;
    return elapsed >= 0 && elapsed <= TOUCH_DOUBLE_TAP_TIMEOUT_MS;
  }

  function scheduleTapFocus() {
    cancelPendingTapFocus();
    tapFocusTimer = window.setTimeout(() => {
      tapFocusTimer = null;
      lastTap = null;
      term.focus();
    }, TOUCH_DOUBLE_TAP_TIMEOUT_MS);
  }

  function cancelPendingTapFocus() {
    if (tapFocusTimer == null) return;
    window.clearTimeout(tapFocusTimer);
    tapFocusTimer = null;
  }

  function emitTouchScroll(state, deltaY) {
    state.remainderY += deltaY * TOUCH_SCROLL_SPEED;
    const linePx = touchScrollLinePx();
    const lines = Math.trunc(state.remainderY / linePx);
    if (!lines) return 0;

    const cappedLines = Math.sign(lines) * Math.min(Math.abs(lines), TOUCH_WHEEL_EVENTS_PER_FRAME);
    state.remainderY -= cappedLines * linePx;
    dispatchTouchWheel(state.point, -Math.sign(cappedLines), Math.abs(cappedLines));
    return Math.abs(cappedLines);
  }

  function startMomentum(source) {
    const elapsed = Math.max(1, source.lastAt - source.startAt);
    const totalVelocityY = (source.lastY - source.startY) / elapsed;
    const initialVelocity =
      Math.abs(source.velocityY) > Math.abs(totalVelocityY) ? source.velocityY : totalVelocityY;
    if (Math.abs(initialVelocity) < TOUCH_MOMENTUM_MIN_VELOCITY) return;

    const state = {
      point: source.point,
      remainderY: source.remainderY,
    };
    let velocityY = initialVelocity;
    let lastAt = performance.now();
    const startedAt = lastAt;

    function step(now) {
      if (Math.abs(velocityY) < TOUCH_MOMENTUM_STOP_VELOCITY) {
        velocityY = 0;
        momentumFrame = null;
        return;
      }

      const elapsed = Math.min(32, Math.max(1, now - lastAt));
      lastAt = now;
      emitTouchScroll(state, velocityY * elapsed);
      velocityY *= Math.pow(TOUCH_MOMENTUM_DECAY_PER_FRAME, elapsed / 16);

      if (now - startedAt < TOUCH_MOMENTUM_MAX_MS) {
        momentumFrame = requestAnimationFrame(step);
      } else {
        velocityY = 0;
        momentumFrame = null;
      }
    }

    momentumFrame = requestAnimationFrame(step);
  }

  function stopMomentum() {
    if (momentumFrame != null) {
      cancelAnimationFrame(momentumFrame);
      momentumFrame = null;
    }
  }
}

function shouldEnableMobileTouchScroll() {
  return Boolean(
    navigator.maxTouchPoints > 0 ||
      'ontouchstart' in window ||
      window.matchMedia?.('(pointer: coarse)')?.matches
  );
}

function terminalFontSize() {
  return window.matchMedia?.(`(max-width: ${PHONE_TERMINAL_MAX_WIDTH}px)`)?.matches
    ? PHONE_TERMINAL_FONT_SIZE
    : DESKTOP_TERMINAL_FONT_SIZE;
}

function touchScrollLinePx() {
  const heights = [];
  const viewport = term.element?.querySelector('.xterm-viewport');
  const scrollable = term.element?.querySelector('.xterm-scrollable-element');
  for (const el of [viewport, scrollable, term.element, els.terminalFit, els.terminal]) {
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.height > 0) heights.push(rect.height);
  }
  if (heights.length > 0 && term.rows > 0) {
    return Math.max(8, Math.min(...heights) / term.rows);
  }

  const fontSize = Number.parseFloat(term.options.fontSize);
  return Number.isFinite(fontSize) && fontSize > 0 ? Math.max(8, fontSize) : 16;
}

function terminalWheelTarget() {
  return term.element?.querySelector('.xterm-screen') || term.element;
}

function touchWheelPoint(touch) {
  return {
    clientX: touch.clientX,
    clientY: touch.clientY,
    screenX: touch.screenX,
    screenY: touch.screenY,
  };
}

function touchEventTime(ev) {
  return Number.isFinite(ev.timeStamp) && ev.timeStamp > 0 ? ev.timeStamp : performance.now();
}

function dispatchTouchWheel(touch, direction, repeat) {
  const target = terminalWheelTarget();
  if (!target) return;
  const deltaMode = window.WheelEvent.DOM_DELTA_LINE || 1;
  for (let i = 0; i < repeat; i++) {
    target.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: touch.clientX,
        clientY: touch.clientY,
        screenX: touch.screenX,
        screenY: touch.screenY,
        deltaX: 0,
        deltaY: direction,
        deltaMode,
      })
    );
  }
}

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
  } catch {
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
term.open(els.terminalFit);
fitAddon.fit();
observeTerminalSize();
initMobileTouchScroll();
term.focus();
connect();
