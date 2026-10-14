import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createObservationPrecomputeManifest,
  markObservationChunkComplete
} from '../src/observation-precompute-plan.mjs';
import {
  normalizeStoryboardRef,
  readSpoilerGatedStoryboardFrame
} from '../src/storyboard-frame.mjs';

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
