'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const sea = require('node:sea');

const EMBEDDED_PTY_FILES = Object.freeze([
  'package.json',
  'lib/index.js',
  'lib/utils.js',
  'lib/terminal.js',
  'lib/eventEmitter2.js',
  'lib/unixTerminal.js',
  'build/Release/pty.node',
]);

const runtimeDirs = new Set();
let cleanupRegistered = false;

function cleanupPtyRuntimeSync() {
  for (const directory of runtimeDirs) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  runtimeDirs.clear();
}

function loadEmbeddedPty(readAsset, runtimeRoot = process.env.RUNTIME_DIRECTORY || os.tmpdir()) {
  if (process.platform !== 'linux') {
    throw new Error(`Embedded node-pty is not supported on ${process.platform}`);
  }

  const runtimeDir = fs.mkdtempSync(path.join(runtimeRoot, 'webterm-pty-'));
  const packageDir = path.join(runtimeDir, 'node-pty');
  runtimeDirs.add(runtimeDir);

  try {
    for (const file of EMBEDDED_PTY_FILES) {
      const target = path.join(packageDir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, readAsset(`node-pty/${file}`), { mode: 0o600 });
    }

    if (!cleanupRegistered) {
      cleanupRegistered = true;
      process.once('exit', cleanupPtyRuntimeSync);
    }

    return createRequire(path.join(packageDir, 'package.json'))('./');
  } catch (err) {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    runtimeDirs.delete(runtimeDir);
    throw err;
  }
}

const pty = sea.isSea()
  ? loadEmbeddedPty((key) => new Uint8Array(sea.getRawAsset(key)))
  : require('node-pty');

module.exports = {
  EMBEDDED_PTY_FILES,
  cleanupPtyRuntimeSync,
  loadEmbeddedPty,
  pty,
};
