import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  addSessionMessage,
  openDatabase,
  openSession,
  setMediaCompatibility,
  syncMediaIndex,
  updateSessionPlayback
} from '../src/database.mjs';
import { createMediaId, scanMediaDirectory } from '../src/media-library.mjs';
import {
  createObservationPrecomputeManifest,
  markObservationChunkComplete
} from '../src/observation-precompute-plan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'owc-live-tick-smoke-'));
const mediaRoot = join(temporaryRoot, 'media');
const aiPackagesRoot = join(temporaryRoot, 'ai-packages');
const relativeMediaPath = 'Synthetic Film.mp4';
const mediaId = createMediaId(relativeMediaPath);
const packageDir = join(aiPackagesRoot, mediaId);
const chunkDir = join(packageDir, 'chunks', 'chunk-0000');
const storyboardDir = join(chunkDir, 'storyboards');
const port = 5050 + Math.floor(Math.random() * 100);
const baseUrl = `http://127.0.0.1:${port}`;
let cinema;
let mcp;
let mcpOutput;
let cinemaStderr = '';
let mcpStderr = '';

async function waitForCinema() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { cache: 'no-store' });
      if (response.ok) {
        const health = await response.json();
        if (health.capabilities?.includes('ai-tick-v1')) return health;
      }
    } catch {
      // The isolated server is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('Isolated cinema did not become ai-tick ready in time.');
}

function createMcpClient(child) {
  const pending = new Map();
  let nextId = 1;
  const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  output.on('line', (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    waiter.resolve(message);
  });
  return {
    output,
    request(method, params = {}) {
      const id = nextId++;
      const promise = new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectPromise(new Error(`MCP request timed out: ${method}`));
        }, 10_000);
        pending.set(id, {
          resolve(message) {
            clearTimeout(timer);
            resolvePromise(message);
          }
        });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return promise;
    }
  };
}

function toolPayload(response) {
  if (response.error) throw new Error(response.error.message);
  const text = response.result?.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('MCP tool did not return text content.');
  const payload = JSON.parse(text);
  if (response.result.isError) throw new Error(payload.message || 'MCP tool failed.');
  return payload;
}

