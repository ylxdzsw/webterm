'use strict';

// Headless-Chrome regression for mobile touch scroll. A vertical finger drag
// should enter xterm's existing wheel path and produce SGR wheel input when a
// TUI has enabled mouse reporting.
//
// Run with the test server already listening on http://127.0.0.1:8080/.
//   node scripts/browser-mobile-touch-scroll.js

const {
  dispatchTouchSwipe,
  launchBrowser,
  sleep,
  terminalPoint,
  touchPoint,
  waitFor,
} = require('./browser-test-utils');

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:8080/';

function countWheelReports(payloads, button) {
  const re = new RegExp('\\x1b\\[<' + button + ';\\d+;\\d+M', 'g');
  return payloads.reduce((total, payload) => total + (payload.match(re) || []).length, 0);
}

async function dispatchTouchTapWithClient(client, point) {
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [touchPoint(point.x, point.y)],
  });
  await sleep(20);
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function dispatchTouchDoubleTap(page, point) {
  const client = await page.target().createCDPSession();
  await dispatchTouchTapWithClient(client, point);
  await sleep(80);
  await dispatchTouchTapWithClient(client, point);
  await client.detach();
}

(async () => {
  const errors = [];
  const inputPayloads = [];

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
  page.on('request', (r) => {
    if (!r.url().includes('/api/input')) return;
    if (typeof r.postDataBuffer === 'function') {
      const body = r.postDataBuffer();
      inputPayloads.push(body ? Buffer.from(body).toString('utf8') : '');
    } else {
      inputPayloads.push(r.postData() || '');
    }
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.xterm-rows') != null, {
    timeout: 8000,
  });
  await sleep(1000);

  const phoneFontSize = await page.evaluate(() => term.options.fontSize);
  if (phoneFontSize !== 12) {
    errors.push('phone viewport should use 12px terminal font: ' + phoneFontSize);
  }

  await page.setViewport({
    width: 768,
    height: 1024,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  await page.waitForFunction(() => term.options.fontSize === 14, { timeout: 3000 });
  const resizedFontSize = await page.evaluate(() => term.options.fontSize);
  if (resizedFontSize !== 14) {
    errors.push('resized phone viewport should use 14px terminal font: ' + resizedFontSize);
  }

  await page.setViewport({
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  await page.waitForFunction(() => term.options.fontSize === 12, { timeout: 3000 });

  const touchCss = await page.evaluate(() => {
    const terminal = document.getElementById('terminal');
    const screen = document.querySelector('.xterm-screen');
    return {
      bodyOverflow: getComputedStyle(document.body).overflow,
      bodyOverscrollY: getComputedStyle(document.body).overscrollBehaviorY,
      terminalTouchAction: terminal ? getComputedStyle(terminal).touchAction : '',
      screenTouchAction: screen ? getComputedStyle(screen).touchAction : '',
    };
  });
  if (
    touchCss.bodyOverflow !== 'hidden' ||
    touchCss.bodyOverscrollY !== 'none' ||
    touchCss.terminalTouchAction !== 'none' ||
    touchCss.screenTouchAction !== 'none'
  ) {
    errors.push('mobile touch CSS guard mismatch: ' + JSON.stringify(touchCss));
  }

  const lineMetric = await page.evaluate(async () => {
    const before = window.touchScrollLinePx();
    const output = Array.from({ length: 160 }, (_, i) => 'TOUCH_SCROLL_METRIC_' + i + '\r\n').join('');
    window.handleFrame(
      JSON.stringify({
        m: 'WT1',
        t: 'o',
        d: btoa(output),
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    return {
      before,
      after: window.touchScrollLinePx(),
    };
  });
  if (lineMetric.after < 8 || lineMetric.after > 48) {
    errors.push('touch scroll line height is not viewport-based: ' + JSON.stringify(lineMetric));
  }

  const tapStart = inputPayloads.length;
  const point = await terminalPoint(page);
  await dispatchTouchSwipe(page, point, { x: point.x, y: point.y }, 1);
  await sleep(350);
  if (inputPayloads.length !== tapStart) {
    errors.push('simple touch tap unexpectedly sent input: ' + JSON.stringify(inputPayloads.slice(tapStart)));
  }

  const doubleTapHiddenKeyboard = await page.evaluate(() => {
    document.querySelector('.xterm-helper-textarea')?.blur();
    return {
      before: document.activeElement ? document.activeElement.className : '',
    };
  });
  const doubleTapStart = inputPayloads.length;
  await dispatchTouchDoubleTap(page, point);
  await sleep(150);
  doubleTapHiddenKeyboard.after = await page.evaluate(() =>
    document.activeElement ? document.activeElement.className : ''
  );
  const doubleTapPayloads = inputPayloads.slice(doubleTapStart);
  if (JSON.stringify(doubleTapPayloads) !== JSON.stringify(['\t'])) {
    errors.push('double tap should send one tab: ' + JSON.stringify(doubleTapPayloads));
  }
  if (String(doubleTapHiddenKeyboard.after).includes('xterm-helper-textarea')) {
    errors.push(
      'double tap should not focus terminal helper textarea: ' + JSON.stringify(doubleTapHiddenKeyboard)
    );
  }

  const doubleTapFocusedKeyboard = await page.evaluate(() => {
    document.querySelector('.xterm-helper-textarea')?.focus();
    return {
      before: document.activeElement ? document.activeElement.className : '',
    };
  });
  const focusedDoubleTapStart = inputPayloads.length;
  await dispatchTouchDoubleTap(page, point);
  await sleep(150);
  doubleTapFocusedKeyboard.after = await page.evaluate(() =>
    document.activeElement ? document.activeElement.className : ''
  );
  const focusedDoubleTapPayloads = inputPayloads.slice(focusedDoubleTapStart);
  if (JSON.stringify(focusedDoubleTapPayloads) !== JSON.stringify(['\t'])) {
    errors.push('focused double tap should send one tab: ' + JSON.stringify(focusedDoubleTapPayloads));
  }
  if (!String(doubleTapFocusedKeyboard.before).includes('xterm-helper-textarea')) {
    errors.push('test failed to focus helper textarea before double tap: ' + JSON.stringify(doubleTapFocusedKeyboard));
  }
  if (!String(doubleTapFocusedKeyboard.after).includes('xterm-helper-textarea')) {
    errors.push('double tap should preserve focused helper textarea: ' + JSON.stringify(doubleTapFocusedKeyboard));
  }

  await page.evaluate(() => {
    window.handleFrame(
      JSON.stringify({
        m: 'WT1',
        t: 'o',
        d: btoa('\x1b[?1000h\x1b[?1006h'),
      })
    );
  });
  await sleep(300);

  const swipeStart = inputPayloads.length;
  await dispatchTouchSwipe(page, point, { x: point.x, y: point.y + 140 }, 10);
  await sleep(1000);
  const gotWheelUp = await waitFor(() =>
    inputPayloads.slice(swipeStart).some((payload) => /\x1b\[<64;\d+;\d+M/.test(payload))
  );

  const reverseSwipeStart = inputPayloads.length;
  await dispatchTouchSwipe(page, point, { x: point.x, y: point.y - 140 }, 10);
  await sleep(1000);
  const gotWheelDown = await waitFor(() =>
    inputPayloads.slice(reverseSwipeStart).some((payload) => /\x1b\[<65;\d+;\d+M/.test(payload))
  );

  const swipePayloads = inputPayloads.slice(swipeStart, reverseSwipeStart);
  const reverseSwipePayloads = inputPayloads.slice(reverseSwipeStart);
  const wheelUpCount = countWheelReports(swipePayloads, 64);
  const wheelDownCount = countWheelReports(reverseSwipePayloads, 65);
  console.log('touchCss         :', JSON.stringify(touchCss));
  console.log('lineMetric       :', JSON.stringify(lineMetric));
  console.log('tapPayloads       :', JSON.stringify(inputPayloads.slice(tapStart, doubleTapStart)));
  console.log('doubleTapPayloads :', JSON.stringify(doubleTapPayloads));
  console.log('doubleTapFocus    :', JSON.stringify(doubleTapHiddenKeyboard));
  console.log('focusedDoubleTap  :', JSON.stringify(doubleTapFocusedKeyboard));
  console.log('swipePayloads     :', JSON.stringify(swipePayloads));
  console.log('reverseSwipe      :', JSON.stringify(reverseSwipePayloads));
  console.log('wheelUpCount      :', wheelUpCount);
  console.log('wheelDownCount    :', wheelDownCount);
  console.log('wheelUpDetected   :', gotWheelUp);
  console.log('wheelDownDetected :', gotWheelDown);
  console.log('jsErrors          :', errors.length ? errors : 'none');

  if (!gotWheelUp) {
    errors.push('touch swipe did not produce SGR wheel-up input');
  }
  if (!gotWheelDown) {
    errors.push('touch reverse swipe did not produce SGR wheel-down input');
  }
  if (wheelUpCount < 22) {
    errors.push('touch swipe produced too few wheel-up reports: ' + wheelUpCount);
  }
  if (wheelDownCount < 22) {
    errors.push('touch swipe produced too few wheel-down reports: ' + wheelDownCount);
  }

  const ipadFontSize = await (async () => {
    const ipadPage = await browser.newPage();
    await ipadPage.setViewport({
      width: 768,
      height: 1024,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    await ipadPage.goto(URL, { waitUntil: 'domcontentloaded' });
    await ipadPage.waitForFunction(() => typeof term !== 'undefined' && document.querySelector('.xterm-rows') != null, {
      timeout: 8000,
    });
    const fontSize = await ipadPage.evaluate(() => term.options.fontSize);
    await ipadPage.close();
    return fontSize;
  })();
  console.log('phoneFontSize    :', phoneFontSize);
  console.log('resizedFontSize  :', resizedFontSize);
  console.log('ipadFontSize     :', ipadFontSize);
  if (ipadFontSize !== 14) {
    errors.push('iPad-width viewport should keep 14px terminal font: ' + ipadFontSize);
  }

  await browser.close();

  const ok = errors.length === 0;
  console.log(ok ? '\nMOBILE-TOUCH-SCROLL: PASS' : '\nMOBILE-TOUCH-SCROLL: FAIL');
  if (!ok) {
    for (const err of errors) console.error(' -', err);
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('mobile touch scroll test crashed:', e);
  process.exit(2);
});
