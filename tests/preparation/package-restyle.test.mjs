import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { hashFile, runObservationPrecompute } from '../../src/preparation/observation-precompute-runner.mjs';
import { createObservationPrecomputeManifest, markObservationChunkComplete } from '../../src/preparation/observation-precompute-plan.mjs';
import { recoverPackageUpgrades, upgradeViewingPackage } from '../../src/preparation/package-upgrade.mjs';
import { resolveObserverPython } from '../../src/preparation/observation-manager.mjs';
import { hasStoryboardCornerMarks, imageSettingsForMode, normalizeImageSettings } from '../../src/visuals/image-settings.mjs';
import { createViewingChunk } from '../../src/delivery/viewing-package.mjs';
import { readAiPackage } from '../../src/media/media-library.mjs';

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const run = promisify(execFile);

async function hasColoredPixels(filename, width, sourceBox) {
  const result = await run('ffmpeg', ['-v', 'error', '-i', filename,
    '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
  const height = result.stdout.length / (width * 3);
  const [left, top, right, bottom] = sourceBox.map((value, index) => Math.round(value * (index % 2 ? height : width)));
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const offset = (y * width + x) * 3;
      const [r, g, b] = result.stdout.subarray(offset, offset + 3);
      if (Math.max(r, g, b) - Math.min(r, g, b) > 20) return true;
    }
  }
  return false;
}

test('the library offers upgrades by package format, independently of local storyboard revisions', async t => {
  const packagePath = await mkdtemp(join(tmpdir(), 'cinema-package-version-'));
  t.after(() => rm(packagePath, { recursive: true, force: true }));
  assert.equal(await readAiPackage(null, 'film', { packagePath }), null);
  const cases = [
    [{}, true], [{ packageVersion: 1 }, true], [{ packageVersion: 2 }, true],
    [{ packageVersion: 3 }, false],
    [{ packageVersion: 3, imageSettings: { assetVersion: 2, storyboardHeight: 480 } }, false],
    [{ packageVersion: 4 }, false]
  ];
  for (const mode of ['economy', 'balanced', 'full']) {
    const current = imageSettingsForMode(mode);
    assert.equal(current.assetVersion, mode === 'economy' ? 3 : 4);
    assert.equal(hasStoryboardCornerMarks(current), mode !== 'economy');
    for (const version of [undefined, current.assetVersion - 1, current.assetVersion, current.assetVersion + 1]) {
      cases.push([{ packageVersion: 3, imageSettings: { ...current, assetVersion: version } }, false]);
      const settings = { ...current, assetVersion: version };
      if (version !== current.assetVersion) {
        assert.throws(() => normalizeImageSettings(settings), /Unsupported image asset version/);
        assert.equal(hasStoryboardCornerMarks(settings), false);
      }
    }
  }
  for (const [fields, expected] of cases) {
    await writeFile(join(packagePath, 'manifest.json'), JSON.stringify({ packageKind: 'open-watch-cinema-ai-package', ...fields }));
    const pkg = await readAiPackage(null, 'film', { packagePath });
    assert.equal(pkg.needsStoryboardUpgrade, expected, JSON.stringify(fields));
  }
});

