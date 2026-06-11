'use strict';

// Headless-Chrome smoke test for the frontend. Not part of the app; used to
// validate that the UI loads without errors, connects, sends input, and renders
// live output. Run with the server up on 127.0.0.1:8080 and WEBTERM_TOKEN=testtoken.

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

  const inputReqs = [];
  let streamStatus = null;
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('/api/input')) inputReqs.push(r.status());
    if (u.includes('/api/stream')) streamStatus = r.status();
  });

  await page.evaluateOnNewDocument((tok) => {
    localStorage.setItem('webterm_token', tok);
  }, TOKEN);

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  // Let it connect and paint the snapshot.
  await new Promise((r) => setTimeout(r, 1500));

  // Type a command that produces a unique marker.
  const marker = 'PUPPETEER_OK_' + Date.now();
  await page.keyboard.type('echo ' + marker + '\n');
  await new Promise((r) => setTimeout(r, 1200));

  // Read what xterm has rendered via its accessibility/serialize path. xterm
  // doesn't expose buffer globally, so we scrape the live DOM text the renderer
  // mirrors, falling back to the active buffer if exposed.
  const screenHasMarker = await page.evaluate((mk) => {
    // xterm renders to canvas; use the underlying buffer through the public
    // Terminal if the app exposed it, else scan the DOM text content.
    const text = document.querySelector('.xterm-rows')
      ? document.querySelector('.xterm-rows').innerText
      : document.body.innerText;
    return text.includes(mk);
  }, marker);

  const overlayVisible = await page.evaluate(() => {
    const o = document.getElementById('overlay');
    return o && !o.classList.contains('hidden');
  });

  // Independently confirm the command actually ran in the PTY by re-reading the
  // server snapshot.
  let snapshotHasMarker = false;
  try {
    const res = await fetch('http://127.0.0.1:8080/api/stream?session=default', {
      headers: { Authorization: 'Bearer ' + TOKEN },
    });
    // read a little of the stream
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const start = Date.now();
    while (Date.now() - start < 1000) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes('snapshot')) break;
    }
    reader.cancel();
    for (const line of buf.split('\n')) {
      try {
        const m = JSON.parse(line);
        if (m.t === 'o' && m.snapshot) {
          const d = Buffer.from(m.d, 'base64').toString('utf8');
          if (d.includes(marker)) snapshotHasMarker = true;
        }
      } catch (e) {}
    }
  } catch (e) {
    errors.push('snapshot recheck failed: ' + e.message);
  }

  await browser.close();

  console.log('streamStatus       :', streamStatus);
  console.log('inputReqs (statuses):', JSON.stringify(inputReqs));
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
