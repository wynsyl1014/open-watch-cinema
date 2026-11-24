import { migrateCinemaRecords, migrateModels, removeEmptyDirectory } from './src/storage/local-layout.mjs';
import { imageSettingsForMode } from './src/visuals/image-settings.mjs';
import { aiProfileSettings, updateAiProfileSettings, participantProfile, resolveActor, setParticipantName } from './src/storage/participants.mjs';
import { createAiActivity } from './src/delivery/ai-activity.mjs';
import { createCodexScreening } from './src/delivery/codex-screening.mjs';
import { createCleanupCoordinator } from './src/storage/cleanup-coordinator.mjs';
import { createCollectionSkipSettings } from './src/storage/collection-skip-settings.mjs';
import { includedRanges } from './src/media/skip-ranges.mjs';
import { initializeFilmCleanup, previewRoomCleanup, deleteRoomWithNotebook } from './src/storage/film-cleanup.mjs';
import { createSubtitleJob, createSubtitleJobs, subtitlePreferences } from './src/media/subtitle-jobs.mjs';
import { deleteFilmSubtitles, inspectFilmSubtitles } from './src/media/media-subtitles.mjs';
import { createRoomEvents } from './src/storage/room-events.mjs';
import {
  getWatchBridgeSettings, getWatchBridgeState, setWatchBridgeSettings,
  getWatchBridgeMode, setWatchBridgeMode, getChatBridgeSettings, setChatBridgeSettings, getChatBridgeLookaheadMs,
  migrateChatBridgeSettings,
  getChatBridgeCheckpoint, setChatBridgeCheckpoint, CHAT_TOOL_DEFAULTS, rememberChatPlayback
} from './src/storage/watch-bridge-settings.mjs';
import { getRoomOpeningMessage } from './src/storage/database.mjs';
import { getMcpResumePromptSettings, setMcpResumePromptSettings } from './src/storage/mcp-resume-prompt.mjs';
import { formatNotebook, parseNotebookText } from './src/storage/notebook-text.mjs';
import { initializeNotebook, readNotebook, writeNotebook, writeNotebookBatch, readNotebookChanges } from './src/storage/notebook.mjs';
import { randomUUID } from 'node:crypto';
import { openBrowser } from './src/media/browser-launcher.mjs';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addSessionMessage,
  getInteractionSettings,
  setInteractionSettings,
  getQuickMessages,
  setQuickMessages,
  addSessionObservations,
  endSession,
  getMediaCascadeSummary,
  getActiveSession,
  getSession,
  latestRoomResume,
  listIndexedMedia,
  listSessionMessages,
  listSessionObservations,
  listSessions,
  openDatabase,
  openSession,
  setMediaCompatibility,
  syncMediaIndex,
  updateSessionPlayback
} from './src/storage/index.mjs';
import {
  buildCinemaTick,
  cinemaTickRange,
  readObservationTrackWindow,
  roomJournal, notebookJournal, renderRoomText, renderNotebookText,
  renderRoomHtml, renderNotebookHtml
} from './src/delivery/index.mjs';
import {
  parseSingleRange,
  prepareMediaPlayback,
  probeMedia,
  readAiPackage,
  createFilmLibrary
} from './src/media/index.mjs';

import {
  analyzeObservationSegment,
  getObserverStatus,
  runObservationPrecompute,
  upgradeViewingPackage,
  recoverPackageUpgrades,
  getAudioDescriptionStatus
} from './src/preparation/index.mjs';

import {
  readSpoilerGatedStoryboardFrame,
  getViewingSettings,
  setViewingSettings
} from './src/visuals/index.mjs';

// 1. Configuration and shared application state

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(ROOT, 'public');
const LOCAL_DATA_ROOT = resolve(process.env.LOCAL_DATA_ROOT || resolve(ROOT, 'local-data'));
const MEDIA_ROOT = resolve(LOCAL_DATA_ROOT, 'media');
const AI_PACKAGES_ROOT = resolve(LOCAL_DATA_ROOT, 'ai-packages');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4182);
const JSON_BODY_LIMIT = 64 * 1024;

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/viewing-guide.md', ['../docs/观影须知/观影指南.md', 'text/markdown; charset=utf-8']],
  ['/collection-folder.svg', ['collection-folder.svg', 'image/svg+xml']],
  ['/library-shelf.js', ['library-shelf.js', 'text/javascript; charset=utf-8']],
  ['/cleanup-dialog.js', ['cleanup-dialog.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/ai-activity.js', ['ai-activity.js', 'text/javascript; charset=utf-8']],
  ['/ai-activity.css', ['ai-activity.css', 'text/css; charset=utf-8']],
  ['/ai-profile-settings.js', ['ai-profile-settings.js', 'text/javascript; charset=utf-8']],
  ['/ai-connect-settings.js', ['ai-connect-settings.js', 'text/javascript; charset=utf-8']],
  ['/quick-message-settings.js', ['quick-message-settings.js', 'text/javascript; charset=utf-8']],
  ['/codex-screening-settings.js', ['codex-screening-settings.js', 'text/javascript; charset=utf-8']],
  ['/notebook.js', ['notebook.js', 'text/javascript; charset=utf-8']],
  ['/notebook-window.js', ['notebook-window.js', 'text/javascript; charset=utf-8']],
  ['/notebook-graph.js', ['notebook-graph.js', 'text/javascript; charset=utf-8']],
  ['/notebook.css', ['notebook.css', 'text/css; charset=utf-8']],
  ['/playback-sync.js', ['playback-sync.js', 'text/javascript; charset=utf-8']],
  ['/film-subtitle-settings.js', ['film-subtitle-settings.js', 'text/javascript; charset=utf-8']],
  ['/skip-settings.js', ['skip-settings.js', 'text/javascript; charset=utf-8']],
  ['/playback-skip.js', ['playback-skip.js', 'text/javascript; charset=utf-8']],
  ['/subtitle-utils.js', ['subtitle-utils.js', 'text/javascript; charset=utf-8']]
]);

const MEDIA_TYPES = new Map([
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
  ['.mkv', 'video/x-matroska']
]);

await mkdir(MEDIA_ROOT, { recursive: true });
const databasePath = await migrateCinemaRecords(LOCAL_DATA_ROOT);
await migrateModels(LOCAL_DATA_ROOT);
const database = openDatabase(databasePath);
migrateChatBridgeSettings(database);
const roomEvents = createRoomEvents();
const activityRunId = randomUUID();
const aiActivity = createAiActivity({
  resolveName: profileId => profileId ? participantProfile(database, { kind: 'ai', id: profileId }).name : '待选择档案',
  getActiveRoomId: () => getActiveSession(database)?.id,
  onlineTimeoutSeconds: getViewingSettings(database).aiOnlineTimeoutSeconds,
  onChange: () => roomEvents.publish('ai-activity')
});
const codexScreening = createCodexScreening({
  db: database, cinemaRoot: ROOT, dataRoot: LOCAL_DATA_ROOT,
  getRoom: () => getActiveSession(database),
  getProfileId: () => aiProfileSettings(database).selectedId,
  getProfileName: id => participantProfile(database, { kind: 'ai', id }).name,
  getViewerName: () => participantProfile(database, { kind: 'user' }).displayName,
  onChange: () => roomEvents.publish('ai-activity')
});
const chatAdapterInstalled = ['main.mjs', 'screening.mjs'].every(name =>
  existsSync(resolve(ROOT, 'watch-bridge', 'adapters', 'chat', name)));
const chatAdapter = chatAdapterInstalled ? await import('./watch-bridge/adapters/chat/screening.mjs') : null;
const chatScreening = chatAdapter?.createChatScreening({
  cinemaRoot: ROOT,
  getRoom: () => getActiveSession(database),
  getLatestViewerMessageId: () => getWatchBridgeState(database).latestViewerMessageId ?? 0,
  getIntervalMs: () => getWatchBridgeSettings(database).intervalMs,
  getLookaheadMs: () => getChatBridgeLookaheadMs(database),
  getProfileId: () => aiProfileSettings(database).selectedId,
  getViewerName: () => participantProfile(database, { kind: 'user' }).displayName,
  getOpeningMessage: id => getRoomOpeningMessage(database, id),
  readActivity: readChatActivity,
  getSettings: () => getChatBridgeSettings(database),
  readCheckpoint: () => getChatBridgeCheckpoint(database),
  writeCheckpoint: sessions => setChatBridgeCheckpoint(database, sessions),
  onChange() {
    roomEvents.publish('ai-activity');
    roomEvents.publish('watch-bridge-chat');
  }
});

function viewingBridgeSettings() {
  return { ...getWatchBridgeSettings(database), mode: getWatchBridgeMode(database) };
}

function updateViewingBridge({ mode, intervalSeconds, codex, chat }) {
  if (mode === 'chat' && !chatScreening) throw new TypeError('请先安装 ChatGPT 连续观影适配器。');
  let applyCodex;
  const previousMode = getWatchBridgeMode(database);
  database.exec('begin immediate');
  try {
    if (intervalSeconds !== undefined) setWatchBridgeSettings(database, { intervalSeconds });
    if (mode !== undefined) setWatchBridgeMode(database, mode);
    if (codex || (mode === 'chat' && codexScreening.settings().enabled)) {
      applyCodex = codexScreening.storeSettings(codex ?? { enabled: false });
    }
    if (chat || (mode === 'codex' && getChatBridgeSettings(database).enabled)) {
      setChatBridgeSettings(database, chat ?? { enabled: false });
    }
    database.exec('commit');
  } catch (error) {
    database.exec('rollback');
    throw error;
  }
  if (chat?.enabled === false || (mode === 'codex' && previousMode === 'chat')) chatScreening?.pause();
  applyCodex?.();
  chatScreening?.reconcile();
  roomEvents.publish('watch-bridge-settings');
}
const notebookEdits = new Map();
initializeNotebook(database);
initializeFilmCleanup(database);
database.exec(`create table if not exists notebook_peeks (
  room_id text not null, request_id text not null, primary key(room_id, request_id)
)`);
let mediaById = new Map();
const compatibilityJobs = new Map();
const aiPreparationJobs = new Map();
const subtitleSettings = subtitlePreferences(database);
const subtitleJobs = createSubtitleJobs({
  save: (item,job) => filmLibrary.saveSubtitleJob(item,job),
  refresh: refreshSubtitleTracks,
  changed: mediaId => roomEvents.publish('subtitle-library-changed',null,{mediaId})
});
const filesystemEdits = new Set();
const subtitleDeletions = new Set();
const releasePreviews = new Map();
const legacyFilms = new Map(database.prepare('select id, relative_path, byte_size, modified_at from media where present = 1').all().map(row => [row.id, row]));
const filmLibrary = createFilmLibrary(MEDIA_ROOT, {
  aiPackagesRoot: AI_PACKAGES_ROOT,
  collectionSkipSettings: createCollectionSkipSettings(database),
  newSubtitleJob(id) {
    const languages = subtitleSettings.get();
    return languages.length ? {...createSubtitleJob(id,{languages}),status:'pending'} : null;
  },
  isBusy: id => Boolean(subtitleDeletions.has(id) || activeJobForMedia(id) || activeAiJobForMedia(id) || subtitleJobs.active(id)),
  isLegacyMedia(id, path, stat) {
    const row = legacyFilms.get(id);
    return Boolean(row && row.relative_path === path && row.byte_size === stat.size && row.modified_at === stat.mtime.toISOString());
  }
});
const cleanup = createCleanupCoordinator({
  db: database, library: filmLibrary, edits: filesystemEdits,
  busy: id => Boolean(activeJobForMedia(id) || activeAiJobForMedia(id) || subtitleJobs.active(id)),
  updated: async () => {
    if (scanInProgress) await scanInProgress;
    await rescanMedia();
    aiActivity.refreshOnlineStatus();
    codexScreening.reconcile();
    chatScreening?.reconcile();
    roomEvents.publish('library-changed');
    roomEvents.publish('room');
  }
});
let shelf = { folders: [], retainedFilms: [], issues: [], notices: [] };
let lastCatalog = null;
let lastSubtitleTracks = null;
let scanInProgress = null;

// 2. Functional dispatch. Add endpoints to their group; register a new group here.
// Handlers return true only when they own the request, including streamed responses.
// Every group uses this application's single database, media index and job registries.
const routeGroups = [
  handleAiActivityRoutes,
  handleSystemRoutes,
  handleMediaRoutes,
  handleRoomRoutes,
  handleJournalExport,
  handleViewingRoutes,
  handleNotebookRoutes,
  handlePreparationRoutes,
  handleFileRoutes
];

