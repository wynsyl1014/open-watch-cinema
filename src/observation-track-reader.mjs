import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { validateObservationPrecomputeManifest } from './observation-precompute-plan.mjs';
import { AUDIO_NOT_PREPARED, validateAudioPayload } from './audio-descriptions.mjs';

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function visualStatusOf(manifest) {
  return manifest.visualTrack?.status || manifest.status;
}

function publicObservation(chunk, observation) {
  const next = {
    ...observation,
    sourceChunkId: chunk.chunkId,
    metrics: observation.metrics ? { ...observation.metrics } : observation.metrics
  };
  if (observation.storyboard) {
    const storyboardRootRef = chunk.storyboardRootRef
      || `${dirname(chunk.visualRef || chunk.resultRef || '').replaceAll('\\', '/')}/storyboards`;
    next.storyboard = {
      ...observation.storyboard,
      storyboardRef: `${storyboardRootRef}/${observation.storyboard.filename}`.replace(/^\//, '')
    };
    delete next.storyboard.filename;
  }
  return next;
}

function emptyWindow(manifest, fromMs, toMs, effectiveFromMs, revealThroughMs) {
  return {
    planId: manifest.planId,
    visualStatus: visualStatusOf(manifest),
    dialogueTrack: manifest.dialogueTrack || null,
    audioTrack: manifest.audioTrack || AUDIO_NOT_PREPARED,
    aiReadiness: manifest.aiReadiness || null,
    requestedRange: { fromMs, toMs },
    deliveredRange: { fromMs: effectiveFromMs, toMs: effectiveFromMs },
    revealThroughMs,
    observations: [],
    dialogue: [],
    audioDescriptions: [],
    nextCursorMs: effectiveFromMs,
    hasMore: false,
    dialogueHasMore: false,
    audioHasMore: false
  };
}

export async function readObservationTrackWindow(packageDir, {
  fromMs,
  toMs,
  playheadMs,
  lookaheadMs = 1_000,
  maxItems = 24,
  maxDialogueItems = 80,
  maxAudioItems = 20
}) {
  fromMs = requireNonNegativeInteger(fromMs, 'fromMs');
  toMs = requireNonNegativeInteger(toMs, 'toMs');
  playheadMs = requireNonNegativeInteger(playheadMs, 'playheadMs');
  lookaheadMs = requireNonNegativeInteger(lookaheadMs, 'lookaheadMs');
  maxItems = requirePositiveInteger(maxItems, 'maxItems');
  maxDialogueItems = requirePositiveInteger(maxDialogueItems, 'maxDialogueItems');
  maxAudioItems = requirePositiveInteger(maxAudioItems, 'maxAudioItems');
  if (maxAudioItems > 100) throw new RangeError('maxAudioItems must not exceed 100.');
  if (maxItems > 100) throw new RangeError('maxItems must not exceed 100.');
  if (maxDialogueItems > 300) throw new RangeError('maxDialogueItems must not exceed 300.');
  if (toMs < fromMs) throw new RangeError('toMs must be greater than or equal to fromMs.');

  const absolutePackageDir = resolve(packageDir);
  const manifest = await readJson(join(absolutePackageDir, 'manifest.json'));
  validateObservationPrecomputeManifest(manifest);
  if (visualStatusOf(manifest) !== 'ready') {
    throw new Error('Visual observation track is not ready.');
  }

  const revealThroughMs = Math.min(manifest.durationMs, playheadMs + lookaheadMs);
  const effectiveFromMs = Math.min(fromMs, manifest.durationMs);
  const effectiveToMs = Math.min(toMs, revealThroughMs, manifest.durationMs);

  if (effectiveToMs <= effectiveFromMs) {
    return emptyWindow(manifest, fromMs, toMs, effectiveFromMs, revealThroughMs);
  }

  const visualCandidates = [];
  const dialogueById = new Map();
  const audioById = new Map();
  for (const chunk of manifest.chunks) {
    if (chunk.status !== 'complete') continue;
    if (chunk.logicalEndMs <= effectiveFromMs || chunk.logicalStartMs >= effectiveToMs) continue;

    const visualRef = chunk.visualRef || chunk.resultRef;
    if (visualRef) {
      const payload = await readJson(join(absolutePackageDir, visualRef));
      for (const observation of payload.observations || []) {
        if (observation.fromMs >= effectiveToMs || observation.toMs <= effectiveFromMs) continue;
        visualCandidates.push(publicObservation(chunk, observation));
      }
    }

    if (chunk.dialogueRef) {
      const dialoguePayload = await readJson(join(absolutePackageDir, chunk.dialogueRef));
      for (const cue of dialoguePayload.cues || []) {
        if (cue.fromMs >= effectiveToMs || cue.toMs <= effectiveFromMs) continue;
        dialogueById.set(cue.cueId || `${cue.fromMs}:${cue.toMs}:${cue.text}`, {
          ...cue,
          sourceChunkId: chunk.chunkId
        });
      }
    }
    if (chunk.audioRef && chunk.audioStatus === 'ready') {
      const audioPayload = validateAudioPayload(await readJson(join(absolutePackageDir, chunk.audioRef)), chunk);
      for (const description of audioPayload.descriptions) {
        // Deliver on completion, not overlap: a caption can describe the END of its audio clip.
        // Audio never uses the optional visual/dialogue lookahead allowance.
        if (description.availableAtMs <= effectiveFromMs
            || description.availableAtMs > Math.min(effectiveToMs, playheadMs)) continue;
        audioById.set(description.id, { ...description, sourceChunkId: chunk.chunkId });
      }
    }
  }

  visualCandidates.sort((left, right) => left.fromMs - right.fromMs || left.toMs - right.toMs);
  const dialogueCandidates = [...dialogueById.values()]
    .sort((left, right) => left.fromMs - right.fromMs || left.toMs - right.toMs);
  const observations = visualCandidates.slice(0, maxItems);
  const dialogue = dialogueCandidates.slice(0, maxDialogueItems);
  const audioCandidates = [...audioById.values()].sort((a, b) => a.availableAtMs - b.availableAtMs);
  const audioDescriptions = audioCandidates.slice(0, maxAudioItems);
  const audioHasMore = audioCandidates.length > audioDescriptions.length;
  const hasMore = visualCandidates.length > observations.length;
  const dialogueHasMore = dialogueCandidates.length > dialogue.length;
  const deliveredEnds = [
    ...observations.map((item) => item.toMs),
    ...dialogue.map((item) => item.toMs),
    ...audioDescriptions.map((item) => item.availableAtMs)
  ];
  let nextCursorMs = deliveredEnds.length > 0
    ? Math.max(...deliveredEnds)
    : effectiveToMs;
  // Never skip a not-yet-deliverable audio caption via a longer dialogue cue or lookahead.
  if (manifest.audioTrack) nextCursorMs = Math.min(nextCursorMs, effectiveToMs, playheadMs);
  if (audioHasMore) nextCursorMs = Math.min(nextCursorMs, audioCandidates[maxAudioItems].availableAtMs - 1);

  return {
    planId: manifest.planId,
    visualStatus: visualStatusOf(manifest),
    dialogueTrack: manifest.dialogueTrack || null,
    audioTrack: manifest.audioTrack || AUDIO_NOT_PREPARED,
    aiReadiness: manifest.aiReadiness || null,
    requestedRange: { fromMs, toMs },
    deliveredRange: { fromMs: effectiveFromMs, toMs: effectiveToMs },
    revealThroughMs,
    observations,
    dialogue,
    audioDescriptions,
    nextCursorMs,
    hasMore,
    dialogueHasMore,
    audioHasMore
  };
}
