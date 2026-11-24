import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  readSubtitleBundle
} from '../media/media-subtitles.mjs';

import { skipRangeAt } from '../media/skip-ranges.mjs';

const TIMESTAMP_PATTERN = /^(?:(\d{1,}):)?(\d{2}):(\d{2})[.,](\d{3})$/;

function parseTimestamp(value) {
  const match = TIMESTAMP_PATTERN.exec(String(value || '').trim());
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  return (((hours * 60) + minutes) * 60 + seconds) * 1000 + milliseconds;
}

function plainCueText(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n+/g, ' ')
    .replace(/[\t ]+/g, ' ')
    .trim();
}

export function parseWebVttDialogue(text) {
  const normalized = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  const cues = [];

  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const match = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[timingIndex].trim());
    if (!match) continue;
    const fromMs = parseTimestamp(match[1]);
    const toMs = parseTimestamp(match[2]);
    const cueText = plainCueText(lines.slice(timingIndex + 1).join('\n'));
    if (fromMs === null || toMs === null || toMs <= fromMs || !cueText) continue;
    const cueId = createHash('sha256')
      .update(`${fromMs}\n${toMs}\n${cueText}`)
      .digest('hex')
      .slice(0, 20);
    cues.push({ cueId, fromMs, toMs, text: cueText });
  }

  cues.sort((left, right) => left.fromMs - right.fromMs || left.toMs - right.toMs);
  return cues;
}

function isEnglish(track) {
  return /^(eng|en)(-|$)/i.test(track.language || '');
}

export function chooseDialogueSubtitleTrack(tracks, preferredTrackId = null) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  if (preferredTrackId) {
    const preferred = tracks.find((track) => track.id === preferredTrackId);
    if (preferred) return preferred;
  }
  return tracks.find(isEnglish)
    || tracks.find((track) => track.default)
    || tracks[0];
}

export async function prepareDialogueSource(mediaPath, {
  preferredTrackId = null
} = {}) {
  const tracks = await readSubtitleBundle(mediaPath);
  const track = chooseDialogueSubtitleTrack(tracks, preferredTrackId);
  if (!track) {
    return {
      status: 'source_missing',
      sourceMode: 'none',
      track: null,
      cues: [],
      note: 'No timed text subtitle is available. Import a subtitle or an external ASR result for full dialogue support.'
    };
  }

  const cues = parseWebVttDialogue(await readFile(track.absolutePath, 'utf8'));
  if (cues.length === 0) {
    return {
      status: 'source_missing',
      sourceMode: 'subtitle_bundle',
      track,
      cues: [],
      note: 'The selected subtitle track contains no readable timed cues.'
    };
  }

  return {
    status: 'source_detected',
    sourceMode: 'subtitle_bundle',
    track,
    cues,
    note: `Using ${track.label || track.title || track.language || 'subtitle'} as the dialogue source.`
  };
}

export function filterDialogueSource(source, skipRanges) {
  if (!source?.cues?.length || !skipRanges.length) return source;
  return { ...source, cues: source.cues.filter(cue => !skipRangeAt(skipRanges, cue.fromMs)) };
}

export function dialogueTrackState(source, visualStatus = 'pending') {
  if (!source || source.status === 'source_missing') {
    return {
      status: 'source_missing',
      sourceMode: source?.sourceMode || 'none',
      sourceTrack: source?.track ? publicTrack(source.track) : null,
      cueCount: 0,
      resultKind: 'chunked_dialogue_track',
      note: source?.note || 'No dialogue source is available.'
    };
  }

  return {
    status: visualStatus === 'ready' ? 'ready' : 'running',
    sourceMode: source.sourceMode,
    sourceTrack: publicTrack(source.track),
    cueCount: source.cues.length,
    resultKind: 'chunked_dialogue_track',
    note: source.note
  };
}

function publicTrack(track) {
  return {
    id: track.id,
    language: track.language || 'und',
    title: track.title || null,
    label: track.label || null,
    default: Boolean(track.default),
    format: track.format || 'webvtt'
  };
}

export function dialogueChunkPayload(source, chunk, metadata = {}) {
  const cues = (source?.cues || [])
    .filter((cue) => metadata.ownership === 'start'
      ? cue.fromMs >= chunk.acceptFromMs && cue.fromMs < chunk.acceptToMs
      : cue.toMs > chunk.acceptFromMs && cue.fromMs < chunk.acceptToMs)
    .map((cue) => ({
      ...cue,
      owned: cue.fromMs >= chunk.acceptFromMs && cue.fromMs < chunk.acceptToMs
    }));

  return {
    packageVersion: metadata.packageVersion || 1,
    planId: metadata.planId || null,
    chunkId: chunk.chunkId,
    chunkIndex: chunk.index,
    ownershipRange: {
      fromMs: chunk.acceptFromMs,
      toMs: chunk.acceptToMs
    },
    status: source?.status === 'source_detected' ? 'ready' : 'source_missing',
    sourceMode: source?.sourceMode || 'none',
    sourceTrack: source?.track ? publicTrack(source.track) : null,
    cues
  };
}