async function dispatchRequest(context) {
  for (const handleRoutes of routeGroups) {
    if (await handleRoutes(context)) return;
  }
  sendText(context.response, 404, 'Not found');
}

// 3. HTTP primitives and public response shapes

function sendJson(response, statusCode, body) {
  if (response.destroyed || response.writableEnded) return;
  if (statusCode >= 400 && body?.error && !body.code) {
    body = { ...body, code: statusCode === 400 ? 'INVALID_ARGUMENT'
      : statusCode === 404 ? 'RESOURCE_UNAVAILABLE'
      : statusCode === 409 ? 'REQUEST_CONFLICT' : 'CINEMA_REQUEST_FAILED' };
  }
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

async function readJsonBody(request, maxBytes = JSON_BODY_LIMIT) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) throw new Error('Request body is too large.');
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
    subtitleJob: subtitleJobs.get(item.id),
    collectionPath: source?.collection || '',
    skipConfig: source?.skipConfig ?? null,
    skipRanges: source?.skipRanges ?? [],
    storyboardProfile: publicProfile(source?.aiPackage),
    streamUrl: `/api/media/${item.id}/stream`,
    subtitleTracks,
    aiPackage: source?.aiPackage ? { ...source.aiPackage, storyboardProfile: publicProfile(source.aiPackage) } : null,
    aiPreparationJobId: activeAiJobForMedia(item.id)?.id || null,
    aiPreparationOperation: activeAiJobForMedia(item.id)?.operation || null
  };
}

function listPublicMedia() {
  return listIndexedMedia(database).map(publicMediaItem);
}

function publicSession(session) {
  if (!session) return null;
  return {
    ...session,
    mediaAvailable: mediaById.has(session.mediaId),
    writable: session.status === 'active',
    aiAvailable: session.status === 'active',
    frameProcessingAvailable: session.status === 'active'
  };
}

function publicMessage(message) {
  if (!message) return message;
  const { senderIdentity: _senderIdentity, ...visible } = message;
  return visible;
}

// 4. Media catalog, preparation jobs and lifecycle operations

function publicProfile(pkg) {
  if (!pkg) return null;
  const mode = pkg.imageSettings?.mode || 'full';
  return mode === 'full' ? { mode, height: pkg.imageSettings?.storyboardHeight || 480 } : { mode };
}

function acceptCatalog({items, collections, retainedFilms = [], pendingSubtitles, issues}) {
  shelf = {
    folders: collections.filter(Boolean).map(path => ({ path, name: path.split('/').at(-1) })),
    issues: pendingSubtitles.map(entry => ({ ...entry, id: entry.relativePath })),
    retainedFilms,
    notices: issues
  };
  const signature = JSON.stringify([items.map(({id, relativePath, size, modifiedAt, skipConfig, skipRanges}) =>
    [id, relativePath, size, modifiedAt, skipConfig, skipRanges]), shelf]);
  const trackSignature = JSON.stringify(items.map(item => [item.id,item.subtitleTracks.map(track => track.id)]));
  if (signature !== lastCatalog) {
    syncMediaIndex(database, items);
    if (lastCatalog !== null) roomEvents.publish('library-changed');
    lastCatalog = signature;
  } else if (trackSignature !== lastSubtitleTracks) {
    roomEvents.publish('subtitle-library-changed');
  }
  lastSubtitleTracks = trackSignature;
  mediaById = new Map(items.map(item => [item.id, item]));
  subtitleJobs.observe(items);
  for (const item of items) legacyFilms.delete(item.id);
  for (const id of releasePreviews.keys()) if (!mediaById.has(id)) releasePreviews.delete(id);
  return listPublicMedia();
}

async function refreshSubtitleTracks(item) {
  // Finish older scans before updating the player's published track list.
  const tracks = await filmLibrary.subtitleTracks(item);
  item.subtitleTracks = tracks;
  const current = mediaById.get(item.id);
  if (current) current.subtitleTracks = tracks;
}