test('staged upgrade migrates a GitHub v2 package into v3 and restyles cleanly across all three modes', async t => {
  try {
    await run('ffmpeg', ['-version']);
    await run(await resolveObserverPython(projectRoot), ['-c', 'import cv2, numpy']);
  } catch { t.skip('requires FFmpeg and the visual observer environment'); return; }
  const outputRoot = await mkdtemp(join(tmpdir(), 'cinema-restyle-'));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const inputPath = join(outputRoot, 'source.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=2:d=2',
    '-pix_fmt', 'yuv420p', inputPath]);
  const common = { inputPath, outputRoot, packageKey: '观影包', viewingIntervalMs: 2000,
    initialBufferMs: 900000, includeAudio: false };

  // Seed a public GitHub v2 package (visual.json + dialogue.json, no imageSettings/masters).
  const packageDir = join(outputRoot, '观影包');
  const chunkDir = join(packageDir, 'chunks', 'chunk-0000');
  const storyboardDir = join(chunkDir, 'storyboards');
  await mkdir(storyboardDir, { recursive: true });
  const v2Plan = createObservationPrecomputeManifest({
    mediaIdentity: 'sha256:' + await hashFile(inputPath),
    durationMs: 2000
  });
  const legacyStoryboardRef = 'chunks/chunk-0000/storyboards/chunk-0000-0001-0.jpg';
  const legacyBytes = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  await writeFile(join(packageDir, legacyStoryboardRef), legacyBytes);
  await writeFile(join(chunkDir, 'visual.json'), JSON.stringify({
    packageVersion: 2, planId: v2Plan.planId, chunkId: 'chunk-0000', chunkIndex: 0,
    observations: [{ fromMs: 0, toMs: 500, kind: 'visual_heartbeat', storyboard: { filename: 'chunk-0000-0001-0.jpg', mediaTimeMs: 0, panelTimesMs: [0, 0, 0] } }],
    frames: [{ filename: 'chunk-0000-0001-0.jpg', mediaTimeMs: 0, panelTimesMs: [0, 0, 0] }]
  }));
  await writeFile(join(chunkDir, 'dialogue.json'), JSON.stringify({
    packageVersion: 2, planId: v2Plan.planId, chunkId: 'chunk-0000', status: 'source_missing', cues: []
  }));
  const v2Manifest = {
    ...v2Plan,
    packageVersion: 2,
    packageKind: 'open-watch-cinema-ai-package',
    status: 'ready',
    progress: { totalChunks: 1, pendingChunks: 0, runningChunks: 0, completeChunks: 1, failedChunks: 0, completedThroughMs: 2000, percent: 100 },
    dialogueTrack: { status: 'source_missing', sourceMode: 'none', cueCount: 0 },
    chunks: [{
      ...v2Plan.chunks[0], status: 'complete',
      visualRef: 'chunks/chunk-0000/visual.json',
      dialogueRef: 'chunks/chunk-0000/dialogue.json',
      storyboardRootRef: 'chunks/chunk-0000/storyboards',
      observationCount: 1, storyboardCount: 1
    }]
  };
  const manifestAt = join(packageDir, 'manifest.json');
  const originalV2 = Buffer.from(JSON.stringify(v2Manifest, null, 2));
  await writeFile(manifestAt, originalV2);

  const economy = imageSettingsForMode('economy');
  const options = { ...common, imageSettings: economy, recycleOldPackage: false };

  // Failed publish leaves original v2 package intact.
  await assert.rejects(upgradeViewingPackage(projectRoot, { ...options, beforeSwitch: async () => {
    assert.deepEqual(await readFile(manifestAt), originalV2);
    throw new Error('interrupted before publish');
  } }), /interrupted before publish/);
  assert.deepEqual(await readFile(join(packageDir, legacyStoryboardRef)), legacyBytes);

  // Rejects upgrading into a retired legacy image configuration.
  await assert.rejects(
    upgradeViewingPackage(projectRoot, { ...options, imageSettings: { assetVersion: 2, storyboardHeight: 480 } }),
    /Invalid storyboard mode|Unsupported image asset version/i
  );

  // Upgrading GitHub v2 -> v3 economy publishes viewing.json, skips blank groups, and backs up old package.
  const upgraded = await upgradeViewingPackage(projectRoot, options);
  assert.equal(upgraded.manifest.packageVersion, 3);
  assert.equal(upgraded.manifest.imageSettings.mode, 'economy');
  assert.equal(upgraded.manifest.imageSettings.assetVersion, economy.assetVersion);
  assert.deepEqual(await readFile(join(upgraded.backupPath, legacyStoryboardRef)), legacyBytes);

  // Restyling v3 economy -> balanced -> full 480p reuses tracks, reports live progress, and keeps zero masters/.
  const chunkPath = join(packageDir, upgraded.manifest.chunks[0].viewingRef);
  const restyleProgress = [];
  await upgradeViewingPackage(projectRoot, {
    ...options,
    imageSettings: imageSettingsForMode('balanced'),
    onPreparationProgress(progress) { restyleProgress.push(progress); }
  });
  assert.ok(restyleProgress.some(p => p.live === true && typeof p.percent === 'number'));
  const blank = JSON.parse(await readFile(chunkPath, 'utf8'));
  assert.ok(blank.omittedGroups.length > 0);
  assert.equal(blank.segments.flatMap(s => s.entries).filter(e => e.type === 'image').length, 0);

  await upgradeViewingPackage(projectRoot, { ...options, imageSettings: imageSettingsForMode('full', 480) });
  const full = JSON.parse(await readFile(chunkPath, 'utf8'));
  assert.deepEqual(full.omittedGroups, blank.omittedGroups);
  await assert.rejects(readFile(join(packageDir, 'chunks/chunk-0000/storyboards/masters')), { code: 'ENOENT' });

  // Also verify v3 -> v3 restyling preserves dialogue and sound tracks untouched.
  const texturedRoot = await mkdtemp(join(tmpdir(), 'cinema-restyle-tracks-'));
  t.after(() => rm(texturedRoot, { recursive: true, force: true }));
  const textured = await runObservationPrecompute(projectRoot, {
    inputPath, outputRoot: texturedRoot, packageKey: '观影包',
    viewingIntervalMs: 2000, initialBufferMs: 900000, includeAudio: true,
    imageSettings: economy,
    dialogueSource: { status: 'source_detected', track: { id: 'fixture' }, sourceMode: 'test',
      cues: [{ cueId: 'line', fromMs: 200, toMs: 800, text: 'Hello' }] },
    describeAudioChunk: async () => ({ status: 'ready', descriptions: [{ id: 's1', fromMs: 0, toMs: 2000,
      availableAtMs: 0, text: 'Water', source: 'acoustic_measurement' }] })
  });
  const beforeEntries = JSON.parse(await readFile(join(textured.packageDir, 'chunks/chunk-0000/viewing.json'), 'utf8'))
    .segments.flatMap(s => s.entries).filter(e => e.type !== 'image');
  await upgradeViewingPackage(projectRoot, {
    inputPath, outputRoot: texturedRoot, packageKey: '观影包',
    viewingIntervalMs: 2000, initialBufferMs: 900000, includeAudio: true,
    imageSettings: imageSettingsForMode('balanced'), recycleOldPackage: false
  });
  const afterEntries = JSON.parse(await readFile(join(textured.packageDir, 'chunks/chunk-0000/viewing.json'), 'utf8'))
    .segments.flatMap(s => s.entries).filter(e => e.type !== 'image');
  assert.deepEqual(afterEntries, beforeEntries);
});

