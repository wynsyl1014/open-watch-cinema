import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runObservationPrecompute } from '../src/observation-precompute-runner.mjs';
import { readObservationTrackWindow } from '../src/observation-track-reader.mjs';
import { readSpoilerGatedStoryboardFrame } from '../src/storyboard-frame.mjs';
import { buildCinemaTick } from '../src/cinema-tick.mjs';
import { selectInlineStoryboards } from '../mcp/viewing-feed.mjs';

import {
  addSessionObservations,
  endSession,
  listSessionObservations,
  openDatabase,
  openSession
} from '../src/database.mjs';
import {
  analyzeObservationSegment,
  getObserverStatus,
  resolveObserverPython
} from '../src/observation-manager.mjs';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function createSceneChangeFilm(outputPath) {
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=2:r=24',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=2:r=24',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outputPath
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('OpenCV observer emits timed motion metrics, storyboards, and room archives lock observation writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-watch-cinema-observer-'));
  const videoPath = join(root, 'scene-change.mp4');
  const databasePath = join(root, 'cinema.sqlite');
  const outputDir = join(root, 'storyboards');
  createSceneChangeFilm(videoPath);

  const status = await getObserverStatus(PROJECT_ROOT);
  assert.equal(status.available, true);
  assert.equal(status.baselineAvailable, true);
  assert.equal(status.opencvAvailable, true);

  const analysis = await analyzeObservationSegment(PROJECT_ROOT, {
    inputPath: videoPath,
    startMs: 0,
    durationMs: 4_000,
    sampleFps: 2,
    outputDir,
    storyboardPrefix: 'test'
  });
  assert.equal(analysis.engine, 'opencv-observer-v1');
  assert.ok(analysis.decodedFrameCount >= 6);
  assert.ok(analysis.observations.length >= 2);
  assert.ok(Math.max(...analysis.observations.map((item) => item.sceneScore)) > 0.5);
  assert.ok(analysis.observations.some((item) => item.metrics.histogramDistance > 0));
  assert.ok(analysis.observations.every((item) => typeof item.metrics.perceptualHash === 'string'));
  assert.ok(analysis.frames.length >= 1);
  await access(join(outputDir, analysis.frames[0].filename));
  const storyboard = analysis.frames.find((frame) => frame.frameReason === 'scene_change');
  assert.equal(storyboard.mediaTimeMs, 2_500, 'Select the stable sample after the cut.');
  assert.ok(storyboard.panelTimesMs.every((time) => time <= storyboard.mediaTimeMs));
  const dimensions = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json',
    join(outputDir, storyboard.filename)
  ], { encoding: 'utf8' });
  assert.equal(dimensions.status, 0, dimensions.stderr);
  assert.deepEqual(JSON.parse(dimensions.stdout).streams[0], { width: 1544, height: 288 });

  const db = openDatabase(databasePath);
  try {
    const room = openSession(db, { mediaId: 'b'.repeat(24), mediaTitle: 'Observer Film' });
    const inserted = addSessionObservations(db, room.id, analysis);
    assert.equal(inserted.length, analysis.observations.length);
    assert.deepEqual(listSessionObservations(db, room.id), inserted);

    endSession(db, room.id, { lastPositionMs: 4_000 });
    assert.throws(
      () => addSessionObservations(db, room.id, analysis),
      /read-only/i
    );
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('storyboard selection and source detail regression checks', async () => {
  const python = await resolveObserverPython(PROJECT_ROOT);
  const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'observer', '-p', 'test_*.py'], {
    cwd: PROJECT_ROOT, encoding: 'utf8', windowsHide: true
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('prepared static footage keeps visual coverage across chunk boundaries through the normal frame gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owc-visual-heartbeat-'));
  try {
    const inputPath = join(root, 'static.mp4');
    const video = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
      'color=c=blue:s=640x360:d=40:r=2', '-c:v', 'libx264', '-preset', 'ultrafast', inputPath],
    { encoding: 'utf8', windowsHide: true });
    assert.equal(video.status, 0, video.stderr);
    const prepared = await runObservationPrecompute(PROJECT_ROOT, {
      inputPath, outputRoot: join(root, 'packages'), durationMs: 40000,
      maxAnalysisDurationMs: 16000, boundaryContextMs: 2000,
      dialogueSource: { status: 'source_missing', cues: [] }
    });
    assert.equal(prepared.ready, true);
    let lastDeliveryMs = 0;
    let delivered = 0;
    for (let fromMs = 0; fromMs < 40000; fromMs += 2000) {
      const toMs = fromMs + 2000;
      const window = await readObservationTrackWindow(prepared.packageDir, {
        fromMs, toMs, playheadMs: toMs, lookaheadMs: 0
      });
      const tick = buildCinemaTick({ room: { status: 'active' }, window,
        targetRange: { fromMs, toMs, playheadMs: toMs, bootstrap: fromMs === 0 } });
      const selected = selectInlineStoryboards(tick);
      assert.ok(selected.length <= 1, 'Static footage should not consume both image slots.');
      for (const selection of selected) {
        assert.equal(selection.kind, 'visual_heartbeat');
        const image = await readSpoilerGatedStoryboardFrame(prepared.packageDir, {
          ...selection, playheadMs: toMs
        });
        assert.ok(image.content.length > 100);
        assert.ok(image.metadata.panelTimesMs.every((time) => time <= toMs));
        assert.ok(toMs - lastDeliveryMs <= 15000, 'No long visual gap, including at a chunk boundary.');
        lastDeliveryMs = toMs;
        delivered++;
      }
    }
    assert.ok(delivered >= 3 && delivered <= 6, `Expected sparse heartbeat delivery; got ${delivered}.`);
    assert.ok(40000 - lastDeliveryMs <= 15000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