function rescanMedia() {
  if (!scanInProgress) scanInProgress = filmLibrary.snapshot().then(acceptCatalog).finally(() => { scanInProgress = null; });
  return scanInProgress;
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

async function refreshAiPackage(item, { signal } = {}) {
  const aiPackage = await readAiPackage(null, item.id, { packagePath: item.packagePath, signal });
  item.aiPackage = aiPackage;
  const current = mediaById.get(item.id);
  if (current) current.aiPackage = aiPackage;
  return aiPackage;
}

function packageCanBeRead(aiPackage) {
  return aiPackage?.packageVersion === 3 || aiPackage?.status === 'ready';
}

function publicJob(job) {
  if (job.kind === 'subtitles') return {...job};
  return {
    id: job.id,
    kind: job.kind || 'compatibility',
    mediaId: job.mediaId,
    repairMode: job.repairMode || null,
    operation: job.operation || null,
    backupPath: job.backupPath || null,
    oldPackageDisposition: job.oldPackageDisposition || null,
    preparedThroughMs: job.preparedThroughMs ?? null,
    replacementMediaId: job.replacementMediaId || null,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    changed: job.changed ?? null,
    subtitleTrackCount: job.subtitleTrackCount ?? null,
    experienceMode: job.experienceMode || null,
    aiPackage: job.aiPackage || null,
    durationMs: job.durationMs ?? job.aiPackage?.durationMs ?? null,
    viewingTrack: job.aiPackage?.viewingTrack || null,
    dialogueTrack: job.aiPackage?.dialogueTrack || null,
    audioTrack: job.aiPackage?.audioTrack || null,
    aiReadiness: job.aiPackage?.aiReadiness || null,
    canStartViewing: Boolean(job.aiPackage?.canStartViewing),
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
  if (activeAiJobForMedia(item.id)?.operation === 'upgrade') throw new Error('Wait for the package upgrade to finish before repairing this film.');
  assertFilmReadyForJob(item);
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

async function preparationSettings(item, profile, { upgrading = false } = {}) {
  const settings = getViewingSettings(database);
  if (profile !== undefined) {
    requirePlainObject(profile, '分镜档位');
    if (!['economy', 'balanced', 'full'].includes(profile.mode) ||
        Object.keys(profile).some(key => !['mode','height'].includes(key)) ||
        (profile.height !== undefined && (profile.mode !== 'full' || ![480,720,1080].includes(profile.height)))) {
      throw new Error('请选择有效的影片分镜档位。');
    }
  }
  const saved = upgrading && !item.aiPackage?.imageSettings?.mode ? null : publicProfile(item.aiPackage);
  const target = profile || saved || { mode: 'balanced' };
  settings.imageSettings = imageSettingsForMode(target.mode, target.height);
  // Repeated requests can return the existing job without changing its captured options.
  const durationMs = item.aiPackage?.durationMs ?? item.durationMs;
  const skipRanges = item.aiPackage ? item.aiPackage.skipRanges ?? [] : item.skipRanges;
  const needsAudio = !durationMs || includedRanges(0, durationMs, skipRanges).length > 0;
  if (!activeAiJobForMedia(item.id) && settings.includeAudio && needsAudio &&
      !['ready', 'source_missing'].includes(item.aiPackage?.audioTrack?.status)) {
    const audio = await getAudioDescriptionStatus(ROOT, LOCAL_DATA_ROOT);
    if (audio.status !== 'available') {
      if (upgrading && !settings.configured) return { ...settings, includeAudio: false };
      throw Object.assign(new Error('声音描述已开启，但本地声音环境尚未就绪。请先完成音频安装，或在影院设置关闭声音描述后再准备。' + (audio.note ? ` ${audio.note}` : '')), { code: 'AUDIO_SETUP_REQUIRED' });
    }
  }
  return settings;
}

function startAiPreparationJob(item, { preferredDialogueTrackId = null, settings = getViewingSettings(database) } = {}) {
  assertFilmReadyForJob(item);
  const existing = activeAiJobForMedia(item.id);
  if (existing) return existing;
  const job = {
    id: randomUUID(),
    kind: 'ai-package',
    mediaId: item.id,
    status: 'queued',
    stage: 'Preparing viewing package',
    progress: 0,
    aiPackage: item.aiPackage || null,
    startedAt: new Date().toISOString()
  };
  aiPreparationJobs.set(job.id, job);

  void (async () => {
    try {
      const previous = await refreshAiPackage(item);
      if (previous?.needsStoryboardUpgrade) {
        throw new Error('This viewing package uses an earlier format. Upgrade it to continue.');
      }
      const preparation = {
        viewingIntervalMs: previous?.viewingIntervalMs || settings.intervalMs,
        initialBufferMs: previous?.viewingTrack?.initialBufferMs || settings.initialBufferMs,
        imageSettings: previous?.imageSettings || settings.imageSettings
      };
      if (!preparation.initialBufferMs || !preparation.imageSettings) {
        throw new Error('Choose the viewing buffer and image settings before preparing this film.');
      }
      job.status = 'processing';
      job.stage = 'Preparing pictures, dialogue and sound in order';
      const updatePreparation = async (progress) => {
        if (!progress.live) job.aiPackage = await refreshAiPackage(item);
        const committedPercent = progress.durationMs > 0
          ? 100 * progress.preparedThroughMs / progress.durationMs : 0;
        const nextPercent = typeof progress.livePercent === 'number' && Number.isFinite(progress.livePercent)
          ? Math.max(committedPercent, progress.livePercent) : committedPercent;
        job.progress = Number(Math.max(job.progress || 0, Math.min(99.9, nextPercent)).toFixed(1));
        job.preparedThroughMs = typeof progress.liveThroughMs === 'number'
          ? Math.max(progress.preparedThroughMs || 0, progress.liveThroughMs)
          : progress.preparedThroughMs;
        job.durationMs = progress.durationMs;
        job.stage = job.aiPackage?.canStartViewing
          ? 'Viewing buffer ready; preparing the rest'
          : 'Preparing the starting viewing buffer';
      };
      const result = await runObservationPrecompute(ROOT, {
        inputPath: item.absolutePath,
        outputRoot: dirname(item.packagePath),
        packageKey: basename(item.packagePath),
        // Existing package profiles are resumed; replacing real assets is explicit maintenance.
        replaceMismatchedPackage: false,
        sourceMediaId: item.id,
        sourceRelativePath: item.relativePath,
        preferredDialogueTrackId: preferredDialogueTrackId ?? previous?.dialogueTrack?.sourceTrack?.id,
        ...(previous ? { skipRanges: previous.skipRanges ?? [] } : { skipConfig: item.effectiveSkipConfig }),
        includeAudio: settings.includeAudio,
        ...preparation,
        onPreparationProgress: updatePreparation,
        onInitialBufferReady() {
          job.stage = 'Viewing buffer ready; preparing the rest';
        }
      });
      job.aiPackage = await refreshAiPackage(item);
      if (settings.includeAudio && !['ready', 'source_missing'].includes(result.manifest.audioTrack?.status)) {
        throw new Error('画面与对白已保留，但声音描述尚未完成。请在影院设置检查声音环境，再继续准备。');
      }
      job.status = 'done';
      job.stage = 'Available viewing tracks prepared';
      job.progress = 100;
      job.experienceMode = result.manifest.aiReadiness?.experienceMode || 'complete';
      job.message = job.experienceMode === 'visual_only'
        ? 'Pictures are ready. No timed dialogue source was found.'
        : 'Pictures and dialogue are ready on the same movie timeline.';
      const audioStatus = result.manifest.audioTrack?.status;
      job.message += !settings.includeAudio
        ? ' Sound description preparation is turned off in cinema settings; existing sound data is preserved.'
        : audioStatus === 'ready'
        ? ' Audio descriptions are ready too.'
        : audioStatus === 'source_missing'
          ? ' This film has no audio stream.'
          : ` Audio descriptions are not prepared. ${result.manifest.audioTrack?.note || 'Open cinema settings to check the audio environment and resume preparation.'}`;
      job.finishedAt = new Date().toISOString();
    } catch (error) {
      console.error('AI package preparation failed:', error);
      job.status = 'error';
      job.stage = 'AI preparation stopped';
      job.error = error.message;
      job.finishedAt = new Date().toISOString();
      job.aiPackage = await refreshAiPackage(item);
    }
  })();

  return job;
}

function assertUpgradeAllowed(item) {
  if (activeJobForMedia(item.id)) throw new Error('Wait for playback preparation to finish before upgrading.');
  if (listSessions(database).some((room) => room.mediaId === item.id && room.status === 'active')) {
    throw new Error('End this film’s active room before upgrading its viewing package.');
  }
}

function startPackageUpgradeJob(item, { preferredDialogueTrackId = null, settings = getViewingSettings(database) } = {}) {
  assertFilmReadyForJob(item);
  const existing = activeAiJobForMedia(item.id);
  if (existing) {
    if (existing.operation === 'upgrade') return existing;
    throw new Error('Wait for the existing preparation task to finish before upgrading.');
  }
  assertUpgradeAllowed(item);
  if (!settings.initialBufferMs || !settings.imageSettings) {
    throw new Error('Save viewing settings before upgrading this film.');
  }
  const job = {
    id: randomUUID(), kind: 'ai-package', operation: 'upgrade', mediaId: item.id,
    status: 'queued', stage: 'Preparing upgraded package; original package retained',
    progress: 0, aiPackage: item.aiPackage || null, startedAt: new Date().toISOString()
  };
  aiPreparationJobs.set(job.id, job);
  void (async () => {
    try {
      job.status = 'processing';
      const result = await upgradeViewingPackage(ROOT, {
        inputPath: item.absolutePath, outputRoot: dirname(item.packagePath), packageKey: basename(item.packagePath),
        sourceMediaId: item.id, sourceRelativePath: item.relativePath,
        viewingIntervalMs: item.aiPackage?.viewingIntervalMs || settings.intervalMs,
        initialBufferMs: item.aiPackage?.viewingTrack?.initialBufferMs || settings.initialBufferMs,
        imageSettings: settings.imageSettings, preferredDialogueTrackId: preferredDialogueTrackId ?? item.aiPackage?.dialogueTrack?.sourceTrack?.id,
        includeAudio: settings.includeAudio,
        onPreparationProgress(progress) {
          const raw = typeof progress.percent === 'number' && Number.isFinite(progress.percent)
            ? progress.percent
            : typeof progress.livePercent === 'number' && Number.isFinite(progress.livePercent)
              ? Math.min(99, progress.livePercent * 0.99)
              : progress.durationMs > 0
                ? Math.min(99, 100 * progress.preparedThroughMs / progress.durationMs)
                : 0;
          job.progress = Number(Math.max(job.progress || 0, Math.min(99, raw)).toFixed(1));
          job.preparedThroughMs = typeof progress.liveThroughMs === 'number'
            ? Math.max(progress.preparedThroughMs || 0, progress.liveThroughMs)
            : progress.preparedThroughMs;
          job.durationMs = progress.durationMs;
          job.stage = '正在准备新版画面、对白和声音';
        },
        onUpgradeStage({ phase, stage }) {
          job.stage = stage;
          if (phase !== 'validation') job.progress = 99;
        },
        beforeSwitch() { assertUpgradeAllowed(item); }
      });
      job.aiPackage = await refreshAiPackage(item);
      job.backupPath = result.backupPath || null;
      job.oldPackageDisposition = result.oldPackageDisposition;
      job.status = 'done'; job.progress = 100;
      job.stage = 'Viewing package upgraded';
      job.message = result.message;
    } catch (error) {
      job.status = 'error'; job.stage = 'Upgrade stopped; original package retained';
      job.error = error.message;
      job.aiPackage = await refreshAiPackage(item);
    } finally { job.finishedAt = new Date().toISOString(); }
  })();
  return job;
}

function localLibraryRequest(request) {
  const host = request.headers.host || '';
  const origin = request.headers.origin;
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)
    && (!origin || origin === 'http://' + host) && request.headers['sec-fetch-site'] !== 'cross-site';
}

function allowAutomaticViewingTrigger(request, response) {
  if (localLibraryRequest(request) || !automaticViewingEnabled()) return true;
  sendJson(response, 403, { error: '请在本机影院操作连续观影。' });
  return false;
}

function automaticViewingEnabled() {
  return codexScreening.settings().enabled || (chatScreening && getChatBridgeSettings(database).enabled);
}

function expectedRoomMatches(request, response, room) {
  const expectedRoomId = request.headers['x-owc-expected-room'];
  if (expectedRoomId !== undefined && (room?.status !== 'active' || room.id !== expectedRoomId)) {
    sendJson(response, 409, { code: 'ROOM_UNAVAILABLE', error: 'The selected screening room is no longer active.' });
    return false;
  }
  const expectedSeek = request.headers['x-owc-expected-seek-version'];
  if (expectedSeek !== undefined && String(room?.seekVersion) !== expectedSeek) {
    sendJson(response, 409, { code: 'PLAYBACK_CHANGED', error: 'The screening has moved to a different playback position.' });
    return false;
  }
  return true;
}

async function mediaDeletePreview(item) {
  const { revision, ...usage } = await filmLibrary.spaceUsage(item.id);
  let preview = releasePreviews.get(item.id);
  if (!preview || preview.revision !== revision) {
    preview = { revision, token: randomUUID() };
    releasePreviews.set(item.id, preview);
  }
  const records = getMediaCascadeSummary(database, item.id);
  return { mediaId: item.id, title: item.title, usage, records, token: preview.token,
    busy: Boolean(records.activeSessionCount || activeJobForMedia(item.id) || activeAiJobForMedia(item.id) || subtitleJobs.active(item.id)) };
}

function assertFilmReadyForJob(item) {
  if (subtitleJobs.active(item.id)) throw new Error('字幕正在提取，请稍后再试。');
  if (filesystemEdits.has(item.id) || mediaById.get(item.id)?.absolutePath !== item.absolutePath) {
    throw new Error('影片文件正在整理或已经移动，请刷新片库。');
  }
}

// 5. File delivery and desktop integration

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



// 6. HTTP endpoints, grouped by cinema function

// System status and viewing settings.
function requireAiProfile(id) {
  const actor = { kind: 'ai', id };
  if (typeof id !== 'string' || !id.trim() || id.length > 120 || !participantProfile(database, actor).configured) {
    throw Object.assign(new Error('请先在影院设置中选择观影 AI。'), { code: 'AI_PROFILE_REQUIRED' });
  }
  return actor;
}

function readAiActivitySnapshot() {
  const activity = aiActivity.list();
  const chat = chatScreening?.connection();
  const managed = [
    [codexScreening.status(), 'codex', codexScreening.isManaged],
    [chat, 'chat', id => chatScreening?.isManaged(id)]
  ];
  const merged = new Set();
  const name = session => participantProfile(database, { kind: 'ai', id: session.profileId }).name;
  const connections = activity.connections.map(connection => {
    for (const [session, transport, wasManaged] of managed) {
      if (connection.connectionId === session?.connectionId) {
        merged.add(transport);
        return { ...connection, ...session, name: name(session), transport };
      }
      if (wasManaged(connection.connectionId)) return { ...connection, online: false, transport };
    }
    return connection;
  });
  for (const [session, transport] of managed) {
    if (session && !merged.has(transport)) connections.unshift({
      ...session, name: name(session), transport, callCount: 0, lastSeenAt: session.connectedAt
    });
  }
  return { ...activity, connections, runId: activityRunId, codexError: codexScreening.error(),
    chatStatus: chatScreening?.status() ?? 'disabled', chatError: chatScreening?.error() ?? null };
}

function readAiActivityCalls(connectionId, offset, limit) {
  const calls = aiActivity.calls(connectionId, { offset, limit });
  if (calls) return calls;
  if ([codexScreening.status()?.connectionId, chatScreening?.connection()?.connectionId].includes(connectionId)) {
    return { connectionId, totalCalls: 0, evictedCalls: 0, offset, nextOffset: null, calls: [] };
  }
  return null;
}

function readChatActivity({ action, connectionId, callId, offset, limit, index }) {
  if (action === 'activity') {
    const active = getActiveSession(database);
    const room = active ? { id: active.id, mediaTitle: active.mediaTitle, lastPositionMs: active.lastPositionMs } : null;
    return { ...readAiActivitySnapshot(), room };
  }
  if (action === 'activity_calls') return readAiActivityCalls(connectionId, offset ?? 0, limit ?? 100);
  if (action === 'activity_call') return aiActivity.result(connectionId, callId);
  const image = aiActivity.image(connectionId, callId, index);
  return image && { type: 'image', mimeType: image.mimeType, data: image.data.toString('base64') };
}

// Presence and MCP replies belong to the current service run.
async function handleAiActivityRoutes({ request, response, pathname, url }) {
  const root = '/api/ai/activity';
  if (pathname !== root && !pathname.startsWith(root + '/')) return false;
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'private, no-store');
  if (request.method === 'POST' && pathname === root) {
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
      sendJson(response, 415, { error: '活动报告需要 JSON。' });
      return true;
    }
    const body = await readJsonBody(request, 32 * 1024 * 1024);
    if (body.runId !== activityRunId) {
      if (body.op !== 'heartbeat') {
        sendJson(response, 409, { code: 'ACTIVITY_RUN_CHANGED', error: '影院已重新启动。' });
        return true;
      }
      // An adapter can survive a service restart. Its first heartbeat registers
      // presence in the new run, while counters from the previous run expire.
      delete body.droppedCalls;
    }
    aiActivity.report(body);
    sendJson(response, 200, { ok: true, runId: activityRunId });
    return true;
  }
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: '此操作不可用。' });
    return true;
  }
  if (pathname === root) {
    sendJson(response, 200, readAiActivitySnapshot());
    return true;
  }

  const match = /^\/api\/ai\/activity\/([a-f0-9-]{36})\/calls(?:\/([a-f0-9-]{36})(?:\/images\/(\d+))?)?$/.exec(pathname);
  if (match) {
    const [, connectionId, callId, imageIndex] = match;
    if (imageIndex !== undefined) {
      const image = aiActivity.image(connectionId, callId, Number(imageIndex));
      if (image) {
        response.writeHead(200, {
          'content-type': image.mimeType,
          'content-length': image.data.length,
          'x-content-type-options': 'nosniff'
        });
        response.end(image.data);
        return true;
      }
    } else if (callId) {
      const result = aiActivity.result(connectionId, callId);
      if (result) {
        const content = result.content.map(block => block.type === 'image'
          ? { ...block, url: pathname + '/images/' + block.index }
          : block);
        sendJson(response, 200, { ...result, content });
        return true;
      }
    } else {
      const offset = readIntegerValue(url.searchParams.get('offset'), 'offset', 0);
      const limit = readIntegerValue(url.searchParams.get('limit'), 'limit', 100, { min: 1, max: 200 });
      const calls = readAiActivityCalls(connectionId, offset, limit);
      if (calls) {
        sendJson(response, 200, calls);
        return true;
      }
    }
  }
  sendJson(response, 404, { error: '这次影院运行中找不到这条记录。' });
  return true;
}