try {
  await Promise.all([
    mkdir(mediaRoot, { recursive: true }),
    mkdir(storyboardDir, { recursive: true })
  ]);
  execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:d=30:r=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    join(mediaRoot, relativeMediaPath)
  ], { windowsHide: true });
  await writeFile(join(storyboardDir, 'scene.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  let manifest = createObservationPrecomputeManifest({
    mediaIdentity: 'sha256:tick-smoke-fixture',
    durationMs: 30_000
  });
  manifest = markObservationChunkComplete(manifest, 0, {
    observationCount: 121,
    storyboardCount: 1,
    resultRef: 'chunks/chunk-0000/visual.json'
  });
  manifest.chunks[0] = {
    ...manifest.chunks[0],
    visualRef: 'chunks/chunk-0000/visual.json',
    dialogueRef: 'chunks/chunk-0000/dialogue.json',
    storyboardRootRef: 'chunks/chunk-0000/storyboards',
    dialogueCueCount: 2
  };
  manifest = {
    ...manifest,
    packageVersion: 2,
    packageKind: 'open-watch-cinema-ai-package',
    analysisActivation: 'manual_opt_in',
    sourceMediaId: mediaId,
    sourceRelativePath: relativeMediaPath,
    visualTrack: { status: 'ready', protocolVersion: 2 },
    dialogueTrack: { status: 'ready', cueCount: 2 },
    aiReadiness: {
      status: 'ready',
      ready: true,
      experienceMode: 'complete',
      blockers: []
    }
  };

  await writeFile(join(chunkDir, 'visual.json'), `${JSON.stringify({
    observations: [
      {
        fromMs: 7_000,
        toMs: 7_500,
        kind: 'scene_change',
        sceneScore: 0.9,
        motionScore: 0.7,
        metrics: {
          brightness: 0.42,
          averageRgb: [0.1, 0.2, 0.3],
          histogramDistance: 0.8,
          motionDirection: 'right'
        },
        storyboard: {
          filename: 'scene.jpg',
          mediaTimeMs: 7_000,
          frameReason: 'scene_change',
          perceptualHash: 'tick-smoke-hash'
        }
      },
      ...Array.from({ length: 120 }, (_, index) => ({
        fromMs: 8_000 + index * 100,
        toMs: 8_080 + index * 100,
        kind: index % 20 === 0 ? 'motion_peak' : 'heartbeat',
        sceneScore: 0.05,
        motionScore: index % 20 === 0 ? 0.8 : 0.1,
        metrics: {
          brightness: 0.5,
          histogramDistance: 0.1,
          motionDirection: index % 2 === 0 ? 'right' : 'left'
        }
      }))
    ]
  })}\n`);
  await writeFile(join(chunkDir, 'dialogue.json'), `${JSON.stringify({
    status: 'ready',
    cues: [
      { cueId: 'cue-one', fromMs: 6_000, toMs: 7_200, text: 'First timed line.' },
      { cueId: 'cue-two', fromMs: 15_000, toMs: 16_200, text: 'Second timed line.' }
    ]
  })}\n`);
  await writeFile(join(packageDir, 'manifest.json'), `${JSON.stringify(manifest)}\n`);

  const mediaItems = await scanMediaDirectory(mediaRoot, { aiPackagesRoot });
  if (mediaItems.length !== 1 || mediaItems[0].id !== mediaId) {
    throw new Error('Synthetic media fixture did not scan as expected.');
  }
  const mediaStat = await stat(join(mediaRoot, relativeMediaPath));
  const db = openDatabase(join(temporaryRoot, 'open-watch-cinema.sqlite'));
  syncMediaIndex(db, [{
    ...mediaItems[0],
    size: mediaStat.size,
    modifiedAt: mediaStat.mtime.toISOString()
  }]);
  setMediaCompatibility(db, mediaId, {
    status: 'ready',
    containerName: 'mp4',
    videoCodec: 'h264',
    audioCodec: 'aac',
    note: 'Synthetic tick smoke fixture.',
    processedAt: new Date().toISOString()
  });
  const room = openSession(db, { mediaId, mediaTitle: 'Synthetic Film' });
  updateSessionPlayback(db, room.id, { mediaTimeMs: 20_000, playbackState: 'playing' });
  addSessionMessage(db, room.id, {
    senderName: 'Sylvie',
    senderKind: 'user',
    content: 'Did you notice that?',
    mediaTimeMs: 8_000
  });
  addSessionMessage(db, room.id, {
    senderName: 'Sylvie',
    senderKind: 'user',
    content: 'And the second thing too.',
    mediaTimeMs: 10_000
  });
  addSessionMessage(db, room.id, {
    senderName: 'Elias',
    senderKind: 'ai',
    content: 'A prior AI reply that should not echo back.',
    mediaTimeMs: 11_000
  });
  db.close();

  cinema = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      LOCAL_DATA_ROOT: temporaryRoot,
      PORT: String(port),
      OPEN_BROWSER: '0'
    },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  cinema.stderr.setEncoding('utf8');
  cinema.stderr.on('data', (chunk) => { cinemaStderr += chunk; });
  const health = await waitForCinema();

  mcp = spawn(process.execPath, [resolve(ROOT, 'mcp', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      OPEN_WATCH_CINEMA_URL: baseUrl
    },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  mcp.stderr.setEncoding('utf8');
  mcp.stderr.on('data', (chunk) => { mcpStderr += chunk; });
  const client = createMcpClient(mcp);
  mcpOutput = client.output;

  await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'open-watch-cinema-live-tick-smoke', version: '1.0.0' }
  });
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

  const first = toolPayload(await client.request('tools/call', {
    name: 'open_watch_cinema_tick',
    arguments: {
      roomId: room.id,
      consumerName: 'Elias',
      cursors: { messageId: 0, observationSequence: 0 },
      limits: {
        initialWindowMs: 15_000,
        maxAdvanceMs: 20_000,
        maxMessages: 20,
        maxStoryboards: 5,
        maxMotionEvents: 8
      }
    }
  }));
  const incompleteCursor = await client.request('tools/call', {
    name: 'open_watch_cinema_tick',
    arguments: { roomId: room.id, consumerName: 'Elias', cursors: { mediaMs: first.tick.cursors.mediaMs } }
  });
  assert.equal(incompleteCursor.result?.isError, true);
  assert.match(JSON.stringify(incompleteCursor), /mediaMs requires seekVersion/);

  const second = toolPayload(await client.request('tools/call', {
    name: 'open_watch_cinema_tick',
    arguments: {
      roomId: room.id,
      consumerName: 'Elias',
      cursors: first.tick.cursors
    }
  }));

  const selectedStoryboard = first.tick.storyboards[0];
  const frameResponse = await client.request('tools/call', {
    name: 'cinema_get_frame',
    arguments: {
      roomId: room.id,
      storyboardRef: selectedStoryboard.storyboardRef,
      mediaTimeMs: selectedStoryboard.mediaTimeMs
    }
  });
  if (frameResponse.error || frameResponse.result?.isError) {
    throw new Error('MCP frame tool returned an error.');
  }
  const frameImage = frameResponse.result?.content?.find((item) => item.type === 'image');
  const frameMetadata = frameResponse.result?.content?.find((item) => item.type === 'text');
  if (frameImage?.mimeType !== 'image/jpeg' || !frameImage.data) {
    throw new Error('MCP frame tool did not return JPEG image content.');
  }
  if (!frameMetadata?.text?.includes('scene.jpg')) {
    throw new Error('MCP frame tool did not return verified storyboard metadata.');
  }
  const serialized = JSON.stringify(first.tick);
  for (const forbidden of ['brightness', 'averageRgb', 'histogramDistance', 'perceptualHash']) {
    if (serialized.includes(`\"${forbidden}\"`)) {
      throw new Error(`Compact tick leaked raw visual telemetry: ${forbidden}`);
    }
  }
  if (first.tick.newMessages.length !== 2) throw new Error('First tick did not deliver both viewer messages.');
  if (first.tick.cursors.messageId !== 3) throw new Error('First tick did not advance past the omitted self-authored message.');
  if (first.tick.compacted.selfMessagesOmitted !== 1) throw new Error('First tick did not report the omitted self-authored message.');
  if (first.tick.dialogueDelta.length !== 1) throw new Error('First compact tick did not deliver the first dialogue cue.');
  if (first.tick.storyboards.length !== 1) throw new Error('First tick did not deliver the selected storyboard.');
  if (!first.tick.more.media || first.tick.cursors.mediaMs >= first.tick.playback.playheadMs) {
    throw new Error('Dense viewing material was not split into a bounded first increment.');
  }
  if (second.tick.newMessages.length !== 0) throw new Error('Second tick replayed messages after cursor advancement.');
  if (second.tick.dialogueDelta.length !== 1) throw new Error('Second tick did not deliver the remaining dialogue cue.');
  if (second.tick.cursors.mediaMs !== 20_000 || second.tick.more.media) {
    throw new Error('Second tick did not finish the remaining media increment.');
  }

  async function playback(mediaTimeMs, playbackState = 'paused', seeked = false) {
    const response = await fetch(`${baseUrl}/api/rooms/${room.id}/playback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaTimeMs, playbackState, seeked })
    });
    assert.equal(response.status, 200);
    return (await response.json()).room;
  }
  async function poll(cursors) {
    return toolPayload(await client.request('tools/call', {
      name: 'open_watch_cinema_tick',
      arguments: { roomId: room.id, consumerName: 'Elias', cursors }
    })).tick;
  }

  // Start at five seconds, then skip the first cue and storyboard.
  await playback(5_000, 'paused', true);
  const beforeSeek = await poll(second.tick.cursors);
  assert.equal(beforeSeek.range.seekDetected, true);
  await playback(29_000, 'paused', true);
  // A following pause/resume update must not erase the seek version.
  const resumed = await playback(29_000, 'playing');
  const forward = await poll(beforeSeek.cursors);
  assert.equal(forward.range.seekDetected, true);
  assert.equal(forward.range.fromMs, 14_000);
  assert.equal(forward.cursors.mediaMs, 29_000);
  assert.equal(forward.cursors.seekVersion, resumed.seekVersion);
  assert.deepEqual(forward.dialogueDelta.map((cue) => cue.cueId), ['cue-two']);
  assert.equal(forward.storyboards.length, 0);
  assert.equal(forward.newMessages.length, 0);
  assert.equal(forward.cursors.messageId, second.tick.cursors.messageId);
  assert.equal(forward.cursors.observationSequence, second.tick.cursors.observationSequence);
  // Each consumer acknowledges independently; one poll cannot consume the seek for others.
  assert.equal((await poll(beforeSeek.cursors)).range.seekDetected, true);
  const steady = await poll(forward.cursors);
  assert.equal(steady.range.seekDetected, false);
  assert.equal(steady.dialogueDelta.length, 0);
  assert.equal(steady.more.media, false);

  await playback(28_000, 'paused', true);
  await playback(27_000, 'paused', true);
  const backward = await poll(forward.cursors);
  assert.equal(backward.range.seekDetected, true);
  assert.equal(backward.range.fromMs, 12_000);
  assert.equal(backward.cursors.mediaMs, 27_000);
  assert.equal(backward.cursors.seekVersion, forward.cursors.seekVersion + 2);
  assert.equal(backward.playback.state, 'paused');
  assert.equal((await poll(backward.cursors)).range.seekDetected, false);

  console.log(JSON.stringify({
    ok: true,
    apiVersion: health.apiVersion,
    mcpVersion: '0.5.0',
    roomId: room.id,
    firstCounts: {
      messages: first.tick.newMessages.length,
      dialogue: first.tick.dialogueDelta.length,
      storyboards: first.tick.storyboards.length,
      motionEvents: first.tick.motionEvents.length
    },
    firstCursors: first.tick.cursors,
    secondCounts: {
      messages: second.tick.newMessages.length,
      dialogue: second.tick.dialogueDelta.length,
      storyboards: second.tick.storyboards.length,
      motionEvents: second.tick.motionEvents.length
    },
    secondCursors: second.tick.cursors,
    seekChecks: 'forward, backward, repeated, paused, independent consumers, no replay',
    rawTelemetryOmitted: first.tick.compacted.rawVisualMetricsOmitted,
    selfMessagesOmitted: first.tick.compacted.selfMessagesOmitted,
    detailedWindowToolAvailable: first.tick.compacted.detailedWindowToolAvailable
  }, null, 2));
} catch (error) {
  throw new Error([
    error.message,
    cinemaStderr ? `Cinema stderr:\n${cinemaStderr}` : '',
    mcpStderr ? `MCP stderr:\n${mcpStderr}` : ''
  ].filter(Boolean).join('\n'));
} finally {
  if (mcp) {
    mcp.stdin.end();
    mcp.kill();
  }
  mcpOutput?.close();
  if (cinema && !cinema.killed) cinema.kill();
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
