'use strict';

// Simulate the proxy redirecting API calls to a different origin and verify the
// frontend requires a refresh instead of silently retrying.

const { launchBrowser, sleep } = require('./browser-test-utils');

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:8080/';
const REDIRECT_TARGET =
  process.env.NAG_REDIRECT_TARGET || 'https://example.com/acknowledge';

(async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (
      req.url().includes('/api/stream') ||
      req.url().includes('/api/resize') ||
      req.url().includes('/api/input')
    ) {
      req.respond({
        status: 302,
        headers: {
          Location: REDIRECT_TARGET,
        },
      });
    } else {
      req.continue();
    }
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(1500);

  const result = await page.evaluate(() => {
    const o = document.getElementById('overlay');
    return {
      overlayVisible: o && !o.classList.contains('hidden'),
      title: document.getElementById('overlay-title').textContent,
      hasRefresh: Array.from(document.querySelectorAll('#overlay-actions *')).some(
        (n) => /refresh/i.test(n.textContent)
      ),
    };
  });

  await browser.close();

  console.log('overlayVisible:', result.overlayVisible);
  console.log('title         :', JSON.stringify(result.title));
  console.log('hasRefresh    :', result.hasRefresh);

  const ok =
    result.overlayVisible && /refresh required/i.test(result.title) && result.hasRefresh;
  console.log(ok ? '\nNAG-REDIRECT: PASS' : '\nNAG-REDIRECT: FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('nag redirect test crashed:', e);
  process.exit(2);
});
