import assert from 'node:assert/strict';
import test from 'node:test';
import { createObservationPrecomputeManifest } from '../../src/preparation/observation-precompute-plan.mjs';
import {
  appendViewingAudio, createViewingChunk, validateViewingChunk,
  viewingAudioPayload, viewingPreparationState
} from '../../src/delivery/viewing-package.mjs';

function fixture(motionObservations = []) {
  const manifest = createObservationPrecomputeManifest({
    mediaIdentity: 'viewing-fixture', durationMs: 12_000, viewingIntervalMs: 4_000
  });
  const chunk = manifest.chunks[0];
  const payload = createViewingChunk({
    planId: manifest.planId, chunk, intervalMs: manifest.viewingIntervalMs,
    storyboardRootRef: 'chunks/chunk-0000/storyboards',
    dialogue: {
      status: 'ready', sourceMode: 'fixture',
      cues: [{ cueId: 'cross-section', fromMs: 3_000, toMs: 5_500, text: 'A complete sentence.' }]
    },
    analysis: {
      engine: 'fixture', protocolVersion: 2, sampleFps: 2,
      observations: [
        { fromMs: 0, toMs: 500, kind: 'heartbeat', motionScore: 0 },
        { fromMs: 6_000, toMs: 6_500, kind: 'scene_change', motionScore: 0 },
        ...motionObservations
      ],
      frames: [{
        filename: 'strip.jpg', mediaTimeMs: 6_000, panelTimesMs: [5_000, 5_500, 6_000],
        panels: [5_000, 5_500, 6_000].map((mediaTimeMs) => ({ mediaTimeMs })),
        parts: [
          { filename: 'strip.jpg', mediaTimeMs: 5_500, image: { width: 476, height: 268 } },
          { filename: 'strip-part-2.jpg', mediaTimeMs: 6_000, image: { width: 120, height: 90 } }
        ]
      }]
    }
  });
  return { manifest, chunk, payload };
}

test('complete dialogue belongs once to its start section and image refs remain portable', () => {
  const { manifest, chunk, payload } = fixture();
  assert.equal(validateViewingChunk(payload, manifest, chunk), payload);
  const entries = payload.segments.flatMap((section) => section.entries);
  const dialogue = entries.filter((entry) => entry.type === 'dialogue');
  assert.equal(dialogue.length, 1);
  assert.equal(payload.segments[0].entries[0].id, dialogue[0].id);
  assert.equal(dialogue[0].toMs, 5_500);
  assert.equal(dialogue[0].availableAtMs, 3_000);
  const image = entries.find((entry) => entry.type === 'image');
  assert.equal(image.storyboardRef, 'chunks/chunk-0000/storyboards/strip.jpg');
  assert.equal(image.parts[1].ref, 'chunks/chunk-0000/storyboards/strip-part-2.jpg');
  assert.equal(image.panels.length, 3);
  assert.equal(entries.filter((entry) => entry.type === 'motion').length, 1);
});

test('audio belongs to its start section and releases at the start without splitting its range', () => {
  const { manifest, chunk, payload } = fixture();
  const audio = {
    status: 'ready', model: 'fixture',
    descriptions: [
      { id: 'a', fromMs: 0, toMs: 10_000, availableAtMs: 10_000, text: 'Footsteps and a late knock.', source: 'local_audio_model' },
      { id: 'b', fromMs: 10_000, toMs: 12_000, availableAtMs: 12_000, text: 'Music.', source: 'local_audio_model' }
    ]
  };
  const updated = appendViewingAudio(payload, audio, 'fixture-profile');
  validateViewingChunk(updated, manifest, chunk);
  assert.equal(updated.segments[0].entries.find((entry) => entry.type === 'sound').toMs, 10_000);
  assert.equal(updated.segments[0].entries.find((entry) => entry.type === 'sound').availableAtMs, 0);
  assert.deepEqual(viewingAudioPayload(updated).descriptions,
    audio.descriptions.map((entry) => ({ ...entry, availableAtMs: entry.fromMs })));
  assert.deepEqual(appendViewingAudio(updated, audio, 'fixture-profile'), updated);
});

test('buffer readiness waits for the requested audio while preserving visual progress', () => {
  const { manifest } = fixture();
  Object.assign(manifest.chunks[0], { status: 'complete', viewingRef: 'chunks/chunk-0000/viewing.json' });
  let progress = viewingPreparationState(manifest, { initialBufferMs: 8_000, audioRequested: true });
  assert.equal(progress.visualPreparedThroughMs, 12_000);
  assert.equal(progress.preparedThroughMs, 0);
  assert.equal(progress.initialBufferReady, false);
  manifest.chunks[0].audioStatus = 'ready';
  progress = viewingPreparationState(manifest, { initialBufferMs: 8_000, audioRequested: true });
  assert.equal(progress.initialBufferReady, true);
  assert.equal(progress.status, 'ready');
  assert.equal(viewingPreparationState(manifest).initialBufferReady, null);
});

test('fixed viewing sections align analysis ownership without changing the decoding limit', () => {
  const manifest = createObservationPrecomputeManifest({
    mediaIdentity: 'aligned-fixture', durationMs: 700_000, viewingIntervalMs: 7_000
  });
  assert.equal(manifest.logicalChunkDurationMs, 294_000);
  assert.ok(manifest.chunks.every((chunk) => chunk.logicalStartMs % 7_000 === 0));
  assert.ok(manifest.chunks.every((chunk) => chunk.analysisDurationMs <= 300_000));
});

test('strong motion without a clear direction keeps its plain motion note', () => {
  const { manifest, chunk, payload } = fixture([
    { fromMs: 7_000, toMs: 7_500, kind: 'motion_peak', motionScore: 1, metrics: { motionDirection: 'still' } },
    { fromMs: 8_000, toMs: 8_500, kind: 'motion_peak', motionScore: 1, metrics: { motionDirection: 'right' } }
  ]);
  assert.equal(validateViewingChunk(payload, manifest, chunk), payload);
  const motion = payload.segments.flatMap((section) => section.entries)
    .filter((entry) => entry.type === 'motion').map(({ text, direction }) => ({ text, direction }));
  assert.deepEqual(motion, [
    { text: '画面出现明显切换。', direction: null },
    { text: '画面出现明显运动。', direction: 'still' },
    { text: '画面出现明显运动，主要方向向右。', direction: 'right' }
  ]);
});
