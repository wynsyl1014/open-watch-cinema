import { basename, dirname, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { upgradeViewingPackage, recoverPackageUpgrades } from '../../src/preparation/package-upgrade.mjs';
import { fileURLToPath } from 'node:url';

import {
  runObservationPrecompute
} from '../../src/preparation/index.mjs';

import { imageSettingsForMode, needsStoryboardUpgrade } from '../../src/visuals/image-settings.mjs';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function parseArguments(argv) {
  const options = { viewingIntervalMs: 2000, initialBufferMs: 900000 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--audio') { options.includeAudio = true; continue; }
    if (argument === '--input') options.inputPath = value;
    else if (argument === '--output-root') options.outputRoot = value;
    else if (argument === '--mode') options.mode = value;
    else if (argument === '--full-height') options.fullHeight = Number(value);
    else if (argument === '--max-chunks') options.maxChunks = Number(value);
    else if (argument === '--sample-fps') options.sampleFps = Number(value);
    else throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }
  if (!options.inputPath) throw new Error('--input is required.');
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const startedAt = Date.now();
  const inputPath = resolve(options.inputPath);
  const outputRoot = options.outputRoot ? resolve(options.outputRoot) : dirname(inputPath);
  const packageKey = '观影包';
  let identity;
  try { identity = JSON.parse(await readFile(join(dirname(inputPath), '.cinema.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (identity && (identity.video !== basename(inputPath) || !/^[a-f0-9]{24}$/.test(identity.id))) {
    throw new Error('Input does not match the film identity in this directory.');
  }
  await recoverPackageUpgrades(outputRoot);
  let old;
  try { old = JSON.parse(await readFile(join(outputRoot, packageKey, 'manifest.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (old && ((identity && old.sourceMediaId && identity.id !== old.sourceMediaId)
      || (!identity && old.sourceFileName && old.sourceFileName !== basename(inputPath)))) {
    throw new Error('This output already belongs to another film. Choose its own output directory.');
  }
  if (options.fullHeight !== undefined && options.mode !== 'full') throw new Error('--full-height requires --mode full.');
  const explicit = options.mode !== undefined;
  const requested = explicit || !old?.imageSettings
    ? imageSettingsForMode(options.mode, options.fullHeight)
    : imageSettingsForMode(old.imageSettings.mode ?? 'full', old.imageSettings.storyboardHeight);
  const outdatedFormat = Boolean(old && needsStoryboardUpgrade(old.packageVersion ?? 1));
  const outdatedImages = Boolean(old && old.imageSettings?.assetVersion !== requested.assetVersion);
  const switchProfile = old && explicit && (old.packageVersion !== 3 || !old.imageSettings
    || (old.imageSettings.mode || 'full') !== requested.mode
    || old.imageSettings.storyboardHeight !== requested.storyboardHeight || outdatedImages);
  const imageSettings = old && !switchProfile ? old.imageSettings : requested;
  if (outdatedFormat && !switchProfile) throw new Error('Legacy package remains available. Choose --mode to upgrade it.');
  if (old && old.packageVersion !== 3 && !switchProfile) throw new Error('Unsupported viewing package format.');
  if (outdatedImages && !switchProfile) {
    throw new Error('The prepared images use an earlier revision. Choose --mode to rebuild them in a staged package.');
  }
  const args = {
    ...options, inputPath, outputRoot, packageKey, imageSettings,
    sourceMediaId: identity?.id ?? old?.sourceMediaId ?? null,
    viewingIntervalMs: old?.viewingIntervalMs ?? options.viewingIntervalMs,
    initialBufferMs: old?.viewingTrack?.initialBufferMs ?? options.initialBufferMs,
    preferredDialogueTrackId: old?.dialogueTrack?.sourceTrack?.id,
    includeAudio: options.includeAudio ?? old?.viewingTrack?.audioRequested ?? false,
    onChunkComplete({ chunk, elapsedMs, progress }) {
      process.stderr.write(
        `${chunk.chunkId} complete in ${elapsedMs}ms (${progress.completeChunks}/${progress.totalChunks})\n`
      );
    }
  };
  const result = switchProfile ? await upgradeViewingPackage(PROJECT_ROOT, args)
    : await runObservationPrecompute(PROJECT_ROOT, args);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    planId: result.manifest.planId,
    status: result.manifest.status,
    ready: result.manifest.viewingTrack?.status === 'ready',
    chunksRun: result.chunksRun,
    progress: result.manifest.progress,
    elapsedMs: Date.now() - startedAt,
    manifestPath: join(outputRoot, packageKey, 'manifest.json')
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exitCode = 1;
});
