import { createHash } from 'node:crypto';
import { skipRangeAt } from '../media/skip-ranges.mjs';

export const VIEWING_PACKAGE_VERSION = 1;
export const VIEWING_CHUNK_KIND = 'open-watch-cinema-viewing-chunk';

const ENTRY_ORDER = { dialogue: 0, image: 1, motion: 2, sound: 3 };
const DIRECTIONS = {
  right: '向右', left: '向左', up: '向上', down: '向下',
  'up-right': '向右上方', 'up-left': '向左上方',
  'down-right': '向右下方', 'down-left': '向左下方'
};

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}

function itemId(type, sourceId, parts) {
  const identity = sourceId || createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
  return `${type}:${identity}`;
}

export function packageAssetRef(rootRef, filename) {
  const name = String(filename || '').replaceAll('\\', '/');
  const root = String(rootRef || '').replaceAll('\\', '/').replace(/\/$/, '');
  if (!name || !root || /^[A-Za-z]:|^\//.test(name) || /^[A-Za-z]:|^\//.test(root)
      || name.split('/').some((part) => !part || part === '.' || part === '..')
      || root.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new TypeError('Viewing image references must be relative to their package.');
  }
  return `${root}/${name}`;
}

function imagePanel(panel, rootRef) {
  const { filename, ...metadata } = panel;
  return filename ? { ...metadata, ref: packageAssetRef(rootRef, filename) } : metadata;
}

export function imageEntry(frame, rootRef) {
  const atMs = frame.mediaTimeMs;
  const storyboardRef = packageAssetRef(rootRef, frame.filename);
  const panelTimesMs = frame.panelTimesMs || [atMs];
  if (!Number.isSafeInteger(atMs) || atMs < 0 || !Array.isArray(panelTimesMs)
      || panelTimesMs.length < 1 || panelTimesMs.length > 3
      || panelTimesMs.some((time) => !Number.isSafeInteger(time) || time < 0 || time > atMs)) {
    throw new Error('Viewing image panel times must not exceed the inspection time.');
  }
  return {
    id: itemId('image', null, [atMs, storyboardRef]),
    type: 'image', fromMs: atMs, toMs: atMs, availableAtMs: atMs,
    storyboardRef, panelTimesMs,
    frameReason: frame.frameReason || 'visual_event',
    ...(frame.image ? { image: { ...frame.image } } : {}),
    ...(frame.parts ? { parts: frame.parts.map((part) => imagePanel(part, rootRef)) } : {}),
    ...(frame.panels ? { panels: frame.panels.map((panel) => imagePanel(panel, rootRef)) } : {}),
    ...(frame.perceptualHash ? { perceptualHash: frame.perceptualHash } : {}),
    ...(frame.averageRgb ? { averageRgb: frame.averageRgb } : {})
  };
}

function motionEntry(observation) {
  const kind = observation.kind;
  let text;
  if (kind === 'scene_change') text = '画面出现明显切换。';
  else if (kind === 'motion_peak' || Number(observation.motionScore) >= 0.45) {
    const direction = DIRECTIONS[observation.metrics?.motionDirection];
    text = direction ? `画面出现明显运动，主要方向${direction}。` : '画面出现明显运动。';
  } else return null;
  const direction = observation.metrics?.motionDirection || null;
  return {
    id: itemId('motion', null, [observation.fromMs, observation.toMs, kind, direction]),
    type: 'motion', fromMs: observation.fromMs, toMs: observation.toMs,
    availableAtMs: observation.fromMs, text, kind, direction
  };
}

export function orderEntries(left, right) {
  // Equal-time image groups retain the order in which they were composed.
  return left.fromMs - right.fromMs || ENTRY_ORDER[left.type] - ENTRY_ORDER[right.type]
    || left.toMs - right.toMs || (left.type === 'image' ? 0 : left.id.localeCompare(right.id));
}

function sectionEntries(segments, entries, intervalMs, range) {
  const byStart = new Map(segments.map((segment) => [segment.fromMs, segment]));
  const ids = new Set();
  for (const entry of entries) {
    if (entry.fromMs < range.fromMs || entry.fromMs >= range.toMs || ids.has(entry.id)) continue;
    const start = Math.floor(entry.fromMs / intervalMs) * intervalMs;
    const segment = byStart.get(start);
    if (!segment) throw new Error('Viewing entry does not belong to a planned section.');
    segment.entries.push(entry);
    ids.add(entry.id);
  }
  for (const segment of segments) segment.entries.sort(orderEntries);
  return segments;
}