async function handleSystemRoutes({ request, response, url, pathname, signal }) {
if (request.method === 'GET' && pathname === '/api/events') {
  roomEvents.subscribe(request, response); return true;
}
if (pathname === '/api/mcp-resume-prompt' && ['GET', 'POST'].includes(request.method)) {
  if (!localLibraryRequest(request)) {
    sendJson(response, 403, { error: '请在本机影院设置 MCP 续看提示词。' });
    return true;
  }
  const settings = request.method === 'GET'
    ? getMcpResumePromptSettings(database)
    : setMcpResumePromptSettings(database, await readJsonBody(request, 128 * 1024));
  sendJson(response, 200, settings);
  return true;
}
if (request.method === 'GET' && pathname === '/api/watch-bridge/state') {
  sendJson(response, 200, getWatchBridgeState(database));
  return true;
}
if (pathname === '/api/watch-bridge/settings') {
  if (request.method === 'GET') {
    sendJson(response, 200, viewingBridgeSettings());
    return true;
  }
  if (request.method === 'POST') {
    if (!localLibraryRequest(request)) {
      sendJson(response, 403, { error: '请在本机影院设置连续观影间隔。' });
      return true;
    }
    const patch = await readJsonBody(request);
    if (!patch || !Object.keys(patch).length || Object.keys(patch).some(key => !['mode', 'intervalSeconds'].includes(key))) {
      throw new TypeError('连续观影设置无效。');
    }
    updateViewingBridge(patch);
    sendJson(response, 200, viewingBridgeSettings());
    return true;
  }
}
if (pathname === '/api/watch-bridge/chat/transport' && request.method === 'POST') {
  response.setHeader('Cache-Control', 'private, no-store');
  if (!localLibraryRequest(request) || request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined
    || request.headers['x-owc-chat-transport'] !== '1') {
    sendJson(response, 403, { error: '此入口供本机 ChatGPT 影院适配器使用。' });
    return true;
  }
  if (!chatScreening) {
    sendJson(response, 404, { error: '未安装 ChatGPT 连续观影适配器。' });
    return true;
  }
  try {
    sendJson(response, 200, await chatScreening.command(await readJsonBody(request, 128 * 1024), { signal }));
  } catch (error) {
    sendJson(response, error.status ?? 400, { error: error.message });
  }
  return true;
}
if (pathname === '/api/watch-bridge/chat' && ['GET', 'POST'].includes(request.method)) {
  if (!localLibraryRequest(request)) {
    sendJson(response, 403, { error: '请在本机影院操作 ChatGPT 连续观影。' });
    return true;
  }
  if (request.method === 'POST') {
    const chat = await readJsonBody(request, 128 * 1024);
    if (!chatScreening) throw new TypeError('请先安装 ChatGPT 连续观影适配器。');
    if (!chat || typeof chat !== 'object' || Array.isArray(chat)) throw new TypeError('ChatGPT 观影设置无效。');
    updateViewingBridge({ chat, ...(chat?.enabled === true && { mode: 'chat' }) });
  }
  sendJson(response, 200, { available: Boolean(chatScreening), settings: getChatBridgeSettings(database),
    defaults: { instructions: chatAdapter?.DEFAULT_INSTRUCTIONS ?? '', lookaheadSeconds: 0, ...CHAT_TOOL_DEFAULTS },
    intervalSeconds: getWatchBridgeSettings(database).intervalSeconds,
    status: chatScreening?.status() ?? 'disabled', error: chatScreening?.error() ?? null });
  return true;
}
if (pathname === '/api/watch-bridge/codex' || pathname === '/api/watch-bridge/codex/account' || pathname === '/api/watch-bridge/codex/login') {
  if (!localLibraryRequest(request)) {
    sendJson(response, 403, { error: '请在本机影院操作 Codex 连续观影。' });
    return true;
  }
  const available = codexScreening.available();
  if (pathname === '/api/watch-bridge/codex') {
    if (request.method === 'POST') {
      const codex = await readJsonBody(request, 128 * 1024);
      if (!codex || typeof codex !== 'object' || Array.isArray(codex)) throw new TypeError('Codex 观影设置无效。');
      updateViewingBridge({ codex, ...(codex?.enabled === true && { mode: 'codex' }) });
    }
    else if (request.method !== 'GET') return false;
    const defaults = available ? await import('./watch-bridge/adapters/codex/instructions.mjs') : null;
    sendJson(response, 200, { available, settings: codexScreening.settings(), error: codexScreening.error(),
      defaults: { instructions: defaults?.DEFAULT_INSTRUCTIONS ?? '', openingPrompt: '' } });
    return true;
  }
  if (!available) {
    sendJson(response, 404, { error: '未安装 Codex 连续观影适配器。' });
    return true;
  }
  const authMode = url.searchParams.get('mode');
  const mode = authMode === null ? codexScreening.settings().authMode : authMode;
  if (!['inherit', 'isolated'].includes(mode)) throw new TypeError('无效的 Codex 账号来源。');
  const options = { mode: mode === 'inherit' ? 'inherited' : 'isolated', dataRoot: LOCAL_DATA_ROOT };
  const setup = await import('./watch-bridge/adapters/codex/setup.mjs');
  if (pathname.endsWith('/account') && request.method === 'GET') {
    const account = await setup.checkCodexAccount({ ...options, includeModels: url.searchParams.get('models') === '1' });
    sendJson(response, 200, account);
    return true;
  }
  if (pathname.endsWith('/login') && request.method === 'POST') {
    const body = await readJsonBody(request);
    if (body?.action === 'start') sendJson(response, 200, await setup.startCodexLogin(options));
    else if (body?.action === 'cancel') {
      await setup.cancelCodexLogin(options);
      sendJson(response, 200, { ok: true });
    } else if (body?.action === 'reconnect' && mode === codexScreening.settings().authMode) {
      codexScreening.reconcile({ retry: true });
      sendJson(response, 200, { ok: true });
    } else throw new TypeError('无效的 Codex 登录操作。');
    return true;
  }
}
if (pathname === '/api/participants/viewer' && request.method === 'GET') {
  sendJson(response, 200, participantProfile(database, { kind: 'user' }));
  return true;
}
if (pathname === '/api/participants/viewer' && request.method === 'POST') {
  const body = await readJsonBody(request);
  const actor = { kind: 'user' };
  try {
    const before = participantProfile(database, actor);
    const profile = setParticipantName(database, actor, body.name, { initializeOnly: body.initializeOnly === true });
    if (!before.configured || before.displayName !== profile.displayName) roomEvents.publish('participant-name');
    sendJson(response, 200, profile);
  } catch (error) {
    sendJson(response, 400, { code: 'INVALID_ARGUMENT', error: '请填写不超过 60 个字符的单行名字。' });
  }
  return true;
}
if (pathname === '/api/participants/ai-profiles' && request.method === 'GET') {
  sendJson(response, 200, aiProfileSettings(database));
  return true;
}
if (pathname === '/api/participants/ai-profiles' && request.method === 'POST') {
  const body = await readJsonBody(request);
  try {
    const settings = updateAiProfileSettings(database, body);
    if (codexScreening.needsProfile()) codexScreening.reconcile({ retry: true });
    chatScreening?.reconcile();
    roomEvents.publish('participant-name');
    sendJson(response, 200, settings);
  } catch (error) {
    const status = error.code === 'AI_NAME_TAKEN' ? 409 : error.code === 'AI_PROFILE_NOT_FOUND' ? 404 : 400;
    sendJson(response, status, { code: error.code || 'INVALID_ARGUMENT', error: error.message });
  }
  return true;
}
if (pathname === '/api/interaction-settings' && request.method === 'GET') {
  sendJson(response, 200, getInteractionSettings(database)); return true;
}
if (pathname === '/api/interaction-settings' && request.method === 'POST') {
  const settings = setInteractionSettings(database, await readJsonBody(request));
  roomEvents.publish('settings');
  sendJson(response, 200, settings); return true;
}
if (pathname === '/api/quick-messages') {
  if (request.method === 'GET') {
    sendJson(response, 200, getQuickMessages(database));
    return true;
  }
  if (request.method === 'POST') {
    if (!localLibraryRequest(request)) { sendJson(response, 403, { error: '请在本机影院设置快捷消息。' }); return true; }
    try {
      const saved = setQuickMessages(database, await readJsonBody(request));
      roomEvents.publish('settings');
      sendJson(response, 200, saved);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return true;
  }
}

if (request.method === 'GET' && pathname === '/api/health') {
  const activeSession = getActiveSession(database);
  sendJson(response, 200, {
    ok: true,
    apiVersion: '0.5.0',
    capabilities: ['ai-package-v1', 'ai-window-v1', 'ai-tick-v1', 'ai-frame-v1', 'ai-playback-state-v1', 'audio-descriptions-v1', 'ai-cadence-v1', 'release-space-v1', 'room-archive-v1'],
    mediaCount: mediaById.size,
    mediaFolder: 'local-data/media',
    activePreparationCount: [...compatibilityJobs.values()].filter((job) => ['checking', 'processing'].includes(job.status)).length,
    activeAiPreparationCount: [...aiPreparationJobs.values()].filter((job) => ['queued', 'processing'].includes(job.status)).length,
    roomOpen: Boolean(activeSession),
    activeRoomId: activeSession?.id || null
  });
  return true;
}

if (pathname === '/api/subtitle-settings') {
  if (request.method === 'GET') {
    sendJson(response,200,{languages:subtitleSettings.get()});
    return true;
  }
  if (request.method === 'POST') {
    if (!localLibraryRequest(request)) { sendJson(response,403,{error:'请在本机影院设置字幕语言。'}); return true; }
    try {
      const {languages} = await readJsonBody(request);
      sendJson(response,200,{languages:subtitleSettings.set(languages)});
      roomEvents.publish('settings');
    } catch (error) { sendJson(response,400,{error:error.message}); }
    return true;
  }
}
if (request.method === 'GET' && pathname === '/api/viewing-settings') {
  sendJson(response, 200, { settings: getViewingSettings(database) });
  return true;
}

if (request.method === 'POST' && pathname === '/api/viewing-settings') {
  const body = await readJsonBody(request);
  const settings = setViewingSettings(database, body);
  aiActivity.setOnlineTimeout(settings.aiOnlineTimeoutSeconds);
  sendJson(response, 200, { settings });
  return true;
}

if (request.method === 'GET' && pathname === '/api/mcp-connection-info') {
  if (!localLibraryRequest(request)) {
    sendJson(response, 403, { error: '请在本机影院查看 AI 连接信息。' });
    return true;
  }
  const address = server.address();
  const activePort = typeof address === 'object' && address ? address.port : PORT;
  sendJson(response, 200, {
    mcpServerPath: resolve(ROOT, 'mcp', 'server.mjs'),
    skillPath: resolve(ROOT, 'mcp', 'SKILL.md'),
    platform: process.platform,
    port: activePort
  });
  return true;
}

if (request.method === 'GET' && pathname === '/api/observer/status') {
  sendJson(response, 200, {
    observer: await getObserverStatus(ROOT),
    audio: await getAudioDescriptionStatus(ROOT, LOCAL_DATA_ROOT)
  });
  return true;
}
  return false;
}

// Media library and deletion.
async function handleMediaRoutes({ request, response, url, pathname, signal }) {
const filmSkipSettings = /^\/api\/media\/([a-f0-9]{24})\/skip-settings$/.exec(pathname);
const collectionSkipSettings = pathname === '/api/library/skip-settings';
if ((filmSkipSettings || collectionSkipSettings) && ['GET', 'POST'].includes(request.method)) {
  const saving = request.method === 'POST';
  if (saving && !localLibraryRequest(request)) {
    sendJson(response, 403, { error: '请在本机影院设置跳过区间。' });
    return true;
  }
  try {
    const body = saving ? await readJsonBody(request) : null;
    const config = body?.skipConfig;
    if (saving && config !== null && (!config || typeof config !== 'object' || Array.isArray(config))) {
      throw Object.assign(new Error('skipConfig 应为对象或 null。'), {statusCode: 400});
    }
    if (filmSkipSettings) {
      const id = filmSkipSettings[1];
      if (!mediaById.has(id)) {
        sendJson(response, 404, {error: '影片已不在片库。'});
        return true;
      }
      if (saving) acceptCatalog(await filmLibrary.saveFilmSkipConfig(id, config));
      const film = mediaById.get(id);
      sendJson(response, 200, { skipConfig: film.skipConfig, skipRanges: film.skipRanges });
    } else {
      const path = saving ? body.collectionPath : url.searchParams.get('collectionPath');
      if (typeof path !== 'string' || !path) {
        throw Object.assign(new Error('请选择一个合集。'), {statusCode: 400});
      }
      if (saving) acceptCatalog(await filmLibrary.saveCollectionSkipConfig(path, config));
      sendJson(response, 200, { collectionPath: path, skipConfig: await filmLibrary.collectionSkipConfig(path) });
    }
  } catch (error) {
    sendJson(response, error.statusCode || 409, { error: error.message });
  }
  return true;
}
if (pathname === '/api/library' && request.method === 'GET') {
  sendJson(response, 200, shelf);
  return true;
}
if (pathname.startsWith('/api/library/') && request.method === 'POST') {
  if (!localLibraryRequest(request)) {
    sendJson(response, 403, { error: '请在本机影院整理片库。' });
    return true;
  }
  const action = pathname.slice('/api/library/'.length);
  const body = action === 'import' ? {} : await readJsonBody(request);
  if (action === 'cleanup-preview' || action === 'cleanup') {
    try {
      const result = action === 'cleanup-preview' ? {preview: await cleanup.preview(body)} : await cleanup.apply(body);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, error.statusCode || error.status || 409, {error: error.message});
    }
    return true;
  }
  let ids = action === 'move' && Array.isArray(body.mediaIds) ? body.mediaIds : [body.mediaId].filter(Boolean);
  if (action === 'rename-folder') {
    ids = [...mediaById.values()].filter(item => item.collection === body.path
      || item.collection.startsWith(body.path + '/')).map(item => item.id);
  }
  if (ids.some(id => filesystemEdits.has(id))) {
    sendJson(response, 409, {error: '影片正在整理，请稍后重试。'});
    return true;
  }
  ids.forEach(id => filesystemEdits.add(id));
  try {
    let snapshot;
    switch (action) {
      case 'folders':
        if (!body.name || /[\\/]/.test(body.name)) throw new Error('请输入单个收纳夹名称。');
        snapshot = await filmLibrary.createCollection([body.parentPath, body.name].filter(Boolean).join('/'));
        break;
      case 'rename-folder': snapshot = await filmLibrary.renameCollection(body.path, body.name); break;
      case 'move': snapshot = await filmLibrary.moveFilms(body.mediaIds, body.collectionPath ?? ''); break;
      case 'rename': snapshot = await filmLibrary.renameFilm(body.mediaId, body.name); break;
      case 'subtitles': snapshot = await filmLibrary.assignSubtitle(body.issueId, body.mediaId); break;
      case 'import':
        snapshot = await filmLibrary.importFile(url.searchParams.get('name'), request, {
          collection: url.searchParams.get('collectionPath') || '', mediaId: url.searchParams.get('mediaId') || null
        });
        break;
      default: return false;
    }
    const items = acceptCatalog(snapshot);
    sendJson(response, 200, { ...shelf, items });
  } catch (error) {
    sendJson(response, error.status || error.statusCode || 409, { error: error.message });
  } finally { ids.forEach(id => filesystemEdits.delete(id)); }
  return true;
}

if (request.method === 'GET' && pathname === '/api/media') {
  await Promise.all([...mediaById.values()].map((item) => refreshAiPackage(item, { signal })));
  sendJson(response, 200, { items: listPublicMedia() });
  return true;
}

if (request.method === 'POST' && pathname === '/api/media/rescan') {
  const items = await rescanMedia();
  sendJson(response, 200, { items });
  return true;
}

const deletePreviewMatch = /^\/api\/media\/([a-f0-9]{24})\/delete-preview$/.exec(pathname);
if (request.method === 'GET' && deletePreviewMatch) {
  const item = mediaById.get(deletePreviewMatch[1]);
  if (!item) {
    sendJson(response, 404, { error: 'Media not found. Rescan the folder and try again.' });
    return true;
  }
  sendJson(response, 200, { preview: await mediaDeletePreview(item) });
  return true;
}

const deleteMediaMatch = /^\/api\/media\/([a-f0-9]{24})$/.exec(pathname);
if (request.method === 'DELETE' && deleteMediaMatch) {
  const item = mediaById.get(deleteMediaMatch[1]);
  if (!item) {
    sendJson(response, 404, { error: 'Media not found. Rescan the folder and try again.' });
    return true;
  }
  if (!localLibraryRequest(request)) { sendJson(response, 403, { error: '请在本机影院释放空间。' }); return true; }
  const body = await readJsonBody(request);
  if (!['media','package'].includes(body.scope) || body.confirmMediaId !== item.id) {
    sendJson(response, 400, { error: '请在弹窗选择清理范围并确认影片。' });
    return true;
  }
  const preview = releasePreviews.get(item.id);
  if (!preview || preview.token !== body.token) {
    sendJson(response, 409, { error: '请重新打开释放空间弹窗，核对当前占用。' });
    return true;
  }
  if (getActiveSession(database)?.mediaId === item.id || filesystemEdits.has(item.id)
      || activeJobForMedia(item.id) || activeAiJobForMedia(item.id) || subtitleJobs.active(item.id)) {
    sendJson(response, 409, { error: '请先结束这部影片的活动房间，并等待正在进行的任务完成。' });
    return true;
  }
  filesystemEdits.add(item.id);
  try {
    const catalog = await filmLibrary.releaseSpace(item.id, body.scope, { revision: preview.revision });
    const items = acceptCatalog(catalog);
    releasePreviews.delete(item.id);
    if (body.scope === 'package') roomEvents.publish('library-changed');
    sendJson(response, 200, { items, scope: body.scope });
  } catch (error) {
    sendJson(response, error.statusCode || 409, { error: error.message });
  } finally { filesystemEdits.delete(item.id); }
  return true;
}

const relinkMatch = /^\/api\/media\/([a-f0-9]{24})\/relink$/.exec(pathname);
if (request.method === 'POST' && relinkMatch) {
  if (!localLibraryRequest(request)) { sendJson(response, 403, {error: '请在本机影院关联片源。'}); return true; }
  const id = relinkMatch[1];
  const film = database.prepare('select title,relative_path from media where id = ? and present = 0').get(id);
  if (!film || mediaById.has(id) || filesystemEdits.has(id)) {
    sendJson(response, 409, { error: '这部影片已有片源或正在整理。' });
    return true;
  }
  const parent = film.relative_path.split('/').slice(0,-2).join('/');
  const collection = shelf.folders.some(folder => folder.path === parent) ? parent : '';
  filesystemEdits.add(id);
  try {
    const snapshot = await filmLibrary.relinkFile(id, url.searchParams.get('name'), request, {collection, title: film.title});
    sendJson(response, 200, {items: acceptCatalog(snapshot)});
  } catch (error) { sendJson(response, error.statusCode || 409, {error: error.message}); }
  finally { filesystemEdits.delete(id); }
  return true;
}
  return false;
}

