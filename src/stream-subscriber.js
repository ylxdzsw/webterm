'use strict';

const DEFAULT_BUFFER_BYTES = 4 * 1024 * 1024;

function parseBufferLimit(value) {
  const n = Number.parseInt(value ?? String(DEFAULT_BUFFER_BYTES), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BUFFER_BYTES;
  return n;
}

function createStreamSubscriber(
  res,
  { maxBufferBytes = DEFAULT_BUFFER_BYTES, onClose = () => {} } = {}
) {
  let queue = [];
  let queuedBytes = 0;
  let waitingForDrain = false;
  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    queue = [];
    queuedBytes = 0;
    res.off('drain', flush);
    try {
      res.end();
    } catch (e) {
      /* peer may already be gone */
    }
    onClose();
  }

  function writeNow(line) {
    try {
      waitingForDrain = !res.write(line);
    } catch (e) {
      close();
    }
  }

  function enqueue(line) {
    const size = Buffer.byteLength(line, 'utf8');
    if (queuedBytes + size > maxBufferBytes) {
      close();
      return;
    }
    queue.push({ line, size });
    queuedBytes += size;
  }

  function flush() {
    waitingForDrain = false;
    while (!closed && queue.length && !waitingForDrain) {
      const item = queue.shift();
      queuedBytes -= item.size;
      writeNow(item.line);
    }
  }

  res.on('drain', flush);

  return {
    send(line) {
      if (closed) return;
      if (waitingForDrain || queue.length) {
        enqueue(line);
        return;
      }
      writeNow(line);
    },
    end: close,
    close,
    get queuedBytes() {
      return queuedBytes;
    },
  };
}

module.exports = {
  DEFAULT_BUFFER_BYTES,
  createStreamSubscriber,
  parseBufferLimit,
};
