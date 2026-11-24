import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { validateObservationPrecomputeManifest } from '../preparation/observation-precompute-plan.mjs';
import { AUDIO_NOT_PREPARED, validateAudioPayload } from '../preparation/audio-descriptions.mjs';
import { validateViewingChunk, viewingPreparationState } from './viewing-package.mjs';

const ALL_TRACKS = ['visual', 'dialogue', 'audio'];

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

async function readJson(filePath, signal) {
  signal?.throwIfAborted();
  const text = await readFile(filePath, { encoding: 'utf8', signal });
  signal?.throwIfAborted();
  return JSON.parse(text);
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
    packageVersion: manifest.packageVersion || 1,
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


function entryTrack(entry) {
  return entry.type === 'sound' ? 'audio' : entry.type === 'dialogue' ? 'dialogue' : 'visual';
}

function viewingObservation(entry, sourceChunkId) {
  const common = {
    id: entry.id, fromMs: entry.fromMs, toMs: entry.toMs,
    kind: entry.kind || entry.frameReason || 'visual_event', sourceChunkId
  };
  if (entry.type === 'motion') {
    return { ...common, text: entry.text, metrics: { motionDirection: entry.direction } };
  }
  const { id, type, fromMs, toMs, availableAtMs, ...storyboard } = entry;
  return { ...common, storyboard: { ...storyboard, mediaTimeMs: fromMs } };
}

async function readViewingWindow(packageDir, manifest, options) {
  const { fromMs, toMs, playheadMs, maxItems, maxDialogueItems, maxAudioItems, tracks, signal, gateAudioAtEnd } = options;
  const preparation = viewingPreparationState(manifest);
  const revealThroughMs = Math.min(playheadMs, manifest.durationMs);
  const effectiveFromMs = Math.min(fromMs, manifest.durationMs);
  const effectiveToMs = Math.min(toMs, playheadMs, preparation.visualPreparedThroughMs, manifest.durationMs);
  const result = {
    ...emptyWindow(manifest, fromMs, toMs, effectiveFromMs, revealThroughMs),
    viewingIntervalMs: manifest.viewingIntervalMs,
    imageSettings: manifest.imageSettings || null,
    viewingTrack: preparation,
    segments: [],
    pendingAudioRanges: [],
    awaitingPreparation: Math.min(toMs, playheadMs) > preparation.visualPreparedThroughMs
  };
  const inspectStartFrame = tracks.size === 1 && tracks.has('visual')
    && effectiveFromMs === 0 && playheadMs === 0 && toMs > 0 && preparation.visualPreparedThroughMs > 0;
  const inspectStartAudio = tracks.has('audio') && effectiveFromMs === 0
    && playheadMs === 0 && preparation.visualPreparedThroughMs > 0;
  if (effectiveToMs <= effectiveFromMs && !inspectStartFrame && !inspectStartAudio) return result;

  const candidates = [];
  const sections = new Map();
  for (const [index, chunk] of manifest.chunks.entries()) {
    signal?.throwIfAborted();
    // A description can start before a chunk boundary and finish in the next chunk.
    const previousAudioChunk = gateAudioAtEnd && tracks.has('audio') && chunk.logicalEndMs <= effectiveFromMs
      && manifest.chunks[index + 1]?.logicalEndMs > effectiveFromMs;
    // Include a next-batch caption whose start is exactly the current playback position.
    if ((!previousAudioChunk && chunk.logicalEndMs <= effectiveFromMs) || chunk.logicalStartMs > effectiveToMs) continue;
    const audioReady = ['ready', 'source_missing'].includes(chunk.audioStatus);
    const viewingReady = chunk.status === 'complete' && Boolean(chunk.viewingRef);
    // Reserve the next batch's boundary sound even when its visuals are not ready yet.
    if (tracks.has('audio') && preparation.audioRequested && (!audioReady || !viewingReady)) {
      result.pendingAudioRanges.push({
        chunkId: chunk.chunkId,
        // Keep the exclusive lower bound before a newly reached batch start.
        fromMs: Math.max(effectiveFromMs, chunk.logicalStartMs - 1),
        toMs: Math.min(effectiveToMs, chunk.logicalEndMs)
      });
    }
    if (!viewingReady) continue;
    const payload = validateViewingChunk(
      await readJson(join(packageDir, chunk.viewingRef), signal), manifest, chunk
    );
    for (const segment of payload.segments) {
      for (const storedEntry of segment.entries) {
        const entry = storedEntry.type === 'sound'
          ? { ...storedEntry, availableAtMs: gateAudioAtEnd ? storedEntry.toMs : storedEntry.fromMs } : storedEntry;
        const track = entryTrack(entry);
        if (effectiveToMs <= effectiveFromMs && !inspectStartFrame && track !== 'audio') continue;
        if ((previousAudioChunk && track !== 'audio') || !tracks.has(track) || (track === 'audio' && !audioReady)) continue;
        // A media cursor means delivered through this timestamp: (fromMs, toMs].
        // The initial zero-time frame has no earlier non-negative cursor.
        if (entry.availableAtMs <= effectiveFromMs
            && !(entry.availableAtMs === 0 && effectiveFromMs === 0)) continue;
        if (entry.availableAtMs > Math.min(effectiveToMs, revealThroughMs)) continue;
        sections.set(segment.id, segment);
        candidates.push({ entry, segmentId: segment.id, sourceChunkId: chunk.chunkId });
      }
    }
  }

  // Equal release times retain the order in which the package lists its images.
  candidates.sort((left, right) => left.entry.availableAtMs - right.entry.availableAtMs);
  const limits = { visual: maxItems, dialogue: maxDialogueItems, audio: maxAudioItems };
  const counts = { visual: 0, dialogue: 0, audio: 0 };
  const selected = [];
  let nextCursorMs = effectiveToMs;
  for (let index = 0; index < candidates.length;) {
    let end = index + 1;
    const atMs = candidates[index].entry.availableAtMs;
    while (end < candidates.length && candidates[end].entry.availableAtMs === atMs) end += 1;
    const group = candidates.slice(index, end);
    const added = { visual: 0, dialogue: 0, audio: 0 };
    for (const { entry } of group) added[entryTrack(entry)] += 1;
    if (selected.length && atMs - 1 > effectiveFromMs
        && ALL_TRACKS.some((track) => counts[track] + added[track] > limits[track])) {
      nextCursorMs = atMs - 1;
      for (const { entry } of candidates.slice(index)) {
        if (entry.type === 'dialogue') result.dialogueHasMore = true;
        else if (entry.type === 'sound') result.audioHasMore = true;
        else result.hasMore = true;
      }
      break;
    }
    // Keep a single simultaneous group intact, even if it exceeds a soft item limit.
    // A time-only cursor cannot resume inside that group without dropping or replaying entries.
    selected.push(...group);
    for (const track of ALL_TRACKS) counts[track] += added[track];
    index = end;
  }

  const deliveredSections = new Map();
  for (const { entry, segmentId, sourceChunkId } of selected) {
    let section = deliveredSections.get(segmentId);
    if (!section) {
      const source = sections.get(segmentId);
      section = { id: source.id, fromMs: source.fromMs, toMs: source.toMs, entries: [] };
      deliveredSections.set(segmentId, section);
    }
    section.entries.push({ ...entry, sourceChunkId });
    if (entry.type === 'dialogue') result.dialogue.push({ ...entry, cueId: entry.id, sourceChunkId });
    else if (entry.type === 'sound') result.audioDescriptions.push({ ...entry, sourceChunkId });
    else result.observations.push(viewingObservation(entry, sourceChunkId));
  }
  for (const section of deliveredSections.values()) {
    section.entries.sort((left, right) => left.fromMs - right.fromMs);
  }
  result.segments = [...deliveredSections.values()].sort((left, right) => left.fromMs - right.fromMs);
  nextCursorMs = Math.min(nextCursorMs, playheadMs);
  // A prepared batch ends before the next batch's start-time entries.
  // Leave that timestamp unread until its pictures and dialogue are available.
  if (nextCursorMs === preparation.visualPreparedThroughMs
      && nextCursorMs < manifest.durationMs
      && (tracks.has('visual') || tracks.has('dialogue'))) {
    nextCursorMs = Math.max(effectiveFromMs, nextCursorMs - 1);
    result.awaitingPreparation = true;
  }
  result.deliveredRange.toMs = nextCursorMs;
  result.nextCursorMs = nextCursorMs;
  result.pendingAudioRanges = result.pendingAudioRanges
    .map((range) => ({ ...range, toMs: Math.min(range.toMs, nextCursorMs) }))
    .filter((range) => range.toMs > range.fromMs);
  signal?.throwIfAborted();
  return result;
}

export async function readObservationTrackWindow(packageDir, {
  fromMs,
  toMs,
  playheadMs,
  lookaheadMs = 1_000,
  maxItems = 24,
  maxDialogueItems = 80,
  maxAudioItems = 20,
  tracks = ALL_TRACKS,
  gateAudioAtEnd = false,
  signal
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

  if (!Array.isArray(tracks) || !tracks.length || tracks.some((track) => !ALL_TRACKS.includes(track))) {
    throw new TypeError('tracks must select visual, dialogue and/or audio.');
  }
  const selectedTracks = new Set(tracks);
  const absolutePackageDir = resolve(packageDir);
  const manifest = await readJson(join(absolutePackageDir, 'manifest.json'), signal);
  validateObservationPrecomputeManifest(manifest);
  if (manifest.packageVersion === 3) {
    return readViewingWindow(absolutePackageDir, manifest, {
      fromMs, toMs, playheadMs, maxItems, maxDialogueItems, maxAudioItems,
      tracks: selectedTracks, gateAudioAtEnd, signal
    });
  }
  // Existing packages remain readable until their conversion policy is chosen.
  if (visualStatusOf(manifest) !== 'ready') {
    throw new Error('Visual observation track is not ready.');
  }

  const revealThroughMs = Math.min(manifest.durationMs, playheadMs + lookaheadMs);
  const effectiveFromMs = Math.min(fromMs, manifest.durationMs);
  const effectiveToMs = Math.min(toMs, revealThroughMs, manifest.durationMs);

  const inspectStartAudio = selectedTracks.has('audio') && effectiveFromMs === 0 && playheadMs === 0;
  if (effectiveToMs <= effectiveFromMs && !inspectStartAudio) {
    return emptyWindow(manifest, fromMs, toMs, effectiveFromMs, revealThroughMs);
  }

  const visualCandidates = [];
  const dialogueById = new Map();
  const audioById = new Map();
  for (const [index, chunk] of manifest.chunks.entries()) {
    if (chunk.status !== 'complete') continue;
    const previousAudioChunk = gateAudioAtEnd && selectedTracks.has('audio') && chunk.logicalEndMs <= effectiveFromMs
      && manifest.chunks[index + 1]?.logicalEndMs > effectiveFromMs;
    if ((!previousAudioChunk && chunk.logicalEndMs <= effectiveFromMs) || chunk.logicalStartMs > effectiveToMs) continue;

    const visualRef = chunk.visualRef || chunk.resultRef;
    signal?.throwIfAborted();
    if (!previousAudioChunk && selectedTracks.has('visual') && visualRef) {
      const payload = await readJson(join(absolutePackageDir, visualRef), signal);
      for (const observation of payload.observations || []) {
        if (observation.fromMs >= effectiveToMs || observation.toMs <= effectiveFromMs) continue;
        visualCandidates.push(publicObservation(chunk, observation));
      }
    }

    if (!previousAudioChunk && selectedTracks.has('dialogue') && chunk.dialogueRef) {
      const dialoguePayload = await readJson(join(absolutePackageDir, chunk.dialogueRef), signal);
      for (const cue of dialoguePayload.cues || []) {
        if (cue.fromMs >= effectiveToMs || cue.toMs <= effectiveFromMs) continue;
        dialogueById.set(cue.cueId || `${cue.fromMs}:${cue.toMs}:${cue.text}`, {
          ...cue,
          sourceChunkId: chunk.chunkId
        });
      }
    }
    if (selectedTracks.has('audio') && chunk.audioRef && chunk.audioStatus === 'ready') {
      const audioPayload = validateAudioPayload(await readJson(join(absolutePackageDir, chunk.audioRef), signal), chunk);
      for (const description of audioPayload.descriptions) {
        // The complete prepared description becomes available at its start, including time zero.
        // Its end can be ahead of playback; images and dialogue keep their own gates.
        const availableAtMs = gateAudioAtEnd ? description.toMs : description.availableAtMs;
        if ((availableAtMs <= effectiveFromMs
              && !(availableAtMs === 0 && effectiveFromMs === 0))
            || availableAtMs > Math.min(effectiveToMs, playheadMs)) continue;
        audioById.set(description.id, { ...description, availableAtMs, sourceChunkId: chunk.chunkId });
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
  // Full caption end times must not move the cursor beyond the actual read/playback range.
  if (manifest.audioTrack && selectedTracks.has('audio')) nextCursorMs = Math.min(effectiveToMs, playheadMs);
  if (audioHasMore) nextCursorMs = Math.min(nextCursorMs, audioCandidates[maxAudioItems].availableAtMs - 1);

  signal?.throwIfAborted();
  return {
    planId: manifest.planId,
    packageVersion: manifest.packageVersion || 1,
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
