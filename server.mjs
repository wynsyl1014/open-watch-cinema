import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addSessionMessage,
  addSessionObservations,
  deleteMediaCascadeRecords,
  endSession,
  getMediaCascadeSummary,
  getActiveSession,
  getSession,
  listIndexedMedia,
  listSessionMessages,
  listSessionObservations,
  listSessions,
  openDatabase,
  openSession,
  setMediaCompatibility,
  syncMediaIndex,
  updateSessionPlayback
} from './src/database.mjs';
import { buildCinemaTick, cinemaTickRange } from './src/cinema-tick.mjs';
import { parseSingleRange } from './src/http-range.mjs';
import {
  prepareMediaPlayback,
  probeMedia
} from './src/media-compatibility.mjs';
import { scanMediaDirectory } from './src/media-library.mjs';
import { extractSubtitleStreams, subtitleBundleDirectory } from './src/media-subtitles.mjs';
import {
  analyzeObservationSegment,
  getObserverStatus
} from './src/observation-manager.mjs';
import { runObservationPrecompute } from './src/observation-precompute-runner.mjs';
import { readObservationTrackWindow } from './src/observation-track-reader.mjs';
import { readSpoilerGatedStoryboardFrame } from './src/storyboard-frame.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(ROOT, 'public');
const LOCAL_DATA_ROOT = resolve(process.env.LOCAL_DATA_ROOT || resolve(ROOT, 'local-data'));
const MEDIA_ROOT = resolve(LOCAL_DATA_ROOT, 'media');
const AI_PACKAGES_ROOT = resolve(LOCAL_DATA_ROOT, 'ai-packages');
const DATABASE_PATH = resolve(LOCAL_DATA_ROOT, 'open-watch-cinema.sqlite');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4182);
const JSON_BODY_LIMIT = 64 * 1024;

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/playback-sync.js', ['playback-sync.js', 'text/javascript; charset=utf-8']],
  ['/subtitle-utils.js', ['subtitle-utils.js', 'text/javascript; charset=utf-8']]
]);

const MEDIA_TYPES = new Map([
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
  ['.mkv', 'video/x-matroska']
]);

await Promise.all([
  mkdir(MEDIA_ROOT, { recursive: true }),
  mkdir(AI_PACKAGES_ROOT, { recursive: true })
]);
const database = openDatabase(DATABASE_PATH);
let mediaById = new Map();
const compatibilityJobs = new Map();
const aiPreparationJobs = new Map();

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  });
  response.end(payload);
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store'
  });
  response.end(text);
}

async function readJsonBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > JSON_BODY_LIMIT) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

function readIntegerValue(value, label, fallback, {
  min = 0,
  max = Number.MAX_SAFE_INTEGER
} = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return number;
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function publicMediaItem(item) {
  const source = mediaById.get(item.id);
  const subtitleTracks = (source?.subtitleTracks || []).map((track) => ({
    id: track.id,
    streamIndex: track.streamIndex,
    sourceCodec: track.sourceCodec,
    language: track.language,
    title: track.title,
    label: track.label,
    default: track.default,
    forced: track.forced,
    hearingImpaired: track.hearingImpaired,
    format: track.format,
    url: `/api/media/${item.id}/subtitles/${encodeURIComponent(track.id)}`
  }));
  return {
    ...item,
    streamUrl: `/api/media/${item.id}/stream`,
    subtitleTracks,
    aiPackage: source?.aiPackage || null
  };
}

function listPublicMedia() {
  return listIndexedMedia(database).map(publicMediaItem);
}

function publicSession(session) {
  if (!session) return null;
  return {
    ...session,
    writable: session.status === 'active',
    aiAvailable: session.status === 'active',
    frameProcessingAvailable: session.status === 'active'
  };
}

async function rescanMedia() {
  const items = await scanMediaDirectory(MEDIA_ROOT, { aiPackagesRoot: AI_PACKAGES_ROOT });
  syncMediaIndex(database, items);
  mediaById = new Map(items.map((item) => [item.id, item]));
  return listPublicMedia();
}

async function serveStatic(pathname, response) {
  const entry = STATIC_FILES.get(pathname);
  if (!entry) return false;
  const [relativePath, contentType] = entry;
  const content = await readFile(resolve(PUBLIC_ROOT, relativePath));
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': content.byteLength,
    'cache-control': 'no-cache'
  });
  response.end(content);
  return true;
}

