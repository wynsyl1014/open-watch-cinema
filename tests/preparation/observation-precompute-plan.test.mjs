import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_ANALYSIS_DURATION_MS,
  createObservationPrecomputeManifest,
  getNextObservationChunk,
  markObservationChunkComplete,
  markObservationChunkFailed,
  markObservationChunkRunning,
  planObservationChunks,
  validateObservationPrecomputeManifest
} from '../../src/preparation/observation-precompute-plan.mjs';

test('short media produces one bounded chunk with no artificial overlap', () => {
  const chunks = planObservationChunks(90_000);
  assert.equal(chunks.length, 1);
  assert.deepEqual(
    {
      logicalStartMs: chunks[0].logicalStartMs,
      logicalEndMs: chunks[0].logicalEndMs,
      analysisStartMs: chunks[0].analysisStartMs,
      analysisDurationMs: chunks[0].analysisDurationMs,
      acceptFromMs: chunks[0].acceptFromMs,
      acceptToMs: chunks[0].acceptToMs
    },
    {
      logicalStartMs: 0,
      logicalEndMs: 90_000,
      analysisStartMs: 0,
      analysisDurationMs: 90_000,
      acceptFromMs: 0,
      acceptToMs: 90_000
    }
  );
});

test('long media has contiguous ownership ranges and bounded two-second context overlap', () => {
  const durationMs = 750_000;
  const chunks = planObservationChunks(durationMs);
  assert.equal(chunks.length, 3);

  let coveredThroughMs = 0;
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.logicalStartMs, coveredThroughMs);
    assert.equal(chunk.acceptFromMs, chunk.logicalStartMs);
    assert.equal(chunk.acceptToMs, chunk.logicalEndMs);
    assert.ok(chunk.analysisDurationMs <= MAX_ANALYSIS_DURATION_MS);
    assert.equal(
      chunk.analysisStartMs,
      index === 0 ? chunk.logicalStartMs : chunk.logicalStartMs - 2_000
    );
    coveredThroughMs = chunk.logicalEndMs;
  }

  assert.equal(coveredThroughMs, durationMs);
  assert.equal(chunks[0].logicalEndMs, chunks[1].logicalStartMs);
  assert.equal(chunks[1].logicalEndMs, chunks[2].logicalStartMs);
});

test('manifest identity is deterministic for the same compatible media and observer profile', () => {
  const input = {
    mediaIdentity: 'sha256:compatible-film-v1',
    durationMs: 750_000,
    observerProtocolVersion: 2,
    sampleFps: 2
  };
  const first = createObservationPrecomputeManifest(input);
  const second = createObservationPrecomputeManifest(input);

  assert.deepEqual(first, second);
  assert.equal(first.status, 'pending');
  assert.equal(first.progress.pendingChunks, 3);
  assert.equal(validateObservationPrecomputeManifest(first), true);
});

test('resume selects the first incomplete chunk and preserves completed progress', () => {
  let manifest = createObservationPrecomputeManifest({
    mediaIdentity: 'sha256:resume-film',
    durationMs: 750_000
  });

  manifest = markObservationChunkRunning(manifest, 0);
  assert.equal(manifest.chunks[0].attempts, 1);
  assert.equal(manifest.status, 'running');

  manifest = markObservationChunkComplete(manifest, 0, {
    observationCount: 42,
    storyboardCount: 6,
    resultRef: 'chunks/chunk-0000.json'
  });
  assert.equal(manifest.progress.completedThroughMs, manifest.chunks[0].logicalEndMs);
  assert.equal(manifest.progress.completeChunks, 1);
  assert.equal(getNextObservationChunk(manifest).index, 1);
  assert.equal(validateObservationPrecomputeManifest(manifest), true);

  manifest = markObservationChunkFailed(manifest, 1, 'synthetic interruption');
  assert.equal(manifest.chunks[1].status, 'failed');
  assert.equal(getNextObservationChunk(manifest).index, 1);

  manifest = markObservationChunkRunning(manifest, 1);
  assert.equal(manifest.chunks[1].attempts, 1);
  assert.equal(manifest.chunks[1].error, null);
});

test('manifest becomes ready only after every logical range is complete', () => {
  let manifest = createObservationPrecomputeManifest({
    mediaIdentity: 'sha256:ready-film',
    durationMs: 600_000
  });

  for (const chunk of manifest.chunks) {
    manifest = markObservationChunkRunning(manifest, chunk.index);
    manifest = markObservationChunkComplete(manifest, chunk.index, {
      observationCount: chunk.index + 1,
      storyboardCount: 0,
      resultRef: `chunks/${chunk.chunkId}.json`
    });
  }

  assert.equal(manifest.status, 'ready');
  assert.equal(manifest.progress.percent, 100);
  assert.equal(manifest.progress.completedThroughMs, 600_000);
  assert.equal(getNextObservationChunk(manifest), null);
  assert.equal(validateObservationPrecomputeManifest(manifest), true);
});

test('invalid overlap configuration is rejected before any worker execution', () => {
  assert.throws(
    () => planObservationChunks(10_000, {
      maxAnalysisDurationMs: 2_000,
      boundaryContextMs: 2_000
    }),
    /smaller than/
  );
});
