'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const esbuild = require('esbuild');
const { ASSET_KEYS, sourceAssetPath } = require('../src/assets');
const { EMBEDDED_PTY_FILES } = require('../src/pty');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const BUNDLE = path.join(DIST, 'webterm.cjs');
const CONFIG = path.join(DIST, 'sea-config.json');
const VERSION_FILE = path.join(DIST, 'version.txt');
const LICENSES_FILE = path.join(DIST, 'licenses.txt');
const OUTPUT = path.join(DIST, 'webterm-linux-x64');
const CHECKSUM = `${OUTPUT}.sha256`;

function readRequired(file, label) {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd();
  } catch {
    throw new Error(`Missing ${label}: ${file}`);
  }
}

function firstExisting(files, label) {
  const file = files.find((candidate) => fs.existsSync(candidate));
  if (!file) throw new Error(`Could not find ${label}`);
  return file;
}

function packageRoot(name) {
  return path.dirname(require.resolve(`${name}/package.json`));
}

function section(name, body) {
  return `${name}\n${'='.repeat(name.length)}\n\n${body}\n`;
}

function buildLicenses() {
  const nodeLicense = firstExisting(
    [
      path.join(path.dirname(path.dirname(process.execPath)), 'LICENSE'),
      '/usr/share/licenses/nodejs/LICENSE',
    ],
    'the Node.js license'
  );
  const xtermLicense = path.join(packageRoot('@xterm/xterm'), 'LICENSE');
  const ptyLicense = path.join(packageRoot('node-pty'), 'LICENSE');
  const addonApiLicense = path.join(packageRoot('node-addon-api'), 'LICENSE.md');
  const esbuildLicense = path.join(packageRoot('esbuild'), 'LICENSE.md');

  return [
    section('WebTerm', readRequired(path.join(ROOT, 'LICENSE'), 'WebTerm license')),
    section('Node.js', readRequired(nodeLicense, 'Node.js license')),
    section(
      'xterm.js packages (@xterm/xterm, headless, addon-fit, addon-serialize)',
      readRequired(xtermLicense, 'xterm.js license')
    ),
    section('node-pty', readRequired(ptyLicense, 'node-pty license')),
    section('node-addon-api', readRequired(addonApiLicense, 'node-addon-api license')),
    section('esbuild', readRequired(esbuildLicense, 'esbuild license')),
  ].join('\n');
}

function gitOutput(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function validateBuilder() {
  const pinned = readRequired(path.join(ROOT, '.node-version'), 'pinned Node version');
  if (process.version !== `v${pinned}`) {
    throw new Error(`SEA builds require Node v${pinned}; current runtime is ${process.version}`);
  }
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(`SEA builds currently require linux-x64; got ${process.platform}-${process.arch}`);
  }
}

function main() {
  validateBuilder();
  fs.mkdirSync(DIST, { recursive: true });
  for (const file of [BUNDLE, CONFIG, VERSION_FILE, LICENSES_FILE, OUTPUT, CHECKSUM]) {
    fs.rmSync(file, { force: true });
  }

  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'main.js')],
    outfile: BUNDLE,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node26',
    external: ['node-pty'],
    legalComments: 'none',
  });

  const commit = gitOutput(['rev-parse', '--short=12', 'HEAD']);
  const dirty = gitOutput(['status', '--porcelain']) ? '-dirty' : '';
  fs.writeFileSync(
    VERSION_FILE,
    `webterm ${pkg.version} ${commit}${dirty} node ${process.version} linux-x64\n`
  );
  fs.writeFileSync(LICENSES_FILE, buildLicenses());

  const assets = {};
  for (const key of ASSET_KEYS) assets[key] = sourceAssetPath(key);

  const ptyRoot = packageRoot('node-pty');
  for (const file of EMBEDDED_PTY_FILES) {
    const source = path.join(ptyRoot, file);
    if (!fs.existsSync(source)) throw new Error(`Missing node-pty runtime file: ${source}`);
    assets[`node-pty/${file}`] = source;
  }
  assets['meta/version.txt'] = VERSION_FILE;
  assets['meta/licenses.txt'] = LICENSES_FILE;

  fs.writeFileSync(
    CONFIG,
    `${JSON.stringify(
      {
        main: BUNDLE,
        mainFormat: 'commonjs',
        output: OUTPUT,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        assets,
      },
      null,
      2
    )}\n`
  );

  const result = spawnSync(process.execPath, [`--build-sea=${CONFIG}`], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`Node SEA build failed with status ${result.status}`);
  }

  fs.chmodSync(OUTPUT, 0o755);
  const body = fs.readFileSync(OUTPUT);
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(CHECKSUM, `${hash}  ${path.basename(OUTPUT)}\n`);
  console.log(`SEA: ${OUTPUT}`);
  console.log(`SHA256: ${hash}`);
  console.log(`SIZE: ${body.length} bytes`);
}

try {
  main();
} catch (err) {
  console.error(`BUILD SEA: FAIL: ${err.message}`);
  process.exit(1);
}
