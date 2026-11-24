import {
  needsStoryboardUpgrade,
  normalizeImageSettings
} from '../visuals/image-settings.mjs';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import {
  dialogueChunkPayload,
  dialogueTrackState,
  filterDialogueSource,
  prepareDialogueSource
} from './dialogue-track.mjs';
import { probeMedia } from '../media/media-compatibility.mjs';
import { includedRanges, resolveSkipRanges } from '../media/skip-ranges.mjs';
import { analyzeObservationSegment, preparedStoryboardViews } from './observation-manager.mjs';
import {
  audioTrackState, createAudioDescriber, getAudioDescriptionStatus, validateAudioPayload
} from './audio-descriptions.mjs';
import {
  createObservationPrecomputeManifest,
  markObservationChunkComplete,
  markObservationChunkFailed,
  markObservationChunkRunning,
  validateObservationPrecomputeManifest
} from './observation-precompute-plan.mjs';
import {
  appendViewingAudio,
  createViewingChunk,
  validateViewingChunk,
  viewingAudioPayload,
  viewingPreparationState
} from '../delivery/viewing-package.mjs';

export const UNIFIED_OBSERVATION_PACKAGE_VERSION = 3;
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
      const heartbeat = setInterval(() => {
        const now = new Date();
        utimes(lockDir, now, now).catch(() => {});
      }, Math.max(1000, Math.min(30_000, Math.floor(staleMs / 3))));
      heartbeat.unref();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
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

export function normalizePackageKey(value) {
  if (value === null || value === undefined) return null;
  const key = String(value).trim();
  if (key !== '观影包' && !/^[a-z0-9][a-z0-9-]{2,79}$/i.test(key)) {
    throw new TypeError('packageKey must contain only letters, numbers, and hyphens.');
  }
  return key;
}

