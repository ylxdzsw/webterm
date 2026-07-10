'use strict';

// End-to-end mobile touch scrolling against real terminal programs.
//
// This drives the shell through webterm, starts actual TUIs, performs mobile
// touch swipes, and verifies the visible terminal content changes enough to be
// useful. It intentionally checks screen movement, not just raw wheel packets.

const puppeteer = require('puppeteer-core');
const { dispatchTouchSwipe, sleep, terminalPoint, waitFor } = require('./browser-test-utils');

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:8080/';
const BASE = URL.replace(/\/$/, '');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';

async function visibleText(page) {
  return page.evaluate(() => document.querySelector('.xterm-rows')?.innerText || '');
}

async function serverText() {
  const res = await fetch(BASE + '/api/state?tailRows=40');
  if (!res.ok) throw new Error('state request failed: ' + res.status);
  const state = await res.json();
  return state.buffers.active.rows.map((row) => row.text).join('\n');
}

async function serverSummary() {
  const res = await fetch(BASE + '/api/state?tailRows=40');
  if (!res.ok) throw new Error('state request failed: ' + res.status);
  const state = await res.json();
  return {
    activeBuffer: state.activeBuffer,
    cursor: state.cursor,
    rows: state.buffers.active.rows.map((row) => row.text),
    normalTail: state.buffers.normal.tailRows.map((row) => row.text),
  };
}

function firstMarker(text, prefix) {
  const re = new RegExp(prefix + '_(\\d{3})');
  const match = re.exec(text);
  return match ? Number.parseInt(match[1], 10) : null;
}

function commandLiteral(command) {
  return command + "\n";
}

async function sendInput(data) {
  const res = await fetch(BASE + '/api/input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream; charset=utf-8' },
    body: Buffer.from(data, 'utf8'),
  });
  if (!res.ok) throw new Error('input request failed: ' + res.status);
}

async function runCommand(command, readyPattern, timeoutMs = 10000) {
  await sendInput(commandLiteral(command));
  const ready = await waitFor(async () => readyPattern.test(await serverText()), timeoutMs);
  if (!ready) {
    throw new Error(
      'command did not become ready: ' +
        command +
        '\nstate: ' +
        JSON.stringify(await serverSummary())
    );
  }
}

async function createFixture(file, prefix) {
  const readyMarker = `FIXTURE_READY_${Date.now()}`;
  const script = `for i in $(seq -w 1 260); do printf '${prefix}_%s\\n' "$i"; done > ${file}; printf '${readyMarker}\\n'`;
  await runCommand(script, new RegExp(readyMarker), 10000);
}

async function testLess(page) {
  const prefix = 'LESS_SCROLL_LINE';
  const file = `/tmp/webterm-mobile-less-${Date.now()}.txt`;
  await createFixture(file, prefix);
  await runCommand(`less -S -R ${JSON.stringify(file)}`, /LESS_SCROLL_LINE_001/, 10000);

  const point = await terminalPoint(page);
  const beforeText = await serverText();
  const before = firstMarker(beforeText, prefix);
  await dispatchTouchSwipe(page, point, { x: point.x, y: point.y - 360 }, 12, 12);
  await sleep(1400);
  const afterText = await serverText();
  const after = firstMarker(afterText, prefix);
  await sendInput('q');
  await sleep(300);
  await sendInput(commandLiteral(`rm -f ${file}`));
  await sleep(300);

  return { name: 'less -S', before, after, moved: after != null && before != null ? after - before : null };
}

async function testVim(page) {
  const prefix = 'VIM_SCROLL_LINE';
  const file = `/tmp/webterm-mobile-vim-${Date.now()}.txt`;
  await createFixture(file, prefix);
  await runCommand(`vim -Nu NONE -n ${file}`, /VIM_SCROLL_LINE_001/, 10000);

  const point = await terminalPoint(page);
  const beforeText = await serverText();
  const before = firstMarker(beforeText, prefix);
  await dispatchTouchSwipe(page, point, { x: point.x, y: point.y - 360 }, 12, 12);
  await sleep(1400);
  const afterText = await serverText();
  const after = firstMarker(afterText, prefix);
  await sendInput('\x1b:qa!\r');
  await sleep(500);
  await sendInput(commandLiteral(`rm -f ${file}`));
  await sleep(300);

  return { name: 'vim', before, after, moved: after != null && before != null ? after - before : null };
}

(async () => {
  const errors = [];
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

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.xterm-rows') != null, {
    timeout: 8000,
  });
  await sleep(1200);

  const results = [];
  try {
    results.push(await testLess(page));
    results.push(await testVim(page));
  } catch (e) {
    errors.push(e && e.stack ? e.stack : String(e));
  }

  await browser.close();

  for (const result of results) {
    console.log(`${result.name} before/after/moved:`, result.before, result.after, result.moved);
    if (!Number.isFinite(result.moved) || result.moved < 30) {
      errors.push(`${result.name} touch swipe moved too little: ` + JSON.stringify(result));
    }
  }
  console.log('jsErrors:', errors.length ? errors : 'none');

  const ok = errors.length === 0;
  console.log(ok ? '\nMOBILE-TUI-SCROLL: PASS' : '\nMOBILE-TUI-SCROLL: FAIL');
  if (!ok) {
    for (const err of errors) console.error(' -', err);
  }
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('mobile TUI scroll test crashed:', e);
  process.exit(2);
});
