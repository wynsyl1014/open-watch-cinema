import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import {
  dialogueChunkPayload,
  dialogueTrackState,
  prepareDialogueSource
} from './dialogue-track.mjs';
import { probeMedia } from './media-compatibility.mjs';
import { analyzeObservationSegment } from './observation-manager.mjs';
import {
  createObservationPrecomputeManifest,
  getNextObservationChunk,
  markObservationChunkComplete,
  markObservationChunkFailed,
  markObservationChunkRunning,
  validateObservationPrecomputeManifest
} from './observation-precompute-plan.mjs';

export const OBSERVATION_PACKAGE_VERSION = 2;
export const DEFAULT_PACKAGE_LOCK_STALE_MS = 15 * 60 * 1000;

async function acquireObservationPackageLock(packageDir, {
  staleMs = DEFAULT_PACKAGE_LOCK_STALE_MS
} = {}) {
  const lockDir = join(packageDir, '.run-lock');

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockDir);
      await writeFile(join(lockDir, 'owner.json'), `${JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString()
      })}\n`, 'utf8');
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const lockStat = await stat(lockDir).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > staleMs) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      throw new Error('This AI package is already being prepared.');
    }
  }

  throw new Error('Could not acquire the AI package lock.');
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toPortableRelativePath(root, filePath) {
  return relative(root, filePath).split(sep).join('/');
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function normalizeMaxChunks(value) {
  if (value === Infinity) return Infinity;
  return requirePositiveInteger(value, 'maxChunks');
}

function normalizePackageKey(value) {
  if (value === null || value === undefined) return null;
  const key = String(value).trim();
  if (!/^[a-z0-9][a-z0-9-]{2,79}$/i.test(key)) {
    throw new TypeError('packageKey must contain only letters, numbers, and hyphens.');
  }
  return key;
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function writeJsonCheckpoint(filePath, payload) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rm(filePath, { force: true });
  await rename(tempPath, filePath);
}

async function readManifest(filePath) {
  const manifest = JSON.parse(await readFile(filePath, 'utf8'));
  validateObservationPrecomputeManifest(manifest);
  return manifest;
}

function deriveAiReadiness(manifest, dialogueTrack) {
  const blockers = [];
  if (manifest.status !== 'ready') blockers.push('visual_track_not_ready');
  if (dialogueTrack.status === 'source_missing') blockers.push('dialogue_source_missing');
  else if (dialogueTrack.status !== 'ready') blockers.push('dialogue_track_not_ready');

  let experienceMode = 'complete';
  if (blockers.includes('visual_track_not_ready') && blockers.includes('dialogue_source_missing')) {
    experienceMode = 'raw';
  } else if (blockers.includes('dialogue_source_missing')) {
    experienceMode = 'visual_only';
  } else if (blockers.includes('visual_track_not_ready')) {
    experienceMode = 'dialogue_only';
  } else if (blockers.length > 0) {
    experienceMode = 'preparing';
  }

  return {
    status: blockers.length === 0 ? 'ready' : 'incomplete',
    ready: blockers.length === 0,
    experienceMode,
    blockers
  };
}

function withCheckpointMetadata(manifest, previous = manifest) {
  const now = new Date().toISOString();
  const baseDialogueTrack = manifest.dialogueTrack || previous.dialogueTrack || {
    status: 'source_missing',
    sourceMode: 'none',
    cueCount: 0,
    resultKind: 'chunked_dialogue_track',
    note: 'No dialogue source is available.'
  };
  const dialogueTrack = baseDialogueTrack.status === 'source_missing'
    ? baseDialogueTrack
    : {
        ...baseDialogueTrack,
        status: manifest.status === 'ready' ? 'ready' : 'running'
      };

  return {
    ...manifest,
    packageVersion: OBSERVATION_PACKAGE_VERSION,
    packageKind: 'open-watch-cinema-ai-package',
    analysisActivation: 'manual_opt_in',
    sourceFileName: manifest.sourceFileName || previous.sourceFileName,
    sourceMediaId: manifest.sourceMediaId || previous.sourceMediaId || null,
    sourceRelativePath: manifest.sourceRelativePath || previous.sourceRelativePath || null,
    storageLayout: {
      manifest: 'manifest.json',
      chunks: 'chunks/<chunkId>/',
      visual: 'chunks/<chunkId>/visual.json',
      dialogue: 'chunks/<chunkId>/dialogue.json',
      storyboards: 'chunks/<chunkId>/storyboards/'
    },
    visualTrack: {
      status: manifest.status,
      protocolVersion: manifest.observerProtocolVersion,
      resultKind: 'chunked_observation_track'
    },
    dialogueTrack,
    aiReadiness: deriveAiReadiness(manifest, dialogueTrack),
    createdAt: previous.createdAt || now,
    updatedAt: now
  };
}

async function saveManifest(manifestPath, manifest) {
  const next = withCheckpointMetadata(manifest);
  validateObservationPrecomputeManifest(next);
  await writeJsonCheckpoint(manifestPath, next);
  return next;
}

function trimAnalysisToOwnership(analysis, chunk) {
  const observations = (analysis.observations || [])
    .filter((item) => item.fromMs >= chunk.acceptFromMs && item.fromMs < chunk.acceptToMs)
    .map((item) => {
      const next = {
        ...item,
        toMs: Math.min(item.toMs, chunk.acceptToMs),
        metrics: item.metrics ? { ...item.metrics } : item.metrics
      };
      if (
        next.storyboard
        && (
          next.storyboard.mediaTimeMs < chunk.acceptFromMs
          || next.storyboard.mediaTimeMs >= chunk.acceptToMs
        )
      ) {
        delete next.storyboard;
      } else if (next.storyboard) {
        next.storyboard = { ...next.storyboard };
      }
      return next;
    });

  const frames = (analysis.frames || [])
    .filter((item) => (
      item.mediaTimeMs >= chunk.acceptFromMs
      && item.mediaTimeMs < chunk.acceptToMs
    ))
    .map((item) => ({ ...item }));

  return { observations, frames };
}

async function removeRejectedStoryboards(outputDir, analysis, acceptedFrames) {
  const accepted = new Set(acceptedFrames.map((item) => item.filename));
  await Promise.all((analysis.frames || [])
    .filter((item) => item.filename && !accepted.has(item.filename))
    .map((item) => rm(join(outputDir, basename(item.filename)), { force: true })));
}

export async function prepareObservationPackage(projectRoot, {
  inputPath,
  outputRoot = join(projectRoot, 'local-data', 'ai-packages'),
  packageKey = null,
  replaceMismatchedPackage = false,
  sourceMediaId = null,
  sourceRelativePath = null,
  durationMs = null,
  mediaIdentity = null,
  sampleFps = 2,
  maxAnalysisDurationMs,
  boundaryContextMs,
  preferredDialogueTrackId = null,
  dialogueSource = null
}) {
  const absoluteInputPath = resolve(inputPath);
  const inputStat = await stat(absoluteInputPath);
  if (!inputStat.isFile()) throw new Error(`Video not found: ${absoluteInputPath}`);

  if (durationMs === null) {
    const probe = await probeMedia(absoluteInputPath);
    durationMs = Math.round(probe.durationSeconds * 1000);
  }
  durationMs = requirePositiveInteger(durationMs, 'durationMs');

  if (mediaIdentity === null) {
    mediaIdentity = `sha256:${await hashFile(absoluteInputPath)}`;
  }

  if (dialogueSource === null) {
    dialogueSource = await prepareDialogueSource(absoluteInputPath, {
      preferredTrackId: preferredDialogueTrackId
    });
  }

  const manifestOptions = {
    mediaIdentity,
    durationMs,
    sampleFps
  };
  if (maxAnalysisDurationMs !== undefined) manifestOptions.maxAnalysisDurationMs = maxAnalysisDurationMs;
  if (boundaryContextMs !== undefined) manifestOptions.boundaryContextMs = boundaryContextMs;

  const expectedManifest = createObservationPrecomputeManifest(manifestOptions);
  packageKey = normalizePackageKey(packageKey);
  const packageDir = join(resolve(outputRoot), packageKey || expectedManifest.planId);
  const manifestPath = join(packageDir, 'manifest.json');
  let manifest;

  if (await pathExists(manifestPath)) {
    manifest = await readManifest(manifestPath);
    if (manifest.planHash !== expectedManifest.planHash) {
      if (!replaceMismatchedPackage) {
        throw new Error('Existing AI package does not match this media or observer profile.');
      }
      await rm(packageDir, { recursive: true, force: true });
      manifest = null;
    }
  }

  const currentDialogueTrack = dialogueTrackState(dialogueSource, manifest?.status || 'pending');
  if (manifest) {
    manifest = withCheckpointMetadata({
      ...manifest,
      sourceMediaId: sourceMediaId || manifest.sourceMediaId,
      sourceRelativePath: sourceRelativePath || manifest.sourceRelativePath,
      dialogueTrack: currentDialogueTrack
    }, manifest);
    await writeJsonCheckpoint(manifestPath, manifest);
  } else {
    manifest = withCheckpointMetadata({
      ...expectedManifest,
      sourceFileName: basename(absoluteInputPath),
      sourceMediaId,
      sourceRelativePath,
      dialogueTrack: currentDialogueTrack
    });
    await writeJsonCheckpoint(manifestPath, manifest);
  }

  return {
    inputPath: absoluteInputPath,
    outputRoot: resolve(outputRoot),
    packageDir,
    manifestPath,
    manifest,
    dialogueSource
  };
}

export async function runObservationPrecompute(projectRoot, {
  inputPath,
  outputRoot,
  packageKey = null,
  replaceMismatchedPackage = false,
  sourceMediaId = null,
  sourceRelativePath = null,
  durationMs = null,
  mediaIdentity = null,
  sampleFps = 2,
  maxAnalysisDurationMs,
  boundaryContextMs,
  preferredDialogueTrackId = null,
  dialogueSource = null,
  maxChunks = Infinity,
  timeoutMs = 300_000,
  analyzeSegment = analyzeObservationSegment,
  onChunkComplete = null
}) {
  maxChunks = normalizeMaxChunks(maxChunks);
  const prepared = await prepareObservationPackage(projectRoot, {
    inputPath,
    outputRoot,
    packageKey,
    replaceMismatchedPackage,
    sourceMediaId,
    sourceRelativePath,
    durationMs,
    mediaIdentity,
    sampleFps,
    maxAnalysisDurationMs,
    boundaryContextMs,
    preferredDialogueTrackId,
    dialogueSource
  });

  const releasePackageLock = await acquireObservationPackageLock(prepared.packageDir);
  try {
    let { manifest } = prepared;
    let chunksRun = 0;

    while (chunksRun < maxChunks) {
      const chunk = getNextObservationChunk(manifest);
      if (!chunk) break;

      manifest = markObservationChunkRunning(manifest, chunk.index);
      manifest = await saveManifest(prepared.manifestPath, manifest);

      const chunkDir = join(prepared.packageDir, 'chunks', chunk.chunkId);
      const storyboardDir = join(chunkDir, 'storyboards');
      const visualPath = join(chunkDir, 'visual.json');
      const dialoguePath = join(chunkDir, 'dialogue.json');
      await rm(chunkDir, { recursive: true, force: true });
      await mkdir(storyboardDir, { recursive: true });

      const startedAt = Date.now();
      try {
        const analysis = await analyzeSegment(projectRoot, {
          inputPath: prepared.inputPath,
          startMs: chunk.analysisStartMs,
          durationMs: chunk.analysisDurationMs,
          sampleFps: manifest.sampleFps,
          outputDir: storyboardDir,
          storyboardPrefix: chunk.chunkId,
          visualStartMs: chunk.acceptFromMs,
          timeoutMs
        });
        const accepted = trimAnalysisToOwnership(analysis, chunk);
        await removeRejectedStoryboards(storyboardDir, analysis, accepted.frames);

        const visualResult = {
          packageVersion: OBSERVATION_PACKAGE_VERSION,
          planId: manifest.planId,
          chunkId: chunk.chunkId,
          chunkIndex: chunk.index,
          engine: analysis.engine,
          protocolVersion: analysis.protocolVersion,
          sampleFps: analysis.sampleFps,
          decodedFrameCount: analysis.decodedFrameCount,
          analysisRange: {
            startMs: chunk.analysisStartMs,
            durationMs: chunk.analysisDurationMs
          },
          ownershipRange: {
            fromMs: chunk.acceptFromMs,
            toMs: chunk.acceptToMs
          },
          elapsedMs: Date.now() - startedAt,
          observations: accepted.observations,
          frames: accepted.frames
        };
        const dialogueResult = dialogueChunkPayload(prepared.dialogueSource, chunk, {
          packageVersion: OBSERVATION_PACKAGE_VERSION,
          planId: manifest.planId
        });
        await Promise.all([
          writeJsonCheckpoint(visualPath, visualResult),
          writeJsonCheckpoint(dialoguePath, dialogueResult)
        ]);

        const visualRef = toPortableRelativePath(prepared.packageDir, visualPath);
        const dialogueRef = toPortableRelativePath(prepared.packageDir, dialoguePath);
        const storyboardRootRef = toPortableRelativePath(prepared.packageDir, storyboardDir);
        manifest = markObservationChunkComplete(manifest, chunk.index, {
          observationCount: accepted.observations.length,
          storyboardCount: accepted.frames.length,
          resultRef: visualRef
        });
        manifest.chunks[chunk.index] = {
          ...manifest.chunks[chunk.index],
          visualRef,
          dialogueRef,
          storyboardRootRef,
          dialogueCueCount: dialogueResult.cues.length
        };
        manifest = await saveManifest(prepared.manifestPath, manifest);
        chunksRun += 1;
        onChunkComplete?.({
          chunk: manifest.chunks[chunk.index],
          elapsedMs: visualResult.elapsedMs,
          progress: manifest.progress
        });
      } catch (error) {
        manifest = markObservationChunkFailed(manifest, chunk.index, error.message || String(error));
        await saveManifest(prepared.manifestPath, manifest);
        throw error;
      }
    }

    return {
      ...prepared,
      manifest,
      chunksRun,
      ready: manifest.status === 'ready'
    };
  } finally {
    await releasePackageLock();
  }
}