export async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function writeJsonCheckpoint(filePath, payload) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  try {
    // Replace without an absent-file interval while a viewer reads completed data.
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true });
  }
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

  const next = {
    ...manifest,
    packageVersion: UNIFIED_OBSERVATION_PACKAGE_VERSION,
    packageKind: 'open-watch-cinema-ai-package',
    analysisActivation: 'manual_opt_in',
    sourceFileName: manifest.sourceFileName || previous.sourceFileName,
    sourceMediaId: manifest.sourceMediaId || previous.sourceMediaId || null,
    sourceRelativePath: manifest.sourceRelativePath || previous.sourceRelativePath || null,
    storageLayout: {
      manifest: 'manifest.json',
      chunks: 'chunks/<chunkId>/',
      viewing: 'chunks/<chunkId>/viewing.json',
      storyboards: 'chunks/<chunkId>/storyboards/'
    },
    visualTrack: {
      status: manifest.status,
      protocolVersion: manifest.observerProtocolVersion,
      resultKind: 'unified_viewing_package'
    },
    dialogueTrack,
    aiReadiness: deriveAiReadiness(manifest, dialogueTrack),
    createdAt: previous.createdAt || now,
    updatedAt: now
  };
  next.viewingTrack = viewingPreparationState(next);
  return next;
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
  const files = (frame) => [
    frame.filename,
    ...(frame.parts || []).map((part) => part.filename)
  ].filter(Boolean);
  const accepted = new Set(acceptedFrames.flatMap(files));
  const rejected = new Set((analysis.frames || []).flatMap(files).filter((name) => !accepted.has(name)));
  for (const filename of rejected) {
    const path = resolve(outputDir, filename);
    if (!path.startsWith(`${resolve(outputDir)}${sep}`)) throw new Error('Observer asset escaped its output directory.');
    await rm(path, { force: true });
  }
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
  viewingIntervalMs = null,
  initialBufferMs = null,
  imageSettings = null,
  skipConfig = null,
  skipRanges = null,
  preferredDialogueTrackId = null,
  dialogueSource = null,
  holdPackageLock = false
}) {
  const absoluteInputPath = resolve(inputPath);
  const inputStat = await stat(absoluteInputPath);
  if (!inputStat.isFile()) throw new Error(`Video not found: ${absoluteInputPath}`);
  if (viewingIntervalMs === null) {
    throw new TypeError('viewingIntervalMs is required to prepare a viewing package.');
  }
  requirePositiveInteger(viewingIntervalMs, 'viewingIntervalMs');
  if (imageSettings === null) {
    throw new TypeError('imageSettings is required to prepare a viewing package.');
  }
  const normalizedImageSettings = normalizeImageSettings(imageSettings);
  if (initialBufferMs !== null) requirePositiveInteger(initialBufferMs, 'initialBufferMs');

  if (durationMs === null) {
    const probe = await probeMedia(absoluteInputPath);
    durationMs = Math.round(probe.durationSeconds * 1000);
  }
  durationMs = requirePositiveInteger(durationMs, 'durationMs');

  if (mediaIdentity === null) {
    mediaIdentity = `sha256:${await hashFile(absoluteInputPath)}`;
  }

  const manifestOptions = {
    mediaIdentity,
    durationMs,
    sampleFps,
    viewingIntervalMs,
    imageSettings: normalizedImageSettings,
    skipRanges: skipRanges ?? resolveSkipRanges(skipConfig, durationMs)
  };
  if (maxAnalysisDurationMs !== undefined) manifestOptions.maxAnalysisDurationMs = maxAnalysisDurationMs;
  if (boundaryContextMs !== undefined) manifestOptions.boundaryContextMs = boundaryContextMs;

  const expectedManifest = createObservationPrecomputeManifest(manifestOptions);
  packageKey = normalizePackageKey(packageKey);
  const packageDir = join(resolve(outputRoot), packageKey || expectedManifest.planId);
  const manifestPath = join(packageDir, 'manifest.json');
  await mkdir(packageDir, { recursive: true });
  const releasePackageLock = await acquireObservationPackageLock(packageDir);
  let transferredLock = false;
  try {
    let manifest;

    if (await pathExists(manifestPath)) {
      manifest = await readManifest(manifestPath);
      const packageVersion = manifest.packageVersion ?? 1;
      if (needsStoryboardUpgrade(packageVersion)) {
        throw new Error('This viewing package uses an earlier format. Upgrade it in a staged package to continue.');
      }
      if (packageVersion === UNIFIED_OBSERVATION_PACKAGE_VERSION
          && manifest.imageSettings?.assetVersion !== normalizedImageSettings.assetVersion) {
        throw new Error('The prepared images use a different revision. Rebuild them in a staged package to continue.');
      }
      if (manifest.planHash !== expectedManifest.planHash) {
        if (!replaceMismatchedPackage || packageVersion === UNIFIED_OBSERVATION_PACKAGE_VERSION) {
          throw new Error('Existing AI package does not match this media or observer profile.');
        }
        for (const name of await readdir(packageDir)) {
          if (name !== '.run-lock') await rm(join(packageDir, name), { recursive: true, force: true });
        }
        manifest = null;
      }
    }

    if (dialogueSource === null && manifest?.status !== 'ready') {
      dialogueSource = await prepareDialogueSource(absoluteInputPath, {
        preferredTrackId: preferredDialogueTrackId
      });
    }
    dialogueSource = filterDialogueSource(dialogueSource, expectedManifest.skipRanges ?? []);
    const currentDialogueTrack = manifest?.status === 'ready'
      ? manifest.dialogueTrack
      : dialogueTrackState(dialogueSource, manifest?.status || 'pending');
    if (manifest) {
      manifest = withCheckpointMetadata({
        ...manifest,
        sourceMediaId: sourceMediaId || manifest.sourceMediaId,
        sourceRelativePath: sourceRelativePath || manifest.sourceRelativePath,
        dialogueTrack: currentDialogueTrack,
        viewingTrack: {
          ...manifest.viewingTrack,
          initialBufferMs: initialBufferMs ?? manifest.viewingTrack?.initialBufferMs ?? null
        }
      }, manifest);
      await writeJsonCheckpoint(manifestPath, manifest);
    } else {
      manifest = withCheckpointMetadata({
        ...expectedManifest,
        sourceFileName: basename(absoluteInputPath),
        sourceMediaId,
        sourceRelativePath,
        dialogueTrack: currentDialogueTrack,
        viewingTrack: { initialBufferMs }
      });
      await writeJsonCheckpoint(manifestPath, manifest);
    }

    transferredLock = holdPackageLock;
    return {
      inputPath: absoluteInputPath,
      outputRoot: resolve(outputRoot),
      packageDir,
      manifestPath,
      manifest,
      dialogueSource,
      ...(holdPackageLock ? { releasePackageLock } : {})
    };
  } finally {
    if (!transferredLock) await releasePackageLock();
  }
}

