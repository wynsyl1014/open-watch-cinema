import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createObservationPrecomputeManifest,
  markObservationChunkComplete
} from '../../src/preparation/observation-precompute-plan.mjs';
import {
  normalizeStoryboardRef,
  readSpoilerGatedStoryboardFrame
} from '../../src/visuals/storyboard-frame.mjs';
import { createViewingChunk, viewingPreparationState } from '../../src/delivery/viewing-package.mjs';
import { imageSettingsForMode } from '../../src/visuals/image-settings.mjs';

async function createPackage() {
  const packageDir = await mkdtemp(join(tmpdir(), 'owc-storyboard-frame-'));
  const chunkDir = join(packageDir, 'chunks', 'chunk-0000');
  const storyboardDir = join(chunkDir, 'storyboards');
  await mkdir(storyboardDir, { recursive: true });

  let manifest = createObservationPrecomputeManifest({
    mediaIdentity: 'sha256:storyboard-frame-fixture',
    durationMs: 10_000
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
    visualTrack: { status: 'ready', protocolVersion: 2 },
    dialogueTrack: { status: 'missing', cueCount: 0 },
    aiReadiness: {
      status: 'ready',
      ready: true,
      experienceMode: 'visual_only',
      blockers: []
    }
  };
  const storyboardRef = 'chunks/chunk-0000/storyboards/scene-0001-5000.jpg';
  await writeFile(join(packageDir, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  await writeFile(join(chunkDir, 'visual.json'), `${JSON.stringify({
    observations: [{
      fromMs: 5_000,
      toMs: 5_500,
      kind: 'scene_change',
      sceneScore: 0.8,
      motionScore: 0.2,
      storyboard: {
        filename: 'scene-0001-5000.jpg',
        mediaTimeMs: 5_000,
        frameReason: 'scene_change'
      }
    }]
  })}\n`);
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  await writeFile(join(storyboardDir, 'scene-0001-5000.jpg'), bytes);
  return { packageDir, storyboardRef, bytes };
}

test('storyboard frame bridge returns only a revealed allowlisted image', async () => {
  const fixture = await createPackage();
  try {
    const frame = await readSpoilerGatedStoryboardFrame(fixture.packageDir, {
      storyboardRef: fixture.storyboardRef,
      mediaTimeMs: 5_000,
      playheadMs: 6_000
    });
    assert.equal(frame.mimeType, 'image/jpeg');
    assert.deepEqual(frame.content, fixture.bytes);
    assert.equal(frame.metadata.mediaTimeMs, 5_000);
    assert.equal(frame.metadata.storyboardRef, fixture.storyboardRef);
  } finally {
    await rm(fixture.packageDir, { recursive: true, force: true });
  }
});

test('storyboard frame bridge blocks future frames and invalid refs', async () => {
  const fixture = await createPackage();
  try {
    await assert.rejects(
      () => readSpoilerGatedStoryboardFrame(fixture.packageDir, {
        storyboardRef: fixture.storyboardRef,
        mediaTimeMs: 5_000,
        playheadMs: 4_999
      }),
      /current playhead/i
    );
    assert.throws(
      () => normalizeStoryboardRef('chunks/chunk-0000/storyboards/../outside.jpg'),
      /allowlisted|traversal/i
    );
  } finally {
    await rm(fixture.packageDir, { recursive: true, force: true });
  }
});

test('HD uses the same reference and timestamp gate before opening the source', async () => {
  const fixture = await createPackage();
  try {
    const options = { storyboardRef: fixture.storyboardRef, mediaTimeMs: 5000,
      playheadMs: 6000, quality: 'hd', inputPath: 'must-not-be-opened.mp4' };
    await assert.rejects(readSpoilerGatedStoryboardFrame(fixture.packageDir,
      { ...options, playheadMs: 4999 }), /current playhead/);
    await assert.rejects(readSpoilerGatedStoryboardFrame(fixture.packageDir,
      { ...options, mediaTimeMs: 5100 }), /not revealed/);
    await assert.rejects(readSpoilerGatedStoryboardFrame(fixture.packageDir,
      { ...options, storyboardRef: 'chunks/chunk-0000/storyboards/unknown.jpg' }), /not revealed/);
    await assert.rejects(readSpoilerGatedStoryboardFrame(fixture.packageDir,
      { ...options, quality: 'invalid' }), /quality must/);
    const visualPath = join(fixture.packageDir, 'chunks', 'chunk-0000', 'visual.json');
    const visual = JSON.parse(await readFile(visualPath, 'utf8'));
    visual.observations[0].storyboard.panelTimesMs = [4500, 5000, 6500];
    await writeFile(visualPath, JSON.stringify(visual));
    for (const quality of ['storyboard', 'hd']) {
      await assert.rejects(readSpoilerGatedStoryboardFrame(fixture.packageDir,
        { ...options, quality }), /panels have not reached/);
    }
  } finally {
    await rm(fixture.packageDir, { recursive: true, force: true });
  }
});

async function createPreparedPackage(mediaTimeMs = 5_000, imageSettings = null) {
  const fixture = await createPackage();
  let manifest = createObservationPrecomputeManifest({
    mediaIdentity: 'sha256:prepared-frame-fixture',
    durationMs: 620_000,
    viewingIntervalMs: 4_000,
    ...(imageSettings ? { imageSettings } : {})
  });
  const payload = createViewingChunk({
    planId: manifest.planId, chunk: manifest.chunks[0], intervalMs: manifest.viewingIntervalMs,
    storyboardRootRef: 'chunks/chunk-0000/storyboards',
    dialogue: { status: 'missing', sourceMode: 'fixture', cues: [] },
    analysis: {
      engine: 'fixture', protocolVersion: 2, sampleFps: 2, observations: [],
      frames: [{
        filename: 'scene-0001-5000.jpg', mediaTimeMs,
        panelTimesMs: [Math.max(0, mediaTimeMs - 1_000), Math.max(0, mediaTimeMs - 500), mediaTimeMs],
        frameReason: 'scene_change',
        image: { width: 853, height: 480, jpegQuality: 86, requestedHeight: 480, budgetLimited: false }
      }]
    }
  });
  manifest = markObservationChunkComplete(manifest, 0, { storyboardCount: 1 });
  manifest.packageVersion = 3;
  manifest.chunks[0].viewingRef = 'chunks/chunk-0000/viewing.json';
  manifest.chunks[0].audioStatus = 'pending';
  manifest.visualTrack = { status: 'partial', protocolVersion: 2 };
  manifest.audioTrack = { status: 'pending' };
  manifest.viewingTrack = viewingPreparationState(manifest, { audioRequested: true });
  const viewingPath = join(fixture.packageDir, manifest.chunks[0].viewingRef);
  await writeFile(viewingPath, JSON.stringify(payload));
  await writeFile(join(fixture.packageDir, 'manifest.json'), JSON.stringify(manifest));
  return { ...fixture, payload, viewingPath, mediaTimeMs };
}

test('prepared v3 storyboards read finished images while later chunks and audio remain pending', async () => {
  const fixture = await createPreparedPackage(5_000, imageSettingsForMode('full', 480));
  try {
    const options = {
      storyboardRef: fixture.storyboardRef, mediaTimeMs: 5_000, playheadMs: 6_000,
      inputPath: 'must-not-be-opened.mp4'
    };
    const strip = await readSpoilerGatedStoryboardFrame(fixture.packageDir, options);
    assert.deepEqual(strip.content, fixture.bytes);
    assert.equal(strip.metadata.hdAvailable, undefined);
    assert.equal(strip.metadata.width, 853);
    assert.equal(strip.metadata.height, 480);
    await assert.rejects(
      readSpoilerGatedStoryboardFrame(fixture.packageDir, { ...options, quality: 'hd' }),
      /本片仅保存成品分镜/
    );
  } finally {
    await rm(fixture.packageDir, { recursive: true, force: true });
  }
});

test('prepared frames are inspectable exactly at their playhead including film time zero', async () => {
  for (const mediaTimeMs of [0, 5_000]) {
    const fixture = await createPreparedPackage(mediaTimeMs);
    try {
      const frame = await readSpoilerGatedStoryboardFrame(fixture.packageDir, {
        storyboardRef: fixture.storyboardRef, mediaTimeMs, playheadMs: mediaTimeMs
      });
      assert.deepEqual(frame.content, fixture.bytes);
    } finally {
      await rm(fixture.packageDir, { recursive: true, force: true });
    }
  }
});

test('cancelled frame requests stop before opening the package or source video', async () => {
  const controller = new AbortController();
  const reason = new Error('frame cancelled');
  controller.abort(reason);
  await assert.rejects(readSpoilerGatedStoryboardFrame('must-not-be-opened', {
    storyboardRef: 'chunks/chunk-0000/storyboards/scene.jpg',
    mediaTimeMs: 0, playheadMs: 0, quality: 'hd',
    inputPath: 'must-not-be-opened.mp4', signal: controller.signal
  }), (error) => error === reason);
});

test('legacy image validation does not open unrelated dialogue or audio track files', async () => {
  const fixture = await createPackage();
  try {
    const manifestPath = join(fixture.packageDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.chunks[0].dialogueRef = 'chunks/chunk-0000/missing-dialogue.json';
    manifest.chunks[0].audioRef = 'chunks/chunk-0000/missing-audio.json';
    manifest.chunks[0].audioStatus = 'ready';
    await writeFile(manifestPath, JSON.stringify(manifest));
    const frame = await readSpoilerGatedStoryboardFrame(fixture.packageDir, {
      storyboardRef: fixture.storyboardRef, mediaTimeMs: 5_000, playheadMs: 6_000
    });
    assert.deepEqual(frame.content, fixture.bytes);
  } finally {
    await rm(fixture.packageDir, { recursive: true, force: true });
  }
});

test('legacy v2 strips retain their original bytes despite a newer requested height', async () => {
  const fixture = await createPackage();
  try {
    const frame = await readSpoilerGatedStoryboardFrame(fixture.packageDir, {
      storyboardRef: fixture.storyboardRef, mediaTimeMs: 5_000, playheadMs: 6_000,
      imageSettings: imageSettingsForMode('full', 1080)
    });
    assert.deepEqual(frame.content, fixture.bytes);
    assert.equal(frame.metadata.settingsApplied, undefined);
    assert.equal(frame.metadata.requestedHeight, undefined);
  } finally {
    await rm(fixture.packageDir, { recursive: true, force: true });
  }
});

test('every prepared group part uses the group release time and its own image metadata', async t => {
  const fixture = await createPreparedPackage();
  t.after(() => rm(fixture.packageDir, { recursive: true, force: true }));
  const entry = fixture.payload.segments.flatMap(s => s.entries).find(e => e.type === 'image');
  const secondRef = entry.storyboardRef.replace('.jpg', '-part-2.jpg');
  const bytes = Buffer.from([0xff, 0xd8, 9, 0xff, 0xd9]);
  entry.parts = [
    { ref: entry.storyboardRef, mediaTimeMs: 4000, image: { width: 477 } },
    { ref: secondRef, mediaTimeMs: 4875, image: { width: 65, views: [
      { sourceIndex: 2, mediaTimeMs: 4875, type: 'crop', box: [0, 0, 65, 100] }
    ] } }
  ];
  await writeFile(fixture.viewingPath, JSON.stringify(fixture.payload));
  await writeFile(join(fixture.packageDir, secondRef), bytes);
  const options = { storyboardRef: secondRef, mediaTimeMs: 5000, playheadMs: 5000 };
  await assert.rejects(readSpoilerGatedStoryboardFrame(fixture.packageDir, { ...options, playheadMs: 4875 }), /playhead/);
  const part = await readSpoilerGatedStoryboardFrame(fixture.packageDir, options);
  assert.deepEqual(part.content, bytes);
  assert.equal(part.metadata.width, 65);
  assert.equal(part.metadata.views[0].mediaTimeMs, 4875);
});

test('a finished picture-in-picture JPEG is read byte for byte once its package group releases', async t => {
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('requires FFmpeg');
  const fixture = await createPreparedPackage();
  t.after(() => rm(fixture.packageDir, { recursive: true, force: true }));
  const entry = fixture.payload.segments.flatMap(section => section.entries).find(item => item.type === 'image');
  const sourceBox = [.39, .34, .56, .54];
  const full = (mediaTimeMs, box) => ({ type: 'full', sourceIndex: 0, mediaTimeMs, box });
  const crop = (mediaTimeMs, anchorTimeMs, box) => ({ type: 'crop', sourceIndex: 0, mediaTimeMs, anchorTimeMs, box, sourceBox });
  entry.image = { width: 80, height: 40, views: [
    full(4000, [0, 0, 40, 40]), crop(4300, 4000, [4, 8, 12, 12]),
    full(4500, [40, 0, 40, 40]), crop(4875, 4500, [48, 8, 12, 12])
  ] };
  const encoded = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=80x40',
    '-vf', 'drawbox=x=40:y=0:w=40:h=40:color=green:t=fill,drawbox=x=4:y=8:w=12:h=12:color=blue:t=fill',
    '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']);
  assert.equal(encoded.status, 0, encoded.stderr.toString());
  await writeFile(fixture.viewingPath, JSON.stringify(fixture.payload));
  await writeFile(join(fixture.packageDir, entry.storyboardRef), encoded.stdout);
  const options = { storyboardRef: entry.storyboardRef, mediaTimeMs: 5000, playheadMs: 5000 };
  await assert.rejects(readSpoilerGatedStoryboardFrame(fixture.packageDir, { ...options, playheadMs: 4999 }), /playhead/);
  for (const playheadMs of [5000, 20_000]) {
    const frame = await readSpoilerGatedStoryboardFrame(fixture.packageDir, { ...options, playheadMs });
    assert.deepEqual(frame.content, encoded.stdout);
    assert.deepEqual(frame.metadata.views, entry.image.views);
  }
});
