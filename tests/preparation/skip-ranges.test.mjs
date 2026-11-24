import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { includedRanges, normalizeSkipConfig, resolveSkipRanges, skipRangeAt } from '../../src/media/skip-ranges.mjs';
import { createObservationPrecomputeManifest } from '../../src/preparation/observation-precompute-plan.mjs';
import { analyzeObservationSegment, resolveObserverPython } from '../../src/preparation/observation-manager.mjs';
import { runObservationPrecompute } from '../../src/preparation/observation-precompute-runner.mjs';
import { upgradeViewingPackage } from '../../src/preparation/package-upgrade.mjs';
import { imageSettingsForMode } from '../../src/visuals/image-settings.mjs';

const project = resolve(import.meta.dirname, '../..');
const run = promisify(execFile);
const range = (fromMs, toMs) => ({ fromMs, toMs });
const config = { intro: range(0, 4_000), middle: [range(4_360, 6_500)], outro: range(9_000, null) };

test('skip settings normalize with half-open times and duration, including overlapping ranges', () => {
  const raw = {
    intro: range(-1, 500),
    middle: [range(600, 900), range(150, 660), range(150, 150), range(8_000, 9_000), range(3, null), range('1', 20)],
    outro: range(840, null)
  };
  assert.deepEqual(normalizeSkipConfig(raw, 850), {
    middle: [range(150, 660), range(600, 850)], outro: range(840, null)
  });
  const ranges = resolveSkipRanges(raw, 850);
  assert.deepEqual(ranges, [
    { kind: 'middle', ...range(150, 660) },
    { kind: 'middle', ...range(600, 850) },
    { kind: 'outro', ...range(840, 850) }
  ]);
  assert.deepEqual(includedRanges(0, 850, ranges), [range(0, 150)]);
  assert.equal(skipRangeAt(ranges, 850), undefined);
  assert.deepEqual(resolveSkipRanges({ outro: range(800, 900) }, 850), [{ kind: 'outro', ...range(800, 850) }]);
});

test('plan identity includes skip ranges and preserves the exact identity of an empty plan', () => {
  const options = { mediaIdentity: 'sha256:skip-fixture', durationMs: 10_000 };
  const previous = createObservationPrecomputeManifest(options);
  const empty = createObservationPrecomputeManifest({ ...options, skipRanges: [] });
  const skipped = createObservationPrecomputeManifest({ ...options, skipRanges: resolveSkipRanges(config, 10_000) });
  assert.equal(empty.planHash, '9bd16d6a8c71a64bda50353cf0f1b5248bf6369b3386665e5df16caef9dac857');
  assert.equal(previous.planHash, empty.planHash);
  assert.equal(Object.hasOwn(empty, 'skipRanges'), false);
  assert.notEqual(skipped.planHash, empty.planHash);
  assert.notEqual(skipped.planId, empty.planId);
});

