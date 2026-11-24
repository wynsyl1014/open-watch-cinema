import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createObservationPrecomputeManifest } from '../../src/preparation/observation-precompute-plan.mjs';
import { runObservationPrecompute } from '../../src/preparation/observation-precompute-runner.mjs';
import { imageSettingsForMode } from '../../src/visuals/image-settings.mjs';

const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DEFAULT_IMAGE_SETTINGS = imageSettingsForMode('balanced');
const DIALOGUE_FIXTURE = {
  status: 'source_detected',
  sourceMode: 'test_fixture',
  track: {
    id: 'fixture-eng',
    language: 'eng',
    title: 'English',
    label: 'English',
    default: true,
    format: 'webvtt'
  },
  cues: [
    { cueId: 'cue-a', fromMs: 1000, toMs: 3000, text: 'Opening line.' },
    { cueId: 'cue-b', fromMs: 299000, toMs: 301000, text: 'Boundary line.' }
  ],
  note: 'Synthetic dialogue fixture.'
};

async function createFakeAnalyzer(callLog, { failOnce = false } = {}) {
  let failed = false;
  return async (_projectRoot, options) => {
    callLog.push({ ...options });
    if (failOnce && !failed) {
      failed = true;
      throw new Error('synthetic worker interruption');
    }

    await mkdir(options.outputDir, { recursive: true });
    const times = [
      options.startMs,
      options.startMs + 2_000,
      options.startMs + options.durationMs - 1_000
    ];
    const frames = [];
    for (const [index, mediaTimeMs] of times.entries()) {
      const filename = `${options.storyboardPrefix}-${index}.jpg`;
      await writeFile(join(options.outputDir, filename), `frame-${mediaTimeMs}`);
      frames.push({ filename, mediaTimeMs, frameReason: 'motion_peak',
        image: { views: [{ type: 'full', sourceIndex: 0, mediaTimeMs }] } });
    }

    return {
      ok: true,
      protocolVersion: 2,
      engine: 'fake-observer-v1',
      sampleFps: options.sampleFps,
      decodedFrameCount: 3,
      observations: times.map((fromMs, index) => ({
        fromMs,
        toMs: fromMs + 1_000,
        kind: index === 0 ? 'segment_start' : 'motion_peak',
        sceneScore: 0,
        motionScore: 0.5,
        metrics: { perceptualHash: String(index) },
        storyboard: frames[index]
      })),
      frames
    };
  };
}

