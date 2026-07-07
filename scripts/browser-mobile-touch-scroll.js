'use strict';

// Headless-Chrome regression for mobile touch scroll. A vertical finger drag
// should enter xterm's existing wheel path and produce SGR wheel input when a
// TUI has enabled mouse reporting.
//
// Run with the server up: WEBTERM_DEV_PORT=8080 npm start
//   node scripts/browser-mobile-touch-scroll.js

const puppeteer = require('puppeteer-core');

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:8080/';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
}

function touchPoint(x, y) {
  return { x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 };
}

async function dispatchTouchSwipe(page, start, end, steps = 8) {
  const client = await page.target().createCDPSession();
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [touchPoint(start.x, start.y)],
  });
  for (let i = 1; i <= steps; i++) {
    const x = start.x + ((end.x - start.x) * i) / steps;
    const y = start.y + ((end.y - start.y) * i) / steps;
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [touchPoint(x, y)],
    });
    await sleep(16);
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await client.detach();
}

async function terminalPoint(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.xterm-screen') || document.getElementById('terminal');
    if (!el) throw new Error('missing terminal screen');
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  });
}

(async () => {
  const errors = [];
  const inputPayloads = [];

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
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

  const tapStart = inputPayloads.length;
  const point = await terminalPoint(page);
  await dispatchTouchSwipe(page, point, { x: point.x, y: point.y }, 1);
  await sleep(300);
  if (inputPayloads.length !== tapStart) {
    errors.push('simple touch tap unexpectedly sent input: ' + JSON.stringify(inputPayloads.slice(tapStart)));
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
  const gotWheelUp = await waitFor(() =>
    inputPayloads.slice(swipeStart).some((payload) => /\x1b\[<64;\d+;\d+M/.test(payload))
  );

  const reverseSwipeStart = inputPayloads.length;
  await dispatchTouchSwipe(page, point, { x: point.x, y: point.y - 140 }, 10);
  const gotWheelDown = await waitFor(() =>
    inputPayloads.slice(reverseSwipeStart).some((payload) => /\x1b\[<65;\d+;\d+M/.test(payload))
  );

  await browser.close();

  const swipePayloads = inputPayloads.slice(swipeStart, reverseSwipeStart);
  const reverseSwipePayloads = inputPayloads.slice(reverseSwipeStart);
  console.log('tapPayloads       :', JSON.stringify(inputPayloads.slice(tapStart, swipeStart)));
  console.log('swipePayloads     :', JSON.stringify(swipePayloads));
  console.log('reverseSwipe      :', JSON.stringify(reverseSwipePayloads));
  console.log('wheelUpDetected   :', gotWheelUp);
  console.log('wheelDownDetected :', gotWheelDown);
  console.log('jsErrors          :', errors.length ? errors : 'none');

  if (!gotWheelUp) {
    errors.push('touch swipe did not produce SGR wheel-up input');
  }
  if (!gotWheelDown) {
    errors.push('touch reverse swipe did not produce SGR wheel-down input');
  }

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