test('all three profiles prepare only kept pictures, motion, sounds and dialogue, and restyle with the same ranges', { timeout: 60_000 }, async t => {
  try {
    await run('ffmpeg', ['-version']);
    await run(await resolveObserverPython(project), ['-c', 'import cv2, numpy']);
  } catch { t.skip('requires FFmpeg and the visual observer environment'); return; }
  const outputRoot = await mkdtemp(join(tmpdir(), 'cinema-skip-'));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const inputPath = join(outputRoot, 'source.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=10',
    '-vf', "negate=enable='between(t,7.45,7.9)'",
    '-pix_fmt', 'yuv420p', inputPath]);
  const dialogueSource = {
    status: 'source_detected', sourceMode: 'fixture', track: { id: 'fixture', format: 'webvtt' },
    cues: [[1_000, 'intro lyric'], [4_000, 'kept line'], [4_360, 'middle line'], [6_500, 'second kept line'], [9_000, 'outro lyric']]
      .map(([time, text]) => ({ cueId: text, ...range(time, time + 700), text }))
  };
  const expected = resolveSkipRanges(config, 10_000);
  async function assertPackage(packageDir, manifest) {
    assert.deepEqual(manifest.skipRanges, expected);
    assert.equal(manifest.status, 'ready');
    assert.equal(manifest.dialogueTrack.cueCount, 2);
    const [first, ...others] = await Promise.all(manifest.chunks.map(async chunk =>
      JSON.parse(await readFile(join(packageDir, chunk.viewingRef), 'utf8'))));
    assert.deepEqual(first.segments.flatMap(segment => segment.entries), []);
    assert.deepEqual(await readdir(join(packageDir, 'chunks', first.chunkId, 'storyboards')).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return [];
    }), []);
    const entries = others.flatMap(chunk => chunk.segments.flatMap(segment => segment.entries));
    assert.deepEqual(entries.filter(entry => entry.type === 'dialogue').map(entry => entry.text), ['kept line', 'second kept line']);
    assert.deepEqual(entries.filter(entry => entry.type === 'sound').map(({ fromMs, toMs }) => range(fromMs, toMs)),
      [range(4_000, 4_360), range(6_500, 8_000), range(8_000, 9_000)]);
    const images = entries.filter(entry => entry.type === 'image');
    assert.ok(entries.some(entry => entry.type === 'motion'));
    for (const span of [range(4_000, 4_360), range(6_500, 9_000)]) {
      assert.ok(images.some(entry => entry.fromMs >= span.fromMs && entry.fromMs < span.toMs),
        `${manifest.imageSettings.mode} is missing pictures within ${span.fromMs}–${span.toMs} ms`);
    }
    for (const entry of entries) {
      assert.equal(skipRangeAt(expected, entry.fromMs), undefined);
      assert.ok(entry.panelTimesMs?.every(time => !skipRangeAt(expected, time)) ?? true);
      if (entry.type === 'motion') {
        assert.deepEqual(includedRanges(entry.fromMs, entry.toMs, expected), [range(entry.fromMs, entry.toMs)]);
      }
    }
  }
  for (const mode of ['economy', 'balanced', 'full']) {
    const visualCalls = [];
    const soundCalls = [];
    const { manifest, packageDir } = await runObservationPrecompute(project, {
      inputPath, outputRoot, packageKey: mode, viewingIntervalMs: 1_000, initialBufferMs: 1_000,
      maxAnalysisDurationMs: 5_000, boundaryContextMs: 1_000, skipConfig: config,
      imageSettings: imageSettingsForMode(mode), dialogueSource, includeAudio: true,
      analyzeSegment(root, options) {
        visualCalls.push(range(options.startMs, options.startMs + options.durationMs));
        assert.equal(options.decodeEndMs, options.startMs + options.durationMs);
        return analyzeObservationSegment(root, options);
      },
      describeAudioChunk({ ranges }) {
        soundCalls.push(...ranges);
        return { status: 'ready', descriptions: ranges.map(span => ({
          ...span, id: String(span.fromMs), text: 'A sound outside the skipped ranges.',
          availableAtMs: span.toMs, source: 'local_audio_model'
        })) };
      }
    });
    assert.deepEqual(visualCalls, [range(4_000, 4_360), range(6_500, 8_000), range(7_000, 9_000)]);
    assert.deepEqual(soundCalls, [range(4_000, 4_360), range(6_500, 8_000), range(8_000, 9_000)]);
    await assertPackage(packageDir, manifest);
    if (mode === 'balanced') {
      const upgraded = await upgradeViewingPackage(project, {
        inputPath, outputRoot, packageKey: mode, viewingIntervalMs: 1_000, initialBufferMs: 1_000,
        imageSettings: imageSettingsForMode('full'), recycleOldPackage: false
      });
      assert.notEqual(upgraded.manifest.planHash, manifest.planHash);
      assert.equal(upgraded.manifest.imageSettings.mode, 'full');
      await assertPackage(packageDir, upgraded.manifest);
    }
  }
});