const screeningDate = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

async function handleJournalExport({ request, response, url, pathname, signal }) {
  const match = /^\/api\/rooms\/([a-f0-9-]{36})\/(notebook\/)?export$/.exec(pathname);
  if (!match || request.method !== 'GET') return false;
  const format = url.searchParams.get('format') ?? 'html';
  if (!['html', 'txt'].includes(format)) {
    sendJson(response, 400, { error: '请选择 HTML 或纯文本格式。' });
    return true;
  }
  const room = getSession(database, match[1]);
  if (!room) {
    sendJson(response, 404, { code: 'ROOM_UNAVAILABLE', error: '找不到这次放映。' });
    return true;
  }

  const notebook = Boolean(match[2]);
  const date = screeningDate.format(new Date(room.openedAt));
  let content;
  if (notebook) {
    const { entries } = readNotebook(database, room.mediaId, room.lastPositionMs);
    const journal = notebookJournal(room.mediaTitle, entries);
    content = format === 'html' ? renderNotebookHtml(journal) : renderNotebookText(journal);
  } else {
    const journal = roomJournal(room.mediaTitle, date, listSessionMessages(database, room.id));
    content = format === 'html' ? renderRoomHtml(journal) : renderRoomText(journal);
  }
  signal.throwIfAborted();
  const title = Array.from(room.mediaTitle.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, '_')).slice(0, 48).join('');
  const suffix = notebook ? '观影手记' : '放映记录-' + date.replace(':', '-');
  const filename = encodeURIComponent((title + '-' + suffix + '.' + format).toWellFormed())
    .replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  response.writeHead(200, {
    'content-type': (format === 'html' ? 'text/html' : 'text/plain') + '; charset=utf-8',
    'content-disposition': `attachment; filename="${notebook ? 'notebook' : 'screening'}.${format}"; filename*=UTF-8''${filename}`,
    'content-length': Buffer.byteLength(content),
    'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'",
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(content);
  return true;
}

// Rooms, playback and conversation.
async function handleRoomRoutes({ request, response, url, pathname, signal }) {
if (request.method === 'GET' && pathname === '/api/rooms') {
  sendJson(response, 200, {
    activeRoom: publicSession(getActiveSession(database)),
    rooms: listSessions(database).map(publicSession)
  });
  return true;
}

if (request.method === 'GET' && pathname === '/api/rooms/resume') {
  const mediaId = url.searchParams.get('mediaId');
  if (!mediaById.has(mediaId)) {
    sendJson(response, 404, { error: 'Select a film from the current library before opening a room.' });
    return true;
  }
  sendJson(response, 200, { resume: getActiveSession(database) ? null : latestRoomResume(database, mediaId) });
  return true;
}

if (request.method === 'POST' && pathname === '/api/rooms/open') {
  const body = await readJsonBody(request, 128 * 1024);
  if (!allowAutomaticViewingTrigger(request, response)) return true;
  const openingMessage = body?.openingMessage;
  const resume = body?.resume;
  if (resume !== undefined && (typeof resume?.roomId !== 'string'
      || !Number.isSafeInteger(resume.lastPositionMs) || resume.lastPositionMs <= 0)) {
    sendJson(response, 400, { error: '请选择有效的续看位置。' });
    return true;
  }
  if (openingMessage !== undefined && (typeof openingMessage !== 'string' || openingMessage.length > 12000)) {
    sendJson(response, 400, { error: '开场消息须为不超过 12000 字符的文本。' });
    return true;
  }
  const hasOpeningMessage = Boolean(openingMessage?.trim());
  if (hasOpeningMessage && !automaticViewingEnabled()) {
    sendJson(response, 409, { error: '请先启用连续观影，再填写这场的开场消息。' });
    return true;
  }
  const item = mediaById.get(String(body?.mediaId || ''));
  if (!item) {
    sendJson(response, 404, { error: 'Select a film from the current library before opening a room.' });
    return true;
  }
  if (filesystemEdits.has(item.id) || activeJobForMedia(item.id) || activeAiJobForMedia(item.id)?.operation === 'upgrade') {
    sendJson(response, 409, { error: '影片整理完成后即可开房。' });
    return true;
  }
  try {
    const mcpResumePrompt = resume && body.includeMcpResumePrompt === true && localLibraryRequest(request) && !automaticViewingEnabled()
      ? { template: getMcpResumePromptSettings(database).template, intervalSeconds: getViewingSettings(database).intervalSeconds }
      : null;
    const room = openSession(database, {
      mediaId: item.id, mediaTitle: item.title, openingMessage: hasOpeningMessage ? openingMessage : undefined, resume
    });
    roomEvents.publish('room', room.id);
    codexScreening.reconcile();
    chatScreening?.reconcile();
    sendJson(response, 201, { room: publicSession(room), ...(mcpResumePrompt && { mcpResumePrompt }) });
  } catch (error) {
    sendJson(response, 409, { code: error.code, error: error.message });
  }
  return true;
}

const playbackStateMatch = /^\/api\/rooms\/([a-f0-9-]{36})\/playback-state$/.exec(pathname);
if (request.method === 'GET' && playbackStateMatch) {
  const room = getSession(database, playbackStateMatch[1]);
  if (!expectedRoomMatches(request, response, room)) return true;
  if (!room) {
    sendJson(response, 404, { code: 'ROOM_UNAVAILABLE', error: 'Room not found.' });
    return true;
  }
  const chatFeed = authorizeChatFeed(request, response, room);
  if (chatFeed === null) return true;
  const after = request.headers['x-owc-notebook-after'];
  const updates = after === undefined ? null : readNotebookChanges(database, room.id, readIntegerValue(after, 'notebook event cursor', 0), 40);
  sendJson(response, 200, { room: {
    id: room.id,
    status: room.status,
    playbackState: room.playbackState,
    lastPositionMs: room.lastPositionMs,
    seekVersion: room.seekVersion,
    ...(chatFeed && { deliveryHorizonMs: chatFeedHorizon(room, mediaById.get(room.mediaId)) })
  }, ...(updates ? { notebookChanges: updates.events } : {}) });
  return true;
}

const roomDeletePreview = /^\/api\/rooms\/([a-f0-9-]{36})\/delete-preview$/.exec(pathname);
if (request.method === 'GET' && roomDeletePreview) {
  if (!localLibraryRequest(request)) { sendJson(response, 403, {error:'请在本机影院查看清理范围。'}); return true; }
  try {
    sendJson(response, 200, {preview: previewRoomCleanup(database, roomDeletePreview[1])});
  } catch (error) { sendJson(response, error.statusCode || 409, {error:error.message}); }
  return true;
}
const roomMatch = /^\/api\/rooms\/([a-f0-9-]{36})$/.exec(pathname);
if (request.method === 'DELETE' && roomMatch) {
  if (!localLibraryRequest(request)) { sendJson(response, 403, {error: '请在本机影院删除历史房间。'}); return true; }
  const body = await readJsonBody(request);
  if (body.confirmRoomId !== roomMatch[1]) {
    sendJson(response, 400, {error: '请确认要删除的这次放映。'}); return true;
  }
  try {
    const result = deleteRoomWithNotebook(database, roomMatch[1], body.revision);
    if (result.deleted) roomEvents.publish('room', roomMatch[1]);
    sendJson(response, 200, result);
  } catch (error) { sendJson(response, error.statusCode || 409, { code:error.code, error:error.message }); }
  return true;
}
if (request.method === 'GET' && roomMatch) {
  const room = getSession(database, roomMatch[1]);
  if (!room) {
    sendJson(response, 404, { code: 'ROOM_UNAVAILABLE', error: 'Room not found.' });
    return true;
  }
  sendJson(response, 200, {
    room: publicSession(room),
    messages: listSessionMessages(database, room.id).map(publicMessage)
  });
  return true;
}

const endRoomMatch = /^\/api\/rooms\/([a-f0-9-]{36})\/end$/.exec(pathname);
if (request.method === 'POST' && endRoomMatch) {
  const body = await readJsonBody(request);
  try {
    const room = endSession(database, endRoomMatch[1], {
      lastPositionMs: body.mediaTimeMs === undefined ? undefined : Number(body.mediaTimeMs) || 0
    });
    aiActivity.refreshOnlineStatus();
    codexScreening.reconcile();
    chatScreening?.reconcile();
    roomEvents.publish('room', room.id);
    sendJson(response, 200, { room: publicSession(room) });
  } catch (error) {
    sendJson(response, 404, { error: error.message });
  }
  return true;
}

const playbackMatch = /^\/api\/rooms\/([a-f0-9-]{36})\/playback$/.exec(pathname);
if (request.method === 'POST' && playbackMatch) {
  const body = await readJsonBody(request);
  if (!allowAutomaticViewingTrigger(request, response)) return true;
  try {
    const previousState = codexScreening.status() ?? chatScreening?.connection();
    const previousRoom = getSession(database, playbackMatch[1]);
    const room = updateSessionPlayback(database, playbackMatch[1], {
      mediaTimeMs: Number(body.mediaTimeMs) || 0,
      playbackState: body.playbackState,
      seeked: body.seeked === true
    });
    rememberChatPlayback(database, previousRoom, room);
    if (body.seeked === true) chatScreening?.reconcile();
    roomEvents.publish('watch-bridge-playback', room.id);
    if (previousState?.roomId === room.id && previousState.paused !== (room.playbackState === 'paused')) {
      roomEvents.publish('ai-activity');
    }
    sendJson(response, 200, { room: publicSession(room) });
  } catch (error) {
    sendJson(response, 409, { error: error.message });
  }
  return true;
}

const messagesMatch = /^\/api\/rooms\/([a-f0-9-]{36})\/messages$/.exec(pathname);
if (request.method === 'GET' && messagesMatch) {
  const room = getSession(database, messagesMatch[1]);
  if (!room) {
    sendJson(response, 404, { code: 'ROOM_UNAVAILABLE', error: 'Room not found.' });
    return true;
  }
  if (url.searchParams.has('ids')) {
    const ids = url.searchParams.get('ids').split(',').map(Number);
    const rows = listSessionMessages(database, room.id, { ids });
    sendJson(response, 200, { messages: rows.map(({ id, senderName }) => ({ id, senderName })) });
    return true;
  }
  sendJson(response, 200, {
    room: publicSession(room),
    messages: listSessionMessages(database, room.id).map(publicMessage)
  });
  return true;
}

if (request.method === 'POST' && messagesMatch) {
  const body = await readJsonBody(request);
  if (!allowAutomaticViewingTrigger(request, response)) return true;
  try {
    const message = addSessionMessage(database, messagesMatch[1], {
      senderName: body.senderName,
      senderKind: body.senderKind,
      content: body.content,
      interaction: body.interaction === 'notebook_peek' ? 'invalid' : body.interaction ?? null,
      mediaTimeMs: Number(body.mediaTimeMs) || 0
    });
    roomEvents.publish('messages', messagesMatch[1]);
    sendJson(response, 201, { message });
  } catch (error) {
    sendJson(response, 409, { error: error.message });
  }
  return true;
}

if (request.method === 'POST' && pathname === '/api/ai/messages') {
  const body = await readJsonBody(request);
  const room = getActiveSession(database);
  if (!expectedRoomMatches(request, response, room)) return true;
  if (!room) {
    sendJson(response, 409, { error: 'There is no active room for an AI message.' });
    return true;
  }
  try {
    const actor = requireAiProfile(body.senderIdentity);
    const message = addSessionMessage(database, room.id, {
      senderKind: 'ai',
      senderIdentity: actor.id,
      content: body.content,
      interaction: body.interaction === 'notebook_peek' ? 'invalid' : body.interaction ?? null,
      // The server owns the timestamp: use the authoritative playhead at write time.
      mediaTimeMs: room.lastPositionMs
    });
    roomEvents.publish('messages', room.id);
    sendJson(response, 201, {
      message: { content: message.content, mediaTimeMs: message.mediaTimeMs }
    });
  } catch (error) {
    sendJson(response, 409, { error: error.message, code: error.code || 'REQUEST_CONFLICT' });
  }
  return true;
}

const observationsMatch = /^\/api\/rooms\/([a-f0-9-]{36})\/observations$/.exec(pathname);
if (request.method === 'GET' && observationsMatch) {
  const room = getSession(database, observationsMatch[1]);
  if (!room) {
    sendJson(response, 404, { code: 'ROOM_UNAVAILABLE', error: 'Room not found.' });
    return true;
  }
  const afterSequence = Number(url.searchParams.get('after') || 0);
  sendJson(response, 200, {
    room: publicSession(room),
    observations: listSessionObservations(database, room.id, { afterSequence })
  });
  return true;
}
  return false;
}

// Notebook: persistent film-scoped revisions.
async function handleNotebookRoutes({ request, response, pathname, url, signal }) {
  const match = /^\/api\/rooms\/([a-f0-9-]{36})\/notebook(?:\/(peek))?$/.exec(pathname);
  const managed = /^\/api\/ai\/notebook$/.exec(pathname);
  if (!match && !managed) return false;
  const activeRoom = getActiveSession(database);
  const room = managed ? activeRoom : getSession(database, match[1]);
  if (!expectedRoomMatches(request, response, room)) return true;
  const action = match?.[2] || '';
  if (!room) {
    sendJson(response, managed ? 409 : 404, { code: 'ROOM_UNAVAILABLE', error: managed ? 'Open a room to use its notebook.' : 'Room not found.' }); return true;
  }
  const readOnly = room.status === 'ended';
  const archiveRead = !managed && readOnly && request.method === 'GET' && !action;
  if (!archiveRead && (readOnly || activeRoom?.id !== room.id)) {
    sendJson(response, 409, { code: 'ROOM_UNAVAILABLE', error: '历史房间的手记仅供阅读。' }); return true;
  }
  const item = mediaById.get(room.mediaId);
  if (!item && !archiveRead) { sendJson(response, 404, { error: 'Film unavailable.' }); return true; }
  const snapshot = () => ({ ...readNotebook(database, room.mediaId, room.lastPositionMs), readOnly,
    editing: readOnly ? [] : [...notebookEdits.values()].filter(item => item.roomId === room.id)
      .map(item => ({ ...item, actorName: resolveActor(database, {kind:'ai', id:item.actorId}).name })) });
  try {
    if (request.method === 'GET' && !action) {
      if (managed && url.searchParams.get('format') === 'context') {
        sendJson(response, 200, {roomId:room.id, mediaId:room.mediaId}); return true;
      }
      if (managed && url.searchParams.get('format') === 'text') {
        const filters = {};
        for (const key of ['section', 'character']) {
          if (url.searchParams.has(key)) filters[key] = url.searchParams.get(key);
        }
        for (const key of ['fromMs', 'toMs']) {
          if (url.searchParams.has(key)) filters[key] = readIntegerValue(url.searchParams.get(key), key, 0);
        }
        if (filters.fromMs > filters.toMs) throw new TypeError('fromMs must be at or before toMs.');
        filters.unresolved = url.searchParams.get('unresolved') === 'true';
        sendJson(response, 200, { text: formatNotebook(readNotebook(database, room.mediaId, room.lastPositionMs).entries, filters) });
      } else {
        sendJson(response, 200, snapshot());
      }
      return true;
    }
    if (request.method !== 'POST') { sendJson(response, 405, { error: 'Unsupported notebook operation.' }); return true; }
    const body = requirePlainObject(await readJsonBody(request, 256 * 1024), 'notebook write');
    signal.throwIfAborted();
    const latest = getActiveSession(database);
    if (!latest || latest.id !== room.id || latest.seekVersion !== room.seekVersion || latest.lastPositionMs < room.lastPositionMs) {
      throw new Error('Playback changed. Try again at the current position.');
    }
    if (action === 'peek' && !allowAutomaticViewingTrigger(request, response)) return true;
    if (action === 'peek') {
      if (!getInteractionSettings(database).enabled || !snapshot().entries.length) {
        sendJson(response, 200, { sent: false }); return true;
      }
      if (typeof body.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.requestId)) throw new Error('A unique peek request ID is required.');
      database.exec('BEGIN IMMEDIATE');
      try {
        const inserted = database.prepare('insert or ignore into notebook_peeks(room_id,request_id) values(?,?)').run(room.id, body.requestId);
        if (inserted.changes) addSessionMessage(database, room.id, {
          senderKind: 'user',
          interaction: 'notebook_peek', mediaTimeMs: latest.lastPositionMs
        });
        database.exec('COMMIT');
        if (inserted.changes) roomEvents.publish('messages', room.id);
        sendJson(response, 200, { sent: Boolean(inserted.changes) });
      } catch (error) { database.exec('ROLLBACK'); throw error; }
      return true;
    }
    if (action) throw new Error('Unknown notebook operation.');
    if (body.expectedRoomId !== undefined && body.expectedRoomId !== latest.id) {
      throw Object.assign(new Error('The active room changed; read the current notebook before writing.'), { code: 'ROOM_UNAVAILABLE' });
    }
    const actor = managed ? requireAiProfile(body.actorId) : { kind: 'user', id: 'viewer' };
    const batch = managed && body.action === 'write';
    const targets = batch ? parseNotebookText(body.text).filter(row => row.ref)
      .map(row => ({ref: row.ref, fields: [row.field]})) : body.id ? [{
        ref: body.id, fields: body.action === 'delete' ? ['*'] : Object.keys(body).filter(key =>
          ['name','text','appearance','detail','label','answer','direction','uncertain','characterIds','eventAtMs','section'].includes(key))
      }] : [];
    if (!managed && body.id) {
      const overlap = [...notebookEdits.values()].filter(edit => edit.roomId === room.id)
        .flatMap(edit => edit.targets).filter(target => String(body.id).startsWith(target.ref))
        .flatMap(target => target.fields).filter(field => field === '*' || body.action === 'delete' || Object.hasOwn(body, field));
      if (overlap.length) throw Object.assign(new Error('AI 正在保存同一项；保留草稿，稍后再保存。'), {
        code: 'NOTEBOOK_VERSION_CONFLICT', fields: [...new Set(overlap)],
        current: snapshot().entries.find(entry => entry.id === body.id)
      });
    }
    const token = randomUUID();
    if (managed) {
      const edit = { roomId: room.id, token, active: true, actorId: actor.id, actorKind: 'ai', targets };
      notebookEdits.set(token, edit);
      roomEvents.publish('notebook-edit', room.id, { ...edit, actorName: resolveActor(database, actor).name });
    }
    try {
      if (batch) {
        const result = writeNotebookBatch(database, latest, {text:body.text, requestId:body.requestId}, actor);
        if (!result.replayed) roomEvents.publish('notebook', room.id);
        const refs = result.entries.map(entry => '#' + entry.id + '/v' + entry.version);
        sendJson(response, 200, { replayed: result.replayed, text:
          (result.replayed ? '这笔已保存。' : '已保存。') + '\n' + refs.join('\n') });
      } else {
        const entry = writeNotebook(database, latest, body, actor);
        roomEvents.publish('notebook', room.id);
        sendJson(response, 200, body.returnEntry === true ? { entry } : snapshot());
      }
    } finally {
      if (managed) {
        notebookEdits.delete(token);
        roomEvents.publish('notebook-edit', room.id, {token, active:false});
      }
    }
  } catch (error) {
    signal.throwIfAborted();
    const conflict = error.code === 'NOTEBOOK_VERSION_CONFLICT';
    sendJson(response, conflict ? 409 : error.code === 'INVALID_ARGUMENT' || error instanceof TypeError ? 400 : 409, {
      error: error.message, code: error.code || 'REQUEST_CONFLICT',
      ...(conflict ? { current: error.current, fields: error.fields } : {}),
      ...(error.line ? {line: error.line} : {})
    });
  }
  return true;
}

