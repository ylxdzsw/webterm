'use strict';

// Simulate the corporate proxy hijacking requests with an HTML "acknowledge"
// page, and verify the frontend detects it and shows the Reconnect overlay
// instead of dumping HTML into the terminal.

const puppeteer = require('puppeteer-core');

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:8080/';
const TOKEN = process.env.SMOKE_TOKEN || 'testtoken';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';

const NAG_HTML =
  '<!DOCTYPE html><html><body><h1>Corporate Reminder</h1>' +
  '<p>Please click Acknowledged to continue.</p></body></html>';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((tok) => {
    localStorage.setItem('webterm_token', tok);
  }, TOKEN);

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    // The first authed call on load is /api/sessions (the lobby fetch); hijack
    // it with the nag page (status 200, text/html) like the proxy would.
    if (req.url().includes('/api/sessions') || req.url().includes('/api/stream')) {
      req.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: NAG_HTML,
      });
    } else {
      req.continue();
    }
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1500));

  const result = await page.evaluate(() => {
    const o = document.getElementById('overlay');
    return {
      overlayVisible: o && !o.classList.contains('hidden'),
      title: document.getElementById('overlay-title').textContent,
      hasReconnect: Array.from(document.querySelectorAll('#overlay-actions *')).some(
        (n) => /reconnect/i.test(n.textContent)
      ),
    };
  });

  await browser.close();

  console.log('overlayVisible:', result.overlayVisible);
  console.log('title         :', JSON.stringify(result.title));
  console.log('hasReconnect  :', result.hasReconnect);

  const ok =
    result.overlayVisible && /reminder/i.test(result.title) && result.hasReconnect;
  console.log(ok ? '\nNAG-DETECT: PASS' : '\nNAG-DETECT: FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('nag test crashed:', e);
  process.exit(2);
});