function activeJobForMedia(mediaId) {
  return [...compatibilityJobs.values()].find((job) => (
    job.mediaId === mediaId && ['checking', 'processing'].includes(job.status)
  ));
}

function activeAiJobForMedia(mediaId) {
  return [...aiPreparationJobs.values()].find((job) => (
    job.mediaId === mediaId && ['queued', 'processing'].includes(job.status)
  ));
}

function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind || 'compatibility',
    mediaId: job.mediaId,
    repairMode: job.repairMode || null,
    replacementMediaId: job.replacementMediaId || null,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    changed: job.changed ?? null,
    subtitleTrackCount: job.subtitleTrackCount ?? null,
    experienceMode: job.experienceMode || null,
    message: job.message || null,
    error: job.error || null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null
  };
}

function codecDetails(probe) {
  return {
    containerName: probe.formatName || null,
    videoCodec: probe.video?.codec_name || null,
    audioCodec: probe.audio?.codec_name || null
  };
}


function startCompatibilityJob(item, { repairMode = 'safe' } = {}) {
  const existing = activeJobForMedia(item.id);
  if (existing) return existing;

  const job = {
    id: randomUUID(),
    kind: 'compatibility',
    mediaId: item.id,
    repairMode,
    status: 'checking',
    stage: 'Planning minimal repair',
    progress: 0,
    startedAt: new Date().toISOString()
  };
  compatibilityJobs.set(job.id, job);
  setMediaCompatibility(database, item.id, {
    status: 'checking',
    note: `Inspecting the file before ${repairMode} playback repair.`
  });

  void (async () => {
    try {
      const probe = await probeMedia(item.absolutePath);
      const details = codecDetails(probe);
      setMediaCompatibility(database, item.id, {
        status: 'processing',
        ...details,
        note: `Applying ${repairMode} playback repair.`
      });
      job.status = 'processing';
      job.stage = repairMode === 'audio'
        ? 'Repairing audio only'
        : repairMode === 'video'
          ? 'Repairing video only'
          : repairMode === 'remux'
            ? 'Rewrapping streams without re-encoding'
            : 'Preparing safest fallback';

      const result = await prepareMediaPlayback(item.absolutePath, {
        repairMode,
        onProgress({ percent }) {
          job.progress = percent;
        }
      });

      await rescanMedia();
      const outputItem = [...mediaById.values()].find((candidate) => candidate.absolutePath === result.outputPath);
      if (!outputItem) throw new Error('Prepared media was not found after the library rescan.');

      setMediaCompatibility(database, outputItem.id, {
        status: 'prepared',
        ...codecDetails(result.probe),
        note: result.repairPlan.note,
        processedAt: new Date().toISOString()
      });

      job.status = 'done';
      job.stage = 'Retest playback';
      job.progress = 100;
      job.changed = result.changed;
      job.replacementMediaId = outputItem.id;
      job.subtitleTrackCount = result.subtitleTracks?.length || 0;
      job.message = `${result.repairPlan.note} Test picture and sound in this browser, then press Mark Ready if both are good.${job.subtitleTrackCount > 0 ? ` ${job.subtitleTrackCount} subtitle track(s) were preserved.` : ''}`;
      job.finishedAt = new Date().toISOString();
    } catch (error) {
      console.error('Compatibility preparation failed:', error);
      setMediaCompatibility(database, item.id, {
        status: 'error',
        note: 'Playback repair failed.',
        error: error.message
      });
      job.status = 'error';
      job.stage = 'Failed';
      job.error = error.message;
      job.finishedAt = new Date().toISOString();
    }
  })();

  return job;
}

