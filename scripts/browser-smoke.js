'use strict';

// Headless-Chrome smoke test for the frontend. Not part of the app; used to
// validate that the UI loads without errors, connects to the single shell,
// sends input, and renders live output. Run with the server up on
// 127.0.0.1:8080.

const puppeteer = require('puppeteer-core');

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:8080/';
const BASE = URL.replace(/\/$/, '');
const CHROME =
  process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(25);
  }
  return false;
}

(async () => {
  const errors = [];
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console.error: ' + m.text());
  });

  const inputReqs = [];
  const inputPayloads = [];
  let streamStatus = null;
  page.on('request', (r) => {
    if (!r.url().includes('/api/input')) return;
    if (typeof r.postDataBuffer === 'function') {
      const body = r.postDataBuffer();
      inputPayloads.push(body ? Buffer.from(body).toString('utf8') : '');
    } else {
      inputPayloads.push(r.postData() || '');
    }
  });
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('/api/input')) inputReqs.push(r.status());
    if (u.includes('/api/stream')) streamStatus = r.status();
  });

  await page.evaluateOnNewDocument(() => {
    window.__webtermNotifications = [];
    window.__webtermNotificationPermission = 'default';
    window.__webtermNotificationPermissionRequests = 0;

    function FakeNotification(title, opts = {}) {
      window.__webtermNotifications.push({
        title,
        body: opts.body,
        icon: opts.icon,
        tag: opts.tag,
      });
    }
    Object.defineProperty(FakeNotification, 'permission', {
      get() {
        return window.__webtermNotificationPermission;
      },
    });
    FakeNotification.requestPermission = () => {
      window.__webtermNotificationPermissionRequests += 1;
      window.__webtermNotificationPermission = 'granted';
      return Promise.resolve('granted');
    };
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: FakeNotification,
    });
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  // No lobby: the page attaches directly to the one shell. Wait for the stream
  // to open and the initial snapshot to paint.
  await page.waitForFunction(
    () => document.querySelector('.xterm-rows') != null,
    { timeout: 5000 }
  );
  await sleep(1500);

  const focusedNotification = await page.evaluate(async () => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get() {
        return false;
      },
    });
    document.hasFocus = () => true;
    await window.triggerTerminalNotification('focused alert');
    return {
      notifications: window.__webtermNotifications.length,
      permissionRequests: window.__webtermNotificationPermissionRequests,
    };
  });
  if (
    focusedNotification.notifications !== 0 ||
    focusedNotification.permissionRequests !== 0
  ) {
    errors.push(
      'focused notification should not prompt or notify: ' +
        JSON.stringify(focusedNotification)
    );
  }

  const backgroundNotification = await page.evaluate(async () => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get() {
        return true;
      },
    });
    document.hasFocus = () => false;
    window.handleOsc9('Codex finished');
    await new Promise((resolve) => setTimeout(resolve, 25));
    await window.triggerTerminalNotification('Codex finished again');
    return {
      notifications: window.__webtermNotifications.slice(),
      permissionRequests: window.__webtermNotificationPermissionRequests,
    };
  });
  if (
    backgroundNotification.permissionRequests !== 1 ||
    backgroundNotification.notifications.length !== 1 ||
    backgroundNotification.notifications[0].title !== 'Webterm' ||
    backgroundNotification.notifications[0].body !== 'Codex finished'
  ) {
    errors.push(
      'background notification did not request once and notify once: ' +
        JSON.stringify(backgroundNotification)
    );
  }

  const inputStart = inputPayloads.length;
  await page.evaluate(() => {
    window.queueNormalInput('abc');
  });
  await page.keyboard.press('Enter');
  const gotEnterBoundary = await waitFor(() => {
    const seen = inputPayloads.slice(inputStart);
    const i = seen.indexOf('abc');
    return i >= 0 && seen[i + 1] === '\r';
  });
  if (!gotEnterBoundary) {
    errors.push(
      'typing abc then Enter did not produce separate ordered payloads: ' +
        JSON.stringify(inputPayloads.slice(inputStart))
    );
  }
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyC');
  await page.keyboard.up('Control');
  await sleep(200);

  const shiftEnterStart = inputPayloads.length;
  await page.keyboard.down('Shift');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Shift');
  const gotShiftEnter = await waitFor(() =>
    inputPayloads.slice(shiftEnterStart).includes('\x1b[13;2u')
  );
  if (!gotShiftEnter) {
    errors.push(
      'Shift+Enter did not produce CSI-u payload: ' +
        JSON.stringify(inputPayloads.slice(shiftEnterStart))
    );
  }
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyC');
  await page.keyboard.up('Control');
  await sleep(200);

  const pasteText = 'PASTE_A_' + Date.now() + '\nPASTE_B_' + Date.now();
  const pasteStart = inputPayloads.length;
  await page.evaluate((text) => {
    const textarea = document.querySelector('.xterm-helper-textarea');
    if (!textarea) throw new Error('missing xterm helper textarea');
    textarea.focus();
    const data = new DataTransfer();
    data.setData('text/plain', text);
    const ev = new ClipboardEvent('paste', {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(ev);
  }, pasteText);
  const gotPaste = await waitFor(() =>
    inputPayloads.slice(pasteStart).join('').replace(/\r/g, '\n').includes(pasteText)
  );
  const pastePayloads = inputPayloads.slice(pasteStart);
  if (!gotPaste || pastePayloads.includes('\r')) {
    errors.push(
      'multiline paste was not preserved as paste data: ' + JSON.stringify(pastePayloads)
    );
  }
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyC');
  await page.keyboard.up('Control');
  await sleep(300);

  // Title fallback: clearing the PTY title via OSC 0 should make the tab
  // show the default "Webterm" title.
  await page.keyboard.type("printf '\\033]0;\\007'; sleep 1.5\n");
  await sleep(800);
  const clearedTitle = await page.evaluate(() => document.title);
  if (clearedTitle !== 'Webterm') {
    errors.push('cleared title is ' + JSON.stringify(clearedTitle) + ', expected "Webterm"');
  }

  // Title passthrough: a PTY title set via OSC 0 must be shown raw, with no
  // "Webterm — " prefix.
  const ptyTitle = 'WEBTERM_PTY_TITLE_' + Date.now();
  await page.keyboard.type("printf '\\033]0;" + ptyTitle + "\\007'; sleep 1.5\n");
  await sleep(800);
  const observedTitle = await page.evaluate(() => document.title);
  if (observedTitle !== ptyTitle) {
    errors.push('pty title is ' + JSON.stringify(observedTitle) + ', expected ' + JSON.stringify(ptyTitle));
  }

  // Type a command that produces a unique marker.
  const marker = 'PUPPETEER_OK_' + Date.now();
  await page.keyboard.type('echo ' + marker + '\n');
  await sleep(1200);

  const screenHasMarker = await page.evaluate((mk) => {
    const text = document.querySelector('.xterm-rows')
      ? document.querySelector('.xterm-rows').innerText
      : document.body.innerText;
    return text.includes(mk);
  }, marker);

  const overlayVisible = await page.evaluate(() => {
    const o = document.getElementById('overlay');
    return o && !o.classList.contains('hidden');
  });

  // Independently confirm the command actually ran in the PTY by reading the
  // current plain-text snapshot.
  let snapshotHasMarker = false;
  try {
    const res = await fetch(BASE + '/api/snapshot');
    const text = await res.text();
    snapshotHasMarker = text.includes(marker);
  } catch (e) {
    errors.push('snapshot recheck failed: ' + e.message);
  }

  await browser.close();

  console.log('streamStatus       :', streamStatus);
  console.log('inputReqs (statuses):', JSON.stringify(inputReqs));
  console.log('inputPayloads      :', JSON.stringify(inputPayloads));
  console.log('overlayVisible     :', overlayVisible);
  console.log('screenHasMarker    :', screenHasMarker);
  console.log('snapshotHasMarker  :', snapshotHasMarker);
  console.log('jsErrors           :', errors.length ? errors : 'none');

  const ok =
    streamStatus === 200 &&
    inputReqs.length > 0 &&
    inputReqs.every((s) => s === 200) &&
    !overlayVisible &&
    snapshotHasMarker &&
    errors.length === 0;
  console.log(ok ? '\nSMOKE: PASS' : '\nSMOKE: FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('smoke crashed:', e);
  process.exit(2);
});
