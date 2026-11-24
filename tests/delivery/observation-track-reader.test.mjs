import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createObservationPrecomputeManifest,
  markObservationChunkComplete
} from '../../src/preparation/observation-precompute-plan.mjs';
import { readObservationTrackWindow } from '../../src/delivery/observation-track-reader.mjs';
import { appendViewingAudio, createViewingChunk, viewingPreparationState } from '../../src/delivery/viewing-package.mjs';

async function createPackage() {
  const packageDir = await mkdtemp(join(tmpdir(), 'owc-track-reader-'));
  const chunkDir = join(packageDir, 'chunks', 'chunk-0000');
  await mkdir(join(chunkDir, 'storyboards'), { recursive: true });
  let manifest = createObservationPrecomputeManifest({
    mediaIdentity: 'sha256:reader-fixture',
    durationMs: 30_000
  });
  manifest = markObservationChunkComplete(manifest, 0, {
    observationCount: 4,
    storyboardCount: 1,
    resultRef: 'chunks/chunk-0000/visual.json'
  });
  manifest.chunks[0] = {
    ...manifest.chunks[0],
    visualRef: 'chunks/chunk-0000/visual.json',
    dialogueRef: 'chunks/chunk-0000/dialogue.json',
    storyboardRootRef: 'chunks/chunk-0000/storyboards',
    dialogueCueCount: 3
  };
  manifest = {
    ...manifest,
    visualTrack: { status: 'ready', protocolVersion: 2 },
    dialogueTrack: { status: 'ready', cueCount: 3 },
    aiReadiness: {
      status: 'ready',
      ready: true,
      experienceMode: 'complete',
      blockers: []
    }
  };
  const observations = [1_000, 5_000, 15_000, 25_000].map((fromMs, index) => ({
    fromMs,
    toMs: fromMs + 500,
    kind: index === 1 ? 'scene_change' : 'heartbeat',
    sceneScore: index / 10,
    motionScore: index / 20,
    metrics: { motionDirection: 'right' },
    ...(index === 1 ? {
      storyboard: {
        filename: 'sample.jpg',
        mediaTimeMs: fromMs,
        frameReason: 'scene_change'
      }
    } : {})
  }));
  const dialogue = [
    { cueId: 'one', fromMs: 900, toMs: 1_800, text: 'First line.' },
    { cueId: 'two', fromMs: 5_500, toMs: 7_500, text: 'Near the spoiler gate.' },
    { cueId: 'three', fromMs: 15_200, toMs: 16_000, text: 'After the seek.' }
  ];
  await writeFile(
    join(chunkDir, 'visual.json'),
    `${JSON.stringify({ observations })}\n`
  );
  await writeFile(
    join(chunkDir, 'dialogue.json'),
    `${JSON.stringify({ status: 'ready', cues: dialogue })}\n`
  );
  await writeFile(join(packageDir, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  return packageDir;
}

test('track reader enforces the playhead spoiler gate for visual and dialogue tracks', async () => {
  const packageDir = await createPackage();
  try {
    const result = await readObservationTrackWindow(packageDir, {
      fromMs: 0,
      toMs: 20_000,
      playheadMs: 6_000,
      lookaheadMs: 1_000
    });

    assert.equal(result.revealThroughMs, 7_000);
    assert.deepEqual(result.observations.map((item) => item.fromMs), [1_000, 5_000]);
    assert.deepEqual(result.dialogue.map((item) => item.cueId), ['one', 'two']);
    assert.ok(result.observations.every((item) => item.fromMs < result.revealThroughMs));
    assert.ok(result.dialogue.every((item) => item.fromMs < result.revealThroughMs));
    assert.equal(result.aiReadiness.ready, true);
  } finally {
    await rm(packageDir, { recursive: true, force: true });
  }
});

test('seek reads from the new cursor without replaying earlier visual or dialogue items', async () => {
  const packageDir = await createPackage();
  try {
    const result = await readObservationTrackWindow(packageDir, {
      fromMs: 14_000,
      toMs: 30_000,
      playheadMs: 20_000,
      lookaheadMs: 0
    });

    assert.deepEqual(result.observations.map((item) => item.fromMs), [15_000]);
    assert.deepEqual(result.dialogue.map((item) => item.cueId), ['three']);
    assert.ok(!result.observations.some((item) => item.fromMs < 14_000));
    assert.ok(!result.dialogue.some((item) => item.fromMs < 14_000));
    assert.equal(result.nextCursorMs, 16_000);
  } finally {
    await rm(packageDir, { recursive: true, force: true });
  }
});

test('storyboards are exposed only as chunk-relative package references', async () => {
  const packageDir = await createPackage();
  try {
    const result = await readObservationTrackWindow(packageDir, {
      fromMs: 4_000,
      toMs: 6_000,
      playheadMs: 6_000,
      lookaheadMs: 0
    });
    const storyboard = result.observations[0].storyboard;
    assert.equal(storyboard.storyboardRef, 'chunks/chunk-0000/storyboards/sample.jpg');
    assert.equal('filename' in storyboard, false);
  } finally {
    await rm(packageDir, { recursive: true, force: true });
  }
});

async function createUnifiedPackage() {
  const packageDir = await mkdtemp(join(tmpdir(), 'owc-unified-reader-'));
  let manifest = createObservationPrecomputeManifest({
    mediaIdentity: 'sha256:unified-reader-fixture', durationMs: 36_000,
    maxAnalysisDurationMs: 20_000, boundaryContextMs: 2_000, viewingIntervalMs: 6_000
  });
  const chunk = manifest.chunks[0];
  const viewingRef = 'chunks/chunk-0000/viewing.json';
  const payload = createViewingChunk({
    planId: manifest.planId, chunk, intervalMs: 6_000,
    storyboardRootRef: 'chunks/chunk-0000/storyboards',
    analysis: {
      engine: 'fixture', protocolVersion: 2, observations: [],
      frames: [0, 1, 5_000, 6_000, 12_000, 17_000].map((atMs) => ({
        filename: atMs + '.jpg', mediaTimeMs: atMs, panelTimesMs: [atMs]
      }))
    },
    dialogue: { status: 'ready', sourceMode: 'fixture', cues: [
      { cueId: 'long', fromMs: 1_000, toMs: 10_000, text: 'Keep this entire sentence.' },
      { cueId: 'next', fromMs: 6_000, toMs: 7_000, text: 'The next line.' }
    ] }
  });
  manifest = markObservationChunkComplete(manifest, 0, { observationCount: 0, storyboardCount: 6 });
  manifest.packageVersion = 3;
  Object.assign(manifest.chunks[0], { viewingRef, audioStatus: 'pending' });
  manifest.visualTrack = { status: 'pending' };
  manifest.dialogueTrack = { status: 'ready' };
  manifest.viewingTrack = viewingPreparationState(manifest, { audioRequested: true });
  await mkdir(join(packageDir, 'chunks/chunk-0000'), { recursive: true });
  await writeFile(join(packageDir, viewingRef), JSON.stringify(payload));
  await writeFile(join(packageDir, 'manifest.json'), JSON.stringify(manifest));
  return { packageDir, manifest, payload, viewingRef };
}

test('a simultaneous panorama and detail keep their prepared order across a cursor boundary', async t => {
  const { packageDir, payload, viewingRef } = await createUnifiedPackage();
  t.after(() => rm(packageDir, { recursive: true, force: true }));
  const section = payload.segments.find(section => section.fromMs === 6_000);
  const index = section.entries.findIndex(entry => entry.type === 'image');
  const panorama = { ...section.entries[index], id: 'image:z-panorama' };
  const detail = { ...panorama, id: 'image:a-detail', storyboardRef: 'chunks/chunk-0000/storyboards/detail.jpg' };
  section.entries.splice(index, 1, panorama, detail);
  await writeFile(join(packageDir, viewingRef), JSON.stringify(payload));

  const range = { toMs: 7_000, playheadMs: 7_000, maxItems: 1, tracks: ['visual'] };
  const earlier = await readObservationTrackWindow(packageDir, { ...range, fromMs: 4_999 });
  assert.equal(earlier.nextCursorMs, 5_999);
  const next = await readObservationTrackWindow(packageDir, { ...range, fromMs: earlier.nextCursorMs });
  const expected = [panorama.storyboardRef, detail.storyboardRef];
  assert.deepEqual(next.observations.map(item => item.storyboard.storyboardRef), expected);
  assert.deepEqual(next.segments.flatMap(section => section.entries.map(entry => entry.storyboardRef)), expected);
});

test('unified reading delivers complete start-time dialogue once and keeps partial preparation visible', async () => {
  const { packageDir } = await createUnifiedPackage();
  try {
    const first = await readObservationTrackWindow(packageDir, {
      fromMs: 0, toMs: 36_000, playheadMs: 4_000, lookaheadMs: 30_000
    });
    assert.equal(first.packageVersion, 3);
    assert.equal(first.revealThroughMs, 4_000);
    assert.deepEqual(first.dialogue.map((entry) => entry.text), ['Keep this entire sentence.']);
    assert.equal(first.dialogue[0].toMs, 10_000);
    assert.equal(first.nextCursorMs, 4_000);
    assert.deepEqual(first.pendingAudioRanges, [{ chunkId: 'chunk-0000', fromMs: 0, toMs: 4_000 }]);
    const next = await readObservationTrackWindow(packageDir, {
      fromMs: first.nextCursorMs, toMs: 6_000, playheadMs: 6_000
    });
    assert.deepEqual(next.dialogue.map((entry) => entry.text), ['The next line.']);
    const backlog = await readObservationTrackWindow(packageDir, {
      fromMs: 6_000, toMs: 30_000, playheadMs: 30_000
    });
    assert.equal(backlog.nextCursorMs, 17_999);
    assert.equal(backlog.awaitingPreparation, true);
  } finally { await rm(packageDir, { recursive: true, force: true }); }
});

test('visual-only lookup includes zero and exact-playhead frames while audio is pending', async () => {
  const { packageDir } = await createUnifiedPackage();
  try {
    for (const atMs of [0, 6_000]) {
      const result = await readObservationTrackWindow(packageDir, {
        fromMs: Math.max(0, atMs - 2_000), toMs: atMs + 1,
        playheadMs: atMs, tracks: ['visual']
      });
      const frame = result.observations.find((entry) => entry.storyboard.mediaTimeMs === atMs);
      assert.equal(frame.storyboard.storyboardRef, 'chunks/chunk-0000/storyboards/' + atMs + '.jpg');
      assert.deepEqual(result.dialogue, []);
      assert.deepEqual(result.audioDescriptions, []);
      assert.deepEqual(result.pendingAudioRanges, []);
    }
  } finally { await rm(packageDir, { recursive: true, force: true }); }
});

test('late audio is reread from its pending range with start-time release and original section', async () => {
  const { packageDir, manifest, payload, viewingRef } = await createUnifiedPackage();
  try {
    const pending = await readObservationTrackWindow(packageDir, {
      fromMs: 0, toMs: 12_000, playheadMs: 12_000
    });
    const audio = {
      status: 'ready',
      descriptions: [0, 6_000, 12_000].map((fromMs) => ({
        id: 'sound-' + fromMs, fromMs, toMs: fromMs + 6_000, availableAtMs: fromMs + 6_000,
        text: 'Footsteps.', source: 'acoustic_measurement'
      }))
    };
    await writeFile(join(packageDir, viewingRef), JSON.stringify(appendViewingAudio(payload, audio, {})));
    manifest.chunks[0].audioStatus = 'ready';
    await writeFile(join(packageDir, 'manifest.json'), JSON.stringify(manifest));
    const range = pending.pendingAudioRanges[0];
    const resumed = await readObservationTrackWindow(packageDir, {
      fromMs: range.fromMs, toMs: range.toMs, playheadMs: 18_000, tracks: ['audio']
    });
    assert.deepEqual(resumed.audioDescriptions.map((entry) => entry.availableAtMs), [0, 6_000, 12_000]);
    assert.deepEqual(resumed.segments.map((section) => section.fromMs), [0, 6_000, 12_000]);
    const last = await readObservationTrackWindow(packageDir, {
      fromMs: 12_000, toMs: 18_000, playheadMs: 18_000, tracks: ['audio']
    });
    assert.deepEqual(last.audioDescriptions, []);
    assert.equal(last.nextCursorMs, 18_000);
  } finally { await rm(packageDir, { recursive: true, force: true }); }
});

test('unified capacity continuation neither drops nor repeats selected image times', async () => {
  const { packageDir } = await createUnifiedPackage();
  try {
    const seen = [];
    let fromMs = 0;
    while (fromMs < 17_999) {
      const page = await readObservationTrackWindow(packageDir, {
        fromMs, toMs: 18_000, playheadMs: 18_000, tracks: ['visual'], maxItems: 1
      });
      seen.push(...page.observations.map((entry) => entry.storyboard.mediaTimeMs));
      assert.ok(page.nextCursorMs > fromMs);
      fromMs = page.nextCursorMs;
    }
    assert.deepEqual(seen, [0, 1, 5_000, 6_000, 12_000, 17_000]);
  } finally { await rm(packageDir, { recursive: true, force: true }); }
});

test('visual-only legacy reads avoid an unrelated missing dialogue file and cancellation stops before I/O', async () => {
  const packageDir = await createPackage();
  try {
    await rm(join(packageDir, 'chunks/chunk-0000/dialogue.json'));
    const result = await readObservationTrackWindow(packageDir, {
      fromMs: 4_000, toMs: 6_000, playheadMs: 6_000, tracks: ['visual']
    });
    assert.equal(result.observations[0].storyboard.mediaTimeMs, 5_000);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(readObservationTrackWindow(join(packageDir, 'missing'), {
      fromMs: 0, toMs: 1, playheadMs: 1, signal: controller.signal
    }), { name: 'AbortError' });
  } finally { await rm(packageDir, { recursive: true, force: true }); }
});

test('zero-time sound is visible immediately, including old end-gated unified entries', async () => {
  const { packageDir, manifest, payload, viewingRef } = await createUnifiedPackage();
  try {
    const updated = appendViewingAudio(payload, {
      status: 'ready', descriptions: [0, 6_000, 12_000].map((fromMs) => ({
        id: 'sound-' + fromMs, fromMs, toMs: fromMs + 6_000, availableAtMs: fromMs,
        text: 'Prepared interval.', source: 'acoustic_measurement'
      }))
    }, {});
    for (const section of updated.segments) for (const entry of section.entries) {
      if (entry.type === 'sound') entry.availableAtMs = entry.toMs;
    }
    await writeFile(join(packageDir, viewingRef), JSON.stringify(updated));
    manifest.chunks[0].audioStatus = 'ready';
    await writeFile(join(packageDir, 'manifest.json'), JSON.stringify(manifest));
    const atZero = await readObservationTrackWindow(packageDir, {
      fromMs: 0, toMs: 0, playheadMs: 0
    });
    assert.deepEqual(atZero.audioDescriptions.map((entry) => entry.availableAtMs), [0]);
    assert.equal(atZero.audioDescriptions[0].toMs, 6_000);
    assert.deepEqual(atZero.observations, []);
    assert.deepEqual(atZero.dialogue, []);
    assert.equal(atZero.nextCursorMs, 0);
    const atStart = await readObservationTrackWindow(packageDir, {
      fromMs: 5_000, toMs: 6_000, playheadMs: 6_000
    });
    assert.deepEqual(atStart.audioDescriptions.map((entry) => entry.availableAtMs), [6_000]);
    assert.equal(atStart.audioDescriptions[0].toMs, 12_000);
    assert.equal(atStart.nextCursorMs, 6_000);
    assert.ok(atStart.observations.every((entry) => entry.fromMs <= 6_000));
    const chatBefore = await readObservationTrackWindow(packageDir, {
      fromMs: 0, toMs: 5_999, playheadMs: 5_999, tracks: ['audio'], gateAudioAtEnd: true
    });
    assert.deepEqual(chatBefore.audioDescriptions, []);
    const chatAtEnd = await readObservationTrackWindow(packageDir, {
      fromMs: chatBefore.nextCursorMs, toMs: 6_000, playheadMs: 6_000,
      tracks: ['audio'], gateAudioAtEnd: true
    });
    assert.deepEqual(chatAtEnd.audioDescriptions.map(entry => [entry.fromMs, entry.toMs, entry.availableAtMs]),
      [[0, 6_000, 6_000]]);
  } finally { await rm(packageDir, { recursive: true, force: true }); }
});

test('pending audio at a newly reached batch start survives unfinished visuals and later preparation', async () => {
  const { packageDir, manifest } = await createUnifiedPackage();
  try {
    const chunk = manifest.chunks[1];
    const viewingRef = 'chunks/' + chunk.chunkId + '/viewing.json';
    const beforeMedia = await readObservationTrackWindow(packageDir, {
      fromMs: chunk.logicalStartMs - 1000, toMs: chunk.logicalStartMs,
      playheadMs: chunk.logicalStartMs
    });
    assert.equal(beforeMedia.nextCursorMs, chunk.logicalStartMs - 1);
    assert.equal(beforeMedia.awaitingPreparation, true);
    const beforeVisuals = await readObservationTrackWindow(packageDir, {
      fromMs: chunk.logicalStartMs - 1000, toMs: chunk.logicalStartMs,
      playheadMs: chunk.logicalStartMs, tracks: ['audio']
    });
    const reserved = beforeVisuals.pendingAudioRanges.find((range) => range.chunkId === chunk.chunkId);
    assert.deepEqual(reserved, {
      chunkId: chunk.chunkId, fromMs: chunk.logicalStartMs - 1, toMs: chunk.logicalStartMs
    });
    const payload = createViewingChunk({
      planId: manifest.planId, chunk, intervalMs: 6_000,
      storyboardRootRef: 'chunks/' + chunk.chunkId + '/storyboards',
      analysis: { engine: 'fixture', observations: [], frames: [{
        filename: 'boundary.jpg', mediaTimeMs: chunk.logicalStartMs,
        panelTimesMs: [chunk.logicalStartMs, chunk.logicalStartMs, chunk.logicalStartMs]
      }] },
      dialogue: { status: 'ready', cues: [{
        cueId: 'boundary-line', fromMs: chunk.logicalStartMs,
        toMs: chunk.logicalStartMs + 2000, text: 'The next batch starts here.'
      }] }
    });
    const next = markObservationChunkComplete(manifest, 1, { observationCount: 0, storyboardCount: 0 });
    Object.assign(next.chunks[1], { viewingRef, audioStatus: 'pending' });
    next.viewingTrack = viewingPreparationState(next, { audioRequested: true });
    await mkdir(join(packageDir, 'chunks', chunk.chunkId), { recursive: true });
    await writeFile(join(packageDir, viewingRef), JSON.stringify(payload));
    await writeFile(join(packageDir, 'manifest.json'), JSON.stringify(next));
    const nextMedia = await readObservationTrackWindow(packageDir, {
      fromMs: beforeMedia.nextCursorMs, toMs: chunk.logicalStartMs + 1000,
      playheadMs: chunk.logicalStartMs + 1000, tracks: ['visual', 'dialogue']
    });
    assert.deepEqual(nextMedia.dialogue.map((entry) => entry.text), ['The next batch starts here.']);
    assert.deepEqual(nextMedia.observations.map((entry) => entry.storyboard.mediaTimeMs), [chunk.logicalStartMs]);
    const afterMedia = await readObservationTrackWindow(packageDir, {
      fromMs: nextMedia.nextCursorMs, toMs: chunk.logicalStartMs + 2000,
      playheadMs: chunk.logicalStartMs + 2000, tracks: ['visual', 'dialogue']
    });
    assert.deepEqual(afterMedia.dialogue, []);
    assert.deepEqual(afterMedia.observations, []);
    const atBoundary = await readObservationTrackWindow(packageDir, {
      fromMs: chunk.logicalStartMs - 1000, toMs: chunk.logicalStartMs,
      playheadMs: chunk.logicalStartMs, tracks: ['audio']
    });
    assert.ok(atBoundary.pendingAudioRanges.some((range) =>
      range.chunkId === chunk.chunkId && range.fromMs === chunk.logicalStartMs - 1
      && range.toMs === chunk.logicalStartMs));
    const ready = appendViewingAudio(payload, {
      status: 'ready', descriptions: [{
        id: 'boundary-sound', fromMs: chunk.logicalStartMs, toMs: chunk.logicalEndMs,
        availableAtMs: chunk.logicalEndMs, text: 'A prepared sound range.', source: 'acoustic_measurement'
      }]
    }, {});
    await writeFile(join(packageDir, viewingRef), JSON.stringify(ready));
    next.chunks[1].audioStatus = 'ready';
    await writeFile(join(packageDir, 'manifest.json'), JSON.stringify(next));
    const supplemented = await readObservationTrackWindow(packageDir, {
      fromMs: reserved.fromMs, toMs: reserved.toMs,
      playheadMs: chunk.logicalStartMs + 1000, tracks: ['audio']
    });
    assert.deepEqual(supplemented.audioDescriptions.map((entry) => entry.fromMs), [chunk.logicalStartMs]);
    assert.equal(supplemented.audioDescriptions[0].toMs, chunk.logicalEndMs);
    assert.equal(supplemented.nextCursorMs, chunk.logicalStartMs);
  } finally { await rm(packageDir, { recursive: true, force: true }); }
});