export function createViewingChunk({
  planId, chunk, intervalMs, analysis, dialogue, storyboardRootRef
}) {
  positiveInteger(intervalMs, 'intervalMs');
  const range = { fromMs: chunk.acceptFromMs, toMs: chunk.acceptToMs };
  if (range.fromMs % intervalMs !== 0) throw new Error('Viewing chunk starts between fixed sections.');
  const segments = [];
  for (let fromMs = range.fromMs; fromMs < range.toMs; fromMs += intervalMs) {
    segments.push({
      id: `section-${fromMs}`, fromMs,
      toMs: Math.min(fromMs + intervalMs, range.toMs), entries: []
    });
  }
  const entries = [
    ...(dialogue.cues || []).map((cue) => ({
      id: itemId('dialogue', cue.cueId, [cue.fromMs, cue.toMs, cue.text, cue.speaker || null]),
      type: 'dialogue', fromMs: cue.fromMs, toMs: cue.toMs,
      availableAtMs: cue.fromMs, text: cue.text,
      ...(cue.speaker ? { speaker: cue.speaker } : {})
    })),
    ...(analysis.frames || []).filter(frame => frame.filename).map((frame) => imageEntry(frame, storyboardRootRef)),
    ...(analysis.observations || []).map(motionEntry).filter(Boolean)
  ];
  return {
    version: VIEWING_PACKAGE_VERSION, kind: VIEWING_CHUNK_KIND,
    planId, chunkId: chunk.chunkId, intervalMs, range,
    ...(analysis.frames?.some(frame => !frame.filename) ? {
      omittedGroups: analysis.frames.filter(frame => !frame.filename)
        .map(({ groupFilename, mediaTimeMs, panelTimesMs, frameReason }) =>
          ({ ...(groupFilename ? { filename: groupFilename } : {}), mediaTimeMs, panelTimesMs, frameReason }))
    } : {}),
    tracks: {
      visual: {
        status: 'ready', engine: analysis.engine,
        protocolVersion: analysis.protocolVersion,
        sampleFps: analysis.sampleFps,
        ...(analysis.visualAssetProfile ? { assetProfile: analysis.visualAssetProfile } : {}),
        ...(analysis.sourceVideo ? { sourceVideo: analysis.sourceVideo } : {}),
        observationCount: (analysis.observations || []).length,
        storyboardCount: (analysis.frames || []).filter(frame => frame.filename).length
      },
      dialogue: {
        status: dialogue.status, sourceMode: dialogue.sourceMode,
        sourceTrack: dialogue.sourceTrack || null,
        cueCount: entries.filter((entry) => entry.type === 'dialogue'
          && entry.fromMs >= range.fromMs && entry.fromMs < range.toMs).length
      },
      audio: { status: 'not_prepared', descriptionCount: 0 }
    },
    segments: sectionEntries(segments, entries, intervalMs, range)
  };
}

export function appendViewingAudio(payload, audio, audioProfile) {
  const segments = payload.segments.map((segment) => ({ ...segment, entries: [] }));
  const entries = payload.segments.flatMap((segment) => segment.entries.filter((entry) => entry.type !== 'sound'));
  for (const sound of audio.descriptions) {
    entries.push({
      id: itemId('sound', sound.id, [sound.fromMs, sound.toMs, sound.text]),
      sourceId: sound.id,
      type: 'sound', fromMs: sound.fromMs, toMs: sound.toMs,
      // A prepared caption is released at its start while retaining its full sound range.
      availableAtMs: sound.fromMs,
      text: sound.text, source: sound.source
    });
  }
  const { descriptions, ...metadata } = audio;
  return {
    ...payload,
    tracks: {
      ...payload.tracks,
      audio: { ...metadata, profile: audioProfile, descriptionCount: descriptions.length }
    },
    segments: sectionEntries(segments, entries, payload.intervalMs, payload.range)
  };
}

export function viewingAudioPayload(payload) {
  const { profile: _profile, descriptionCount: _count, ...metadata } = payload.tracks.audio;
  return {
    ...metadata,
    descriptions: payload.segments.flatMap((segment) => segment.entries)
      .filter((entry) => entry.type === 'sound')
      .map((entry) => ({
        id: entry.sourceId, fromMs: entry.fromMs, toMs: entry.toMs,
        availableAtMs: entry.fromMs, text: entry.text, source: entry.source
      }))
  };
}