export async function runObservationPrecompute(projectRoot, options) {
  const {
    maxChunks: rawMaxChunks = Infinity,
    timeoutMs = 300_000,
    analyzeSegment = analyzeObservationSegment,
    onChunkComplete = null,
    includeAudio,
    describeAudioChunk = null,
    onAudioProgress = null,
    onPreparationProgress = null,
    onInitialBufferReady = null,
    signal
  } = options;
  const maxChunks = normalizeMaxChunks(rawMaxChunks);
  const { releasePackageLock, ...prepared } = await prepareObservationPackage(projectRoot, {
    ...options,
    holdPackageLock: true
  });
  let audioDescriber = null;
  try {
    let { manifest } = prepared;
    const skipRanges = manifest.skipRanges ?? [];
    let chunksRun = 0;
    let initialBufferReported = false;
    const audioRequested = includeAudio === undefined
      ? Boolean(manifest.viewingTrack?.audioRequested)
      : Boolean(includeAudio);
    const hasRetainedAudio = includedRanges(0, manifest.durationMs, skipRanges).length > 0;
    manifest.viewingTrack = { ...manifest.viewingTrack, audioRequested };

    const persist = async () => {
      manifest = await saveManifest(prepared.manifestPath, manifest);
      const progress = { ...manifest.viewingTrack, durationMs: manifest.durationMs };
      await onPreparationProgress?.(progress);
      if (!initialBufferReported && progress.initialBufferReady) {
        initialBufferReported = true;
        await onInitialBufferReady?.(progress);
      }
    };

    let audioStatus = null;
    let audioMetadata = null;
    let audioProfile = null;
    let describe = null;
    let activeChunk = null;
    const emitLiveProgress = (chunk, chunkFraction) => {
      if (!chunk || !manifest.durationMs) return;
      const clamped = Math.max(0, Math.min(1, chunkFraction));
      const liveThroughMs = Math.round(chunk.logicalStartMs + (chunk.logicalEndMs - chunk.logicalStartMs) * clamped);
      const livePercent = Math.min(99.9, (liveThroughMs / manifest.durationMs) * 100);
      void Promise.resolve(onPreparationProgress?.({
        ...manifest.viewingTrack,
        durationMs: manifest.durationMs,
        liveThroughMs,
        livePercent,
        live: true
      })).catch(() => {});
    };
    const reportAudio = ({ throughMs }) => {
      onAudioProgress?.({ throughMs, durationMs: manifest.durationMs });
      if (activeChunk && typeof throughMs === 'number' && Number.isFinite(throughMs)) {
        const span = Math.max(1, activeChunk.logicalEndMs - activeChunk.logicalStartMs);
        const audioFraction = Math.max(0, Math.min(1, (throughMs - activeChunk.logicalStartMs) / span));
        const visualWeight = activeChunk.visualDoneBeforeRun ? 0 : 0.55;
        emitLiveProgress(activeChunk, visualWeight + (1 - visualWeight) * audioFraction);
      }
    };
    if (audioRequested) {
      const dataRoot = resolve(process.env.LOCAL_DATA_ROOT || join(projectRoot, 'local-data'));
      audioStatus = !hasRetainedAudio ? { status: 'available' }
        : describeAudioChunk ? { status: 'available', model: 'custom-local-analyzer' }
          : await getAudioDescriptionStatus(projectRoot, dataRoot);
      if (audioStatus.status === 'available') {
        audioMetadata = {
          model: audioStatus.model, revision: audioStatus.revision,
          promptVersion: audioStatus.promptVersion, segmentMs: audioStatus.segmentMs,
          device: audioStatus.device
        };
        audioProfile = JSON.stringify(audioMetadata);
        for (const chunk of manifest.chunks) {
          if (chunk.audioProfile !== audioProfile) {
            chunk.audioStatus = 'pending';
            chunk.audioError = null;
          }
        }
        manifest.audioTrack = audioTrackState(manifest.chunks, audioMetadata);
        if (hasRetainedAudio) {
          audioDescriber = describeAudioChunk ? null : createAudioDescriber(projectRoot, { dataRoot, onProgress: reportAudio });
          describe = describeAudioChunk || ((request) => audioDescriber.describeChunk(request));
        }
      } else {
        if (!['ready', 'source_missing'].includes(manifest.audioTrack?.status)) {
          manifest.audioTrack = { status: 'unavailable', note: audioStatus.note || 'Run the optional local audio setup.' };
        }
      }
    }
    await persist();

    // Each batch completes its visual/dialogue work and then its audio before
    // advancing. A slow or failed audio chunk never discards prepared images.
    let previousViews = [];
    for (let index = 0; index < manifest.chunks.length; index += 1) {
      let chunk = manifest.chunks[index];
      const kept = includedRanges(chunk.acceptFromMs, chunk.acceptToMs, skipRanges);
      previousViews = previousViews.filter(view => view.mediaTimeMs >= chunk.analysisStartMs);
      const chunkDir = join(prepared.packageDir, 'chunks', chunk.chunkId);
      const storyboardDir = join(chunkDir, 'storyboards');
      const viewingPath = join(chunkDir, 'viewing.json');
      const viewingRef = toPortableRelativePath(prepared.packageDir, viewingPath);
      const storyboardRootRef = toPortableRelativePath(prepared.packageDir, storyboardDir);
      const startedAt = Date.now();
      let payload = null;
      let changed = false;
      const visualDoneBeforeRun = chunk.status === 'complete';
      const chunkHasAudioWork = Boolean(audioRequested && describe);
      activeChunk = { ...chunk, visualDoneBeforeRun };

      if (await pathExists(viewingPath)) {
        try {
          payload = validateViewingChunk(JSON.parse(await readFile(viewingPath, 'utf8')), manifest, chunk);
        } catch (error) {
          if (chunk.status === 'complete') throw error;
          // An uncommitted partial checkpoint can be reconstructed in this job.
        }
      } else if (chunk.status === 'complete') {
        throw new Error(`Completed viewing chunk is missing: ${chunk.chunkId}.`);
      }

      if (chunk.status !== 'complete') {
        if (!payload && chunksRun >= maxChunks) break;
        manifest = markObservationChunkRunning(manifest, index);
        await persist();
        chunk = manifest.chunks[index];
        try {
          if (!payload) {
            // This uncommitted chunk can contain leftover parts from an interrupted composition.
            await rm(storyboardDir, { recursive: true, force: true });
            await mkdir(storyboardDir, { recursive: true });
            const visualWeight = chunkHasAudioWork ? 0.55 : 1;
            const spans = includedRanges(chunk.analysisStartMs, chunk.acceptToMs, skipRanges)
              .filter(span => span.toMs > chunk.acceptFromMs);
            const observations = [];
            const frames = [];
            let analysis = {
              protocolVersion: manifest.observerProtocolVersion, sampleFps: manifest.sampleFps,
              visualAssetProfile: manifest.imageSettings
            };
            for (const [spanIndex, span] of spans.entries()) {
              signal?.throwIfAborted();
              analysis = await analyzeSegment(projectRoot, {
                inputPath: prepared.inputPath, startMs: span.fromMs,
                durationMs: span.toMs - span.fromMs, sampleFps: manifest.sampleFps,
                outputDir: storyboardDir, storyboardPrefix: spanIndex === 0 ? chunk.chunkId : `${chunk.chunkId}-${spanIndex}`,
                visualStartMs: Math.max(chunk.acceptFromMs, span.fromMs), visualEndMs: span.toMs,
                ...(skipRanges.length && { decodeEndMs: span.toMs }),
                previousViews: previousViews.filter(view => view.mediaTimeMs >= span.fromMs),
                imageSettings: manifest.imageSettings, timeoutMs,
                onProgress(event) {
                  if (!event || !event.total) return;
                  const phaseRatio = Math.max(0, Math.min(1, event.completed / event.total));
                  const visualFraction = event.phase === 'metrics' ? 0.2 * phaseRatio : 0.2 + 0.8 * phaseRatio;
                  emitLiveProgress(chunk, visualWeight * (spanIndex + visualFraction) / spans.length);
                }
              });
              const accepted = trimAnalysisToOwnership(analysis, {
                acceptFromMs: Math.max(chunk.acceptFromMs, span.fromMs), acceptToMs: span.toMs
              });
              await removeRejectedStoryboards(storyboardDir, analysis, accepted.frames);
              observations.push(...accepted.observations);
              frames.push(...accepted.frames);
            }
            const dialogue = dialogueChunkPayload(prepared.dialogueSource, chunk, {
              packageVersion: UNIFIED_OBSERVATION_PACKAGE_VERSION,
              planId: manifest.planId, ownership: 'start'
            });
            payload = createViewingChunk({
              planId: manifest.planId, chunk, intervalMs: manifest.viewingIntervalMs,
              analysis: { ...analysis, observations, frames }, dialogue, storyboardRootRef
            });
            validateViewingChunk(payload, manifest, chunk);
            await writeJsonCheckpoint(viewingPath, payload);
            chunksRun += 1;
          }
          manifest = markObservationChunkComplete(manifest, index, {
            observationCount: payload.tracks.visual.observationCount,
            storyboardCount: payload.tracks.visual.storyboardCount,
            resultRef: viewingRef
          });
          Object.assign(manifest.chunks[index], {
            viewingRef, storyboardRootRef,
            dialogueCueCount: payload.tracks.dialogue.cueCount
          });
          await persist();
          chunk = manifest.chunks[index];
          changed = true;
        } catch (error) {
          // Observer failures affect this batch; existing earlier batches remain readable.
          if (manifest.chunks[index].status !== 'complete') {
            manifest = markObservationChunkFailed(manifest, index, error.message || String(error));
            await persist();
          }
          throw error;
        }
      }

      for (const segment of payload.segments) for (const entry of segment.entries) {
        if (entry.type === 'image') previousViews.push(...preparedStoryboardViews(entry));
      }

      if (audioStatus?.status === 'available') {
        let reusable = false;
        if (payload.tracks.audio.profile === audioProfile
            && ['ready', 'source_missing'].includes(payload.tracks.audio.status)) {
          try {
            validateAudioPayload(viewingAudioPayload(payload), chunk, kept);
            reusable = true;
          } catch { /* Replace only this chunk's incomplete audio entries. */ }
        }
        if (!reusable) {
          Object.assign(chunk, { audioStatus: 'running', audioError: null });
          manifest.audioTrack = { ...audioTrackState(manifest.chunks, audioMetadata), status: 'running' };
          await persist();
          reportAudio({ throughMs: chunk.logicalStartMs });
          try {
            const result = kept.length
              ? await describe({ inputPath: prepared.inputPath, chunk, ranges: kept })
              : { status: 'ready', descriptions: [] };
            const audio = validateAudioPayload(result, chunk, kept);
            payload = appendViewingAudio(payload, audio, audioProfile);
            validateViewingChunk(payload, manifest, chunk);
            await writeJsonCheckpoint(viewingPath, payload);
            changed = true;
          } catch (error) {
            Object.assign(chunk, { audioStatus: 'failed', audioError: error.message || String(error) });
            manifest.audioTrack = audioTrackState(manifest.chunks, { ...audioMetadata, note: chunk.audioError });
            await persist();
            throw error;
          }
        }
        // This also recovers a completed audio write interrupted before manifest commit.
        Object.assign(chunk, {
          audioStatus: payload.tracks.audio.status, audioError: null,
          audioProfile, audioDescriptionCount: payload.tracks.audio.descriptionCount
        });
        manifest.audioTrack = audioTrackState(manifest.chunks, audioMetadata);
        await persist();
        reportAudio({ throughMs: chunk.logicalEndMs });
      }

      if (changed) {
        await onChunkComplete?.({
          chunk: manifest.chunks[index], elapsedMs: Date.now() - startedAt,
          progress: manifest.progress, viewingProgress: manifest.viewingTrack
        });
      }
    }

    return {
      ...prepared, manifest, chunksRun,
      ready: manifest.viewingTrack.status === 'ready',
      initialBufferReady: manifest.viewingTrack.initialBufferReady,
      preparedThroughMs: manifest.viewingTrack.preparedThroughMs
    };
  } finally {
    audioDescriber?.close();
    await releasePackageLock();
  }
}
