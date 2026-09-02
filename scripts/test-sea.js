'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { execFileSync, spawn } = require('child_process');
const { STATIC_ROUTES, sourceAssetPath } = require('../src/assets');

const ROOT = path.join(__dirname, '..');
const BUILT_BINARY = path.join(ROOT, 'dist', 'webterm-linux-x64');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function availablePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForServer(baseUrl, child, output) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode != null) throw new Error(`SEA exited during startup:\n${output()}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Listener is not ready yet.
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for SEA listener:\n${output()}`);
}

async function waitForMarker(baseUrl, marker) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${baseUrl}/api/snapshot`);
    if (response.ok && (await response.text()).includes(marker)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for terminal marker ${marker}`);
}

async function waitForExit(child) {
  if (child.exitCode != null) return child.exitCode;
  return Promise.race([
    once(child, 'exit').then(([code]) => code),
    delay(5000).then(() => {
      throw new Error('SEA did not exit after SIGTERM');
    }),
  ]);
}

async function main() {
  assert(fs.existsSync(BUILT_BINARY), 'Run npm run build:sea first');
  assert.match(execFileSync(BUILT_BINARY, ['--version'], { encoding: 'utf8' }), /^webterm /);
  assert.match(
    execFileSync(BUILT_BINARY, ['--licenses'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }),
    /Node\.js/
  );

  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-sea-test-'));
  const isolatedDir = path.join(testRoot, 'isolated');
  const runtimeDir = path.join(testRoot, 'runtime');
  const binary = path.join(isolatedDir, 'webterm');
  fs.mkdirSync(isolatedDir);
  fs.mkdirSync(runtimeDir, { mode: 0o700 });
  fs.copyFileSync(BUILT_BINARY, binary);
  fs.chmodSync(binary, 0o755);

  const port = await availablePort();
  let output = '';
  const child = spawn(binary, [], {
    cwd: isolatedDir,
    env: {
      ...process.env,
      RUNTIME_DIRECTORY: runtimeDir,
      WEBTERM_DEV_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForServer(baseUrl, child, () => output);

    for (const [route, key] of STATIC_ROUTES) {
      const response = await fetch(`${baseUrl}${route}`);
      assert.strictEqual(response.status, 200, route);
      assert.deepStrictEqual(
        Buffer.from(await response.arrayBuffer()),
        fs.readFileSync(sourceAssetPath(key)),
        route
      );
    }

    const marker = `SEA_TEST_${Date.now()}`;
    const input = await fetch(`${baseUrl}/api/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(`printf '${marker}\\n'\r`),
    });
    assert.strictEqual(input.status, 200);
    await waitForMarker(baseUrl, marker);

    child.kill('SIGTERM');
    assert.strictEqual(await waitForExit(child), 0);
    assert.deepStrictEqual(fs.readdirSync(runtimeDir), []);
    assert.deepStrictEqual(fs.readdirSync(isolatedDir), ['webterm']);
    console.log('SEA TEST: PASS');
  } finally {
    if (child.exitCode == null) child.kill('SIGKILL');
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('SEA TEST: FAIL');
  console.error(err.stack || err);
  process.exit(1);
});
