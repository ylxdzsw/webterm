'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { Session, resolveShell } = require('../src/session');
const { createStreamSubscriber } = require('../src/stream-subscriber');

function fakeDeps(shell, opts = {}) {
  return {
    os: {
      userInfo() {
        return { shell, username: 'testuser', uid: 1000 };
      },
    },
    fs: {
      constants: { X_OK: 1 },
      accessSync(file) {
        if (opts.notExecutable || file === opts.notExecutablePath) {
          throw new Error('EACCES');
        }
      },
    },
  };
}

function createTestSession(cols = 5, rows = 3) {
  const session = Object.create(Session.prototype);
  session.cols = cols;
  session.rows = rows;
  session.bytes = 0;
  session._pendingHeadlessWrites = 0;
  session.subscribers = new Set();
  session.ended = false;
  session.exitCode = null;
  session.command = '/bin/bash -l';
  session.title = '';
  session.headless = new Terminal({
    cols,
    rows,
    allowProposedApi: true,
    scrollback: 100,
  });
  session.serializer = new SerializeAddon();
  session.headless.loadAddon(session.serializer);
  session.onExit = null;
  return session;
}

function writeHeadless(term, data) {
  return new Promise((resolve) => term.write(data, resolve));
}

function testResolveShell() {
  const resolved = resolveShell(fakeDeps('/bin/bash'));
  assert.deepStrictEqual(resolved, {
    file: '/bin/bash',
    args: ['-l'],
    command: '/bin/bash -l',
  });

  assert.throws(
    () => resolveShell(fakeDeps('')),
    /Login shell is missing in passwd/
  );
  assert.throws(
    () => resolveShell(fakeDeps('/bin/nope', { notExecutable: true })),
    /Login shell "\/bin\/nope" is not executable/
  );
}

async function testSnapshotAttachOrdering() {
  const session = createTestSession(80, 24);

  try {
    const liveLines = [];
    session._onData('before');
    const readyPromise = new Promise((resolve) => {
      session.attachSubscriber(
        {
          send(line) {
            liveLines.push(line);
          },
          end() {},
        },
        resolve
      );
    });
    session._onData('during');

    const ready = await readyPromise;
    assert.match(ready.snapshot, /before/);
    assert.match(ready.snapshot, /during/);
    assert.strictEqual(liveLines.length, 0);

    ready.markSnapshotSent();
    ready.release();
    assert.strictEqual(liveLines.length, 0);
  } finally {
    session.headless.dispose();
  }
}

async function testLiveFramesTrackHeadlessState() {
  const session = createTestSession(80, 24);

  try {
    const liveLines = [];
    session.subscribers.add({
      send(line) {
        liveLines.push(line);
      },
    });

    session._onData('visible\n');
    await new Promise((resolve) => session._whenHeadlessDrained(resolve));
    assert.match(session.snapshot(), /visible/);
    assert.strictEqual(liveLines.length, 1);
    assert.strictEqual(Buffer.from(JSON.parse(liveLines[0]).d, 'base64').toString('utf8'), 'visible\n');
  } finally {
    session.headless.dispose();
  }
}

async function testAttachBuffersOnlyPostSnapshotOutput() {
  const session = createTestSession(80, 24);

  try {
    const liveLines = [];
    const ready = await new Promise((resolve) => {
      session.attachSubscriber(
        {
          send(line) {
            liveLines.push(line);
          },
          end() {},
        },
        resolve
      );
    });

    ready.markSnapshotSent();
    session._onData('after-snapshot\n');
    await new Promise((resolve) => session._whenHeadlessDrained(resolve));
    ready.release();
    assert.strictEqual(liveLines.length, 1);
    assert.strictEqual(
      Buffer.from(JSON.parse(liveLines[0]).d, 'base64').toString('utf8'),
      'after-snapshot\n'
    );
  } finally {
    session.headless.dispose();
  }
}
async function testAttachDrainIncludesConcurrentOutput() {
  const session = createTestSession(80, 24);

  try {
    const liveLines = [];
    const readyPromise = new Promise((resolve) => {
      session.attachSubscriber(
        {
          send(line) {
            liveLines.push(line);
          },
          end() {},
        },
        resolve
      );
    });
    for (let i = 0; i < 20; i++) {
      session._onData('line' + i + '\n');
    }
    const ready = await readyPromise;

    const snapLines = (ready.snapshot.match(/line\d+/g) || []).length;
    ready.markSnapshotSent();
    ready.release();

    assert.strictEqual(snapLines, 20);
    assert.strictEqual(liveLines.length, 0);
    assert.strictEqual(session.snapshot().match(/line\d+/g).length, 20);
  } finally {
    session.headless.dispose();
  }
}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.blockWrites = false;
    this.writes = [];
    this.ended = false;
  }

  write(line) {
    this.writes.push(line);
    return !this.blockWrites;
  }

  end() {
    this.ended = true;
  }
}

