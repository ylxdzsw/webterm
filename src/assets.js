'use strict';

const fs = require('fs');
const path = require('path');
const sea = require('node:sea');

const ROOT = path.join(__dirname, '..');
const SOURCE_ASSETS = new Map([
  ['public/index.html', path.join(ROOT, 'public', 'index.html')],
  ['public/app.js', path.join(ROOT, 'public', 'app.js')],
  ['public/style.css', path.join(ROOT, 'public', 'style.css')],
  ['public/favicon.svg', path.join(ROOT, 'public', 'favicon.svg')],
  ['public/apple-touch-icon.png', path.join(ROOT, 'public', 'apple-touch-icon.png')],
  [
    'vendor/xterm.js',
    path.join(ROOT, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'),
  ],
  [
    'vendor/xterm.css',
    path.join(ROOT, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
  ],
  [
    'vendor/addon-fit.js',
    path.join(ROOT, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'),
  ],
]);

const ASSET_KEYS = Object.freeze([...SOURCE_ASSETS.keys()]);
const STATIC_ROUTES = new Map([
  ['/', 'public/index.html'],
  ['/index.html', 'public/index.html'],
  ['/app.js', 'public/app.js'],
  ['/style.css', 'public/style.css'],
  ['/favicon.svg', 'public/favicon.svg'],
  ['/apple-touch-icon.png', 'public/apple-touch-icon.png'],
  ['/vendor/xterm.js', 'vendor/xterm.js'],
  ['/vendor/xterm.css', 'vendor/xterm.css'],
  ['/vendor/addon-fit.js', 'vendor/addon-fit.js'],
]);

function sourceAssetPath(key) {
  const file = SOURCE_ASSETS.get(key);
  if (!file) throw new Error(`Unknown asset: ${key}`);
  return file;
}

function readAsset(key, callback) {
  let file;
  try {
    file = sourceAssetPath(key);
  } catch (err) {
    callback(err);
    return;
  }

  if (!sea.isSea()) {
    fs.readFile(file, callback);
    return;
  }

  try {
    callback(null, Buffer.from(sea.getRawAsset(key)));
  } catch (err) {
    callback(err);
  }
}

module.exports = { ASSET_KEYS, STATIC_ROUTES, readAsset, sourceAssetPath };
