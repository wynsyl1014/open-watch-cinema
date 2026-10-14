import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createObservationPrecomputeManifest,
  markObservationChunkComplete
} from '../src/observation-precompute-plan.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const PORT = 4192;
const BASE_URL = `http://127.0.0.1:${PORT}`;

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
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Test server exited early with code ${child.exitCode}.`);
    try {
      const response = await fetch(`${BASE_URL}/api/health`, { cache: 'no-store' });
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw lastError || new Error('Timed out waiting for test server.');
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
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

async function writeAiFixture(localDataRoot, mediaId) {
  const packageDir = join(localDataRoot, 'ai-packages', mediaId);
  const chunkDir = join(packageDir, 'chunks', 'chunk-0000');
  const storyboardDir = join(chunkDir, 'storyboards');
  await mkdir(storyboardDir, { recursive: true });

  let manifest = createObservationPrecomputeManifest({
    mediaIdentity: `media:${mediaId}`,
    durationMs: 1_000
  });
  manifest = markObservationChunkComplete(manifest, 0, {
    observationCount: 1,
    storyboardCount: 1,
    resultRef: 'chunks/chunk-0000/visual.json'
  });
  manifest.chunks[0] = {
    ...manifest.chunks[0],
    visualRef: 'chunks/chunk-0000/visual.json',
    storyboardRootRef: 'chunks/chunk-0000/storyboards'
  };
  manifest = {
    ...manifest,
    packageKind: 'open-watch-cinema-ai-package',
    status: 'ready',
    sourceMediaId: mediaId,
    visualTrack: { status: 'ready', protocolVersion: 2 },
    dialogueTrack: { status: 'missing', cueCount: 0 },
    aiReadiness: {
      status: 'ready',
      ready: true,
      experienceMode: 'visual_only',
      blockers: []
    }
  };
  const storyboardRef = 'chunks/chunk-0000/storyboards/scene-0001-500.jpg';
  const frameBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  await writeFile(join(packageDir, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  await writeFile(join(chunkDir, 'visual.json'), `${JSON.stringify({
    observations: [{
      fromMs: 500,
      toMs: 750,
      kind: 'scene_change',
      sceneScore: 0.9,
      motionScore: 0.2,
      metrics: { perceptualHash: 'fixture-frame' },
      storyboard: {
        filename: 'scene-0001-500.jpg',
        mediaTimeMs: 500,
        frameReason: 'scene_change',
        perceptualHash: 'fixture-frame'
      }
    }]
  })}\n`);
  await writeFile(join(storyboardDir, 'scene-0001-500.jpg'), frameBytes);
  return { storyboardRef, frameBytes };
}

const localDataRoot = await mkdtemp(join(tmpdir(), 'open-watch-cinema-frame-http-'));
const mediaRoot = join(localDataRoot, 'media');
await mkdir(mediaRoot, { recursive: true });

let server;
let serverOutput = '';
try {
  const mediaName = 'frame-smoke.mp4';
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    join(mediaRoot, mediaName)
  ]);
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      OPEN_BROWSER: '0',
      LOCAL_DATA_ROOT: localDataRoot
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (chunk) => { serverOutput += chunk; });
  server.stderr.on('data', (chunk) => { serverOutput += chunk; });
  await waitForServer(server);

  let result = await requestJson('/api/media');
  assert.equal(result.response.status, 200);
  const sourceMediaId = result.payload.items[0].id;
  result = await requestJson(`/api/media/${sourceMediaId}/prepare`, { method: 'POST' });
  assert.equal(result.response.status, 202);
  const jobId = result.payload.job.id;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    result = await requestJson(`/api/jobs/${jobId}`);
    if (result.payload.job?.status === 'done') break;
    if (result.payload.job?.status === 'error') throw new Error(result.payload.job.error);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert.equal(result.payload.job.status, 'done');
  const preparedMediaId = result.payload.job.replacementMediaId;

  result = await requestJson('/api/media');
  assert.equal(result.response.status, 200);
  const preparedMedia = result.payload.items.find((item) => item.id === preparedMediaId);
  assert.ok(preparedMedia, 'Expected one prepared media item.');
  const mediaId = preparedMedia.id;

  const fixture = await writeAiFixture(localDataRoot, mediaId);
  result = await requestJson('/api/media/rescan', { method: 'POST' });
  assert.equal(result.response.status, 200);
  const rescannedMedia = result.payload.items.find((item) => item.id === mediaId);
  assert.ok(rescannedMedia, 'Expected the prepared media after rescan.');
  assert.equal(rescannedMedia.aiPackage.status, 'ready');

  result = await requestJson('/api/rooms/open', {
    method: 'POST',
    body: JSON.stringify({ mediaId })
  });
  assert.equal(result.response.status, 201);
  const roomId = result.payload.room.id;

  result = await requestJson(`/api/rooms/${roomId}/playback`, {
    method: 'POST',
    body: JSON.stringify({ mediaTimeMs: 900, playbackState: 'playing' })
  });
  assert.equal(result.response.status, 200);

  result = await requestJson(`/api/rooms/${roomId}/ai-tick`, {
    method: 'POST',
    body: JSON.stringify({ consumerName: 'Elias' })
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.tick.storyboards[0].storyboardRef, fixture.storyboardRef);

  const frameUrl = new URL(`/api/rooms/${roomId}/ai-frame`, BASE_URL);
  frameUrl.searchParams.set('storyboardRef', fixture.storyboardRef);
  frameUrl.searchParams.set('mediaTimeMs', '500');
  const frameResponse = await fetch(frameUrl);
  assert.equal(frameResponse.status, 200);
  assert.equal(frameResponse.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await frameResponse.arrayBuffer()), fixture.frameBytes);
  const metadata = JSON.parse(Buffer.from(
    frameResponse.headers.get('x-open-watch-frame-metadata'),
    'base64url'
  ).toString('utf8'));
  assert.equal(metadata.mediaTimeMs, 500);
  assert.equal(metadata.storyboardRef, fixture.storyboardRef);

  frameUrl.searchParams.set('quality', 'hd');
  const hdResponse = await fetch(frameUrl);
  assert.equal(hdResponse.status, 200);
  const hdBytes = Buffer.from(await hdResponse.arrayBuffer());
  assert.ok(hdBytes.length > fixture.frameBytes.length);
  const hdPath = join(localDataRoot, 'hd.jpg');
  await writeFile(hdPath, hdBytes);
  const hdDimensions = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', hdPath
  ]);
  assert.deepEqual(JSON.parse(hdDimensions.stdout).streams[0], { width: 320, height: 180 });
  const hdMetadata = JSON.parse(Buffer.from(
    hdResponse.headers.get('x-open-watch-frame-metadata'), 'base64url'
  ).toString('utf8'));
  assert.equal(hdMetadata.quality, 'hd');
  assert.equal(hdMetadata.mediaTimeMs, 500);

  result = await requestJson(`/api/rooms/${roomId}/playback`, {
    method: 'POST',
    body: JSON.stringify({ mediaTimeMs: 400, playbackState: 'paused' })
  });
  assert.equal(result.response.status, 200);
  const blockedResponse = await fetch(frameUrl);
  assert.equal(blockedResponse.status, 409);
  const blocked = await blockedResponse.json();
  assert.match(blocked.error, /current playhead/i);
  frameUrl.searchParams.delete('quality');
  assert.equal((await fetch(frameUrl)).status, 409);

  console.log('frame-http-smoke: PASS');
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
  if (server?.exitCode && server.exitCode !== 0) console.error(serverOutput);
}
