'use strict';

// Headless-Chrome test: after the shell exits, the session-ended overlay can be
// dismissed and the browser keeps scrollback visible. Run with the server up on
// 127.0.0.1:8080 and WEBTERM_TOKEN=testtoken. This test ends the server process.

const puppeteer = require('puppeteer-core');

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:8080/';
const TOKEN = process.env.SMOKE_TOKEN || 'testtoken';
const CHROME =
  process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';

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

  await page.evaluateOnNewDocument((tok) => {
    localStorage.setItem('webterm_token', tok);
  }, TOKEN);

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelector('.xterm-rows') != null,
    { timeout: 5000 }
  );
  await new Promise((r) => setTimeout(r, 1500));

  const marker = 'EXIT_HISTORY_' + Date.now();
  await page.keyboard.type('echo ' + marker + '\n');
  await new Promise((r) => setTimeout(r, 1200));

  await page.keyboard.type('exit 0\n');

  await page.waitForFunction(
    () => {
      const o = document.getElementById('overlay');
      const title = document.getElementById('overlay-title');
      const s = document.getElementById('status');
      return (
        o &&
        !o.classList.contains('hidden') &&
        title &&
        title.textContent === 'Session ended' &&
        s &&
        s.classList.contains('hidden')
      );
    },
    { timeout: 5000 }
  );

  await page.evaluate(() => {
    const dismiss = document.getElementById('overlay-dismiss');
    if (!dismiss || dismiss.classList.contains('hidden')) {
      throw new Error('overlay dismiss button not found');
    }
    dismiss.click();
  });

  await page.waitForFunction(
    () => {
      const o = document.getElementById('overlay');
      return o && o.classList.contains('hidden');
    },
    { timeout: 2000 }
  );

  const screenHasMarker = await page.evaluate((mk) => {
    const text = document.querySelector('.xterm-rows')
      ? document.querySelector('.xterm-rows').innerText
      : document.body.innerText;
    return text.includes(mk);
  }, marker);

  const statusText = await page.evaluate(() => {
    const s = document.getElementById('status');
    return s && !s.classList.contains('hidden') ? s.textContent : '';
  });

  await browser.close();

  console.log('screenHasMarker:', screenHasMarker);
  console.log('statusText       :', statusText);
  console.log('jsErrors         :', errors.length ? errors : 'none');

  if (!screenHasMarker) {
    errors.push('marker missing from terminal after dismissing overlay');
  }
  if (!/session ended/i.test(statusText)) {
    errors.push('status does not show session ended after dismiss');
  }

  const ok = screenHasMarker && errors.length === 0;
  console.log(ok ? '\nEXIT TEST: PASS' : '\nEXIT TEST: FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('exit test crashed:', e);
  process.exit(2);
});
