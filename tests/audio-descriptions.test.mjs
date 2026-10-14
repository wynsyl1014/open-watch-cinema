import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AUDIO_NOT_PREPARED,
  audioTrackState,
  getAudioDescriptionStatus,
  validateAudioPayload
} from '../src/audio-descriptions.mjs';
import {
  createObservationPrecomputeManifest,
  markObservationChunkComplete
} from '../src/observation-precompute-plan.mjs';
import { readObservationTrackWindow } from '../src/observation-track-reader.mjs';

const audioChunk = {
  logicalStartMs: 0,
  logicalEndMs: 30_000
};

function description(fromMs, toMs, id = `audio-${fromMs}`) {
  return {
    id,
    fromMs,
    toMs,
    availableAtMs: toMs,
    text: `Sound at ${fromMs}ms.`,
    source: 'local_audio_model'
  };
}

function payload(status, descriptions) {
  return { status, descriptions };
}

test('validateAudioPayload rejects gaps and overlaps in ready coverage', () => {
  assert.throws(
    () => validateAudioPayload(payload('ready', [
      description(0, 10_000),
      description(11_000, 30_000)
    ]), audioChunk),
    /cover their chunk in order/
  );
  assert.throws(
    () => validateAudioPayload(payload('ready', [
      description(0, 12_000),
      description(11_000, 30_000)
    ]), audioChunk),
    /cover their chunk in order/
  );
});

test('validateAudioPayload rejects a completion time that differs from the clip end', () => {
  assert.throws(
    () => validateAudioPayload(payload('ready', [{
      ...description(0, 10_000),
      availableAtMs: 9_999
    }, description(10_000, 30_000)]), audioChunk),
    /cover their chunk in order/
  );
});

test('validateAudioPayload rejects partial ready coverage and source-missing descriptions', () => {
  assert.throws(
    () => validateAudioPayload(payload('ready', [description(0, 10_000)]), audioChunk),
    /complete chunk/
  );
  assert.throws(
    () => validateAudioPayload(payload('source_missing', [description(0, 30_000)]), audioChunk),
    /cannot contain descriptions/
  );
});

test('validateAudioPayload accepts complete captions and an audio-less chunk', () => {
  const complete = validateAudioPayload(payload('ready', [
    description(0, 10_000),
    description(10_000, 20_000),
    description(20_000, 30_000)
  ]), audioChunk);
  assert.equal(complete.descriptions.length, 3);
  assert.deepEqual(
    validateAudioPayload(payload('source_missing', []), audioChunk),
    { status: 'source_missing', descriptions: [] }
  );
});

test('audioTrackState distinguishes pending, failed, source-missing, and ready tracks', () => {
  assert.equal(audioTrackState([
    { audioStatus: 'ready', audioDescriptionCount: 2 },
    { audioStatus: 'pending', audioDescriptionCount: 0 }
  ], { model: 'fixture' }).status, 'pending');
  assert.equal(audioTrackState([
    { audioStatus: 'ready', audioDescriptionCount: 2 },
    { audioStatus: 'failed', audioDescriptionCount: 0 }
  ]).status, 'failed');
  assert.equal(audioTrackState([
    { audioStatus: 'source_missing', audioDescriptionCount: 0 },
    { audioStatus: 'source_missing', audioDescriptionCount: 0 }
  ]).status, 'source_missing');
  assert.deepEqual(audioTrackState([
    { audioStatus: 'ready', audioDescriptionCount: 2 },
    { audioStatus: 'source_missing', audioDescriptionCount: 0 }
  ]), {
    status: 'ready',
    completeChunks: 2,
    totalChunks: 2,
    descriptionCount: 2,
    resultKind: 'chunked_audio_descriptions'
  });
});

