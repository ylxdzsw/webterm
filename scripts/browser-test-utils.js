'use strict';

const puppeteer = require('puppeteer-core');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs = 5000, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await sleep(intervalMs);
  }
  return false;
}

function launchBrowser() {
  return puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
}

function touchPoint(x, y) {
  return { x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 };
}

async function dispatchTouchSwipe(page, start, end, steps = 8, stepMs = 16) {
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
    await sleep(stepMs);
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

module.exports = { dispatchTouchSwipe, launchBrowser, sleep, terminalPoint, touchPoint, waitFor };
