'use strict';

// End-to-end regression for reconnect scroll + history preservation.
//
// Uses fake networking (brief offline mode) to kill the live stream while a
// crafted shell burst is printing — similar to Codex finishing a chunk of
// output. With the buggy client/server, this used to:
//   1. jump the viewport to the top of scrollback
//   2. drop the newest bottom line permanently
//
// Run with the test server already listening on http://127.0.0.1:8080/.
//   node scripts/browser-reconnect-scroll.js

const puppeteer = require('puppeteer-core');
const path = require('path');

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:8080/';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';
const BURST_SCRIPT = path.join(__dirname, 'repro', 'codex-burst.sh');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

async function readTerminalState(page) {
  return page.evaluate(() => {
    const rows = document.querySelector('.xterm-rows');
    const scrollHost =
      document.querySelector('.xterm .xterm-scrollable-element') ||
      document.querySelector('.xterm-viewport');
    const scrollTop = scrollHost ? scrollHost.scrollTop : -1;
    const maxScroll = scrollHost
      ? Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight)
      : -1;
    const atBottom = maxScroll < 0 ? false : maxScroll - scrollTop <= 4;
    return {
      scrollTop,
      maxScroll,
      atBottom,
      fullText: rows ? rows.innerText : '',
    };
  });
}

(async () => {
  const errors = [];
  const marker = 'BOTTOM_MARKER_' + Date.now();
  const prefix = 'REPRO_' + Date.now();

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.xterm-rows') != null, {
    timeout: 8000,
  });
  await sleep(800);

  const burstCmd =
    'sh ' +
    JSON.stringify(BURST_SCRIPT) +
    ' ' +
    JSON.stringify(prefix) +
    ' ' +
    JSON.stringify(marker) +
    '\n';
  await page.keyboard.type(burstCmd);

  const sawMarker = await waitFor(async () => {
    const state = await readTerminalState(page);
    return state.fullText.includes(marker);
  }, 12000);
  if (!sawMarker) {
    errors.push('marker never appeared before forced disconnect');
  }

  const beforeDrop = await readTerminalState(page);
  if (!beforeDrop.atBottom) {
    errors.push(
      'expected to be scrolled to bottom before drop; scrollTop=' +
        beforeDrop.scrollTop +
        ' max=' +
        beforeDrop.maxScroll
    );
  }

  // Fake network blip: kills the long-lived stream; client auto-reconnects.
  await page.setOfflineMode(true);
  await sleep(400);
  await page.setOfflineMode(false);

  const reconnected = await waitFor(async () => {
    const overlay = await page.evaluate(() => {
      const o = document.getElementById('overlay');
      return o && !o.classList.contains('hidden');
    });
    if (overlay) return false;
    const state = await readTerminalState(page);
    return state.fullText.includes(marker) && state.fullText.includes(prefix);
  }, 15000);
  if (!reconnected) {
    errors.push('terminal did not recover after fake network drop');
  }

  await sleep(1200);

  const afterReconnect = await readTerminalState(page);
  const snapshotText = await (async () => {
    const base = URL.replace(/\/$/, '');
    const res = await fetch(base + '/api/snapshot');
    return res.text();
  })();

  await browser.close();

  console.log('beforeDrop scrollTop :', beforeDrop.scrollTop, '/', beforeDrop.maxScroll);
  console.log('afterReconnect scroll  :', afterReconnect.scrollTop, '/', afterReconnect.maxScroll);
  console.log('afterReconnect atBottom:', afterReconnect.atBottom);
  console.log('marker in screen       :', afterReconnect.fullText.includes(marker));
  console.log('marker in snapshot     :', snapshotText.includes(marker));
  console.log('jsErrors               :', errors.length ? errors : 'none');

  if (!afterReconnect.fullText.includes(marker)) {
    errors.push('marker missing from terminal after reconnect');
  }
  if (!snapshotText.includes(marker)) {
    errors.push('marker missing from server snapshot after reconnect');
  }
  if (!afterReconnect.atBottom) {
    errors.push('viewport not at bottom after reconnect (scroll jump)');
  }

  const ok = errors.length === 0;
  console.log(ok ? '\nRECONNECT-SCROLL: PASS' : '\nRECONNECT-SCROLL: FAIL');
  if (!ok) {
    for (const err of errors) console.error(' -', err);
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('reconnect scroll test crashed:', e);
  process.exit(2);
});