test('same-profile rebuild stages the new image revision without mixing it into the existing package', async t => {
  try {
    await run('ffmpeg', ['-version']);
    await run(await resolveObserverPython(projectRoot), ['-c', 'import cv2, numpy']);
  } catch { t.skip('requires FFmpeg and the visual observer environment'); return; }
  const outputRoot = await mkdtemp(join(tmpdir(), 'cinema-image-revision-'));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const inputPath = join(outputRoot, 'source.mkv');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
    "color=c=black:s=476x268:r=8:d=1,drawbox=x=120:y=80:w=80:h=60:color=gray:t=3",
    '-c:v', 'ffv1', inputPath]);
  const imageSettings = imageSettingsForMode('balanced');
  const previousSettings = { ...imageSettings, assetVersion: 3 };
  const packageKey = 'revision';
  const packageDir = join(outputRoot, packageKey);
  const mediaIdentity = 'sha256:' + await hashFile(inputPath);
  const plan = createObservationPrecomputeManifest({
    mediaIdentity, durationMs: 1000, viewingIntervalMs: 1000, imageSettings: previousSettings
  });
  const viewingRef = 'chunks/chunk-0000/viewing.json';
  const storyboardRootRef = 'chunks/chunk-0000/storyboards';
  const old = { ...markObservationChunkComplete(plan, 0, { storyboardCount: 1, resultRef: viewingRef }),
    packageVersion: 3, packageKind: 'open-watch-cinema-ai-package' };
  Object.assign(old.chunks[0], { viewingRef, storyboardRootRef });
  const payload = createViewingChunk({
    planId: plan.planId, chunk: old.chunks[0], intervalMs: 1000, storyboardRootRef,
    analysis: { engine: 'fixture', visualAssetProfile: previousSettings,
      frames: [{ filename: 'anchor.jpg', mediaTimeMs: 0, panelTimesMs: [0] }] },
    dialogue: { status: 'source_missing', cues: [] }
  });
  await mkdir(join(packageDir, storyboardRootRef), { recursive: true });
  await writeFile(join(packageDir, storyboardRootRef, 'anchor.jpg'), 'old picture');
  await writeFile(join(packageDir, viewingRef), JSON.stringify(payload));
  await writeFile(join(packageDir, 'manifest.json'), JSON.stringify(old));

  const common = { inputPath, outputRoot, packageKey, imageSettings, viewingIntervalMs: 1000,
    initialBufferMs: 1000, includeAudio: false };
  await assert.rejects(runObservationPrecompute(projectRoot, common), /different revision/);
  const previous = await readAiPackage(null, 'film', { packagePath: packageDir });
  assert.equal(previous.needsStoryboardUpgrade, false);
  assert.equal(hasStoryboardCornerMarks(previous.imageSettings), false);
  const rebuilt = await upgradeViewingPackage(projectRoot, { ...common, recycleOldPackage: false });
  assert.equal(rebuilt.manifest.packageVersion, 3);
  assert.notEqual(rebuilt.manifest.planId, old.planId);
  assert.equal(hasStoryboardCornerMarks(rebuilt.manifest.imageSettings), true);
  const composed = JSON.parse(await readFile(join(packageDir, viewingRef), 'utf8'));
  assert.deepEqual(composed.tracks.visual.assetProfile, imageSettings);
  assert.equal(await readFile(join(rebuilt.backupPath, storyboardRootRef, 'anchor.jpg'), 'utf8'), 'old picture');
  const resumed = await runObservationPrecompute(projectRoot, common);
  assert.equal(resumed.chunksRun, 0);
  assert.equal(resumed.manifest.planId, rebuilt.manifest.planId);
});