// AI viewing: tick, detailed frames and content windows.
function initialRoomMediaFloor(room) {
  return room.seekVersion === 0 ? room.resumeFromMs ?? 0 : 0;
}

function chatFeedHorizon(room, item) {
  const actualMs = room.lastPositionMs;
  const requested = actualMs + (room.playbackState === 'playing' ? getChatBridgeLookaheadMs(database) : 0);
  return Number.isSafeInteger(item?.aiPackage?.durationMs)
    ? Math.min(requested, item.aiPackage.durationMs)
    : actualMs;
}

function authorizeChatFeed(request, response, room, enabled = true) {
  const token = request.headers['x-owc-chat-feed-token'];
  if (token === undefined) return false;
  if (enabled && typeof token === 'string' && room?.status === 'active' &&
      request.headers.origin === undefined && request.headers['sec-fetch-site'] === undefined &&
      localLibraryRequest(request) && chatScreening?.authorizeFeed(token, room.id)) return true;
  sendJson(response, 403, { code: 'CHAT_FEED_UNAVAILABLE', error: 'The Chat cinema feed is no longer authorized.' });
  return null;
}

async function handleViewingRoutes({ request, response, url, pathname, signal }) {
const aiTickMatch = /^\/api\/rooms\/([a-f0-9-]{36})\/ai-tick$/.exec(pathname);
const managedAiTick = pathname === '/api/ai/tick';
if (request.method === 'POST' && (aiTickMatch || managedAiTick)) {
  const body = await readJsonBody(request);
  const room = managedAiTick ? getActiveSession(database) : getSession(database, aiTickMatch[1]);
  if (!expectedRoomMatches(request, response, room)) return true;
  if (!room) {
    sendJson(response, managedAiTick ? 409 : 404, {
      code: 'ROOM_UNAVAILABLE',
      error: managedAiTick ? 'There is no active room for an AI tick.' : 'Room not found.'
    });
    return true;
  }
  if (room.status !== 'active') {
    sendJson(response, 409, { code: 'ROOM_UNAVAILABLE', error: 'Archived rooms do not produce live AI ticks.' });
    return true;
  }
  const chatFeed = authorizeChatFeed(request, response, room, managedAiTick);
  if (chatFeed === null) return true;
  const messagesOnly = chatFeed && body.messagesOnly === true;
  const item = mediaById.get(room.mediaId);
  if (!item) {
    sendJson(response, 404, { code: 'MEDIA_NOT_FOUND', error: 'The room film is no longer in the media folder.' });
    return true;
  }
  const cursors = (managedAiTick && body.roomId !== room.id)
    ? {}
    : body.cursors === undefined
    ? {}
    : requirePlainObject(body.cursors, 'cursors');
  const limits = body.limits === undefined
    ? {}
    : requirePlainObject(body.limits, 'limits');
  let consumerIdentity = null;
  if (body.consumerIdentity !== undefined && body.consumerIdentity !== null) {
    consumerIdentity = String(body.consumerIdentity).trim().slice(0, 120);
    if (!consumerIdentity) throw new Error('consumerIdentity must be a non-empty string.');
  }
  let consumerName = null;
  if (body.consumerName !== undefined && body.consumerName !== null) {
    consumerName = String(body.consumerName).trim().slice(0, 60);
    if (!consumerName) throw new Error('consumerName must be a non-empty string.');
  }
  const playheadMs = Math.max(0, Math.round(Number(room.lastPositionMs) || 0));
  const horizonMs = chatFeed && !messagesOnly ? chatFeedHorizon(room, item) : playheadMs;
  const mediaFloorMs = initialRoomMediaFloor(room);
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
  const notebookEventId = readIntegerValue(cursors.notebookEventId, 'cursors.notebookEventId', 0);
  const notebookChanges = messagesOnly ? { events: [] } : readNotebookChanges(database, room.id, notebookEventId, 40);
  const canReadPackage = packageCanBeRead(item.aiPackage);
  if (!messagesOnly && !canReadPackage && !notebookChanges.events.length) {
    sendJson(response, 409, {
      code: 'AI_PACKAGE_INCOMPLETE',
      error: 'The AI package is not ready for this room.',
      aiPackage: item.aiPackage || null
    });
    return true;
  }

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
    maxAdvanceMs,
    mediaFloorMs,
    ...(chatFeed && { deliveryHorizonMs: horizonMs }),
    ...(messagesOnly && { messagesOnly: true })
  });
  const { fromMs } = range;
  let { toMs } = range;

  try {
    const messageRows = chatFeed && !messagesOnly ? [] : listSessionMessages(database, room.id, {
      afterId: messageId,
      limit: maxMessages + 1
    });
    const observationRows = messagesOnly ? [] : listSessionObservations(database, room.id, {
      afterSequence: observationSequence,
      limit: maxLiveObservations + 1
    });
    // Notebook revisions are available even in an explicitly incomplete room.
    let window = { packageVersion: 3, nextCursorMs: fromMs, revealThroughMs: fromMs,
      segments: [], pendingAudioRanges: [], awaitingPreparation: !messagesOnly };
    for (let attempt = 0; !messagesOnly && canReadPackage && attempt < 12; attempt += 1) {
      signal.throwIfAborted();
      window = await readObservationTrackWindow(item.packagePath, {
        fromMs,
        toMs,
        playheadMs: horizonMs,
        lookaheadMs: 0,
        gateAudioAtEnd: chatFeed,
        maxItems: 100,
        maxDialogueItems: 300,
        signal
      });
      signal.throwIfAborted();
      if (window.packageVersion === 3 || (!window.hasMore && !window.dialogueHasMore && !window.audioHasMore)) break;
      const spanMs = toMs - fromMs;
      if (spanMs <= 1) {
        throw new Error('The AI tick range is too dense to deliver without dropping material.');
      }
      toMs = fromMs + Math.max(1, Math.floor(spanMs / 2));
    }
    if (window.packageVersion !== 3 && (window.hasMore || window.dialogueHasMore || window.audioHasMore)) {
      throw new Error('The AI tick range could not be compacted without dropping material.');
    }
    signal.throwIfAborted();
    const latestRoom = getSession(database, room.id);
    if (!latestRoom || latestRoom.status !== 'active' || latestRoom.seekVersion !== room.seekVersion
        || latestRoom.lastPositionMs < playheadMs
        || (chatFeed && (!chatScreening?.authorizeFeed(request.headers['x-owc-chat-feed-token'], room.id)
          || !messagesOnly && chatFeedHorizon(latestRoom, item) < horizonMs))) {
      throw Object.assign(new Error('Playback changed during this tick. Retry with the same cursors.'), { code: 'PLAYBACK_CHANGED' });
    }
    const viewingSettings = getViewingSettings(database);
    const tick = buildCinemaTick({
      room,
      window,
      messages: messagesOnly || canReadPackage ? messageRows.slice(0, maxMessages) : [],
      includeMessageIds: managedAiTick,
      consumerIdentity,
      consumerName,
      liveObservations: canReadPackage ? observationRows.slice(0, maxLiveObservations) : [],
      notebookChanges,
      inputCursors: { messageId, observationSequence, notebookEventId, skipRangeKey: cursors.skipRangeKey },
      skipRanges: messagesOnly ? [] : item.aiPackage?.skipRanges,
      viewerName: item.aiPackage?.skipRanges?.length ? participantProfile(database, { kind: 'user' }).displayName : '',
      targetRange: { ...range, toMs },
      messageHasMore: messageRows.length > maxMessages,
      observationHasMore: observationRows.length > maxLiveObservations,
      limits: { maxStoryboards, maxMotionEvents }
    });
    if (!getInteractionSettings(database).enabled) tick.newMessages = tick.newMessages.filter(message => !message.interaction);
    sendJson(response, 200, {
      tick,
      ...(managedAiTick ? { state: { roomId: room.id, cursors: tick.internalCursors } } : {}),
      viewingSettings,
      recommendedNextPollMs: viewingSettings.intervalMs
    });
  } catch (error) {
    sendJson(response, 409, { code: error.code || 'REQUEST_CONFLICT', error: error.message });
  }
  return true;
}

