'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const MAX_FILENAME_HEADER_CHARS = 4096;
const MAX_FILENAME_BYTES = 220;
const MAX_COLLISION_ATTEMPTS = 100;
const activeUploadPaths = new Set();

const CONTENT_TYPE_EXTENSIONS = new Map([
  ['image/gif', '.gif'],
  ['image/heic', '.heic'],
  ['image/heif', '.heif'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = '';
  let bytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char);
    if (bytes + charBytes > maxBytes) break;
    result += char;
    bytes += charBytes;
  }
  return result;
}

function decodeFilenameHeader(value) {
  if (typeof value !== 'string' || value === '') return '';
  if (value.length > MAX_FILENAME_HEADER_CHARS) throw new Error('bad filename');
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error('bad filename');
  }
}

function fallbackName(contentType) {
  const type = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  return 'upload' + (CONTENT_TYPE_EXTENSIONS.get(type) || '');
}

function sanitizeFilename(originalName, contentType) {
  let name = String(originalName || '').normalize('NFC');
  name = name.replace(/[\\/\u0000-\u001f\u007f]/g, '_');
  if (!name || name === '.' || name === '..') name = fallbackName(contentType);

  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  const safeExt = truncateUtf8(ext, 64);
  const stemBytes = Math.max(1, MAX_FILENAME_BYTES - Buffer.byteLength(safeExt));
  const safeStem = truncateUtf8(stem, stemBytes) || 'upload';
  return safeStem + safeExt;
}

function collisionName(name, suffix) {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  return `${stem}-${suffix}${ext}`;
}

async function openUploadTarget(
  directory,
  name,
  { open = fs.promises.open, randomBytes = crypto.randomBytes } = {}
) {
  for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt++) {
    const candidate = attempt === 0 ? name : collisionName(name, randomBytes(4).toString('hex'));
    const targetPath = path.join(directory, candidate);
    try {
      const file = await open(targetPath, 'wx', 0o600);
      return { file, path: targetPath };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('too many filename collisions');
}

function writeRequestToFile(req, writable, limit = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let settled = false;

    function cleanup() {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      req.off('error', onRequestError);
      writable.off('drain', onDrain);
      writable.off('finish', onFinish);
      writable.off('error', onWriteError);
    }

    function finish(err) {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(bytes);
    }

    function fail(code, message) {
      const err = new Error(message);
      err.code = code;
      writable.destroy();
      finish(err);
      req.resume?.();
    }

    function onData(chunk) {
      bytes += chunk.length;
      if (bytes > limit) {
        fail('UPLOAD_TOO_LARGE', 'payload too large');
        return;
      }
      if (!writable.write(chunk)) req.pause?.();
    }

    function onDrain() {
      req.resume?.();
    }

    function onEnd() {
      writable.end();
    }

    function onAborted() {
      fail('UPLOAD_ABORTED', 'upload aborted');
    }

    function onRequestError(err) {
      writable.destroy();
      finish(err);
    }

    function onWriteError(err) {
      finish(err);
      req.resume?.();
    }

    function onFinish() {
      finish();
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('aborted', onAborted);
    req.on('error', onRequestError);
    writable.on('drain', onDrain);
    writable.on('finish', onFinish);
    writable.on('error', onWriteError);
  });
}

async function receiveUpload(
  req,
  {
    directory = '/tmp',
    limit = MAX_UPLOAD_BYTES,
    filename = decodeFilenameHeader(req.headers['x-webterm-filename']),
    contentType = req.headers['x-webterm-file-type'] || req.headers['content-type'],
  } = {}
) {
  const contentLength = Number.parseInt(req.headers['content-length'] || '', 10);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    req.resume();
    const err = new Error('payload too large');
    err.code = 'UPLOAD_TOO_LARGE';
    throw err;
  }

  const safeName = sanitizeFilename(filename, contentType);
  const target = await openUploadTarget(directory, safeName);
  activeUploadPaths.add(target.path);
  try {
    const bytes = await writeRequestToFile(req, target.file.createWriteStream(), limit);
    activeUploadPaths.delete(target.path);
    return { bytes, path: target.path };
  } catch (err) {
    activeUploadPaths.delete(target.path);
    await target.file.close().catch(() => {});
    await fs.promises.unlink(target.path).catch(() => {});
    throw err;
  }
}

function cleanupActiveUploadsSync() {
  for (const targetPath of activeUploadPaths) {
    try {
      fs.unlinkSync(targetPath);
    } catch (err) {
      if (err?.code !== 'ENOENT') console.error(`Failed to clean partial upload ${targetPath}:`, err);
    }
  }
  activeUploadPaths.clear();
}

module.exports = {
  MAX_UPLOAD_BYTES,
  cleanupActiveUploadsSync,
  collisionName,
  decodeFilenameHeader,
  openUploadTarget,
  receiveUpload,
  sanitizeFilename,
  truncateUtf8,
  writeRequestToFile,
};
