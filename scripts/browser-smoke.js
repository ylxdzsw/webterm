'use strict';

// Headless-Chrome smoke test for the frontend. Not part of the app; used to
// validate that the UI loads without errors, connects to the single shell,
// sends input, and renders live output. Run with the server up on
// 127.0.0.1:8080.

const { launchBrowser, sleep, waitFor: waitUntil } = require('./browser-test-utils');

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:8080/';
const BASE = URL.replace(/\/$/, '');
const waitFor = (fn) => waitUntil(fn, 3000, 25);

(async () => {
  const errors = [];
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
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

  const pwaMetadata = await page.evaluate(() =>
    Object.fromEntries(
      ['theme-color', 'apple-mobile-web-app-capable', 'apple-mobile-web-app-status-bar-style'].map(
        (name) => [name, document.querySelector(`meta[name="${name}"]`)?.content]
      )
    )
  );
  if (
    pwaMetadata['theme-color'] !== '#0b0e14' ||
    pwaMetadata['apple-mobile-web-app-capable'] !== 'yes' ||
    pwaMetadata['apple-mobile-web-app-status-bar-style'] !== 'black-translucent'
  ) {
    errors.push('PWA status bar metadata mismatch: ' + JSON.stringify(pwaMetadata));
  }

  const virtualKeys = await page.evaluate(async () => {
    const rail = document.getElementById('mobile-keys');
    const terminal = document.getElementById('terminal');
    const originalFetch = window.fetch.bind(window);
    const originalScrollTo = window.scrollTo.bind(window);
    const payloads = [];
    const pageScrolls = [];
    const clipboardText = 'MOBILE_PASTE';
    let clipboardReads = 0;
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => {
          clipboardReads += 1;
          return clipboardText;
        },
      },
    });
    window.fetch = async (resource, init = {}) => {
      const url = String(resource && resource.url ? resource.url : resource);
      if (url === 'api/input' || url.endsWith('/api/input')) {
        const body = init.body || new Uint8Array();
        payloads.push(new TextDecoder().decode(body));
        return new Response('{"m":"WT1","t":"ack","ok":true}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(resource, init);
    };
    window.scrollTo = (...args) => {
      pageScrolls.push(args[0]);
    };

    let keyboardActiveElementClass = '';
    try {
      rail.querySelector('button[data-keyboard]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 120));
      keyboardActiveElementClass = document.activeElement ? document.activeElement.className : '';
      const pasteButton = rail.querySelector('button[data-paste]');
      pasteButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      pasteButton.click();
      await new Promise((resolve) => setTimeout(resolve, 120));
      for (const button of rail.querySelectorAll('button[data-input]')) {
        // Simulate a real tap: pointerdown (which the app cancels to keep
        // focus) precedes the click.
        button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      window.fetch = originalFetch;
      window.scrollTo = originalScrollTo;
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      } else {
        delete navigator.clipboard;
      }
    }

    const railBox = rail.getBoundingClientRect();
    const terminalBox = terminal.getBoundingClientRect();
    const firstButtonBox = rail.querySelector('button').getBoundingClientRect();
    return {
      labels: Array.from(rail.querySelectorAll('button')).map((button) => button.textContent),
      payloads,
      clipboardReads,
      visible: getComputedStyle(rail).display !== 'none',
      singleLine: rail.scrollHeight <= rail.clientHeight + 1,
      horizontallyScrollable: rail.scrollWidth > rail.clientWidth,
      railTop: railBox.top,
      terminalBottom: terminalBox.bottom,
      buttonTop: firstButtonBox.top,
      buttonBottom: firstButtonBox.bottom,
      viewportHeight: window.innerHeight,
      terminalPosition: getComputedStyle(terminal).position,
      railTouchAction: getComputedStyle(rail).touchAction,
      keyboardActiveElementClass,
      activeElementClass: document.activeElement ? document.activeElement.className : '',
      pageScrolls,
      documentScrollHeight: document.documentElement.scrollHeight,
    };
  });
  const expectedVirtualKeyPayloads = [
    '\x1b[200~MOBILE_PASTE\x1b[201~',
    '\x1b',
    '\x03',
    '\x04',
    '\x1b[D',
    '\x1b[B',
    '\x1b[A',
    '\x1b[C',
    '\x1b[5~',
    '\x1b[6~',
    '\x1b[H',
    '\x1b[F',
  ];
  if (
    !virtualKeys.visible ||
    !virtualKeys.singleLine ||
    !virtualKeys.horizontallyScrollable ||
    Math.abs(virtualKeys.railTop - virtualKeys.terminalBottom - 3) > 1 ||
    Math.abs(virtualKeys.buttonTop - virtualKeys.railTop - 7) > 1 ||
    Math.abs(virtualKeys.buttonBottom - virtualKeys.viewportHeight) > 1 ||
    virtualKeys.terminalPosition !== 'fixed' ||
    virtualKeys.railTouchAction !== 'pan-x' ||
    !String(virtualKeys.keyboardActiveElementClass).includes('xterm-helper-textarea') ||
    !virtualKeys.pageScrolls.some(
      (scroll) => scroll && scroll.left === 0 && scroll.top === virtualKeys.documentScrollHeight
    ) ||
    virtualKeys.pageScrolls.length > 3 ||
    // Virtual keys must not disturb keyboard state: focus stays on the
    // terminal textarea that the keyboard button gave it.
    !String(virtualKeys.activeElementClass).includes('xterm-helper-textarea') ||
    virtualKeys.clipboardReads !== 1 ||
    JSON.stringify(virtualKeys.labels) !==
      JSON.stringify(['⌨️', '📋', 'Esc', '^C', '^D', '←', '↓', '↑', '→', 'PgUp', 'PgDn', 'Home', 'End']) ||
    JSON.stringify(virtualKeys.payloads) !== JSON.stringify(expectedVirtualKeyPayloads)
  ) {
    errors.push('virtual key rail mismatch: ' + JSON.stringify(virtualKeys));
  }

  const keyboardViewport = await page.evaluate(async () => {
    const root = document.documentElement;
    const terminal = document.getElementById('terminal');
    const rail = document.getElementById('mobile-keys');
    root.style.setProperty('--visual-viewport-offset-top', '180px');
    root.style.setProperty('--keyboard-inset', '220px');
    root.style.setProperty('--mobile-key-bottom-gap', '6px');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const terminalBox = terminal.getBoundingClientRect();
    const screenBox = document.querySelector('.xterm-screen').getBoundingClientRect();
    const railBox = rail.getBoundingClientRect();
    const buttonBox = rail.querySelector('button').getBoundingClientRect();
    root.style.removeProperty('--visual-viewport-offset-top');
    root.style.removeProperty('--keyboard-inset');
    root.style.removeProperty('--mobile-key-bottom-gap');
    return {
      terminalTop: terminalBox.top,
      terminalBottom: terminalBox.bottom,
      screenTop: screenBox.top,
      railTop: railBox.top,
      buttonBottom: buttonBox.bottom,
      keyboardTop: window.innerHeight - 220,
    };
  });
  if (
    Math.abs(keyboardViewport.terminalTop - 180) > 1 ||
    Math.abs(keyboardViewport.screenTop - 186) > 1 ||
    Math.abs(keyboardViewport.railTop - keyboardViewport.terminalBottom - 3) > 1 ||
    Math.abs(keyboardViewport.keyboardTop - keyboardViewport.buttonBottom - 6) > 1
  ) {
    errors.push('keyboard viewport did not keep the terminal cursor area visible: ' + JSON.stringify(keyboardViewport));
  }

  const closedKeyboardSafeArea = await page.evaluate(async () => {
    const root = document.documentElement;
    const rail = document.getElementById('mobile-keys');
    const button = rail.querySelector('button');
    const rootRule = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .find((rule) => rule.selectorText === ':root');
    root.style.setProperty('--mobile-key-bottom-gap', '24px');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const railBox = rail.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    root.style.removeProperty('--mobile-key-bottom-gap');
    return {
      buttonBottom: buttonBox.bottom,
      defaultBottomGap: rootRule?.style.getPropertyValue('--mobile-key-bottom-gap').trim(),
      railBottom: railBox.bottom,
    };
  });
  if (
    closedKeyboardSafeArea.defaultBottomGap !== 'env(safe-area-inset-bottom, 0px)' ||
    Math.abs(closedKeyboardSafeArea.railBottom - closedKeyboardSafeArea.buttonBottom - 24) > 1
  ) {
    errors.push(
      'closed-keyboard rail did not avoid the bottom safe area: ' +
        JSON.stringify(closedKeyboardSafeArea)
    );
  }

  const resizedLayoutKeyboard = await page.evaluate(() => {
    const rootStyle = document.documentElement.style;
    const viewport = window.visualViewport;
    const reducedHeight = viewport.height - 220;
    window.updateKeyboardInset(
      { width: viewport.width, height: reducedHeight, offsetTop: 0 },
      reducedHeight
    );
    const result = {
      keyboardInset: rootStyle.getPropertyValue('--keyboard-inset'),
      bottomGap: rootStyle.getPropertyValue('--mobile-key-bottom-gap'),
    };
    window.updateKeyboardInset(viewport, window.innerHeight);
    return result;
  });
  if (
    resizedLayoutKeyboard.keyboardInset !== '0.00px' ||
    resizedLayoutKeyboard.bottomGap !== '6px'
  ) {
    errors.push(
      'resized-layout keyboard did not use the compact rail gap: ' +
        JSON.stringify(resizedLayoutKeyboard)
    );
  }
  await page.evaluate(() => {
    document.querySelector('.xterm-helper-textarea')?.focus();
  });

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
  const ptyTitle = 'WT_PTY_TITLE_' + Date.now();
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