function startAiPreparationJob(item, { preferredDialogueTrackId = null } = {}) {
  const existing = activeAiJobForMedia(item.id);
  if (existing) return existing;

  const job = {
    id: randomUUID(),
    kind: 'ai-package',
    mediaId: item.id,
    status: 'queued',
    stage: 'Preparing AI package',
    progress: 0,
    startedAt: new Date().toISOString()
  };
  aiPreparationJobs.set(job.id, job);

  void (async () => {
    try {
      job.status = 'processing';
      job.stage = 'Analyzing visual and dialogue tracks';
      const result = await runObservationPrecompute(ROOT, {
        inputPath: item.absolutePath,
        outputRoot: AI_PACKAGES_ROOT,
        packageKey: item.id,
        replaceMismatchedPackage: true,
        sourceMediaId: item.id,
        sourceRelativePath: item.relativePath,
        preferredDialogueTrackId,
        onChunkComplete({ progress, chunk }) {
          job.progress = progress.percent;
          job.stage = `Prepared ${chunk.chunkId}`;
        }
      });
      await rescanMedia();
      job.status = 'done';
      job.stage = 'AI package ready';
      job.progress = 100;
      job.experienceMode = result.manifest.aiReadiness?.experienceMode || 'complete';
      job.message = job.experienceMode === 'visual_only'
        ? 'Visual analysis is ready. No timed dialogue source was found, so AI viewing will continue in visual-only mode.'
        : 'Visual and dialogue tracks are ready on the same chunk timeline.';
      job.finishedAt = new Date().toISOString();
    } catch (error) {
      console.error('AI package preparation failed:', error);
      job.status = 'error';
      job.stage = 'AI preparation failed';
      job.error = error.message;
      job.finishedAt = new Date().toISOString();
    }
  })();

  return job;
}

async function pathStatus(filePath) {
  try {
    const fileStat = await stat(filePath);
    return {
      exists: true,
      kind: fileStat.isDirectory() ? 'directory' : 'file',
      bytes: fileStat.isFile() ? fileStat.size : null
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, kind: null, bytes: null };
    throw error;
  }
}

async function mediaDeletePreview(item) {
  const subtitlePath = subtitleBundleDirectory(item.absolutePath);
  const aiPackagePath = resolve(AI_PACKAGES_ROOT, item.id);
  return {
    mediaId: item.id,
    title: item.title,
    policy: {
      deleteMediaFile: true,
      deleteSubtitleBundle: true,
      deleteAiPackage: true,
      deleteWatchHistory: true
    },
    mediaFile: await pathStatus(item.absolutePath),
    subtitleBundle: await pathStatus(subtitlePath),
    aiPackage: await pathStatus(aiPackagePath),
    records: getMediaCascadeSummary(database, item.id)
  };
}

async function deleteMediaCascade(item) {
  if (activeJobForMedia(item.id) || activeAiJobForMedia(item.id)) {
    throw new Error('Wait for active preparation jobs to finish before deleting this film.');
  }
  const preview = await mediaDeletePreview(item);
  if (preview.records.activeSessionCount > 0) {
    throw new Error('End the active room before deleting this film.');
  }

  const subtitlePath = subtitleBundleDirectory(item.absolutePath);
  const aiPackagePath = resolve(AI_PACKAGES_ROOT, item.id);
  await rm(aiPackagePath, { recursive: true, force: true });
  await rm(subtitlePath, { recursive: true, force: true });
  await rm(item.absolutePath, { force: true });
  const records = deleteMediaCascadeRecords(database, item.id, {
    deleteSessions: true,
    deleteMediaIndex: true
  });
  await rescanMedia();
  return { preview, records };
}

async function streamMedia(request, response, item) {
  if (activeJobForMedia(item.id)) {
    sendText(response, 409, 'This film is being prepared. Wait for the preparation to finish.');
    return;
  }

  const fileStat = await stat(item.absolutePath);
  const size = fileStat.size;
  const rangeHeader = request.headers.range;
  const contentType = MEDIA_TYPES.get(extname(item.absolutePath).toLowerCase()) || 'application/octet-stream';

  if (rangeHeader) {
    const range = parseSingleRange(rangeHeader, size);
    if (!range) {
      response.writeHead(416, { 'content-range': `bytes */${size}` });
      response.end();
      return;
    }

    response.writeHead(206, {
      'accept-ranges': 'bytes',
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
      'content-length': range.length,
      'content-type': contentType,
      'cache-control': 'private, no-store'
    });

    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    createReadStream(item.absolutePath, { start: range.start, end: range.end }).pipe(response);
    return;
  }

  response.writeHead(200, {
    'accept-ranges': 'bytes',
    'content-length': size,
    'content-type': contentType,
    'cache-control': 'private, no-store'
  });

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  createReadStream(item.absolutePath).pipe(response);
}