test('runner checkpoints one chunk, trims overlap, and resumes the same package to ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owc-precompute-runner-'));
  const inputPath = join(root, 'film.mp4');
  const outputRoot = join(root, 'observations');
  await writeFile(inputPath, 'placeholder-compatible-film');
  const calls = [];
  const analyzeSegment = await createFakeAnalyzer(calls);

  try {
    const first = await runObservationPrecompute(PROJECT_ROOT, {
      inputPath,
      outputRoot,
      durationMs: 700_000,
      mediaIdentity: 'sha256:test-resume-film',
      viewingIntervalMs: 2_000,
      imageSettings: DEFAULT_IMAGE_SETTINGS,
      dialogueSource: DIALOGUE_FIXTURE,
      maxChunks: 1,
      analyzeSegment
    });

    assert.equal(first.chunksRun, 1);
    assert.equal(first.ready, false);
    assert.equal(first.manifest.analysisActivation, 'manual_opt_in');
    assert.equal(first.manifest.progress.completeChunks, 1);
    assert.equal(first.manifest.chunks[0].attempts, 1);

    const second = await runObservationPrecompute(PROJECT_ROOT, {
      inputPath,
      outputRoot,
      durationMs: 700_000,
      mediaIdentity: 'sha256:test-resume-film',
      viewingIntervalMs: 2_000,
      imageSettings: DEFAULT_IMAGE_SETTINGS,
      dialogueSource: DIALOGUE_FIXTURE,
      analyzeSegment
    });

    assert.equal(second.ready, true);
    assert.equal(second.manifest.packageVersion, 3);
    assert.equal(second.manifest.status, 'ready');
    assert.equal(second.manifest.visualTrack.status, 'ready');
    assert.equal(second.manifest.aiReadiness.ready, true);
    assert.deepEqual(second.manifest.aiReadiness.blockers, []);
    assert.equal(second.manifest.dialogueTrack.status, 'ready');
    assert.equal(second.manifest.progress.percent, 100);
    assert.equal(calls.length, second.manifest.chunks.length);

    const boundaryChunk = second.manifest.chunks[1];
    assert.deepEqual(calls[1].previousViews, [{ type: 'full', mediaTimeMs: boundaryChunk.acceptFromMs - 1000 }]);
    assert.equal(calls[1].visualEndMs, boundaryChunk.acceptToMs);
    assert.match(boundaryChunk.viewingRef, /^chunks\/chunk-0001\/viewing\.json$/);
    assert.match(boundaryChunk.storyboardRootRef, /^chunks\/chunk-0001\/storyboards$/);
    const viewing = JSON.parse(await readFile(join(second.packageDir, boundaryChunk.viewingRef), 'utf8'));
    const entries = viewing.segments.flatMap((section) => section.entries);
    const images = entries.filter((entry) => entry.type === 'image');
    const dialogue = entries.filter((entry) => entry.type === 'dialogue');
    assert.ok(images.length >= 1);
    assert.ok(entries.every((item) => (
      item.fromMs >= boundaryChunk.acceptFromMs
      && item.fromMs < boundaryChunk.acceptToMs
    )));
    assert.ok(!entries.some((item) => item.fromMs === boundaryChunk.analysisStartMs));
    assert.equal(viewing.tracks.dialogue.status, 'ready');
    assert.ok(dialogue.some((cue) => cue.text === 'Boundary line.'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runner records a failed checkpoint and retries it without creating another package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owc-precompute-failure-'));
  const inputPath = join(root, 'film.mp4');
  const outputRoot = join(root, 'observations');
  await writeFile(inputPath, 'placeholder-compatible-film');
  const calls = [];
  const analyzeSegment = await createFakeAnalyzer(calls, { failOnce: true });
  const expected = createObservationPrecomputeManifest({
    mediaIdentity: 'sha256:test-failure-film',
    durationMs: 90_000,
    viewingIntervalMs: 2_000,
    imageSettings: DEFAULT_IMAGE_SETTINGS
  });
  const manifestPath = join(outputRoot, expected.planId, 'manifest.json');

  try {
    await assert.rejects(
      runObservationPrecompute(PROJECT_ROOT, {
        inputPath,
        outputRoot,
        durationMs: 90_000,
        mediaIdentity: 'sha256:test-failure-film',
        viewingIntervalMs: 2_000,
        imageSettings: DEFAULT_IMAGE_SETTINGS,
        dialogueSource: DIALOGUE_FIXTURE,
        analyzeSegment
      }),
      /synthetic worker interruption/
    );

    const failed = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(failed.status, 'failed');
    assert.equal(failed.chunks[0].status, 'failed');
    assert.equal(failed.chunks[0].attempts, 1);

    const resumed = await runObservationPrecompute(PROJECT_ROOT, {
      inputPath,
      outputRoot,
      durationMs: 90_000,
      mediaIdentity: 'sha256:test-failure-film',
      viewingIntervalMs: 2_000,
      imageSettings: DEFAULT_IMAGE_SETTINGS,
      dialogueSource: DIALOGUE_FIXTURE,
      analyzeSegment
    });
    assert.equal(resumed.ready, true);
    assert.equal(resumed.manifest.chunks[0].attempts, 2);
    assert.equal(calls.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runner holds an exclusive package lock while a chunk is being analyzed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owc-precompute-lock-'));
  const inputPath = join(root, 'film.mp4');
  const outputRoot = join(root, 'observations');
  await writeFile(inputPath, 'placeholder-compatible-film');

  let signalEntered;
  let releaseWorker;
  const entered = new Promise((resolvePromise) => { signalEntered = resolvePromise; });
  const workerGate = new Promise((resolvePromise) => { releaseWorker = resolvePromise; });
  const analyzeSegment = async (_projectRoot, options) => {
    signalEntered();
    await workerGate;
    return {
      ok: true,
      protocolVersion: 2,
      engine: 'fake-observer-v1',
      sampleFps: options.sampleFps,
      decodedFrameCount: 1,
      observations: [{
        fromMs: options.startMs,
        toMs: options.startMs + 500,
        kind: 'segment_start',
        sceneScore: 0,
        motionScore: 0,
        metrics: {}
      }],
      frames: []
    };
  };

  try {
    const firstRun = runObservationPrecompute(PROJECT_ROOT, {
      inputPath,
      outputRoot,
      durationMs: 90_000,
      mediaIdentity: 'sha256:test-lock-film',
      viewingIntervalMs: 2_000,
      imageSettings: DEFAULT_IMAGE_SETTINGS,
      dialogueSource: DIALOGUE_FIXTURE,
      analyzeSegment
    });
    await entered;

    await assert.rejects(
      runObservationPrecompute(PROJECT_ROOT, {
        inputPath,
        outputRoot,
        durationMs: 90_000,
        mediaIdentity: 'sha256:test-lock-film',
        viewingIntervalMs: 2_000,
        imageSettings: DEFAULT_IMAGE_SETTINGS,
        dialogueSource: DIALOGUE_FIXTURE,
        analyzeSegment
      }),
      /already being prepared/
    );

    releaseWorker();
    const completed = await firstRun;
    assert.equal(completed.ready, true);
    assert.equal(completed.manifest.chunks[0].attempts, 1);
  } finally {
    releaseWorker?.();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50
    });
  }
});

test('unified preparation interleaves visuals and sound, exposes its buffer, and keeps one content file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owc-unified-prepare-'));
  const inputPath = join(root, 'film.mp4');
  await writeFile(inputPath, 'synthetic source');
  const calls = [];
  const events = [];
  const fake = await createFakeAnalyzer(calls);
  try {
    const result = await runObservationPrecompute(PROJECT_ROOT, {
      inputPath, outputRoot: join(root, 'packages'),
      mediaIdentity: 'unified-fixture', durationMs: 12_000,
      maxAnalysisDurationMs: 6_000, boundaryContextMs: 0,
      viewingIntervalMs: 2_000, initialBufferMs: 6_000,
      imageSettings: DEFAULT_IMAGE_SETTINGS,
      dialogueSource: DIALOGUE_FIXTURE, includeAudio: true,
      analyzeSegment: async (projectRoot, options) => {
        events.push(`visual:${options.startMs}`);
        return fake(projectRoot, options);
      },
      describeAudioChunk: async ({ chunk }) => {
        events.push(`sound:${chunk.logicalStartMs}`);
        return {
          status: 'ready',
          descriptions: [{
            id: `audio-${chunk.index}`, fromMs: chunk.logicalStartMs, toMs: chunk.logicalEndMs,
            availableAtMs: chunk.logicalEndMs, text: 'Footsteps.', source: 'local_audio_model'
          }]
        };
      },
      onInitialBufferReady: ({ preparedThroughMs }) => events.push(`buffer:${preparedThroughMs}`)
    });
    assert.deepEqual(events, ['visual:0', 'sound:0', 'buffer:6000', 'visual:6000', 'sound:6000']);
    assert.equal(result.ready, true);
    assert.equal(result.manifest.packageVersion, 3);
    assert.equal(result.manifest.viewingTrack.preparedThroughMs, 12_000);
    for (const chunk of result.manifest.chunks) {
      assert.deepEqual((await readdir(join(result.packageDir, 'chunks', chunk.chunkId))).sort(), ['storyboards', 'viewing.json']);
      const payload = JSON.parse(await readFile(join(result.packageDir, chunk.viewingRef), 'utf8'));
      assert.equal(payload.segments.length, 3);
      assert.equal(payload.tracks.audio.status, 'ready');
      assert.equal(payload.segments.flatMap((section) => section.entries).filter((entry) => entry.type === 'sound').length, 1);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed unified sound pass resumes without redoing its committed visual work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owc-unified-resume-'));
  const inputPath = join(root, 'film.mp4');
  await writeFile(inputPath, 'synthetic source');
  const calls = [];
  const analyzeSegment = await createFakeAnalyzer(calls);
  let fail = true;
  const options = {
    inputPath, outputRoot: join(root, 'packages'),
    mediaIdentity: 'unified-resume', durationMs: 12_000,
    maxAnalysisDurationMs: 6_000, boundaryContextMs: 0,
    viewingIntervalMs: 2_000, initialBufferMs: 6_000,
    imageSettings: DEFAULT_IMAGE_SETTINGS,
    dialogueSource: DIALOGUE_FIXTURE, includeAudio: true, analyzeSegment,
    describeAudioChunk: async ({ chunk }) => {
      if (fail) { fail = false; throw new Error('synthetic sound interruption'); }
      return {
        status: 'ready', descriptions: [{
          id: `audio-${chunk.index}`, fromMs: chunk.logicalStartMs, toMs: chunk.logicalEndMs,
          availableAtMs: chunk.logicalEndMs, text: 'Music.', source: 'local_audio_model'
        }]
      };
    }
  };
  try {
    await assert.rejects(runObservationPrecompute(PROJECT_ROOT, options), /synthetic sound interruption/);
    const result = await runObservationPrecompute(PROJECT_ROOT, options);
    assert.equal(result.ready, true);
    assert.deepEqual(calls.map((call) => call.startMs), [0, 6_000]);
    assert.equal(result.manifest.chunks[0].attempts, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runner refuses to continue an earlier package format instead of generating legacy assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owc-legacy-reject-'));
  const inputPath = join(root, 'film.mp4');
  const outputRoot = join(root, 'packages');
  const packageDir = join(outputRoot, '观影包');
  await mkdir(packageDir, { recursive: true });
  await writeFile(inputPath, 'synthetic source');
  const legacyManifest = {
    ...createObservationPrecomputeManifest({
      mediaIdentity: 'legacy-film',
      durationMs: 10_000
    }),
    packageVersion: 2,
    packageKind: 'open-watch-cinema-ai-package'
  };
  await writeFile(join(packageDir, 'manifest.json'), JSON.stringify(legacyManifest));
  try {
    await assert.rejects(
      runObservationPrecompute(PROJECT_ROOT, {
        inputPath,
        outputRoot,
        packageKey: '观影包',
        mediaIdentity: 'legacy-film',
        durationMs: 10_000,
        viewingIntervalMs: 2_000,
        imageSettings: DEFAULT_IMAGE_SETTINGS,
        dialogueSource: DIALOGUE_FIXTURE
      }),
      /earlier format.*Upgrade/i
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
