'use strict';

// Simulate repeated stream-connection failures and verify the frontend stops
// retrying forever and instead asks the user to refresh.

const { launchBrowser } = require('./browser-test-utils');

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:8080/';

(async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().includes('/api/stream')) {
      req.abort('failed');
    } else {
      req.continue();
    }
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => {
      const o = document.getElementById('overlay');
      return (
        o &&
        !o.classList.contains('hidden') &&
        /connection lost/i.test(document.getElementById('overlay-title').textContent)
      );
    },
    { timeout: 12000 }
  );

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
    result.overlayVisible && /connection lost/i.test(result.title) && result.hasRefresh;
  console.log(ok ? '\nRECONNECT-FAIL: PASS' : '\nRECONNECT-FAIL: FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('reconnect fail test crashed:', e);
  process.exit(2);
});
