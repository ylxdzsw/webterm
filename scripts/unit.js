'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { Session, resolveShell } = require('../src/session');
const {
  DEFAULT_BUFFER_BYTES,
  createStreamSubscriber,
  parseBufferLimit,
} = require('../src/stream-subscriber');

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

function testResolveShell() {
  const oldCmd = process.env.WEBTERM_CMD;
  const oldArgs = process.env.WEBTERM_ARGS;
  try {
    process.env.WEBTERM_CMD = '/bin/false';
    process.env.WEBTERM_ARGS = '--ignored';

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
  } finally {
    if (oldCmd === undefined) delete process.env.WEBTERM_CMD;
    else process.env.WEBTERM_CMD = oldCmd;
    if (oldArgs === undefined) delete process.env.WEBTERM_ARGS;
    else process.env.WEBTERM_ARGS = oldArgs;
  }
}

async function testSnapshotAttachOrdering() {
  const session = Object.create(Session.prototype);
  session.cols = 80;
  session.rows = 24;
  session.bytes = 0;
  session.subscribers = new Set();
  session.ended = false;
  session.exitCode = null;
  session.command = '/bin/bash -l';
  session.title = '';
  session.headless = new Terminal({
    cols: session.cols,
    rows: session.rows,
    allowProposedApi: true,
    scrollback: 100,
  });
  session.serializer = new SerializeAddon();
  session.headless.loadAddon(session.serializer);

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
    assert.doesNotMatch(ready.snapshot, /during/);
    assert.strictEqual(liveLines.length, 0);

    ready.release();
    assert.strictEqual(liveLines.length, 1);
    const msg = JSON.parse(liveLines[0]);
    assert.strictEqual(msg.t, 'o');
    assert.strictEqual(Buffer.from(msg.d, 'base64').toString('utf8'), 'during');
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

function testParseBufferLimit() {
  assert.strictEqual(parseBufferLimit('123'), 123);
  assert.strictEqual(parseBufferLimit('0'), DEFAULT_BUFFER_BYTES);
  assert.strictEqual(parseBufferLimit('not-a-number'), DEFAULT_BUFFER_BYTES);
}

(async () => {
  testResolveShell();
  await testSnapshotAttachOrdering();
  testStreamBackpressure();
  testStreamOverflow();
  testParseBufferLimit();
  console.log('UNIT: PASS');
})().catch((e) => {
  console.error('UNIT: FAIL');
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