test('balanced restyling starts a new panorama per chunk and rebuilds same-time omitted groups in order', async t => {
  try {
    await run('ffmpeg', ['-version']);
    await run(await resolveObserverPython(projectRoot), ['-c', 'import cv2, numpy']);
  } catch { t.skip('requires FFmpeg and the visual observer environment'); return; }
  const outputRoot = await mkdtemp(join(tmpdir(), 'cinema-restyle-context-'));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const inputPath = join(outputRoot, 'source.mkv');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
    "color=c=black:s=476x268:r=8:d=2,drawbox=x=120:y=80:w=80:h=60:color=gray:t=3,drawbox=x=225:y=160:w=24:h=20:color=white:t=fill:enable='gte(t,1.125)'",
    '-c:v', 'ffv1', inputPath]);
  const common = { outputRoot, inputPath, packageKey: 'context', viewingIntervalMs: 1000,
    initialBufferMs: 900000, includeAudio: false };
  const prepared = await runObservationPrecompute(projectRoot, {
    ...common, imageSettings: imageSettingsForMode('economy'),
    maxAnalysisDurationMs: 1500, boundaryContextMs: 500,
    dialogueSource: { status: 'source_missing', cues: [] },
    async analyzeSegment(_root, { outputDir, visualStartMs }) {
      const first = visualStartMs === 0;
      const filename = first ? 'anchor.jpg' : '02-retained.jpg';
      const panelTimesMs = first ? [875] : [875, 1125];
      const mediaTimeMs = panelTimesMs.at(-1);
      await writeFile(join(outputDir, filename), 'previously prepared');
      const frames = [{ filename, mediaTimeMs, panelTimesMs }];
      if (!first) frames.push({ groupFilename: '01-omitted.jpg', mediaTimeMs, panelTimesMs, parts: [] });
      return { engine: 'test-fixture', protocolVersion: 2, sampleFps: 2, frames, observations: [] };
    }
  });
  assert.equal(prepared.manifest.chunks.length, 2);
  const changed = await upgradeViewingPackage(projectRoot, {
    ...common, imageSettings: imageSettingsForMode('balanced'), recycleOldPackage: false
  });
  const read = async index => JSON.parse(await readFile(
    join(changed.packageDir, changed.manifest.chunks[index].viewingRef), 'utf8'));
  const first = await read(0);
  const second = await read(1);
  const entries = payload => payload.segments.flatMap(section => section.entries).filter(entry => entry.type === 'image');
  const [panorama] = entries(first);
  assert.deepEqual(panorama.parts.flatMap(part => part.image.views)
    .map(view => [view.type, view.mediaTimeMs]), [['full', 875]]);
  assert.equal(entries(second).length, 1);
  const [entry] = entries(second);
  assert.match(entry.storyboardRef, /01-omitted\.jpg$/);
  assert.deepEqual(entry.parts.flatMap(part => part.image.views)
    .map(view => [view.type, view.mediaTimeMs]), [['full', 1125]]);
  assert.equal(await hasColoredPixels(join(changed.packageDir, panorama.storyboardRef),
    panorama.parts[0].image.width, [0, 0, 1, 1]), false);
  assert.deepEqual(second.omittedGroups.map(group => group.filename), ['02-retained.jpg']);
});

