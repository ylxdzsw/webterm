'use strict';

// Headless-Chrome test for the multi-session lobby. Exercises: lobby on load,
// creating a session via the Advanced form (custom command + id), attaching,
// the terminal title propagating to the page, the two-click Kill from a second
// page, and the Restart overlay when a session's program exits.
//
// Run with the server up on 127.0.0.1:8080 and WEBTERM_TOKEN=testtoken.

const puppeteer = require('puppeteer-core');

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:8080/';
const TOKEN = process.env.SMOKE_TOKEN || 'testtoken';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';

const checks = [];
function check(name, cond) {
  checks.push({ name, ok: !!cond });
  console.log((cond ? 'ok   ' : 'FAIL ') + name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const ctx = async () => {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument((tok) => {
      localStorage.setItem('webterm_token', tok);
    }, TOKEN);
    page.on('pageerror', (e) => check('no pageerror: ' + e.message, false));
    return page;
  };

  // --- Lobby shows on load, create via Advanced (custom command + id).
  const page = await ctx();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#lobby', { visible: true });
  const lobbyShown = await page.evaluate(
    () => !document.getElementById('lobby').classList.contains('hidden')
  );
  check('lobby visible on load (no ?session=)', lobbyShown);

  // Expand Advanced, set a custom command that sets a title then sleeps, and a
  // custom id.
  await page.click('#create-advanced summary');
  await page.type('#create-command', 'sh -c \'printf "\\033]0;MYTITLE\\007"; sleep 30\'');
  await page.type('#create-id', 'titletest');
  await page.click('#create-btn');

  await page.waitForFunction(
    () => new URLSearchParams(location.search).get('session') === 'titletest',
    { timeout: 5000 }
  );
  check('attached to custom id titletest', true);
  await sleep(800);
  const docTitle = await page.evaluate(() => document.title);
  check('terminal title propagated to document.title', /MYTITLE/.test(docTitle));

  // --- Second page sees the session in the lobby; two-click kill removes it.
  const page2 = await ctx();
  await page2.goto(URL, { waitUntil: 'domcontentloaded' });
  await page2.waitForSelector('#lobby', { visible: true });
  await sleep(300);
  const rowInfo = await page2.evaluate(() => {
    const rows = [...document.querySelectorAll('.session-row')];
    const row = rows.find((r) => r.querySelector('.name').textContent.startsWith('titletest'));
    return row ? { name: row.querySelector('.name').textContent } : null;
  });
  check('lobby lists titletest', rowInfo !== null);
  check('lobby row shows the title', rowInfo && /MYTITLE/.test(rowInfo.name));

  // First Kill click arms (text -> Confirm); second click kills.
  const armed = await page2.evaluate(() => {
    const rows = [...document.querySelectorAll('.session-row')];
    const row = rows.find((r) => r.querySelector('.name').textContent.startsWith('titletest'));
    const btn = row.querySelector('button');
    btn.click();
    return btn.textContent;
  });
  check('first Kill click arms confirm', /confirm/i.test(armed));
  await page2.evaluate(() => {
    const rows = [...document.querySelectorAll('.session-row')];
    const row = rows.find((r) => r.querySelector('.name').textContent.startsWith('titletest'));
    row.querySelector('button').click();
  });
  await sleep(600);
  const goneFromList = await page2.evaluate(
    () =>
      ![...document.querySelectorAll('.session-row')].some((r) =>
        r.querySelector('.name').textContent.startsWith('titletest')
      )
  );
  check('two-click kill removes the session from the lobby', goneFromList);

  // The killed session's attached page (page) is notified like any exit: it
  // shows the Restart overlay (a kill is just a terminated program).
  await sleep(1000);
  const page1Restart = await page.evaluate(() => {
    const o = document.getElementById('overlay');
    return (
      o &&
      !o.classList.contains('hidden') &&
      /ended/i.test(document.getElementById('overlay-title').textContent) &&
      [...document.querySelectorAll('#overlay-actions *')].some((n) => /restart/i.test(n.textContent))
    );
  });
  check('killed session: attached page shows Restart overlay', page1Restart);

  // --- Exit shows the Restart overlay.
  const page3 = await ctx();
  await page3.goto(URL, { waitUntil: 'domcontentloaded' });
  await page3.waitForSelector('#create-btn', { visible: true });
  await page3.type('#create-command', 'sh -c \'sleep 0.4; exit 5\'');
  await page3.click('#create-btn');
  await page3.waitForFunction(
    () => {
      const o = document.getElementById('overlay');
      return o && !o.classList.contains('hidden') && /ended/i.test(
        document.getElementById('overlay-title').textContent
      );
    },
    { timeout: 6000 }
  );
  const hasRestart = await page3.evaluate(() =>
    [...document.querySelectorAll('#overlay-actions *')].some((n) => /restart/i.test(n.textContent))
  );
  check('program exit shows Restart overlay', hasRestart);

  await browser.close();

  const failed = checks.filter((c) => !c.ok);
  console.log('\n' + (failed.length ? 'LOBBY: FAIL' : 'LOBBY: PASS'));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('lobby test crashed:', e);
  process.exit(2);
});