test('missing optional audio setup remains diagnostic and does not become silence', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'owc-audio-status-'));
  const previousPython = process.env.OWC_AUDIO_PYTHON;
  process.env.OWC_AUDIO_PYTHON = join(projectRoot, 'missing-python');
  try {
    const status = await getAudioDescriptionStatus(projectRoot, join(projectRoot, 'data'));
    assert.equal(status.status, 'unavailable');
    assert.match(status.note, /optional local audio setup/i);
    assert.deepEqual(AUDIO_NOT_PREPARED, { status: 'not_prepared', descriptionCount: 0 });
  } finally {
    if (previousPython === undefined) delete process.env.OWC_AUDIO_PYTHON;
    else process.env.OWC_AUDIO_PYTHON = previousPython;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

async function createAudioPackage() {
  const packageDir = await mkdtemp(join(tmpdir(), 'owc-audio-reader-'));
  const chunkDir = join(packageDir, 'chunks', 'chunk-0000');
  await mkdir(chunkDir, { recursive: true });

  let manifest = createObservationPrecomputeManifest({
    mediaIdentity: 'sha256:audio-reader-fixture',
    durationMs: 30_000,
    maxAnalysisDurationMs: 30_000,
    boundaryContextMs: 0
  });
  manifest = markObservationChunkComplete(manifest, 0, {
    observationCount: 0,
    storyboardCount: 0
  });
  manifest.chunks[0] = {
    ...manifest.chunks[0],
    audioStatus: 'ready',
    audioRef: 'chunks/chunk-0000/audio.json',
    audioDescriptionCount: 3
  };
  manifest = {
    ...manifest,
    visualTrack: { status: 'ready', protocolVersion: 2 },
    audioTrack: { status: 'ready', model: 'fixture' },
    aiReadiness: { status: 'ready', ready: true, experienceMode: 'complete', blockers: [] }
  };
  await writeFile(join(chunkDir, 'audio.json'), `${JSON.stringify({
    status: 'ready',
    descriptions: [
      description(0, 10_000, 'one'),
      description(10_000, 20_000, 'two'),
      description(20_000, 30_000, 'three')
    ]
  })}\n`);
  await writeFile(join(packageDir, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  return packageDir;
}

test('audio is released only at completed clip end and never by lookahead', async () => {
  const packageDir = await createAudioPackage();
  try {
    const beforeClipEnd = await readObservationTrackWindow(packageDir, {
      fromMs: 0,
      toMs: 30_000,
      playheadMs: 9_999,
      lookaheadMs: 10_000
    });
    assert.deepEqual(beforeClipEnd.audioDescriptions, []);

    const atClipEnd = await readObservationTrackWindow(packageDir, {
      fromMs: 0,
      toMs: 30_000,
      playheadMs: 10_000,
      lookaheadMs: 10_000
    });
    assert.deepEqual(atClipEnd.audioDescriptions.map((item) => item.id), ['one']);
    assert.equal(atClipEnd.audioDescriptions[0].availableAtMs, 10_000);
  } finally {
    await rm(packageDir, { recursive: true, force: true });
  }
});

test('audio cursor does not repeat an acknowledged clip', async () => {
  const packageDir = await createAudioPackage();
  try {
    const result = await readObservationTrackWindow(packageDir, {
      fromMs: 10_000,
      toMs: 30_000,
      playheadMs: 20_000,
      lookaheadMs: 1_000
    });
    assert.deepEqual(result.audioDescriptions.map((item) => item.id), ['two']);
    assert.ok(!result.audioDescriptions.some((item) => item.id === 'one'));
  } finally {
    await rm(packageDir, { recursive: true, force: true });
  }
});

test('audio item limits retain backlog in nextCursorMs', async () => {
  const packageDir = await createAudioPackage();
  try {
    const firstPage = await readObservationTrackWindow(packageDir, {
      fromMs: 0,
      toMs: 30_000,
      playheadMs: 30_000,
      lookaheadMs: 0,
      maxAudioItems: 1
    });
    assert.deepEqual(firstPage.audioDescriptions.map((item) => item.id), ['one']);
    assert.equal(firstPage.audioHasMore, true);
    assert.equal(firstPage.nextCursorMs, 10_000);

    const secondPage = await readObservationTrackWindow(packageDir, {
      fromMs: firstPage.nextCursorMs,
      toMs: 30_000,
      playheadMs: 30_000,
      lookaheadMs: 0,
      maxAudioItems: 1
    });
    assert.deepEqual(secondPage.audioDescriptions.map((item) => item.id), ['two']);
    assert.equal(secondPage.nextCursorMs, 20_000);
  } finally {
    await rm(packageDir, { recursive: true, force: true });
  }
});
