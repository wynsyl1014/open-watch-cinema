// Isolated HTTP acceptance test for the user-adjustable cadence, no real films.
// Uses a fresh temporary database and a new random loopback port.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '../..');
const dataRoot = await mkdtemp(join(tmpdir(), 'owc-cadence-'));
const temp = net.createServer();
await new Promise((resolveReady, reject) => temp.once('error', reject).listen(0, '127.0.0.1', resolveReady));
const port = temp.address().port;
await new Promise((resolveClosed) => temp.close(resolveClosed));
const base = 'http://127.0.0.1:' + port;
let child;

async function launch() {
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      OPEN_BROWSER: '0',
      LOCAL_DATA_ROOT: dataRoot
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let output = '';
  child.stdout.on('data', (data) => { output = (output + String(data)).slice(-3000); });
  child.stderr.on('data', (data) => { output = (output + String(data)).slice(-3000); });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Server failed: ' + output);
    try {
      const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(600) });
      if (response.ok) return;
    } catch {}
    await sleep(80);
  }
  throw new Error('Server did not become healthy: ' + output);
}

async function close() {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((res) => child.once('exit', res)),
    sleep(2500)
  ]);
  child = null;
}

async function request(path, body = undefined) {
  const response = await fetch(base + path, {
    ...(body === undefined ? {} : {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }),
    signal: AbortSignal.timeout(3000)
  });
  return { status: response.status, payload: await response.json() };
}

try {
  await launch();
  const before = await request('/api/viewing-settings');
  assert.equal(before.status, 200);
  assert.equal(before.payload.settings.intervalMs, 2000);

  for (const seconds of [0.5, 1.75, 7.125, 30, 2]) {
    const updated = await request('/api/viewing-settings', { intervalSeconds: seconds });
    assert.equal(updated.status, 200, 'Could not save seconds ' + seconds);
    assert.equal(updated.payload.settings.intervalMs, Math.round(seconds * 1000));
    const loaded = await request('/api/viewing-settings');
    assert.equal(loaded.payload.settings.intervalSeconds, seconds);
    assert.equal(loaded.payload.settings.dialoguePolicy, 'complete');
  }

  for (const invalid of [-3, 0.49, 30.1, '2', null]) {
    const attempt = await request('/api/viewing-settings', { intervalSeconds: invalid });
    assert.equal(attempt.status, 400);
    assert.equal((await request('/api/viewing-settings')).payload.settings.intervalMs, 2000);
  }

  const health = await request('/api/health');
  assert.ok(health.payload.capabilities.includes('ai-cadence-v1'));
  assert.equal(health.payload.mediaCount, 0);
  await request('/api/viewing-settings', { intervalSeconds: 0.5 });
  await close();
  await launch();
  const persisted = await request('/api/viewing-settings');
  assert.equal(persisted.payload.settings.intervalMs, 500);
  const page = await fetch(base + '/');
  const html = await page.text();
  assert.ok(html.includes('viewingSettingsButton'));
  assert.ok(html.includes('viewingIntervalInput'));
  const js = await (await fetch(base + '/app.js')).text();
  assert.ok(js.includes('installPlaybackHeartbeat'));
  assert.ok(js.includes("'/api/viewing-settings'"));

  console.log(JSON.stringify({
    ok: true,
    defaultMs: 2000,
    minimumMs: 500,
    decimalValuesAccepted: [1.75, 7.125],
    maxMs: 30000,
    invalidInputsRejected: 5,
    persistentAcrossServerRestart: true,
    settingsUIAndPlaybackHeartbeatPresent: true,
    mediaCount: health.payload.mediaCount,
    userMediaUnchanged: true
  }, null, 2));
} finally {
  await close();
  await rm(dataRoot, { recursive: true, force: true });
}
