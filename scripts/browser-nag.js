'use strict';

// Simulate the corporate proxy hijacking requests with an HTML "acknowledge"
// page, and verify the frontend detects it and requires a refresh instead of
// dumping HTML into the terminal.

const puppeteer = require('puppeteer-core');

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:8080/';
const TEST_URL =
  URL.replace(/\/$/, '/') +
  '?x=' +
  encodeURIComponent('<img src=x onerror="window.__webtermXss=1">');
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
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    // The first calls on load are /api/resize then /api/stream; hijack them
    // with the nag page (status 200, text/html) like the proxy would.
    if (
      req.url().includes('/api/stream') ||
      req.url().includes('/api/resize') ||
      req.url().includes('/api/input')
    ) {
      req.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: NAG_HTML,
      });
    } else {
      req.continue();
    }
  });

  await page.goto(TEST_URL, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1500));

  const result = await page.evaluate(() => {
    const o = document.getElementById('overlay');
    const body = document.getElementById('overlay-body');
    return {
      overlayVisible: o && !o.classList.contains('hidden'),
      title: document.getElementById('overlay-title').textContent,
      hasRefresh: Array.from(document.querySelectorAll('#overlay-actions *')).some(
        (n) => /refresh/i.test(n.textContent)
      ),
      hasInjectedNode: !!(body && body.querySelector('img,script,svg')),
      xssFired: window.__webtermXss === 1,
    };
  });

  await browser.close();

  console.log('overlayVisible:', result.overlayVisible);
  console.log('title         :', JSON.stringify(result.title));
  console.log('hasRefresh    :', result.hasRefresh);
  console.log('hasInjectedNode:', result.hasInjectedNode);
  console.log('xssFired      :', result.xssFired);

  const ok =
    result.overlayVisible &&
    /refresh required/i.test(result.title) &&
    result.hasRefresh &&
    !result.hasInjectedNode &&
    !result.xssFired;
  console.log(ok ? '\nNAG-DETECT: PASS' : '\nNAG-DETECT: FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('nag test crashed:', e);
  process.exit(2);
});