export function validateViewingChunk(payload, manifest, chunk) {
  if (!payload || payload.version !== VIEWING_PACKAGE_VERSION || payload.kind !== VIEWING_CHUNK_KIND
      || payload.planId !== manifest.planId || payload.chunkId !== chunk.chunkId
      || payload.intervalMs !== manifest.viewingIntervalMs
      || payload.range?.fromMs !== chunk.acceptFromMs || payload.range?.toMs !== chunk.acceptToMs
      || payload.tracks?.visual?.status !== 'ready' || !Array.isArray(payload.segments)) {
    throw new Error('Viewing chunk does not match its preparation plan.');
  }
  let nextStart = chunk.acceptFromMs;
  const ids = new Set();
  const skipRanges = manifest.skipRanges ?? [];
  for (const segment of payload.segments) {
    if (segment.id !== `section-${nextStart}` || segment.fromMs !== nextStart
        || segment.toMs !== Math.min(nextStart + payload.intervalMs, chunk.acceptToMs)
        || !Array.isArray(segment.entries)) throw new Error('Invalid viewing section range.');
    let previous = null;
    for (const entry of segment.entries) {
      if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)
          || !Object.hasOwn(ENTRY_ORDER, entry.type)
          || !Number.isSafeInteger(entry.fromMs) || !Number.isSafeInteger(entry.toMs)
          || entry.toMs < entry.fromMs || entry.fromMs < segment.fromMs || entry.fromMs >= segment.toMs
          || !Number.isSafeInteger(entry.availableAtMs) || entry.availableAtMs < entry.fromMs
          || (previous && orderEntries(previous, entry) > 0)) {
        throw new Error('Invalid or duplicate viewing entry.');
      }
      if (entry.type === 'image') {
        if (typeof entry.storyboardRef !== 'string' || !entry.storyboardRef
            || !Array.isArray(entry.panelTimesMs) || entry.panelTimesMs.length < 1 || entry.panelTimesMs.length > 3
            || entry.panelTimesMs.some((time) => !Number.isSafeInteger(time) || time > entry.availableAtMs || time < 0
              || skipRangeAt(skipRanges, time))) {
          throw new Error('Invalid viewing image reference or timing.');
        }
        if (entry.parts !== undefined && (!Array.isArray(entry.parts) || !entry.parts.length
            || entry.parts[0].ref !== entry.storyboardRef
            || new Set(entry.parts.map(part => part.ref)).size !== entry.parts.length
            || entry.parts.some(part => typeof part.ref !== 'string' || !part.ref
              || !Number.isSafeInteger(part.mediaTimeMs) || part.mediaTimeMs < 0 || part.mediaTimeMs > entry.availableAtMs
              || skipRangeAt(skipRanges, part.mediaTimeMs)))) {
          throw new Error('Invalid storyboard group parts or release time.');
        }
      } else if (typeof entry.text !== 'string' || !entry.text.trim()) {
        throw new Error('Viewing text entries need their complete text.');
      }
      if (skipRangeAt(skipRanges, entry.fromMs) || (['motion', 'sound'].includes(entry.type)
          && skipRanges.some(range => entry.fromMs < range.toMs && range.fromMs < entry.toMs))) {
        throw new Error('Viewing entries overlap a skipped range.');
      }
      ids.add(entry.id);
      previous = entry;
    }
    nextStart = segment.toMs;
  }
  if (nextStart !== chunk.acceptToMs) throw new Error('Viewing sections do not cover their batch.');
  return payload;
}

export function viewingPreparationState(manifest, {
  initialBufferMs = manifest.viewingTrack?.initialBufferMs ?? null,
  audioRequested = manifest.viewingTrack?.audioRequested ?? false
} = {}) {
  if (initialBufferMs !== null) positiveInteger(initialBufferMs, 'initialBufferMs');
  const through = (accept) => {
    let position = 0;
    for (const chunk of manifest.chunks) {
      if (chunk.logicalStartMs !== position || !accept(chunk)) break;
      position = chunk.logicalEndMs;
    }
    return position;
  };
  const visualPreparedThroughMs = through((chunk) => chunk.status === 'complete' && Boolean(chunk.viewingRef));
  const audioPreparedThroughMs = audioRequested
    ? through((chunk) => chunk.status === 'complete' && Boolean(chunk.viewingRef)
      && ['ready', 'source_missing'].includes(chunk.audioStatus))
    : null;
  const preparedThroughMs = audioRequested
    ? Math.min(visualPreparedThroughMs, audioPreparedThroughMs)
    : visualPreparedThroughMs;
  return {
    version: VIEWING_PACKAGE_VERSION, intervalMs: manifest.viewingIntervalMs,
    status: preparedThroughMs === manifest.durationMs ? 'ready' : preparedThroughMs > 0 ? 'partial' : 'pending',
    visualPreparedThroughMs, audioPreparedThroughMs, preparedThroughMs,
    audioRequested, initialBufferMs,
    initialBufferReady: initialBufferMs === null ? null
      : preparedThroughMs >= Math.min(initialBufferMs, manifest.durationMs)
  };
}
