import { createHash } from 'node:crypto';

// One cinema-wide viewer preference, persisted in the existing SQLite settings table.
// This selects how often a watching client checks for newly available data;
// the subtitle timeline and storyboard event filters are independent of this rate.
export const VIEWING_CADENCE_KEY = 'ai_viewing_interval_ms';
export const DEFAULT_VIEWING_INTERVAL_MS = 2000;
export const MIN_VIEWING_INTERVAL_MS = 500;
export const MAX_VIEWING_INTERVAL_MS = 30000;

export function validateViewingIntervalSeconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('Viewing interval must be a finite number of seconds.');
  }
  const intervalMs = Math.round(value * 1000);
  if (value < MIN_VIEWING_INTERVAL_MS / 1000
      || value > MAX_VIEWING_INTERVAL_MS / 1000
      || !Number.isSafeInteger(intervalMs)) {
    throw new RangeError('Viewing interval must be between 0.5 and 30 seconds.');
  }
  return intervalMs;
}

export function viewingCadence(intervalMs = DEFAULT_VIEWING_INTERVAL_MS) {
  return {
    intervalMs,
    intervalSeconds: intervalMs / 1000,
    minSeconds: MIN_VIEWING_INTERVAL_MS / 1000,
    maxSeconds: MAX_VIEWING_INTERVAL_MS / 1000,
    dialoguePolicy: 'complete',
    visualPolicy: 'event_selected'
  };
}

export function getViewingCadence(db) {
  const row = db.prepare('select value from settings where key = ?').get(VIEWING_CADENCE_KEY);
  const value = Number(row?.value);
  const intervalMs = Number.isSafeInteger(value)
      && value >= MIN_VIEWING_INTERVAL_MS
      && value <= MAX_VIEWING_INTERVAL_MS
    ? value
    : DEFAULT_VIEWING_INTERVAL_MS;
  return viewingCadence(intervalMs);
}

export function setViewingCadence(db, intervalSeconds) {
  const intervalMs = validateViewingIntervalSeconds(intervalSeconds);
  db.prepare('insert into settings (key, value, updated_at) values (?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at')
    .run(VIEWING_CADENCE_KEY, String(intervalMs), new Date().toISOString());
  return viewingCadence(intervalMs);
}

export const VIEWING_PREFERENCES_KEY = 'ai_viewing_preferences';
const SKIP_PROMPT_KEY = 'skip_intro_outro_prompt';
const AI_ONLINE_TIMEOUT_KEY = 'ai_online_timeout_seconds';
const DEFAULT_AI_ONLINE_TIMEOUT_SECONDS = 30;
export const DEFAULT_INITIAL_BUFFER_MINUTES = 15;

function validAiOnlineTimeout(value) {
  return Number.isInteger(value) && value >= 1 && value <= 300;
}

function validateInitialBufferMinutes(value) {
  if (![15, 30].includes(value)) throw new RangeError('Initial buffer must be 15 or 30 minutes.');
  return value;
}

function storedPreferences(db) {
  const row = db.prepare('select value from settings where key = ?').get(VIEWING_PREFERENCES_KEY);
  try {
    const value = JSON.parse(row?.value || 'null');
    validateInitialBufferMinutes(value?.initialBufferMinutes);
    return value;
  } catch {
    return null;
  }
}

export function getViewingSettings(db) {
  const preferences = storedPreferences(db);
  const cadence = getViewingCadence(db);
  const initialBufferMinutes = preferences?.initialBufferMinutes ?? DEFAULT_INITIAL_BUFFER_MINUTES;
  const values = {
    ...cadence,
    initialBufferMinutes,
    initialBufferMs: initialBufferMinutes * 60_000,
    audioReleasePolicy: 'start',
    includeAudio: typeof preferences?.includeAudio === 'boolean' ? preferences.includeAudio : true,
    skipIntroOutroPrompt: db.prepare('select value from settings where key = ?').get(SKIP_PROMPT_KEY)?.value === 'true',
    configured: preferences !== null
  };
  const timeout = Number(db.prepare('select value from settings where key = ?').get(AI_ONLINE_TIMEOUT_KEY)?.value);
  return {
    ...values,
    aiOnlineTimeoutSeconds: validAiOnlineTimeout(timeout) ? timeout : DEFAULT_AI_ONLINE_TIMEOUT_SECONDS,
    revision: createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 16)
  };
}

export function setViewingSettings(db, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Viewing settings must be an object.');
  const allowed = new Set(['intervalSeconds', 'initialBufferMinutes', 'includeAudio', 'skipIntroOutroPrompt', 'aiOnlineTimeoutSeconds']);
  if (Object.keys(patch).some((key) => !allowed.has(key))) throw new TypeError('Unknown viewing setting.');
  const current = getViewingSettings(db);
  if (Object.hasOwn(patch, 'includeAudio') && typeof patch.includeAudio !== 'boolean') throw new TypeError('includeAudio must be a boolean.');
  const includeAudio = patch.includeAudio ?? current.includeAudio;
  if (Object.hasOwn(patch, 'skipIntroOutroPrompt') && typeof patch.skipIntroOutroPrompt !== 'boolean') {
    throw new TypeError('skipIntroOutroPrompt must be a boolean.');
  }
  if (Object.hasOwn(patch, 'intervalSeconds')) validateViewingIntervalSeconds(patch.intervalSeconds);
  if (Object.hasOwn(patch, 'aiOnlineTimeoutSeconds') && !validAiOnlineTimeout(patch.aiOnlineTimeoutSeconds)) {
    throw new RangeError('AI 在线保留时间须为 1 至 300 秒。');
  }
  const initialBufferMinutes = Object.hasOwn(patch, 'initialBufferMinutes')
    ? validateInitialBufferMinutes(patch.initialBufferMinutes) : current.initialBufferMinutes;
  const savePreferences = current.configured || Object.hasOwn(patch, 'initialBufferMinutes') || Object.hasOwn(patch, 'includeAudio');
  db.exec('begin immediate');
  try {
    if (Object.hasOwn(patch, 'intervalSeconds')) setViewingCadence(db, patch.intervalSeconds);
    const save = db.prepare('insert into settings (key, value, updated_at) values (?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at');
    const now = new Date().toISOString();
    if (savePreferences) save.run(VIEWING_PREFERENCES_KEY, JSON.stringify({ initialBufferMinutes, includeAudio }), now);
    if (Object.hasOwn(patch, 'skipIntroOutroPrompt')) save.run(SKIP_PROMPT_KEY, String(patch.skipIntroOutroPrompt), now);
    if (Object.hasOwn(patch, 'aiOnlineTimeoutSeconds')) save.run(AI_ONLINE_TIMEOUT_KEY, String(patch.aiOnlineTimeoutSeconds), now);
    db.exec('commit');
  } catch (error) {
    db.exec('rollback');
    throw error;
  }
  return getViewingSettings(db);
}
