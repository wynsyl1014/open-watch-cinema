import { createHash } from 'node:crypto';
import { getActiveSession } from './database.mjs';

const KEY = 'watch_bridge_interval_ms';
const MODE_KEY = 'watch_bridge_mode';
const CHAT_KEY = 'watch_bridge_chat';
// Fingerprint of the previous factory text, so edited copies remain custom.
const LEGACY_CHAT_PROMPT_SHA256 = 'ca83fb325a5ce817ef3a896a3f91f81ad8c986ab7bafea7015795fe9282575f2';
const CHAT_CHECKPOINT_KEY = 'watch_bridge_chat_checkpoint';
const CHAT_PLAYBACK_KEY = 'watch_bridge_chat_playback';
export const CHAT_TOOL_DEFAULTS = Object.freeze({ enableManual: false, enableHistory: false, enableControl: false });
const DEFAULT_INTERVAL_MS = 6000;
const MIN_SECONDS = 0.5;
const MAX_SECONDS = 30;
const validSeconds = value => Number.isFinite(value) && value >= MIN_SECONDS && value <= MAX_SECONDS;
const toMilliseconds = value => Math.round(value * 1000);

export function getWatchBridgeSettings(db) {
  const value = Number(db.prepare('select value from settings where key = ?').get(KEY)?.value);
  const intervalMs = Number.isSafeInteger(value) && value >= MIN_SECONDS * 1000 && value <= MAX_SECONDS * 1000
    ? value : DEFAULT_INTERVAL_MS;
  return { intervalMs, intervalSeconds: intervalMs / 1000 };
}

export function setWatchBridgeSettings(db, patch) {
  const value = patch?.intervalSeconds;
  if (!patch || Object.keys(patch).length !== 1 || !validSeconds(value)) {
    throw new TypeError('连续观影间隔须为 0.5 至 30 秒。');
  }
  const intervalMs = toMilliseconds(value);
  db.prepare(`insert into settings (key, value, updated_at) values (?, ?, ?)
    on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`)
    .run(KEY, String(intervalMs), new Date().toISOString());
  return { intervalMs, intervalSeconds: intervalMs / 1000 };
}

export function getWatchBridgeMode(db) {
  return db.prepare('select value from settings where key = ?').get(MODE_KEY)?.value === 'chat' ? 'chat' : 'codex';
}

export function setWatchBridgeMode(db, mode) {
  if (!['codex', 'chat'].includes(mode)) throw new TypeError('无效的连续观影方式。');
  save(db, MODE_KEY, mode);
}

export function getChatBridgeSettings(db) {
  const stored = JSON.parse(db.prepare('select value from settings where key = ?').get(CHAT_KEY)?.value ?? '{}');
  const { batchSeconds, ...settings } = stored ?? {};
  return { enabled: false, instructions: null, lookaheadSeconds: validSeconds(batchSeconds) ? batchSeconds : 0,
    ...CHAT_TOOL_DEFAULTS, ...settings };
}

export function migrateChatBridgeSettings(db) {
  const raw = db.prepare('select value from settings where key = ?').get(CHAT_KEY)?.value;
  const stored = JSON.parse(raw ?? '{}') ?? {};
  const legacyInstructions = typeof stored.instructions === 'string'
    && createHash('sha256').update(stored.instructions).digest('hex') === LEGACY_CHAT_PROMPT_SHA256;
  if (Object.hasOwn(stored, 'batchSeconds') || legacyInstructions) {
    const settings = getChatBridgeSettings(db);
    if (legacyInstructions) settings.instructions = null;
    save(db, CHAT_KEY, JSON.stringify(settings));
  }
}

export function setChatBridgeSettings(db, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)
    || Object.keys(patch).some(key => !['enabled', 'instructions', 'lookaheadSeconds', ...Object.keys(CHAT_TOOL_DEFAULTS)].includes(key))) {
    throw new TypeError('ChatGPT 观影设置无效。');
  }
  const next = { ...getChatBridgeSettings(db), ...patch };
  if (typeof next.enabled !== 'boolean'
    || Object.keys(CHAT_TOOL_DEFAULTS).some(key => typeof next[key] !== 'boolean') || (next.instructions !== null
    && (typeof next.instructions !== 'string' || next.instructions.length > 12000))) {
    throw new TypeError('ChatGPT 观影设置无效。');
  }
  if (next.lookaheadSeconds !== 0 && !validSeconds(next.lookaheadSeconds)) {
    throw new TypeError('提前送达时长须为 0 秒（关闭）或 0.5 至 30 秒。');
  }
  next.lookaheadSeconds = toMilliseconds(next.lookaheadSeconds) / 1000;
  save(db, CHAT_KEY, JSON.stringify(next));
  return next;
}

export function getChatBridgeLookaheadMs(db) {
  return toMilliseconds(getChatBridgeSettings(db).lookaheadSeconds);
}

export function getChatBridgeCheckpoint(db) {
  return JSON.parse(db.prepare('select value from settings where key = ?').get(CHAT_CHECKPOINT_KEY)?.value ?? '[]');
}

export function setChatBridgeCheckpoint(db, sessions) {
  save(db, CHAT_CHECKPOINT_KEY, JSON.stringify(sessions));
}

function save(db, key, value) {
  db.prepare(`insert into settings (key, value, updated_at) values (?, ?, ?)
    on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, value, new Date().toISOString());
}

export function rememberChatPlayback(db, previous, room) {
  const changedSeek = previous?.seekVersion !== room.seekVersion;
  const justPaused = previous?.playbackState === 'playing' && room.playbackState === 'paused';
  if (!changedSeek && !justPaused) return;
  const saved = JSON.parse(db.prepare('select value from settings where key = ?').get(CHAT_PLAYBACK_KEY)?.value ?? 'null');
  const fromMs = changedSeek ? room.lastPositionMs
    : saved?.roomId === room.id && saved.seekVersion === room.seekVersion ? saved.fromMs : room.resumeFromMs ?? 0;
  const throughMs = justPaused && !changedSeek ? room.lastPositionMs : null;
  save(db, CHAT_PLAYBACK_KEY, JSON.stringify({ roomId: room.id, seekVersion: room.seekVersion, fromMs, throughMs,
    pauseVersion: throughMs === null ? null : room.playbackVersion }));
}

export function getWatchBridgeState(db) {
  const room = db.prepare(`
    select id as roomId, playback_state as playbackState, seek_version as seekVersion,
      last_position_ms as playheadMs,
      (select max(id) from watch_messages where session_id = watch_sessions.id and sender_kind = 'user')
        as latestViewerMessageId
    from watch_sessions where status = 'active'
  `).get();
  const chatPlayback = room && JSON.parse(db.prepare('select value from settings where key = ?').get(CHAT_PLAYBACK_KEY)?.value ?? 'null');
  const matchesChatPlayback = chatPlayback?.roomId === room?.roomId && chatPlayback?.seekVersion === room?.seekVersion;
  return {
    roomId: null, playbackState: null, seekVersion: null, playheadMs: null, latestViewerMessageId: null,
    ...room,
    resumeFromMs: room ? getActiveSession(db)?.resumeFromMs ?? null : null,
    ...(chatPlayback && matchesChatPlayback && { chatPlayback }),
    intervalMs: getWatchBridgeSettings(db).intervalMs
  };
}
