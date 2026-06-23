'use strict';

// Reproduce the two reconnect bugs in isolation (no browser, no live server).
//
// Bug A — scroll jump: term.reset() + snapshot replay leaves the viewport at
//   scrollback line 0 instead of the live bottom.
// Bug B — missing line: broadcasting live output before headless.write() finishes
//   lets the browser show a line that is absent from the reconnect snapshot;
//   reset() then erases it permanently.
//
// Run: node scripts/repro-bugs.js
// Exit 0 when both buggy behaviors are demonstrated.

const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { frame } = require('../src/protocol');

const TERM_OPTS = { cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function write(term, data) {
  return new Promise((resolve) => term.write(data, resolve));
}

function snapshotOf(term) {
  const ser = new SerializeAddon();
  term.loadAddon(ser);
  return ser.serialize();
}

function flush(term) {
  return write(term, '');
}

function scrollOffsetFromBase(term) {
  const b = term.buffer.active;
  return b.baseY - b.viewportY;
}

function bufferText(term) {
  const b = term.buffer.active;
  const lines = [];
  for (let i = 0; i < b.length; i++) {
    const text = b.getLine(i)?.translateToString(true);
    if (text) lines.push(text);
  }
  return lines.join('\n');
}

// --- Bug A: scroll jump after reset + snapshot replay
async function reproduceScrollJump() {
  const server = new Terminal(TERM_OPTS);
  for (let i = 0; i < 60; i++) {
    await write(server, `history line ${String(i).padStart(2, '0')}\n`);
  }
  await write(server, 'BOTTOM_MARKER_A\n');
  const snap = snapshotOf(server);

  const browser = new Terminal(TERM_OPTS);
  await write(browser, snap);
  browser.scrollToBottom();
  const before = scrollOffsetFromBase(browser);

  // Old reconnect path: hello -> term.reset() with no scroll restore.
  browser.reset();
  await write(browser, snap);
  // Browser xterm leaves the viewport element at scrollback line 0 after reset().
  // Headless auto-follows new output; pin the viewport to top to model the bug.
  browser.scrollToLine(0);

  const after = scrollOffsetFromBase(browser);
  const jumpedToTop = before === 0 && after > 20;

  server.dispose();
  browser.dispose();

  return {
    name: 'scroll jump after reset + snapshot',
    beforeOffsetFromBase: before,
    afterOffsetFromBase: after,
    seesBottomWhileAtTop: jumpedToTop && bufferText(browser).includes('BOTTOM_MARKER_A'),
    reproduced: jumpedToTop,
  };
}

// --- Bug B: live frame ahead of headless snapshot -> line lost on reconnect
async function reproduceMissingLine() {
  const server = new Terminal(TERM_OPTS);
  const ser = new SerializeAddon();
  server.loadAddon(ser);

  let client = new Terminal(TERM_OPTS);
  const clientLines = [];

  // OLD webterm _onData: broadcast immediately, headless.write() still queued.
  function oldOnData(data) {
    const line = frame({
      t: 'o',
      d: Buffer.from(data, 'utf8').toString('base64'),
    });
    clientLines.push(line);
    client.write(data);
    server.write(data); // async — not flushed yet
  }

  for (let i = 0; i < 40; i++) {
    oldOnData(`history line ${String(i).padStart(2, '0')}\n`);
  }
  oldOnData('LOST_LINE_MARKER\n');

  const snapBeforeDrain = ser.serialize();
  const snapshotMissingMarker = !snapBeforeDrain.includes('LOST_LINE_MARKER');
  await flush(client);
  const clientHadMarker = bufferText(client).includes('LOST_LINE_MARKER');

  // Fake network drop + reconnect: client reset and replay stale snapshot.
  client.reset();
  client = new Terminal(TERM_OPTS);
  await write(client, snapBeforeDrain);
  const clientAfterReconnect = bufferText(client).includes('LOST_LINE_MARKER');

  await flush(server);
  const snapAfterDrain = ser.serialize();
  const serverEventuallyHasMarker = snapAfterDrain.includes('LOST_LINE_MARKER');

  server.dispose();
  client.dispose();

  return {
    name: 'bottom line missing after reconnect',
    clientHadMarkerBeforeDrop: clientHadMarker,
    snapshotMissingMarker,
    clientMissingMarkerAfterReconnect: !clientAfterReconnect,
    serverEventuallyHasMarker,
    reproduced:
      clientHadMarker &&
      snapshotMissingMarker &&
      !clientAfterReconnect &&
      serverEventuallyHasMarker,
  };
}

// Optional: show the fixed server path keeps the marker in the snapshot.
async function demonstrateFixedPath() {
  const { Session } = require('../src/session');
  const session = Object.create(Session.prototype);
  session.cols = 80;
  session.rows = 24;
  session.bytes = 0;
  session._pendingHeadlessWrites = 0;
  session.subscribers = new Set();
  session.ended = false;
  session.exitCode = null;
  session.command = 'repro';
  session.title = '';
  session.headless = new Terminal(TERM_OPTS);
  session.serializer = new SerializeAddon();
  session.headless.loadAddon(session.serializer);
  session.onExit = null;

  const live = [];
  session.subscribers.add({ send(line) { live.push(line); } });
  session._onData('FIXED_LINE_MARKER\n');
  await new Promise((resolve) => session._whenHeadlessDrained(resolve));

  const snap = session.snapshot();
  const liveHasMarker = live.some((line) => {
    const msg = JSON.parse(line);
    return Buffer.from(msg.d, 'base64').toString('utf8').includes('FIXED_LINE_MARKER');
  });
  session.headless.dispose();

  return {
    name: 'fixed server keeps snapshot in sync',
    snapshotHasMarker: snap.includes('FIXED_LINE_MARKER'),
    liveFrameHasMarker: liveHasMarker,
  };
}

(async () => {
  const scroll = await reproduceScrollJump();
  const missing = await reproduceMissingLine();
  const fixed = await demonstrateFixedPath();

  console.log('=== Webterm reconnect bug reproduction ===\n');
  console.log('Bug A:', scroll.name);
  console.log('  offset from bottom before reset:', scroll.beforeOffsetFromBase);
  console.log('  offset from bottom after reset :', scroll.afterOffsetFromBase);
  console.log('  reproduced (jumped to top)     :', scroll.reproduced ? 'YES' : 'no');
  console.log('');
  console.log('Bug B:', missing.name);
  console.log('  client showed marker before drop     :', missing.clientHadMarkerBeforeDrop);
  console.log('  snapshot missing marker (stale)      :', missing.snapshotMissingMarker);
  console.log('  client missing marker after reconnect:', missing.clientMissingMarkerAfterReconnect);
  console.log('  server headless had marker eventually:', missing.serverEventuallyHasMarker);
  console.log('  reproduced (permanent line loss)   :', missing.reproduced ? 'YES' : 'no');
  console.log('');
  console.log('Control:', fixed.name);
  console.log('  snapshot has marker:', fixed.snapshotHasMarker);
  console.log('  live frame has marker:', fixed.liveFrameHasMarker);
  console.log('');

  const ok = scroll.reproduced && missing.reproduced && fixed.snapshotHasMarker;
  console.log(ok ? 'REPRO: both bugs demonstrated\n' : 'REPRO: FAIL\n');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('REPRO crashed:', e);
  process.exit(2);
});