const aiFrameMatch = /^\/api\/rooms\/([a-f0-9-]{36})\/ai-frame$/.exec(pathname);
if (request.method === 'GET' && aiFrameMatch) {
  const room = getSession(database, aiFrameMatch[1]);
  if (!expectedRoomMatches(request, response, room)) return true;
  if (!room) {
    sendJson(response, 404, { code: 'ROOM_UNAVAILABLE', error: 'Room not found.' });
    return true;
  }
  const chatFeed = authorizeChatFeed(request, response, room);
  if (chatFeed === null) return true;
  const item = mediaById.get(room.mediaId);
  if (!item) {
    sendJson(response, 404, { code: 'MEDIA_NOT_FOUND', error: 'The room film is no longer in the media folder.' });
    return true;
  }
  if (!packageCanBeRead(item.aiPackage)) {
    sendJson(response, 409, {
      code: 'AI_PACKAGE_INCOMPLETE',
      error: 'The AI package is not ready for this room.',
      aiPackage: item.aiPackage || null
    });
    return true;
  }

  const storyboardRef = url.searchParams.get('storyboardRef') || '';
  const rawMediaTimeMs = url.searchParams.get('mediaTimeMs');
  if (rawMediaTimeMs === null || rawMediaTimeMs === '') {
    throw new Error('mediaTimeMs is required.');
  }
  const mediaTimeMs = readIntegerValue(rawMediaTimeMs, 'mediaTimeMs', 0);
  const quality = url.searchParams.get('quality') || 'storyboard';
  const horizonMs = chatFeed && quality === 'storyboard'
    ? chatFeedHorizon(room, item) : Math.max(0, Math.round(Number(room.lastPositionMs) || 0));
  try {
    signal.throwIfAborted();
    const frame = await readSpoilerGatedStoryboardFrame(
      item.packagePath,
      {
        storyboardRef,
        mediaTimeMs,
        quality,
        inputPath: item.absolutePath,
        signal,
        playheadMs: horizonMs
      }
    );
    signal.throwIfAborted();
    const latestRoom = getSession(database, room.id);
    if (!latestRoom || latestRoom.seekVersion !== room.seekVersion
        || latestRoom.status !== room.status || latestRoom.lastPositionMs < room.lastPositionMs
        || (chatFeed && (!chatScreening?.authorizeFeed(request.headers['x-owc-chat-feed-token'], room.id)
          || chatFeedHorizon(latestRoom, item) < horizonMs))) {
      sendJson(response, 409, { code: 'PLAYBACK_CHANGED', error: 'Playback changed while reading the frame. Retry at the current playhead.' });
      return true;
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
    sendJson(response, 409, { code: error.code || 'FRAME_UNAVAILABLE', error: error.message });
  }
  return true;
}

const aiWindowMatch = /^\/api\/rooms\/([a-f0-9-]{36})\/ai-window$/.exec(pathname);
if (request.method === 'GET' && aiWindowMatch) {
  const room = getSession(database, aiWindowMatch[1]);
  if (!expectedRoomMatches(request, response, room)) return true;
  if (!room) {
    sendJson(response, 404, { code: 'ROOM_UNAVAILABLE', error: 'Room not found.' });
    return true;
  }
  const chatFeed = authorizeChatFeed(request, response, room);
  if (chatFeed === null) return true;
  const item = mediaById.get(room.mediaId);
  if (!item) {
    sendJson(response, 404, { code: 'MEDIA_NOT_FOUND', error: 'The room film is no longer in the media folder.' });
    return true;
  }
  if (!packageCanBeRead(item.aiPackage)) {
    sendJson(response, 409, {
      code: 'AI_PACKAGE_INCOMPLETE',
      error: 'The AI package is not ready for this room.',
      aiPackage: item.aiPackage || null
    });
    return true;
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
  const horizonMs = chatFeed ? chatFeedHorizon(room, item) : room.lastPositionMs;
  const playheadMs = Math.min(horizonMs, readInteger('playheadMs', room.lastPositionMs));
  const fromMs = readInteger('fromMs', Math.max(0, playheadMs - 10_000));
  const toMs = readInteger('toMs', playheadMs + 1_000);
  const lookaheadMs = chatFeed ? 0 : readInteger('lookaheadMs', 1_000, { max: 30_000 });
  const maxItems = readInteger('maxItems', 24, { min: 1, max: 100 });
  const maxDialogueItems = readInteger('maxDialogueItems', 80, { min: 1, max: 300 });
  const maxAudioItems = readInteger('maxAudioItems', 20, { min: 1, max: 100 });
  const tracks = url.searchParams.has('tracks')
    ? url.searchParams.get('tracks').split(',').map((track) => track.trim())
    : ['dialogue', 'audio'];

  try {
    const window = await readObservationTrackWindow(item.packagePath, {
      fromMs,
      toMs,
      playheadMs,
      lookaheadMs,
      gateAudioAtEnd: chatFeed,
      maxItems,
      maxDialogueItems,
      maxAudioItems,
      tracks,
      signal
    });
    signal.throwIfAborted();
    const latestRoom = getSession(database, room.id);
    if (!latestRoom || latestRoom.status !== 'active' || latestRoom.seekVersion !== room.seekVersion
        || latestRoom.lastPositionMs < (chatFeed ? room.lastPositionMs : playheadMs)
        || (chatFeed && (!chatScreening?.authorizeFeed(request.headers['x-owc-chat-feed-token'], room.id)
          || chatFeedHorizon(latestRoom, item) < playheadMs))) {
      throw Object.assign(new Error('Playback changed during this window. Retry at the current playhead.'), { code: 'PLAYBACK_CHANGED' });
    }
    sendJson(response, 200, {
      room: publicSession(room),
      media: publicMediaItem(listIndexedMedia(database).find((candidate) => candidate.id === item.id)),
      window
    });
  } catch (error) {
    sendJson(response, 409, { code: error.code || 'REQUEST_CONFLICT', error: error.message });
  }
  return true;
}
  return false;
}

// Visual analysis, subtitle preparation and background jobs.
async function handlePreparationRoutes({ request, response, url, pathname, signal }) {
const analyzeObservationsMatch = /^\/api\/rooms\/([a-f0-9-]{36})\/observations\/analyze$/.exec(pathname);
if (request.method === 'POST' && analyzeObservationsMatch) {
  const room = getSession(database, analyzeObservationsMatch[1]);
  if (!room) {
    sendJson(response, 404, { code: 'ROOM_UNAVAILABLE', error: 'Room not found.' });
    return true;
  }
  if (room.status !== 'active') {
    sendJson(response, 409, { error: 'Archived rooms are read-only.' });
    return true;
  }
  const item = mediaById.get(room.mediaId);
  if (!item) {
    sendJson(response, 404, { code: 'MEDIA_NOT_FOUND', error: 'The room film is no longer in the media folder.' });
    return true;
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
  return true;
}

const subtitles = /^\/api\/media\/([a-f0-9]{24})\/subtitles(?:\/(prepare|delete))?$/.exec(pathname);
if (subtitles && (subtitles[2] ? request.method === 'POST' : request.method === 'GET')) {
  const item = mediaById.get(subtitles[1]);
  if (!item) { sendJson(response,404,{error:'影片已不在片库。'}); return true; }
  const operation = subtitles[2];
  try {
    if (operation) {
      if (!localLibraryRequest(request)) { sendJson(response,403,{error:'请在本机影院管理字幕。'}); return true; }
      const body = await readJsonBody(request);
      if (operation === 'prepare' && subtitleJobs.active(item.id)) {
        sendJson(response,202,{job:subtitleJobs.get(item.id)});
        return true;
      }
      if (activeJobForMedia(item.id) || activeAiJobForMedia(item.id)) throw new Error('影片正在处理中，请稍后再试。');
      assertFilmReadyForJob(item);
      if (operation === 'prepare' && body.retry === true) {
        const previous = subtitleJobs.get(item.id);
        if (!previous || !['failed','interrupted'].includes(previous.status)) throw new Error('没有可重试的字幕任务。');
        const ids = previous.plannedTrackIds ?? previous.trackIds;
        const selection = ids ? {trackIds:ids} : {languages:previous.languages};
        sendJson(response,202,{job:await subtitleJobs.start(item,selection)});
        return true;
      }
      if (!Array.isArray(body.trackIds) || !body.trackIds.length || body.trackIds.some(id => typeof id !== 'string')) {
        sendJson(response,400,{error:'请至少选择一条字幕。'}); return true;
      }
      const trackIds = [...new Set(body.trackIds)];
      if (operation === 'prepare') {
        const job = await subtitleJobs.start(item,{trackIds});
        sendJson(response,202,{job});
        return true;
      }
      filesystemEdits.add(item.id);
      subtitleDeletions.add(item.id);
      try {
        await deleteFilmSubtitles(item.absolutePath,trackIds);
        await refreshSubtitleTracks(item);
        roomEvents.publish('subtitle-library-changed',null,{mediaId:item.id});
      } finally { subtitleDeletions.delete(item.id); filesystemEdits.delete(item.id); }
    }
    sendJson(response,200,{...await inspectFilmSubtitles(item.absolutePath), job:subtitleJobs.get(item.id)});
  } catch (error) { sendJson(response,error.statusCode || 409,{error:error.message}); }
  return true;
}

const prepareMatch = /^\/api\/media\/([a-f0-9]{24})\/prepare$/.exec(pathname);
if (request.method === 'POST' && prepareMatch) {
  const item = mediaById.get(prepareMatch[1]);
  if (!item) {
    sendJson(response, 404, { error: 'Media not found. Rescan the folder and try again.' });
    return true;
  }
  const body = await readJsonBody(request);
  const job = startCompatibilityJob(item, {
    repairMode: body.repairMode ? String(body.repairMode) : 'safe'
  });
  sendJson(response, 202, { job: publicJob(job) });
  return true;
}

const upgradeMatch = /^\/api\/media\/([a-f0-9]{24})\/upgrade-ai$/.exec(pathname);
if (request.method === 'POST' && upgradeMatch) {
  const item = mediaById.get(upgradeMatch[1]);
  if (!item) { sendJson(response, 404, { error: 'Media not found. Rescan the folder.' }); return true; }
  const body = await readJsonBody(request);
  await refreshAiPackage(item, { signal });
  if (!item.aiPackage?.needsStoryboardUpgrade) {
    sendJson(response, 409, { error: item.aiPackage ? 'This package does not need a legacy upgrade.' : 'The package was removed. Refresh the library and prepare it again.' });
    return true;
  }
  try {
    const settings = await preparationSettings(item, body.storyboardProfile, { upgrading: true });
    signal.throwIfAborted();
    const job = startPackageUpgradeJob(item, {
      settings,
      preferredDialogueTrackId: body.dialogueTrackId ? String(body.dialogueTrackId) : null
    });
    sendJson(response, 202, { job: publicJob(job) });
  } catch (error) { sendJson(response, 409, { code: error.code || 'REQUEST_CONFLICT', error: error.message }); }
  return true;
}

const prepareAiMatch = /^\/api\/media\/([a-f0-9]{24})\/prepare-ai$/.exec(pathname);
if (request.method === 'POST' && prepareAiMatch) {
  const item = mediaById.get(prepareAiMatch[1]);
  if (!item) {
    sendJson(response, 404, { error: 'Media not found. Rescan the folder and try again.' });
    return true;
  }
  const body = await readJsonBody(request);
  try {
    await refreshAiPackage(item, { signal });
    const current = item.aiPackage;
    const upgrading = Boolean(current?.needsStoryboardUpgrade);
    const settings = await preparationSettings(item, body.storyboardProfile, { upgrading });
    signal.throwIfAborted();
    const selected = publicProfile({ imageSettings: settings.imageSettings });
    const changing = upgrading || (current && (
      current.imageSettings?.assetVersion !== settings.imageSettings.assetVersion
      || (body.storyboardProfile && JSON.stringify(selected) !== JSON.stringify(publicProfile(current)))
    ));
    const startJob = changing ? startPackageUpgradeJob : startAiPreparationJob;
    const job = startJob(item, {
      settings, preferredDialogueTrackId: body.dialogueTrackId ? String(body.dialogueTrackId) : null
    });
    sendJson(response, 202, { job: publicJob(job) });
  } catch (error) { sendJson(response, 409, { code: error.code || 'REQUEST_CONFLICT', error: error.message }); }
  return true;
}

const jobMatch = /^\/api\/jobs\/([a-f0-9-]{36})$/.exec(pathname);
if (request.method === 'GET' && jobMatch) {
  const job = compatibilityJobs.get(jobMatch[1]) || aiPreparationJobs.get(jobMatch[1]) || subtitleJobs.find(jobMatch[1]);
  if (!job) {
    sendJson(response, 404, { error: 'Preparation job not found.' });
    return true;
  }
  if (job.kind === 'ai-package') {
    const item = mediaById.get(job.mediaId);
    if (item) job.aiPackage = await refreshAiPackage(item, { signal });
  }
  sendJson(response, 200, { job: publicJob(job) });
  return true;
}
  return false;
}

// Subtitle files, video streaming and the browser application.
async function handleFileRoutes({ request, response, url, pathname, signal }) {
const subtitleMatch = /^\/api\/media\/([a-f0-9]{24})\/subtitles\/([a-z0-9-]+)$/.exec(pathname);
if (request.method === 'GET' && subtitleMatch) {
  const item = mediaById.get(subtitleMatch[1]);
  if (!item) {
    sendText(response, 404, 'Media not found. Rescan the folder and try again.');
    return true;
  }
  await serveSubtitle(response, item, decodeURIComponent(subtitleMatch[2]));
  return true;
}

const streamMatch = /^\/api\/media\/([a-f0-9]{24})\/stream$/.exec(pathname);
if ((request.method === 'GET' || request.method === 'HEAD') && streamMatch) {
  const item = mediaById.get(streamMatch[1]);
  if (!item) {
    sendText(response, 404, 'Media not found. Rescan the folder and try again.');
    return true;
  }
  await streamMedia(request, response, item);
  return true;
}

if (request.method === 'GET' && await serveStatic(pathname, response)) return true;
  return false;
}

// 7. Application lifecycle and request boundary

await cleanup.recover();
await recoverPackageUpgrades(AI_PACKAGES_ROOT);
await rescanMedia();
for (const item of mediaById.values()) {
  await recoverPackageUpgrades(item.episodePath);
  await refreshAiPackage(item);
}
await removeEmptyDirectory(AI_PACKAGES_ROOT);
const catalogTimer = setInterval(() => {
  if (!scanInProgress) void cleanup.recover(true).then(rescanMedia).catch(error => console.error('片库扫描：', error.message));
}, 6500);
catalogTimer.unref();

const server = http.createServer(async (request, response) => {
  const controller = new AbortController();
  const abortRequest = () => {
    if (!response.writableEnded) controller.abort(new DOMException('HTTP client disconnected.', 'AbortError'));
  };
  request.once('aborted', abortRequest);
  response.once('close', abortRequest);
  const signal = controller.signal;
  response.setHeader('x-open-watch-cinema', 'open-watch-cinema');
  try {
    const url = new URL(request.url || '/', `http://${HOST}:${PORT}`);
    const pathname = url.pathname;

    const guarded = /^\/api\/media\/([a-f0-9]{24})(?:\/|$)/.exec(pathname);
    if (request.method !== 'GET' && guarded && filesystemEdits.has(guarded[1])) {
      sendJson(response, 409, { error: '影片正在整理，请稍后重试。' });
      return;
    }
    await dispatchRequest({ request, response, url, pathname, signal });
  } catch (error) {
    if (signal.aborted || response.destroyed) return;
    console.error(error);
    if (!response.headersSent) sendJson(response, 400, { error: error.message || 'Request failed.' });
    else response.destroy(error);
  } finally {
    request.removeListener('aborted', abortRequest);
    response.removeListener('close', abortRequest);
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${server.address().port}`;
  codexScreening.start(url);
  chatScreening?.start(url);
  console.log('');
  console.log('Open Watch Cinema is ready.');
  console.log(`Open: ${url}`);
  console.log(`Media folder: ${MEDIA_ROOT}`);
  console.log('Press Ctrl+C to stop.');
  void openBrowser(url, {
    chooseBrowser: process.argv.includes('--choose-browser'),
    defaultBrowser: process.argv.includes('--default-browser'),
    localDataRoot: LOCAL_DATA_ROOT
  }).then((result) => {
    if (result.reason === 'unavailable') console.log(`Could not open the selected browser. Open ${url} manually.`);
  }).catch(() => {
    console.log(`Could not open a browser. Open ${url} manually.`);
  });
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(catalogTimer);
  await Promise.all([codexScreening.close(), chatScreening?.close()]);
  roomEvents.close();
  server.close(() => {
    aiActivity.close();
    database.close();
    process.exit(0);
  });
  server.closeAllConnections();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