test('full-profile preparation rebuilds the panorama after a chunk checkpoint', async t => {
  try {
    await run('ffmpeg', ['-version']);
    await run(await resolveObserverPython(projectRoot), ['-c', 'import cv2, numpy']);
  } catch { t.skip('requires FFmpeg and the visual observer environment'); return; }
  const outputRoot = await mkdtemp(join(tmpdir(), 'cinema-resume-corners-'));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const inputPath = join(outputRoot, 'source.mkv');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
    "color=c=black:s=476x268:r=8:d=2,drawbox=x=120:y=80:w=80:h=60:color=gray:t=3,drawbox=x=225:y=160:w=24:h=20:color=white:t=fill:enable='gte(t,0.875)'",
    '-c:v', 'ffv1', inputPath]);
  const options = { outputRoot, inputPath, packageKey: 'resume', viewingIntervalMs: 1000,
    initialBufferMs: 1000, includeAudio: false, imageSettings: imageSettingsForMode('full'),
    maxAnalysisDurationMs: 2000, boundaryContextMs: 1000,
    dialogueSource: { status: 'source_missing', cues: [] } };
  const first = await runObservationPrecompute(projectRoot, { ...options, maxChunks: 1 });
  const load = async (manifest, index) => JSON.parse(await readFile(
    join(first.packageDir, manifest.chunks[index].viewingRef), 'utf8'));
  const entries = payload => payload.segments.flatMap(section => section.entries).filter(entry => entry.type === 'image');
  const [panorama] = entries(await load(first.manifest, 0));
  assert.deepEqual(panorama.parts.flatMap(part => part.image.views)
    .map(view => [view.type, view.mediaTimeMs]), [['full', 0]]);
  const anchorPath = join(first.packageDir, panorama.storyboardRef);
  const before = await readFile(anchorPath);
  const finished = await runObservationPrecompute(projectRoot, options);
  assert.equal(finished.chunksRun, 1);
  assert.deepEqual(await readFile(anchorPath), before);
  const pairs = entries(await load(finished.manifest, 1))
    .flatMap(entry => entry.parts.flatMap(part => part.image.views.map(view => [part, view])));
  assert.equal(pairs.length, 1);
  const [[part, reanchored]] = pairs;
  assert.equal(reanchored.type, 'full');
  assert.ok(reanchored.mediaTimeMs >= finished.manifest.chunks[1].acceptFromMs);
  assert.equal(await hasColoredPixels(anchorPath, panorama.parts[0].image.width, [0, 0, 1, 1]), false);
  assert.equal(await hasColoredPixels(join(first.packageDir, part.ref), part.image.width, [0, 0, 1, 1]), false);
});

test('per-film recovery restores the verified original across the package rename gap', async t => {
  const episode = await mkdtemp(join(tmpdir(), 'cinema-restore-'));
  t.after(() => rm(episode, { recursive: true, force: true }));
  const token = randomUUID();
  const transaction = join(episode, '.upgrades', token);
  const backup = join(transaction, 'old-package');
  await mkdir(join(backup, '.run-lock'), { recursive: true });
  await writeFile(join(backup, 'manifest.json'), 'original');
  await writeFile(join(backup, '.run-lock', 'owner.json'), JSON.stringify({ upgradeToken: token }));
  await writeFile(join(transaction, 'upgrade.json'), JSON.stringify({
    kind: 'open-watch-cinema-package-upgrade', pid: 2147483647, packageKey: '观影包', token, status: 'switching'
  }));
  assert.equal((await recoverPackageUpgrades(episode)).length, 1);
  assert.equal(await readFile(join(episode, '观影包', 'manifest.json'), 'utf8'), 'original');
  await assert.rejects(readFile(join(episode, '观影包', '.run-lock', 'owner.json')), { code: 'ENOENT' });
  assert.deepEqual(await recoverPackageUpgrades(episode), []);

  // Completed recycled upgrade shells are automatically pruned during recovery.
  const doneToken = randomUUID();
  const doneTx = join(episode, '.upgrades', doneToken);
  await mkdir(join(doneTx, 'new'), { recursive: true });
  await writeFile(join(doneTx, 'upgrade.json'), JSON.stringify({
    kind: 'open-watch-cinema-package-upgrade', packageKey: '观影包', token: doneToken,
    status: 'complete', oldPackageDisposition: 'recycled'
  }));
  await recoverPackageUpgrades(episode);
  await assert.rejects(readFile(join(doneTx, 'upgrade.json')), { code: 'ENOENT' });
});