function testStreamBackpressure() {
  const res = new FakeResponse();
  const sub = createStreamSubscriber(res, { maxBufferBytes: 32 });
  res.blockWrites = true;
  sub.send('first');
  sub.send('second');
  assert.strictEqual(sub.queuedBytes, Buffer.byteLength('second'));
  assert.deepStrictEqual(res.writes, ['first']);

  res.blockWrites = false;
  res.emit('drain');
  assert.strictEqual(sub.queuedBytes, 0);
  assert.deepStrictEqual(res.writes, ['first', 'second']);
}

function testStreamOverflow() {
  let closed = 0;
  const res = new FakeResponse();
  const sub = createStreamSubscriber(res, {
    maxBufferBytes: 5,
    onClose() {
      closed += 1;
    },
  });
  res.blockWrites = true;
  sub.send('first');
  sub.send('1234');
  sub.send('56');
  assert.strictEqual(res.ended, true);
  assert.strictEqual(closed, 1);
}

async function testVisibleTextAndStructuredState() {
  const session = createTestSession(5, 3);
  try {
    await writeHeadless(session.headless, 'hello\nworld\nfoo\nbar');

    assert.strictEqual(session.visibleText(), '    f\noo\n  bar');

    const state = session.describeState(2);
    assert.strictEqual(state.activeBuffer, 'normal');
    assert.deepStrictEqual(state.cursor, { x: 5, y: 2 });
    assert.deepStrictEqual(state.buffers.active.rows, [
      { index: 3, wrapped: false, text: '    f' },
      { index: 4, wrapped: true, text: 'oo' },
      { index: 5, wrapped: false, text: '  bar' },
    ]);
    assert.deepStrictEqual(state.buffers.normal.tailRows, [
      { index: 4, wrapped: true, text: 'oo' },
      { index: 5, wrapped: false, text: '  bar' },
    ]);
  } finally {
    session.headless.dispose();
  }
}

async function testAlternateBufferStateIncludesNormalTail() {
  const session = createTestSession(10, 3);
  try {
    await writeHeadless(session.headless, 'line1\nline2\nline3\nline4');
    await writeHeadless(session.headless, '\x1b[?1049hHELLO');

    const state = session.describeState(3);
    assert.strictEqual(state.activeBuffer, 'alternate');
    assert.deepStrictEqual(state.buffers.active.rows, [
      { index: 0, wrapped: false, text: '' },
      { index: 1, wrapped: false, text: '         H' },
      { index: 2, wrapped: true, text: 'ELLO' },
    ]);
    assert.deepStrictEqual(state.buffers.normal.tailRows, [
      { index: 2, wrapped: false, text: '         l' },
      { index: 3, wrapped: true, text: 'ine3' },
      { index: 4, wrapped: false, text: '    line4' },
    ]);
  } finally {
    session.headless.dispose();
  }
}

async function testEndedSessionStillReadable() {
  const session = createTestSession(8, 3);
  try {
    await writeHeadless(session.headless, 'prompt\nresult');
    session._onExit(7);

    assert.strictEqual(session.ended, true);
    assert.strictEqual(session.exitCode, 7);
    assert.match(session.visibleText(), /prompt/);
    assert.strictEqual(session.describeState(5).exitCode, 7);
  } finally {
    session.headless.dispose();
  }
}

(async () => {
  testResolveShell();
  await testSnapshotAttachOrdering();
  await testLiveFramesTrackHeadlessState();
  await testAttachDrainIncludesConcurrentOutput();
  await testAttachBuffersOnlyPostSnapshotOutput();
  await testVisibleTextAndStructuredState();
  await testAlternateBufferStateIncludesNormalTail();
  await testEndedSessionStillReadable();
  testStreamBackpressure();
  testStreamOverflow();
  console.log('UNIT: PASS');
  process.exit(0);
})().catch((e) => {
  console.error('UNIT: FAIL');
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