async function serveSubtitle(response, item, subtitleId) {
  const track = (item.subtitleTracks || []).find((candidate) => candidate.id === subtitleId);
  if (!track) {
    sendText(response, 404, 'Subtitle track not found.');
    return;
  }

  const content = await readFile(track.absolutePath);
  response.writeHead(200, {
    'content-type': 'text/vtt; charset=utf-8',
    'content-length': content.byteLength,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(content);
}

function openBrowser(url) {
  if (process.env.OPEN_BROWSER === '0') return;

  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'cmd.exe';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.on('error', () => {
    // The server remains usable when no desktop opener is installed.
  });
  child.unref();
}

await rescanMedia();

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${HOST}:${PORT}`);
    const pathname = url.pathname;

    if (request.method === 'GET' && pathname === '/api/health') {
      const activeSession = getActiveSession(database);
      sendJson(response, 200, {
        ok: true,
        apiVersion: '0.5.0',
        capabilities: ['ai-package-v1', 'ai-window-v1', 'ai-tick-v1', 'ai-frame-v1', 'cascade-delete-v1'],
        mediaCount: mediaById.size,
        mediaFolder: 'local-data/media',
        activePreparationCount: [...compatibilityJobs.values()].filter((job) => ['checking', 'processing'].includes(job.status)).length,
        activeAiPreparationCount: [...aiPreparationJobs.values()].filter((job) => ['queued', 'processing'].includes(job.status)).length,
        roomOpen: Boolean(activeSession),
        activeRoomId: activeSession?.id || null
      });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/observer/status') {
      sendJson(response, 200, { observer: await getObserverStatus(ROOT) });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/media') {
      sendJson(response, 200, { items: listPublicMedia() });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/media/rescan') {
      const items = await rescanMedia();
      sendJson(response, 200, { items });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/rooms') {
      sendJson(response, 200, {
        activeRoom: publicSession(getActiveSession(database)),
        rooms: listSessions(database).map(publicSession)
      });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/rooms/open') {
      const body = await readJsonBody(request);
      const item = mediaById.get(String(body.mediaId || ''));
      if (!item) {
        sendJson(response, 404, { error: 'Select a film from the current library before opening a room.' });
        return;
      }
      if (activeJobForMedia(item.id)) {
        sendJson(response, 409, { error: 'Wait for playback preparation to finish before opening a room.' });
        return;
      }
      try {
        const room = openSession(database, { mediaId: item.id, mediaTitle: item.title });
        sendJson(response, 201, { room: publicSession(room) });
      } catch (error) {
        sendJson(response, 409, { error: error.message });
      }
      return;
    }

    const roomMatch = /^\/api\/rooms\/([a-f0-9-]{36})$/.exec(pathname);
    if (request.method === 'GET' && roomMatch) {
      const room = getSession(database, roomMatch[1]);
      if (!room) {
        sendJson(response, 404, { error: 'Room not found.' });
        return;
      }
      sendJson(response, 200, {
        room: publicSession(room),
        messages: listSessionMessages(database, room.id)
      });
      return;
    }

    const endRoomMatch = /^\/api\/rooms\/([a-f0-9-]{36})\/end$/.exec(pathname);
    if (request.method === 'POST' && endRoomMatch) {
      const body = await readJsonBody(request);
      try {
        const room = endSession(database, endRoomMatch[1], {
          lastPositionMs: Number(body.mediaTimeMs) || 0
        });
        sendJson(response, 200, { room: publicSession(room) });
      } catch (error) {
        sendJson(response, 404, { error: error.message });
      }
      return;
    }

    const playbackMatch = /^\/api\/rooms\/([a-f0-9-]{36})\/playback$/.exec(pathname);
    if (request.method === 'POST' && playbackMatch) {
      const body = await readJsonBody(request);
      try {
        const room = updateSessionPlayback(database, playbackMatch[1], {
          mediaTimeMs: Number(body.mediaTimeMs) || 0,
          playbackState: body.playbackState,
          seeked: body.seeked === true
        });
        sendJson(response, 200, { room: publicSession(room) });
      } catch (error) {
        sendJson(response, 409, { error: error.message });
      }
      return;
    }

    const messagesMatch = /^\/api\/rooms\/([a-f0-9-]{36})\/messages$/.exec(pathname);
    if (request.method === 'GET' && messagesMatch) {
      const room = getSession(database, messagesMatch[1]);
      if (!room) {
        sendJson(response, 404, { error: 'Room not found.' });
        return;
      }
      sendJson(response, 200, {
        room: publicSession(room),
        messages: listSessionMessages(database, room.id)
      });
      return;
    }

    if (request.method === 'POST' && messagesMatch) {
      const body = await readJsonBody(request);
      try {
        const message = addSessionMessage(database, messagesMatch[1], {
          senderName: body.senderName,
          senderKind: body.senderKind,
          content: body.content,
          mediaTimeMs: Number(body.mediaTimeMs) || 0
        });
        sendJson(response, 201, { message });
      } catch (error) {
        sendJson(response, 409, { error: error.message });
      }
      return;
    }

    const observationsMatch = /^\/api\/rooms\/([a-f0-9-]{36})\/observations$/.exec(pathname);
    if (request.method === 'GET' && observationsMatch) {
      const room = getSession(database, observationsMatch[1]);
      if (!room) {
        sendJson(response, 404, { error: 'Room not found.' });
        return;
      }
      const afterSequence = Number(url.searchParams.get('after') || 0);
      sendJson(response, 200, {
        room: publicSession(room),
        observations: listSessionObservations(database, room.id, { afterSequence })
      });
      return;
    }

    const aiTickMatch = /^\/api\/rooms\/([a-f0-9-]{36})\/ai-tick$/.exec(pathname);
    if (request.method === 'POST' && aiTickMatch) {
      const room = getSession(database, aiTickMatch[1]);
      if (!room) {
        sendJson(response, 404, { error: 'Room not found.' });
        return;
      }
      if (room.status !== 'active') {
        sendJson(response, 409, { error: 'Archived rooms do not produce live AI ticks.' });
        return;
      }
      const item = mediaById.get(room.mediaId);
      if (!item) {
        sendJson(response, 404, { error: 'The room film is no longer in the media folder.' });
        return;
      }
      if (!item.aiPackage || item.aiPackage.status !== 'ready') {
        sendJson(response, 409, {
          error: 'The AI package is not ready for this room.',
          aiPackage: item.aiPackage || null
        });
        return;
      }

      const body = await readJsonBody(request);
      const cursors = body.cursors === undefined
        ? {}
        : requirePlainObject(body.cursors, 'cursors');
      const limits = body.limits === undefined
        ? {}
        : requirePlainObject(body.limits, 'limits');
      let consumerName = null;
      if (body.consumerName !== undefined && body.consumerName !== null) {
        consumerName = String(body.consumerName).trim().slice(0, 60);
        if (!consumerName) throw new Error('consumerName must be a non-empty string.');
      }
      const playheadMs = Math.max(0, Math.round(Number(room.lastPositionMs) || 0));
      const initialWindowMs = readIntegerValue(
        limits.initialWindowMs,
        'limits.initialWindowMs',
        15_000,
        { min: 1_000, max: 60_000 }
      );
      const maxAdvanceMs = readIntegerValue(
        limits.maxAdvanceMs,
        'limits.maxAdvanceMs',
        20_000,
        { min: 1_000, max: 60_000 }
      );
      const maxMessages = readIntegerValue(
        limits.maxMessages,
        'limits.maxMessages',
        20,
        { min: 1, max: 100 }
      );
      const maxLiveObservations = readIntegerValue(
        limits.maxLiveObservations,
        'limits.maxLiveObservations',
        40,
        { min: 1, max: 200 }
      );
      const maxStoryboards = readIntegerValue(
        limits.maxStoryboards,
        'limits.maxStoryboards',
        5,
        { min: 1, max: 12 }
      );
      const maxMotionEvents = readIntegerValue(
        limits.maxMotionEvents,
        'limits.maxMotionEvents',
        8,
        { min: 1, max: 30 }
      );
      const messageId = readIntegerValue(cursors.messageId, 'cursors.messageId', 0);
      const observationSequence = readIntegerValue(
        cursors.observationSequence,
        'cursors.observationSequence',
        0
      );
      const suppliedMediaCursor = Object.hasOwn(cursors, 'mediaMs');
      const mediaCursorMs = suppliedMediaCursor
        ? readIntegerValue(cursors.mediaMs, 'cursors.mediaMs', 0)
        : undefined;
      const range = cinemaTickRange({
        playheadMs,
        mediaCursorMs,
        seekVersion: room.seekVersion,
        cursorSeekVersion: readIntegerValue(cursors.seekVersion, 'cursors.seekVersion', 0),
        initialWindowMs,
        maxAdvanceMs
      });
      const { fromMs } = range;
      let { toMs } = range;

      try {
        const messageRows = listSessionMessages(database, room.id, {
          afterId: messageId,
          limit: maxMessages + 1
        });
        const observationRows = listSessionObservations(database, room.id, {
          afterSequence: observationSequence,
          limit: maxLiveObservations + 1
        });
        let window;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          window = await readObservationTrackWindow(resolve(AI_PACKAGES_ROOT, item.id), {
            fromMs,
            toMs,
            playheadMs,
            lookaheadMs: 0,
            maxItems: 100,
            maxDialogueItems: 300
          });
          if (!window.hasMore && !window.dialogueHasMore) break;
          const spanMs = toMs - fromMs;
          if (spanMs <= 1) {
            throw new Error('The AI tick range is too dense to deliver without dropping material.');
          }
          toMs = fromMs + Math.max(1, Math.floor(spanMs / 2));
        }
        if (window.hasMore || window.dialogueHasMore) {
          throw new Error('The AI tick range could not be compacted without dropping material.');
        }
        const latestRoom = getSession(database, room.id);
        if (!latestRoom || latestRoom.status !== 'active' || latestRoom.seekVersion !== room.seekVersion
            || latestRoom.lastPositionMs < playheadMs) {
          throw new Error('Playback changed during this tick. Retry with the same cursors.');
        }
        const tick = buildCinemaTick({
          room,
          window,
          messages: messageRows.slice(0, maxMessages),
          consumerName,
          liveObservations: observationRows.slice(0, maxLiveObservations),
          inputCursors: { messageId, observationSequence },
          targetRange: { ...range, toMs },
          messageHasMore: messageRows.length > maxMessages,
          observationHasMore: observationRows.length > maxLiveObservations,
          limits: { maxStoryboards, maxMotionEvents }
        });
        sendJson(response, 200, { tick });
      } catch (error) {
        sendJson(response, 409, { error: error.message });
      }
      return;
    }

    const aiFrameMatch = /^\/api\/rooms\/([a-f0-9-]{36})\/ai-frame$/.exec(pathname);
    if (request.method === 'GET' && aiFrameMatch) {
      const room = getSession(database, aiFrameMatch[1]);
      if (!room) {
        sendJson(response, 404, { error: 'Room not found.' });
        return;
      }
      const item = mediaById.get(room.mediaId);
      if (!item) {
        sendJson(response, 404, { error: 'The room film is no longer in the media folder.' });
        return;
      }
      if (!item.aiPackage || item.aiPackage.status !== 'ready') {
        sendJson(response, 409, {
          error: 'The AI package is not ready for this room.',
          aiPackage: item.aiPackage || null
        });
        return;
      }

      const storyboardRef = url.searchParams.get('storyboardRef') || '';
      const rawMediaTimeMs = url.searchParams.get('mediaTimeMs');
      if (rawMediaTimeMs === null || rawMediaTimeMs === '') {
        throw new Error('mediaTimeMs is required.');
      }
      const mediaTimeMs = readIntegerValue(rawMediaTimeMs, 'mediaTimeMs', 0);
      try {
        const frame = await readSpoilerGatedStoryboardFrame(
          resolve(AI_PACKAGES_ROOT, item.id),
          {
            storyboardRef,
            mediaTimeMs,
            quality: url.searchParams.get('quality') || 'storyboard',
            inputPath: item.absolutePath,
            playheadMs: Math.max(0, Math.round(Number(room.lastPositionMs) || 0))
          }
        );
        const latestRoom = getSession(database, room.id);
        if (!latestRoom || latestRoom.seekVersion !== room.seekVersion
            || latestRoom.status !== room.status || latestRoom.lastPositionMs < room.lastPositionMs) {
          sendJson(response, 409, { error: 'Playback changed while reading the frame. Retry at the current playhead.' });
          return;
        }
        const metadataHeader = Buffer.from(JSON.stringify(frame.metadata), 'utf8').toString('base64url');
        response.writeHead(200, {
          'content-type': frame.mimeType,
          'content-length': frame.content.byteLength,
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
          'x-open-watch-frame-metadata': metadataHeader
        });
        response.end(frame.content);
      } catch (error) {
        sendJson(response, 409, { error: error.message });
      }
      return;
    }

    const aiWindowMatch = /^\/api\/rooms\/([a-f0-9-]{36})\/ai-window$/.exec(pathname);
    if (request.method === 'GET' && aiWindowMatch) {
      const room = getSession(database, aiWindowMatch[1]);
      if (!room) {
        sendJson(response, 404, { error: 'Room not found.' });
        return;
      }
      const item = mediaById.get(room.mediaId);
      if (!item) {
        sendJson(response, 404, { error: 'The room film is no longer in the media folder.' });
        return;
      }
      if (!item.aiPackage || item.aiPackage.status !== 'ready') {
        sendJson(response, 409, {
          error: 'The AI package is not ready for this room.',
          aiPackage: item.aiPackage || null
        });
        return;
      }

      const readInteger = (name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
        const raw = url.searchParams.get(name);
        if (raw === null || raw === '') return fallback;
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || value < min || value > max) {
          throw new Error(`${name} must be an integer between ${min} and ${max}.`);
        }
        return value;
      };
      const playheadMs = readInteger('playheadMs', room.lastPositionMs);
      const fromMs = readInteger('fromMs', Math.max(0, playheadMs - 10_000));
      const toMs = readInteger('toMs', playheadMs + 1_000);
      const lookaheadMs = readInteger('lookaheadMs', 1_000, { max: 30_000 });
      const maxItems = readInteger('maxItems', 24, { min: 1, max: 100 });
      const maxDialogueItems = readInteger('maxDialogueItems', 80, { min: 1, max: 300 });

      try {
        const window = await readObservationTrackWindow(resolve(AI_PACKAGES_ROOT, item.id), {
          fromMs,
          toMs,
          playheadMs,
          lookaheadMs,
          maxItems,
          maxDialogueItems
        });
        sendJson(response, 200, {
          room: publicSession(room),
          media: publicMediaItem(listIndexedMedia(database).find((candidate) => candidate.id === item.id)),
          window
        });
      } catch (error) {
        sendJson(response, 409, { error: error.message });
      }
      return;
    }

    const analyzeObservationsMatch = /^\/api\/rooms\/([a-f0-9-]{36})\/observations\/analyze$/.exec(pathname);
    if (request.method === 'POST' && analyzeObservationsMatch) {
      const room = getSession(database, analyzeObservationsMatch[1]);
      if (!room) {
        sendJson(response, 404, { error: 'Room not found.' });
        return;
      }
      if (room.status !== 'active') {
        sendJson(response, 409, { error: 'Archived rooms are read-only.' });
        return;
      }
      const item = mediaById.get(room.mediaId);
      if (!item) {
        sendJson(response, 404, { error: 'The room film is no longer in the media folder.' });
        return;
      }
      const body = await readJsonBody(request);
      try {
        const result = await analyzeObservationSegment(ROOT, {
          inputPath: item.absolutePath,
          startMs: Number.isFinite(Number(body.startMs)) ? Number(body.startMs) : room.lastPositionMs,
          durationMs: Number(body.durationMs) || 10_000,
          sampleFps: Number(body.sampleFps) || 2
        });
        const observations = addSessionObservations(database, room.id, {
          engine: result.engine,
          observations: result.observations
        });
        sendJson(response, 201, {
          analysis: {
            engine: result.engine,
            startMs: result.startMs,
            durationMs: result.durationMs,
            sampleFps: result.sampleFps,
            decodedFrameCount: result.decodedFrameCount
          },
          observations
        });
      } catch (error) {
        sendJson(response, 503, { error: error.message });
      }
      return;
    }

    const subtitlePrepareMatch = /^\/api\/media\/([a-f0-9]{24})\/subtitles\/prepare$/.exec(pathname);
    if (request.method === 'POST' && subtitlePrepareMatch) {
      const item = mediaById.get(subtitlePrepareMatch[1]);
      if (!item) {
        sendJson(response, 404, { error: 'Media not found. Rescan the folder and try again.' });
        return;
      }
      if (activeJobForMedia(item.id)) {
        sendJson(response, 409, { error: 'Wait for playback preparation to finish before extracting subtitles.' });
        return;
      }
      try {
        const result = await extractSubtitleStreams(item.absolutePath, { outputMediaPath: item.absolutePath });
        await rescanMedia();
        const indexed = listIndexedMedia(database).find((candidate) => candidate.id === item.id);
        if (!indexed) throw new Error('Media disappeared after subtitle extraction.');
        sendJson(response, 200, {
          status: result.status,
          media: publicMediaItem(indexed)
        });
      } catch (error) {
        sendJson(response, 409, { error: error.message });
      }
      return;
    }

    const prepareMatch = /^\/api\/media\/([a-f0-9]{24})\/prepare$/.exec(pathname);
    if (request.method === 'POST' && prepareMatch) {
      const item = mediaById.get(prepareMatch[1]);
      if (!item) {
        sendJson(response, 404, { error: 'Media not found. Rescan the folder and try again.' });
        return;
      }
      const body = await readJsonBody(request);
      const job = startCompatibilityJob(item, {
        repairMode: body.repairMode ? String(body.repairMode) : 'safe'
      });
      sendJson(response, 202, { job: publicJob(job) });
      return;
    }

    const prepareAiMatch = /^\/api\/media\/([a-f0-9]{24})\/prepare-ai$/.exec(pathname);
    if (request.method === 'POST' && prepareAiMatch) {
      const item = mediaById.get(prepareAiMatch[1]);
      if (!item) {
        sendJson(response, 404, { error: 'Media not found. Rescan the folder and try again.' });
        return;
      }
      const body = await readJsonBody(request);
      const job = startAiPreparationJob(item, {
        preferredDialogueTrackId: body.dialogueTrackId ? String(body.dialogueTrackId) : null
      });
      sendJson(response, 202, { job: publicJob(job) });
      return;
    }

    const deletePreviewMatch = /^\/api\/media\/([a-f0-9]{24})\/delete-preview$/.exec(pathname);
    if (request.method === 'GET' && deletePreviewMatch) {
      const item = mediaById.get(deletePreviewMatch[1]);
      if (!item) {
        sendJson(response, 404, { error: 'Media not found. Rescan the folder and try again.' });
        return;
      }
      sendJson(response, 200, { preview: await mediaDeletePreview(item) });
      return;
    }

    const deleteMediaMatch = /^\/api\/media\/([a-f0-9]{24})$/.exec(pathname);
    if (request.method === 'DELETE' && deleteMediaMatch) {
      const item = mediaById.get(deleteMediaMatch[1]);
      if (!item) {
        sendJson(response, 404, { error: 'Media not found. Rescan the folder and try again.' });
        return;
      }
      const body = await readJsonBody(request);
      if (body.cascade !== true || body.confirmMediaId !== item.id) {
        sendJson(response, 400, { error: 'Cascade deletion requires an exact media confirmation.' });
        return;
      }
      try {
        const deleted = await deleteMediaCascade(item);
        sendJson(response, 200, { deleted });
      } catch (error) {
        sendJson(response, 409, { error: error.message });
      }
      return;
    }

    const jobMatch = /^\/api\/jobs\/([a-f0-9-]{36})$/.exec(pathname);
    if (request.method === 'GET' && jobMatch) {
      const job = compatibilityJobs.get(jobMatch[1]) || aiPreparationJobs.get(jobMatch[1]);
      if (!job) {
        sendJson(response, 404, { error: 'Preparation job not found.' });
        return;
      }
      sendJson(response, 200, { job: publicJob(job) });
      return;
    }

    const subtitleMatch = /^\/api\/media\/([a-f0-9]{24})\/subtitles\/([a-z0-9-]+)$/.exec(pathname);
    if (request.method === 'GET' && subtitleMatch) {
      const item = mediaById.get(subtitleMatch[1]);
      if (!item) {
        sendText(response, 404, 'Media not found. Rescan the folder and try again.');
        return;
      }
      await serveSubtitle(response, item, decodeURIComponent(subtitleMatch[2]));
      return;
    }

    const streamMatch = /^\/api\/media\/([a-f0-9]{24})\/stream$/.exec(pathname);
    if ((request.method === 'GET' || request.method === 'HEAD') && streamMatch) {
      const item = mediaById.get(streamMatch[1]);
      if (!item) {
        sendText(response, 404, 'Media not found. Rescan the folder and try again.');
        return;
      }
      await streamMedia(request, response, item);
      return;
    }

    if (request.method === 'GET' && await serveStatic(pathname, response)) return;

    sendText(response, 404, 'Not found');
  } catch (error) {
    console.error(error);
    if (!response.headersSent) sendJson(response, 400, { error: error.message || 'Request failed.' });
    else response.destroy(error);
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log('');
  console.log('Open Watch Cinema is ready.');
  console.log(`Open: ${url}`);
  console.log(`Media folder: ${MEDIA_ROOT}`);
  console.log('Press Ctrl+C to stop.');
  openBrowser(url);
});

function shutdown() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
