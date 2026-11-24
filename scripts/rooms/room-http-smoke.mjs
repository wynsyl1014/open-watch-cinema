import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '../..');
const filmId = '1'.repeat(24);
let baseUrl;

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function waitForServer(child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Test server exited early with code ${child.exitCode}.`);
    const url = /^Open: (http:\/\/127\.0\.0\.1:\d+)$/m.exec(serverOutput)?.[1];
    if (url) return url;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('Timed out waiting for test server.');
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

const localDataRoot = await mkdtemp(join(tmpdir(), 'open-watch-cinema-http-'));
const filmRoot = join(localDataRoot, 'media', 'room-smoke');

let server;
let serverOutput = '';
try {
  await mkdir(filmRoot, { recursive: true });
  // Seed an indexed film so the room smoke does not start automatic subtitle extraction.
  await writeFile(join(filmRoot, '.cinema.json'), JSON.stringify({ id: filmId, video: 'room-smoke.mp4' }));
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    join(filmRoot, 'room-smoke.mp4')
  ]);

  server = spawn(process.execPath, ['server.mjs'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: '0',
      OPEN_BROWSER: '0',
      LOCAL_DATA_ROOT: localDataRoot
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (chunk) => { serverOutput += chunk; });
  server.stderr.on('data', (chunk) => { serverOutput += chunk; });
  baseUrl = await waitForServer(server);

  let result = await request('/api/rooms/open', {
    method: 'POST',
    body: JSON.stringify({ mediaId: filmId })
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.payload));
  const room = result.payload.room;
  assert.equal(room.status, 'active');
  assert.equal(room.aiAvailable, true);

  result = await request('/api/observer/status');
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.observer.opencvAvailable, true);

  result = await request(`/api/rooms/${room.id}/observations/analyze`, {
    method: 'POST',
    body: JSON.stringify({ startMs: 0, durationMs: 1_000, sampleFps: 2 })
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.payload.analysis.engine, 'opencv-observer-v1');
  assert.ok(result.payload.observations.length >= 1);

  result = await request(`/api/rooms/${room.id}/observations`);
  assert.equal(result.response.status, 200);
  assert.ok(result.payload.observations.length >= 1);

  result = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      senderName: 'Smoke Viewer',
      content: 'Bound to the film timeline.',
      mediaTimeMs: 420
    })
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.payload.message.mediaTimeMs, 420);

  result = await request(`/api/rooms/${room.id}/messages`);
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.messages.length, 1);

  result = await request(`/api/rooms/${room.id}/end`, {
    method: 'POST',
    body: JSON.stringify({ mediaTimeMs: 900 })
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.room.status, 'ended');

  result = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      senderName: 'Smoke Viewer',
      content: 'Archived rooms must reject this.',
      mediaTimeMs: 950
    })
  });
  assert.equal(result.response.status, 409);

  result = await request(`/api/rooms/${room.id}/observations/analyze`, {
    method: 'POST',
    body: JSON.stringify({ startMs: 0, durationMs: 1_000 })
  });
  assert.equal(result.response.status, 409);

  result = await request('/api/rooms');
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.activeRoom, null);
  assert.equal(result.payload.rooms[0].messageCount, 1);

  console.log('room-http-smoke: PASS');
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((resolvePromise) => {
      const timer = setTimeout(resolvePromise, 1500);
      server.once('exit', () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }
  await rm(localDataRoot, { recursive: true, force: true });
  if (server?.exitCode && server.exitCode !== 0) {
    console.error(serverOutput);
  }
}
