import { createCleanupDialog } from './cleanup-dialog.js';
import { createLibraryShelf } from './library-shelf.js';
import { createFilmSubtitleSettings, createSubtitlePreferences, subtitleJobSummary } from './film-subtitle-settings.js';
import { createAiActivity } from './ai-activity.js';
import { createAiProfileSettings } from './ai-profile-settings.js';
import { createAiConnectSettings, createChatScreeningSettings, createMcpResumeDialog, createMcpResumePromptSettings, createWatchBridgeSettings, readEnabledViewingMode } from './ai-connect-settings.js';
import { createQuickMessageSettings } from './quick-message-settings.js';
import { createCodexScreeningSettings } from './codex-screening-settings.js';
import { createNotebook } from './notebook.js';
import { createPlaybackSync } from './playback-sync.js';
import { createPlaybackSkip, playbackSkipRanges } from './playback-skip.js';
import { createSkipSettingsEditor, shouldRemindBeforePreparation } from './skip-settings.js';

const SUBTITLE_TIMESTAMP_PATTERN = /^(?:(\d{1,}):)?(\d{2}):(\d{2})\.(\d{3})$/;

function parseSubtitleTimestamp(value) {
  const match = SUBTITLE_TIMESTAMP_PATTERN.exec(String(value || '').trim());
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  return (((hours * 60) + minutes) * 60 + seconds) * 1000 + milliseconds;
}

function formatSubtitleTimestamp(milliseconds) {
  const safe = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const millis = safe % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function flattenSubtitleCueText(text) {
  return String(text || '')
    .replace(/\n+/g, ' ')
    .replace(/[\t ]+/g, ' ')
    .trim();
}

function escapeSubtitleCueText(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function parseWebVtt(text) {
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
    const fromMs = parseSubtitleTimestamp(match[1]);
    const toMs = parseSubtitleTimestamp(match[2]);
    const cueText = lines.slice(timingIndex + 1).join('\n').trim();
    if (fromMs === null || toMs === null || toMs <= fromMs || !cueText) continue;
    cues.push({ fromMs, toMs, text: cueText });
  }
  return cues;
}

function subtitleCueSettings() {
  return 'line:-1 position:50% size:96% align:center';
}

function buildWebVtt(cues, { bilingual = false } = {}) {
  const blocks = cues.map((cue) => {
    const text = bilingual ? cue.text : flattenSubtitleCueText(cue.text);
    return `${formatSubtitleTimestamp(cue.fromMs)} --> ${formatSubtitleTimestamp(cue.toMs)} ${subtitleCueSettings()}\n${text}`;
  });
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}

function styleWebVttForPlayback(text) {
  return buildWebVtt(parseWebVtt(text));
}

function activeSubtitleText(cues, startIndex, fromMs, toMs) {
  let index = startIndex;
  while (index < cues.length && cues[index].toMs <= fromMs) index += 1;
  const pieces = [];
  let cursor = index;
  while (cursor < cues.length && cues[cursor].fromMs < toMs) {
    if (cues[cursor].toMs > fromMs) {
      const text = flattenSubtitleCueText(cues[cursor].text);
      if (text && pieces.at(-1) !== text) pieces.push(text);
    }
    cursor += 1;
  }
  return { index, text: pieces.join(' ') };
}

function mergeBilingualWebVtt(chineseText, englishText) {
  const chineseCues = parseWebVtt(chineseText);
  const englishCues = parseWebVtt(englishText);
  const boundaries = [...new Set([
    ...chineseCues.flatMap((cue) => [cue.fromMs, cue.toMs]),
    ...englishCues.flatMap((cue) => [cue.fromMs, cue.toMs])
  ])].sort((a, b) => a - b);

  const intervals = [];
  let chineseIndex = 0;
  let englishIndex = 0;
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const fromMs = boundaries[index];
    const toMs = boundaries[index + 1];
    if (toMs - fromMs < 40) continue;
    const chinese = activeSubtitleText(chineseCues, chineseIndex, fromMs, toMs);
    const english = activeSubtitleText(englishCues, englishIndex, fromMs, toMs);
    chineseIndex = chinese.index;
    englishIndex = english.index;
    if (!chinese.text && !english.text) continue;

    const lines = [];
    if (chinese.text) lines.push(`<c.zh>${escapeSubtitleCueText(chinese.text)}</c>`);
    if (english.text) lines.push(`<c.en>${escapeSubtitleCueText(english.text)}</c>`);
    const text = lines.join('\n');
    const previous = intervals.at(-1);
    if (previous && previous.toMs === fromMs && previous.text === text) {
      previous.toMs = toMs;
    } else {
      intervals.push({ fromMs, toMs, text });
    }
  }

  return buildWebVtt(intervals, { bilingual: true });
}

const mediaGrid = document.querySelector('#mediaGrid');
const emptyState = document.querySelector('#emptyState');
const mediaCount = document.querySelector('#mediaCount');
const librarySection = document.querySelector('#librarySection');
const libraryBody = document.querySelector('#libraryBody');
const libraryToggle = document.querySelector('#libraryToggle');
const librarySearch = document.querySelector('#librarySearch');
const searchEmpty = document.querySelector('#searchEmpty');
const rescanButton = document.querySelector('#rescanButton');
const serverStatus = document.querySelector('#serverStatus');
const cinemaWorkspace = document.querySelector('#cinemaWorkspace');
const playerShell = document.querySelector('#playerShell');
const playerStage = document.querySelector('#playerStage');
const screenFrame = document.querySelector('#screenFrame');
const screenActions = document.querySelector('#screenActions');
const videoPlayer = document.querySelector('#videoPlayer');
const nowPlayingTitle = document.querySelector('#nowPlayingTitle');
const nowPlayingDetails = document.querySelector('#nowPlayingDetails');
const nowPlayingDuration = document.querySelector('#nowPlayingDuration');
const nowPlayingSubtitles = document.querySelector('#nowPlayingSubtitles');
const playerMessage = document.querySelector('#playerMessage');
const fullscreenButton = document.querySelector('#fullscreenButton');
const viewingSettingsButton = document.querySelector('#viewingSettingsButton');
const viewingSettingsDialog = document.querySelector('#viewingSettingsDialog');
const viewingSettingsForm = document.querySelector('#viewingSettingsForm');
const viewingIntervalInput = document.querySelector('#viewingIntervalInput');
const aiOnlineTimeoutInput = document.querySelector('#aiOnlineTimeoutInput');
const viewingSettingsStatus = document.querySelector('#viewingSettingsStatus');
const viewingSettingsClose = document.querySelector('#viewingSettingsClose');
const viewingSettingsSave = document.querySelector('#viewingSettingsSave');
const viewingSettingsFields = document.querySelector('#viewingSettingsFields');
const viewingSettingsRetry = document.querySelector('#viewingSettingsRetry');
const initialBufferSelect = document.querySelector('#initialBufferSelect');
const filmProfile = document.querySelector('#filmProfile');
const filmHeight = document.querySelector('#filmHeight');
const profileLabels = { economy: '经济', balanced: '均衡', full: '完整' };
const openCleanup = createCleanupDialog({ request: fetchJson, completed: refreshAfterCleanup, formatDate: formatSessionDate });
const subtitlePreferences = createSubtitlePreferences(fetchJson);
const filmSubtitleSettings = createFilmSubtitleSettings({
  request: fetchJson, refreshLibrary: scheduleSubtitleLibraryRefresh, updateJobStatus: updateSubtitleJobStatus
});
const openFilmSkipSettings = createSkipSettingsEditor(document.querySelector('#filmSkipSettingsForm'), {
  request: fetchJson, refresh: refreshLibrary, film: true
});
const collectionSkipDialog = document.querySelector('#collectionSkipSettingsDialog');
document.querySelector('#collectionSkipSettingsClose').onclick = () => collectionSkipDialog.close();
const openCollectionSkipSettings = createSkipSettingsEditor(document.querySelector('#collectionSkipSettingsForm'), {
  request: fetchJson, refresh: refreshLibrary
});
const skipReminderDialog = document.querySelector('#skipReminderDialog');
const playbackSkip = createPlaybackSkip(() => playbackSkipRanges(currentMedia()));

function openFilmSettings(item, restoreFocus, { editSkip = false } = {}) {
  const subtitles = filmSubtitleSettings.open(item, restoreFocus);
  void openFilmSkipSettings(item, { edit: editSkip });
  return subtitles;
}

const shelf = createLibraryShelf({
  manageFilm: openFilmSettings,
  manageRetained: (film, restoreFocus) => openCleanup({ target: { mediaId: film.id }, name: film.title, restoreFocus }),
  manageFolder: (folder, rename, restoreFocus) => openCleanup({
    target: { collectionPath: folder.path }, name: folder.path, collection: true, rename, restoreFocus
  }),
  openFolderSettings(folder, restoreFocus) {
    document.querySelector('#collectionSkipSettingsTitle').textContent = '默认跳过片头片尾 · ' + folder.name;
    collectionSkipDialog.addEventListener('close', restoreFocus, { once: true });
    collectionSkipDialog.showModal();
    void openCollectionSkipSettings(folder);
  },
  request: fetchJson,
  refresh: async () => { await refreshLibrary(); await refreshRooms({ restoreActive: false }); },
  filter: applyMediaFilter,
  getItems: () => currentItems
});
const includeAudioInput = document.querySelector('#includeAudioInput');
const skipIntroOutroPromptInput = document.querySelector('#skipIntroOutroPromptInput');
const audioEnvironmentStatus = document.querySelector('#audioEnvironmentStatus');

const currentAiBuffer = document.querySelector('#currentAiBuffer');
const currentAiBufferLabel = document.querySelector('#currentAiBufferLabel');
const currentAiBufferProgress = document.querySelector('#currentAiBufferProgress');
const currentAiBufferFill = document.querySelector('#currentAiBufferFill');
const currentAiBufferDetail = document.querySelector('#currentAiBufferDetail');
const danmakuLayer = document.querySelector('#danmakuLayer');
const danmakuToggle = document.querySelector('#danmakuToggle');
const subtitleSelect = document.querySelector('#subtitleSelect');
const addSubtitleButton = document.querySelector('#addSubtitleButton');
const subtitleFileInput = document.querySelector('#subtitleFileInput');
const playbackRepairDialog = document.querySelector('#playbackRepairDialog');
const playbackRepairDialogTitle = document.querySelector('#playbackRepairDialogTitle');
const playbackRepairOptions = document.querySelector('#playbackRepairOptions');
const playbackRepairConfirm = document.querySelector('#playbackRepairConfirm');
const aiSubtitleDialog = document.querySelector('#aiSubtitleDialog');
const aiSubtitleDialogTitle = document.querySelector('#aiSubtitleDialogTitle');
const aiSubtitleOptions = document.querySelector('#aiSubtitleOptions');
const quickComposer = document.querySelector('#quickComposer');
const quickMessageInput = document.querySelector('#quickMessageInput');
const dockNote = document.querySelector('#dockNote');
const roomState = document.querySelector('#roomState');
const openRoomButton = document.querySelector('#openRoomButton');
const roomOpeningDialog = document.querySelector('#roomOpeningDialog');
const roomOpeningMessage = document.querySelector('#roomOpeningMessage');
const roomOpeningMessageLabel = document.querySelector('label[for="roomOpeningMessage"]');
const roomOpeningHelp = document.querySelector('#roomOpeningHelp');
const roomOpeningWarning = document.querySelector('#roomOpeningWarning');
const roomOpeningSubmit = document.querySelector('#roomOpeningSubmit');
const roomOpeningRestart = document.querySelector('#roomOpeningRestart');
const endRoomButton = document.querySelector('#endRoomButton');
const sidebarHandle = document.querySelector('#sidebarHandle');
const closeSidebarButton = document.querySelector('#closeSidebarButton');
const unreadBadge = document.querySelector('#unreadBadge');
const sidebarTitle = document.querySelector('#sidebarTitle');
const messagesTab = document.querySelector('#messagesTab');
const sessionsTab = document.querySelector('#sessionsTab');
const messagesPanel = document.querySelector('#messagesPanel');
const sessionsPanel = document.querySelector('#sessionsPanel');
const roomSummaryBox = document.querySelector('#roomSummaryBox');
const roomDrawerBody = document.querySelector('#roomDrawerBody');
const roomDrawerHandle = document.querySelector('#roomDrawerHandle');
const roomExportHint = document.querySelector('#roomExportHint');
const roomSummary = document.querySelector('#roomSummary');
const messageList = document.querySelector('#messageList');
const sidebarComposer = document.querySelector('#sidebarComposer');
const interactionPopover = document.querySelector('#interactionPopover');
const interactionTriggers = [
  document.querySelector('#quickInteractionTrigger'),
  document.querySelector('#sidebarInteractionTrigger')
].filter(Boolean);
const identitySettings = document.querySelector('#identitySettings');
const viewerNameForm = document.querySelector('#viewerNameForm');
const viewerNameSave = document.querySelector('#viewerNameSave');
const viewerNameStatus = document.querySelector('#viewerNameStatus');
const aiProfiles = createAiProfileSettings(fetchJson);
const currentNameLabel = document.querySelector('#currentNameLabel');
const senderNameInput = document.querySelector('#senderNameInput');
const sidebarMessageInput = document.querySelector('#sidebarMessageInput');
const sessionList = document.querySelector('#sessionList');

const STORAGE = {
  danmaku: 'owc-danmaku-enabled',
  senderName: 'owc-sender-name',
  playbackProgress: 'owc-playback-progress-v1',
  subtitleChoices: 'owc-subtitle-choices-v1',
  lastMedia: 'owc-last-media-id',
  libraryCollapsed: 'owc-library-collapsed',
  directPlayReady: 'owc-direct-play-ready-v3'
};

let activeMediaId = null;
let activeMediaPlayable = false;
let currentItems = [];
let activeRoom = null;
let selectedRoom = null;
let rooms = [];
let messages = [];
const expandedSessionGroups = new Set();
let sidebarOpen = false;
let unreadCount = 0;
let messagePollToken = 0;
let messageEvents = null;
let messageEventsConnected = false;
let messageSettingsRefresh = Promise.resolve();
let requestMessageRefresh = null;
let pendingSeekMs = null;
let timelineShown = new Set();
let lastTimelineMs = -1;
const pendingDanmaku = [];
let danmakuFrame = null;
let nextDanmakuLane = 0;
let controlsHideTimer = null;
let lastProgressWriteAt = 0;
let viewingIntervalMs = 2000;
const aiConnect = createAiConnectSettings({
  fetchJson,
  getIntervalSeconds: () => viewingIntervalMs / 1000,
  onOpenGuide: () => openViewingSettings('guide'),
  onOpenBridge: () => void refreshAutomaticViewingSettings()
});
const codexScreeningPanel = document.querySelector('#codexScreeningPanel');
const chatScreeningPanel = document.querySelector('#chatScreeningPanel');
const chatScreeningForm = document.querySelector('#chatScreeningForm');
const chatToolSettings = document.querySelector('#chatToolSettings');
const chatConnectionDetails = document.querySelector('#chatConnectionDetails');
let automaticViewingSelection;
const watchBridge = createWatchBridgeSettings({
  fetchJson,
  onModeChange(mode, saving) {
    codexScreeningPanel.inert = chatScreeningPanel.inert = saving;
    codexScreeningPanel.hidden = mode !== 'codex';
    chatScreeningForm.hidden = chatConnectionDetails.hidden = mode !== 'chat';
    if (automaticViewingSelection === mode) return;
    chatToolSettings.open = mode === 'chat';
    if (automaticViewingSelection === 'codex') codexSettings.clearEnabledDraft();
    if (automaticViewingSelection === 'chat') chatSettings.clearEnabledDraft();
    automaticViewingSelection = mode;
  }
});
const mcpResumePromptSettings = createMcpResumePromptSettings({ fetchJson });
const mcpResumeDialog = createMcpResumeDialog();
const codexSettings = createCodexScreeningSettings({ fetchJson, onSaving: watchBridge.setAdapterSaving });
const chatSettings = createChatScreeningSettings({
  fetchJson,
  onAvailability(available) {
    chatScreeningPanel.hidden = !available && automaticViewingSelection !== 'chat';
    watchBridge.setChatAvailable(available);
  },
  onSaving: watchBridge.setAdapterSaving
});

async function refreshAutomaticViewingSettings() {
  await watchBridge.refresh();
  await Promise.all([codexSettings.refresh(), chatSettings.refresh()]);
}
const quickMessages = createQuickMessageSettings({
  fetchJson,
  onOpenSettings: () => void openViewingSettings('quick-messages'),
  isRoomWritable: () => roomIsWritable()
});
let roomOpeningPending = false;
let pendingRoomStart = null;
let viewingSettings = null;
let viewingSettingsLoading = false;
let viewingSettingsSaving = false;
let viewingSettingsRequest = 0;
const aiPreparationPolls = new Map();
// Page-session results survive library refreshes, without persisting stale package state.
const aiUpgradeResults = new Map();
const aiPreparationResults = new Map();
const aiPreparationPollErrors = new Map();
const aiPreparationStarting = new Set();
let playbackHeartbeatTimer = null;
let bridgePlaybackSample = null;
let danmakuEnabled = localStorage.getItem(STORAGE.danmaku) !== 'false';
let playbackProgress = readStoredObject(STORAGE.playbackProgress);
let subtitleChoices = readStoredObject(STORAGE.subtitleChoices);
let directPlayReady = readStoredObject(STORAGE.directPlayReady);
let activeSubtitleObjectUrls = [];
let subtitleLoadToken = 0;

let viewerProfile = { displayName: '', name: 'user' };
let nameDraftDirty = false;
let nameRevision = 0;
let nameReadSerial = 0;
let savingViewer = false;
let participantRefreshSerial = 0;
let viewingDraftDirty = false;

function readStoredObject(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoredObject(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function mediaPlaybackFingerprint(item) {
  return `${item?.size || 0}:${item?.modifiedAt || ''}`;
}

function browserDirectPlayReady(item) {
  return Boolean(item && directPlayReady[item.id] === mediaPlaybackFingerprint(item));
}

function markBrowserDirectPlayReady(item) {
  if (!item) return;
  directPlayReady[item.id] = mediaPlaybackFingerprint(item);
  writeStoredObject(STORAGE.directPlayReady, directPlayReady);
}

function clearBrowserDirectPlayReady(item) {
  if (!item || !(item.id in directPlayReady)) return;
  delete directPlayReady[item.id];
  writeStoredObject(STORAGE.directPlayReady, directPlayReady);
}

function playbackReadyForCurrentBrowser(item) {
  return Boolean(item && (item.compatibilityStatus === 'ready' || browserDirectPlayReady(item)));
}

function canConfirmDirectPlay(item) {
  return Boolean(
    item
    && item.id === activeMediaId
    && activeMediaPlayable
    && item.compatibilityStatus !== 'ready'
    && !browserDirectPlayReady(item)
  );
}

function confirmDirectPlayReady(item) {
  if (!canConfirmDirectPlay(item)) return;
  markBrowserDirectPlayReady(item);
  renderMedia(currentItems);
  renderRoomState();
  setPlayerNotice('已确认此浏览器可以正常播放画面和声音。');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '大小未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatFilmTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatSessionDate(value) {
  if (!value) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function formatSessionRowDate(value) {
  if (!value) return '时间未知';
  const date = new Date(value);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat('zh-CN', {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function sessionGroupKey(room) {
  return room?.mediaId || room?.mediaTitle || 'unknown';
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      cache: 'no-store',
      ...options,
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
  } catch (cause) {
    if (options.signal?.aborted) throw cause;
    throw Object.assign(new Error('The cinema connection is unavailable. Check that the projector is running.', { cause }), {
      code: 'CONNECTION_FAILED'
    });
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw Object.assign(new Error(payload?.error || 'Request failed with ' + response.status), {
      code: payload?.code || 'CINEMA_REQUEST_FAILED',
      status: response.status,
      fields: payload?.fields,
      current: payload?.current
    });
  }
  if (!payload || typeof payload !== 'object') {
    throw Object.assign(new Error('The cinema returned an unreadable response.'), { code: 'INVALID_RESPONSE' });
  }
  return payload;
}

function installPlaybackHeartbeat() {
  if (playbackHeartbeatTimer !== null) clearInterval(playbackHeartbeatTimer);
  playbackHeartbeatTimer = setInterval(() => {
    if (activeRoom && !videoPlayer.paused) schedulePlaybackSync();
  }, viewingIntervalMs);
}

function setViewingSettingsStatus(message, isError = false) {
  viewingSettingsStatus.textContent = message;
  viewingSettingsStatus.classList.toggle('error', isError);
}

function syncViewingSettingsControls() {
  const busy = viewingSettingsLoading || viewingSettingsSaving;
  viewingSettingsFields.disabled = busy || !viewingSettings;
  viewingSettingsSave.disabled = busy || !viewingSettings;
  viewingSettingsRetry.disabled = busy;
}

function applyViewingCadence(settings) {
  const intervalMs = Number(settings?.intervalMs);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 500 || intervalMs > 30000) {
    throw new Error('影院返回的检查间隔无效。');
  }
  for (const input of [viewingIntervalInput, initialBufferSelect]) input.setCustomValidity('');
  viewingSettings = settings;
  includeAudioInput.checked = settings.includeAudio !== false;
  skipIntroOutroPromptInput.checked = settings.skipIntroOutroPrompt === true;
  for (const item of currentItems) updateAiPreparationCard(item);
  renderCurrentAiBuffer();
  viewingIntervalMs = intervalMs;
  viewingIntervalInput.value = String(intervalMs / 1000);
  aiOnlineTimeoutInput.value = String(settings.aiOnlineTimeoutSeconds ?? 30);
  initialBufferSelect.value = settings.initialBufferMinutes == null ? '' : String(settings.initialBufferMinutes);
  viewingSettingsButton.title = '影院设置';
  viewingSettingsButton.setAttribute('aria-label', '影院设置');
  installPlaybackHeartbeat();
  aiConnect.syncInterval();
}

async function loadViewingCadence({ promptInitial = false } = {}) {
  if (viewingSettingsSaving) return viewingSettings;
  const request = ++viewingSettingsRequest;
  viewingSettingsLoading = true;
  viewingSettingsRetry.hidden = true;
  syncViewingSettingsControls();
  setViewingSettingsStatus('正在读取观影设置…');
  try {
    const { settings } = await fetchJson('/api/viewing-settings');
    if (request !== viewingSettingsRequest) return null;
    viewingDraftDirty = false;
    applyViewingCadence(settings);
    void refreshAudioEnvironment();
    setViewingSettingsStatus(settings.configured
      ? '已读取保存的设置。修改后点击“保存设置”生效。'
      : '先选择起步缓冲，保存后就可以准备一起看。');
    if (promptInitial && !settings.configured && !viewingSettingsDialog.open) {
      showSettingsPage('viewing');
      viewingSettingsDialog.showModal();
    }
    return settings;
  } catch (error) {
    if (request !== viewingSettingsRequest) return null;
    viewingSettings = null;
    viewingSettingsRetry.hidden = false;
    setViewingSettingsStatus(error.code === 'CONNECTION_FAILED'
      ? '暂时连接不到影院，设置还没有读取。恢复连接后点击“重新读取”。'
      : '未能读取观影设置，请重新读取。', true);
    throw error;
  } finally {
    if (request === viewingSettingsRequest) {
      viewingSettingsLoading = false;
      syncViewingSettingsControls();
    }
  }
}

async function refreshAudioEnvironment() {
  audioEnvironmentStatus.textContent = '正在检查本地声音描述环境…';
  try {
    const { audio } = await fetchJson('/api/observer/status');
    audioEnvironmentStatus.textContent = audio?.status === 'available'
      ? '本地声音模型已就绪。' : '本地声音模型尚未就绪。可先关闭声音描述，或按安装指南配置后再准备影片。';
  } catch {
    audioEnvironmentStatus.textContent = '暂时无法检查声音环境，请确认影院服务已启动。';
  }
}

async function loadViewingGuide() {
  const content = document.querySelector('#viewingGuideContent');
  if (content.childElementCount || content.getAttribute('aria-busy') === 'true') return;
  const status = document.querySelector('#viewingGuideStatus');
  const retry = document.querySelector('#viewingGuideRetry');
  retry.hidden = true;
  content.setAttribute('aria-busy', 'true');
  status.textContent = '正在读取观影指南…';
  try {
    const response = await fetch('/viewing-guide.md');
    if (!response.ok) throw new Error('Guide unavailable');
    const blocks = (await response.text()).trim().split(/\r?\n\s*\r?\n/);
    const guide = document.createDocumentFragment();
    for (const block of blocks) {
      if (block.startsWith('# ')) continue;
      const heading = block.startsWith('## ');
      const node = document.createElement(heading ? 'h3' : 'p');
      node.textContent = heading ? block.slice(3) : block;
      guide.append(node);
    }
    content.replaceChildren(guide);
    status.textContent = '';
  } catch {
    status.textContent = '暂时读不到本机指南，请确认影院服务仍在运行。';
    retry.hidden = false;
  } finally {
    content.setAttribute('aria-busy', 'false');
  }
}
document.querySelector('#viewingGuideRetry').addEventListener('click', loadViewingGuide);

function showSettingsPage(page) {
  document.querySelector('#settingsNames').hidden = page !== 'names';
  document.querySelector('#settingsViewing').hidden = page !== 'viewing';
  document.querySelector('#settingsConnect').hidden = page !== 'connect';
  document.querySelector('#settingsGuide').hidden = page !== 'guide';
  document.querySelector('#settingsSubtitles').hidden = page !== 'subtitles';
  document.querySelector('#settingsQuickMessages').hidden = page !== 'quick-messages';
  for (const button of viewingSettingsDialog.querySelectorAll('[data-settings-page]')) {
    button.setAttribute('aria-pressed', String(button.dataset.settingsPage === page));
  }
}

async function openViewingSettings(page = 'viewing') {
  showSettingsPage(page);
  if (!viewingSettingsDialog.open) viewingSettingsDialog.showModal();
  if (page === 'names') {
    await Promise.all([aiProfiles.refresh(), refreshViewerName().catch(() => {
      viewerNameStatus.textContent = '未能读取观众名字，请重新打开设置。';
    })]);
  } else if (page === 'connect') {
    await Promise.all([aiConnect.refresh(), refreshAutomaticViewingSettings(), mcpResumePromptSettings.refresh()]);
  } else if (page === 'guide') {
    await loadViewingGuide();
  } else if (page === 'subtitles') {
    await subtitlePreferences.load();
  } else if (page === 'quick-messages') {
    await quickMessages.refresh();
  } else if (!viewingDraftDirty && !viewingSettingsSaving) {
    await loadViewingCadence().catch(() => {});
  }
}

function currentMedia() {
  return currentItems.find((item) => item.id === activeMediaId) || null;
}

function removeSubtitleTracks({ revokeObjects = true } = {}) {
  videoPlayer.querySelectorAll('track[data-owc-subtitle]').forEach((track) => track.remove());
  if (revokeObjects) {
    activeSubtitleObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    activeSubtitleObjectUrls = [];
  }
}

function createSubtitleObjectUrl(webVtt) {
  const url = URL.createObjectURL(new Blob([webVtt], { type: 'text/vtt' }));
  activeSubtitleObjectUrls.push(url);
  return url;
}

async function fetchSubtitleText(track) {
  const response = await fetch(track.url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Subtitle request failed with ${response.status}.`);
  return response.text();
}

function bilingualPair(item) {
  const tracks = item?.subtitleTracks || [];
  const chinese = tracks.find((track) => (
    /^(chi|zho|zh)(-|$)/i.test(track.language || '')
    && /simplified|简体/i.test(`${track.title || ''} ${track.label || ''}`)
  )) || tracks.find((track) => /^(chi|zho|zh)(-|$)/i.test(track.language || '') && track.default)
    || tracks.find((track) => /^(chi|zho|zh)(-|$)/i.test(track.language || ''));
  const english = tracks.find((track) => /^(eng|en)(-|$)/i.test(track.language || ''));
  return chinese && english ? { chinese, english } : null;
}

function bilingualChoiceValue(item) {
  const pair = bilingualPair(item);
  return pair ? `bilingual:${pair.chinese.id}+${pair.english.id}` : null;
}

function srtToWebVtt(text) {
  const normalized = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (/^WEBVTT(?:\s|$)/i.test(normalized)) return `${normalized}\n`;
  if (!/\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}/.test(normalized)) {
    throw new Error('This subtitle is not a recognizable SRT or WebVTT file.');
  }
  return `WEBVTT\n\n${normalized.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}\n`;
}

function subtitleOptionLabel(track) {
  const language = track.language && track.language !== 'und' ? track.language.toUpperCase() : '';
  const label = track.title || track.label || 'Subtitle';
  return [label, language].filter(Boolean).join(' · ');
}

function preferredAiDialogueTrackId(item) {
  const tracks = item?.subtitleTracks || [];
  const stored = String(subtitleChoices[item?.id] || '');
  if (stored.startsWith('server:')) {
    const trackId = stored.slice('server:'.length);
    if (tracks.some((track) => track.id === trackId)) return trackId;
  }
  if (stored.startsWith('bilingual:')) {
    const chineseTrackId = bilingualPair(item)?.chinese?.id;
    if (chineseTrackId && tracks.some((track) => track.id === chineseTrackId)) return chineseTrackId;
  }
  return tracks.find((track) => track.default)?.id || tracks[0]?.id || null;
}

function choosePlaybackRepair(item) {
  playbackRepairDialogTitle.textContent = `检查《${item.title}》的播放`;
  const inputs = [...playbackRepairOptions.querySelectorAll('input[name="playbackRepair"]')];
  for (const input of inputs) input.checked = false;
  playbackRepairConfirm.disabled = true;

  return new Promise((resolve) => {
    const handleChange = () => {
      playbackRepairConfirm.disabled = !playbackRepairOptions.querySelector('input[name="playbackRepair"]:checked');
    };
    const handleCancel = (event) => {
      event.preventDefault();
      playbackRepairDialog.close('cancel');
    };
    const handleClose = () => {
      playbackRepairDialog.removeEventListener('cancel', handleCancel);
      playbackRepairOptions.removeEventListener('change', handleChange);
      const selected = playbackRepairOptions.querySelector('input[name="playbackRepair"]:checked');
      resolve(playbackRepairDialog.returnValue === 'confirm' ? selected?.value || undefined : undefined);
    };
    playbackRepairOptions.addEventListener('change', handleChange);
    playbackRepairDialog.addEventListener('cancel', handleCancel, { once: true });
    playbackRepairDialog.addEventListener('close', handleClose, { once: true });
    playbackRepairDialog.showModal();
  });
}

function chooseAiDialogueTrack(item) {
  const tracks = item?.subtitleTracks || [];
  const upgrading = item.aiPackage?.needsStoryboardUpgrade;
  const saved = item.aiPackage?.imageSettings;
  filmProfile.replaceChildren();
  for (const [value, label] of Object.entries(profileLabels)) filmProfile.add(new Option(label, value));
  filmProfile.value = saved?.mode || 'balanced';
  filmHeight.value = String(saved?.storyboardHeight || 480);
  const updateProfile = () => {
    document.getElementById('filmHeightLabel').hidden = filmProfile.value !== 'full';
    const help = document.getElementById('filmProfileHelp');
    const descriptions = {
      economy: '画面静止时留一格，有动作时追加小全景。只保存成品分镜。',
      balanced: '保留场景和关键动作，局部可嵌入或分开发送。只保存分镜。',
      full: '选择全景高度。细小变化从原片裁出放大，随全景嵌入或单发。'
    };
    help.textContent = descriptions[filmProfile.value];
  };
  filmProfile.onchange = updateProfile;
  updateProfile();
  aiSubtitleDialogTitle.textContent = (upgrading ? '升级观影包 · ' : '准备观影包 · ') + item.title;
  document.getElementById('aiSubtitleConfirm').textContent = upgrading ? '确认升级' : '准备观影包';
  const upgradeHelp = document.getElementById('filmUpgradeHelp');
  upgradeHelp.hidden = !upgrading;
  if (upgrading) {
    const audioHelp = !viewingSettings.includeAudio ? '声音描述已关闭。'
      : viewingSettings.configured ? '声音描述已开启，需要本地声音模型。'
      : '声音描述默认开启。首次升级若尚未安装声音模型，本次先准备画面和对白，装好后点「继续准备」补声音。';
    upgradeHelp.textContent = '新版通过校验后会替换本片的旧包。' + audioHelp;
  }
  aiSubtitleOptions.replaceChildren();
  const savedTrackId = item.aiPackage?.dialogueTrack?.sourceTrack?.id;
  const preferredTrackId = upgrading && tracks.some(track => track.id === savedTrackId)
    ? savedTrackId : preferredAiDialogueTrackId(item);
  if (!tracks.length) aiSubtitleOptions.textContent = '本片暂无可用的对白字幕。';

  for (const track of tracks) {
    const option = document.createElement('label');
    option.className = 'ai-subtitle-option';

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'aiDialogueTrack';
    input.value = track.id;
    input.checked = track.id === preferredTrackId;

    const label = document.createElement('span');
    const notes = [track.default ? '默认' : null, track.forced ? '强制显示' : null].filter(Boolean);
    label.textContent = `${subtitleOptionLabel(track)}${notes.length ? ` · ${notes.join(', ')}` : ''}`;
    option.append(input, label);
    aiSubtitleOptions.append(option);
  }

  return new Promise((resolve) => {
    const handleCancel = (event) => {
      event.preventDefault();
      aiSubtitleDialog.close('cancel');
    };
    const handleClose = () => {
      aiSubtitleDialog.removeEventListener('cancel', handleCancel);
      const selected = aiSubtitleOptions.querySelector('input[name="aiDialogueTrack"]:checked');
      const mode = filmProfile.value;
      const storyboardProfile = mode === 'full' ? { mode, height: Number(filmHeight.value) } : { mode };
      resolve(aiSubtitleDialog.returnValue === 'confirm' ? { dialogueTrackId: selected?.value || null, storyboardProfile } : undefined);
    };
    aiSubtitleDialog.addEventListener('cancel', handleCancel, { once: true });
    aiSubtitleDialog.addEventListener('close', handleClose, { once: true });
    aiSubtitleDialog.showModal();
  });
}

// Subtitle preferences belong to the local viewer. All text tracks share the
// same visible picture rectangle, including when the video is letterboxed.
const subtitleDisplay = (() => {
  const key = 'owc-subtitle-scale-v1';
  const steps = [75, 85, 100, 115, 130, 150, 175, 200];
  const trigger = document.querySelector('#subtitleSizeButton');
  const panel = document.querySelector('#subtitleSizePanel');
  const smaller = document.querySelector('#subtitleSmaller');
  const larger = document.querySelector('#subtitleLarger');
  const scale = document.querySelector('#subtitleScale');
  let percent = Number(localStorage.getItem(key));
  if (!steps.includes(percent)) percent = 100;
  let letterboxed = false;
  let line = 95;
  let cueWidth = 96;

  function positionActiveCues(track) {
    for (const cue of track.activeCues || []) {
      const targetSnapToLines = !letterboxed;
      const targetLine = letterboxed ? line : -1;
      const targetSize = letterboxed ? 100 : cueWidth;
      // Only use percentage lines when the video has top/bottom letterbox bars.
      // In Chromium <= 144, snapToLines=false applies translate(-left%, -top%),
      // which shifts any cue narrower than 100% to the left.
      if (cue.snapToLines !== targetSnapToLines) cue.snapToLines = targetSnapToLines;
      if (cue.line !== targetLine) cue.line = targetLine;
      if (cue.position !== 50) cue.position = 50;
      if (cue.align !== 'center') cue.align = 'center';
      if (cue.size !== targetSize) cue.size = targetSize;
      if ('lineAlign' in cue) {
        const targetLineAlign = letterboxed ? 'end' : 'start';
        if (cue.lineAlign !== targetLineAlign) cue.lineAlign = targetLineAlign;
      }
    }
  }

  function layout() {
    const { clientWidth: width, clientHeight: height, videoWidth, videoHeight } = videoPlayer;
    if (!width || !height || !videoWidth || !videoHeight) return;
    const fit = Math.min(width / videoWidth, height / videoHeight);
    const pictureHeight = videoHeight * fit;
    const autoSize = Math.max(16, pictureHeight * .0375);
    videoPlayer.style.setProperty('--subtitle-font-size', (autoSize * percent / 100).toFixed(2) + 'px');
    letterboxed = height - pictureHeight > 2;
    line = Number((50 + 45 * pictureHeight / height).toFixed(3));
    cueWidth = Number(Math.max(1, Math.min(96, 96 * videoWidth * fit / width)).toFixed(3));
    for (const element of videoPlayer.querySelectorAll('track[data-owc-subtitle]')) {
      positionActiveCues(element.track);
    }
  }

  function refreshControls() {
    scale.textContent = percent + '%';
    smaller.disabled = percent === steps[0];
    larger.disabled = percent === steps.at(-1);
  }
  function choose(next) {
    percent = next;
    if (percent === 100) localStorage.removeItem(key);
    else localStorage.setItem(key, String(percent));
    refreshControls();
    layout();
  }
  function placePanel() {
    if (!panel.matches(':popover-open')) return;
    const anchor = trigger.getBoundingClientRect();
    const x = Math.max(4, Math.min(anchor.left, window.innerWidth - panel.offsetWidth - 4));
    const y = anchor.top >= panel.offsetHeight + 6
      ? anchor.top - panel.offsetHeight - 6 : anchor.bottom + 6;
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
  }
  smaller.onclick = () => choose(steps[steps.indexOf(percent) - 1]);
  larger.onclick = () => choose(steps[steps.indexOf(percent) + 1]);
  document.querySelector('#subtitleSizeAuto').onclick = () => choose(100);
  panel.addEventListener('toggle', placePanel);
  window.addEventListener('scroll', placePanel, { passive: true, capture: true });
  new ResizeObserver(() => { layout(); placePanel(); }).observe(videoPlayer);
  videoPlayer.addEventListener('loadedmetadata', layout);
  videoPlayer.addEventListener('resize', layout);
  refreshControls();
  return { positionActiveCues };
})();

function appendSubtitleTrack({ src, label, language = 'und' }) {
  const element = document.createElement('track');
  element.dataset.owcSubtitle = 'true';
  element.kind = 'subtitles';
  element.label = label;
  element.srclang = language;
  element.src = src;
  element.default = true;
  element.track.addEventListener('cuechange', () => subtitleDisplay.positionActiveCues(element.track));
  element.addEventListener('load', () => {
    element.track.mode = 'showing';
    subtitleDisplay.positionActiveCues(element.track);
  }, { once: true });
  element.addEventListener('error', () => {
    setPlayerNotice('字幕轨载入失败。', true);
  }, { once: true });
  videoPlayer.append(element);
  queueMicrotask(() => {
    try {
      element.track.mode = 'showing';
    } catch {
      // The load listener will enable it when the browser finishes parsing WebVTT.
    }
  });
}

function renderSubtitleOptions(item, { localLabel = null, selectedValue = 'off' } = {}) {
  subtitleSelect.replaceChildren();
  const off = document.createElement('option');
  off.value = 'off';
  off.textContent = '字幕关闭';
  subtitleSelect.append(off);

  const bilingualValue = bilingualChoiceValue(item);
  if (bilingualValue) {
    const option = document.createElement('option');
    option.value = bilingualValue;
    option.textContent = '双语 · 中文 + English';
    subtitleSelect.append(option);
  }

  const tracks = item?.subtitleTracks || [];
  for (const track of tracks) {
    const option = document.createElement('option');
    option.value = `server:${track.id}`;
    option.textContent = subtitleOptionLabel(track);
    subtitleSelect.append(option);
  }

  if (localLabel) {
    const option = document.createElement('option');
    option.value = 'local';
    option.textContent = `${localLabel} · local`;
    subtitleSelect.append(option);
  }

  subtitleSelect.disabled = !item;
  subtitleSelect.value = [...subtitleSelect.options].some((option) => option.value === selectedValue)
    ? selectedValue
    : 'off';
  addSubtitleButton.disabled = !item;
  const trackCount = tracks.length + Number(Boolean(localLabel));
  nowPlayingSubtitles.hidden = trackCount === 0;
  nowPlayingSubtitles.textContent = trackCount ? `字幕 ${trackCount} 轨` : '';
  nowPlayingDetails.hidden = nowPlayingDuration.hidden && nowPlayingSubtitles.hidden;
}

function preferredSubtitleChoice(item) {
  const stored = String(subtitleChoices[item.id] || '');
  if (stored === 'off') return 'off';
  if (stored.startsWith('bilingual:') && stored === bilingualChoiceValue(item)) return stored;
  if (stored.startsWith('server:')) {
    const id = stored.slice('server:'.length);
    if ((item.subtitleTracks || []).some((track) => track.id === id)) return stored;
  }
  const defaultTrack = (item.subtitleTracks || []).find((track) => track.default)
    || (item.subtitleTracks || [])[0];
  return defaultTrack ? `server:${defaultTrack.id}` : 'off';
}

async function applySubtitleChoice(choice, { persist = true } = {}) {
  const item = currentMedia();
  const mediaId = item?.id || null;
  const token = ++subtitleLoadToken;
  removeSubtitleTracks();
  if (!item) {
    renderSubtitleOptions(null);
    return;
  }

  renderSubtitleOptions(item, { selectedValue: choice });
  try {
    if (choice.startsWith('bilingual:')) {
      const pair = bilingualPair(item);
      if (!pair || choice !== bilingualChoiceValue(item)) throw new Error('The bilingual subtitle pair is unavailable.');
      const [chineseText, englishText] = await Promise.all([
        fetchSubtitleText(pair.chinese),
        fetchSubtitleText(pair.english)
      ]);
      if (token !== subtitleLoadToken || currentMedia()?.id !== mediaId) return;
      const src = createSubtitleObjectUrl(mergeBilingualWebVtt(chineseText, englishText));
      appendSubtitleTrack({ src, label: '简中 + English', language: 'mul' });
    } else if (choice.startsWith('server:')) {
      const id = choice.slice('server:'.length);
      const track = (item.subtitleTracks || []).find((candidate) => candidate.id === id);
      if (!track) throw new Error('The selected subtitle track is unavailable.');
      const text = await fetchSubtitleText(track);
      if (token !== subtitleLoadToken || currentMedia()?.id !== mediaId) return;
      const src = createSubtitleObjectUrl(styleWebVttForPlayback(text));
      appendSubtitleTrack({
        src,
        label: track.label || track.title || track.language || 'Subtitle',
        language: track.language || 'und'
      });
    }

    if (persist) {
      subtitleChoices[item.id] = choice;
      writeStoredObject(STORAGE.subtitleChoices, subtitleChoices);
    }
  } catch (error) {
    if (token !== subtitleLoadToken) return;
    removeSubtitleTracks();
    renderSubtitleOptions(item, { selectedValue: 'off' });
    setPlayerNotice(error.message, true);
  }
}

function setupSubtitles(item) {
  subtitleLoadToken += 1;
  removeSubtitleTracks();
  if (!item) {
    renderSubtitleOptions(null);
    return;
  }
  const choice = preferredSubtitleChoice(item);
  renderSubtitleOptions(item, { selectedValue: choice });
  void applySubtitleChoice(choice, { persist: false });
}

async function addLocalSubtitle(file) {
  const item = currentMedia();
  if (!item || !file) return;
  const extension = file.name.toLocaleLowerCase().split('.').at(-1);
  if (!['srt', 'vtt'].includes(extension)) {
    throw new Error('Choose an SRT or VTT subtitle file.');
  }

  const webVtt = styleWebVttForPlayback(srtToWebVtt(await file.text()));
  subtitleLoadToken += 1;
  removeSubtitleTracks();
  const src = createSubtitleObjectUrl(webVtt);
  renderSubtitleOptions(item, { localLabel: file.name, selectedValue: 'local' });
  appendSubtitleTrack({
    src,
    label: file.name,
    language: 'und'
  });
  subtitleSelect.value = 'local';
}

function roomIsWritable() {
  return Boolean(selectedRoom && activeRoom && selectedRoom.id === activeRoom.id && selectedRoom.status === 'active');
}

function setPlayerNotice(text, isError = false) {
  playerMessage.textContent = text;
  playerMessage.hidden = !text;
  playerMessage.classList.toggle('error', isError);
}

function setNowPlayingTitle(item) {
  setNowPlayingDuration(item?.aiPackage?.durationMs);
  if (!item) {
    nowPlayingTitle.textContent = '尚未选片';
    nowPlayingTitle.removeAttribute('title');
    return;
  }
  nowPlayingTitle.textContent = item.title;
  nowPlayingTitle.title = item.title;
}

function setNowPlayingDuration(durationMs) {
  nowPlayingDuration.hidden = !Number.isFinite(durationMs) || durationMs <= 0;
  nowPlayingDuration.textContent = nowPlayingDuration.hidden ? '' : `片长 ${formatFilmTime(durationMs)}`;
  nowPlayingDetails.hidden = nowPlayingDuration.hidden && nowPlayingSubtitles.hidden;
}

function normalizeSearch(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().trim();
}

function updateCount(total, visible = total) {
  const filtered = Boolean(normalizeSearch(librarySearch.value));
  if (filtered) {
    mediaCount.textContent = `${visible} / ${total} 部`;
    return;
  }
  mediaCount.textContent = `${total} 部`;
}

function setLibraryCollapsed(collapsed, { persist = true } = {}) {
  librarySection.classList.toggle('collapsed', collapsed);
  libraryToggle.setAttribute('aria-expanded', String(!collapsed));
  libraryToggle.setAttribute('title', collapsed ? '展开片库' : '收起片库');
  libraryToggle.querySelector('i[aria-hidden="true"]').textContent = collapsed ? '⌄' : '⌃';
  libraryBody.setAttribute('aria-hidden', String(collapsed));
  libraryBody.inert = collapsed;
  if (persist) localStorage.setItem(STORAGE.libraryCollapsed, String(collapsed));
}

function syncLibraryBrowseHeight() {
  const top = Math.round(cinemaWorkspace.getBoundingClientRect().top + window.scrollY);
  cinemaWorkspace.style.setProperty('--cinema-workspace-top', `${top}px`);
  const height = Math.round(cinemaWorkspace.getBoundingClientRect().height);
  if (height > 0) librarySection.style.setProperty('--cinema-workspace-height', `${height}px`);
}

function applyMediaFilter() {
  const query = normalizeSearch(librarySearch.value);
  const visible = [];
  let total = 0;

  document.querySelectorAll('.media-card').forEach((card) => {
    const inFolder = card.dataset.collection === shelf.path;
    if (inFolder) total += 1;
    const matches = inFolder && (!query || card.dataset.searchText.includes(query));
    card.hidden = !matches;
    if (matches) visible.push(card.dataset.mediaId);
  });

  emptyState.hidden = total > 0 || document.getElementById('shelfFolders').childElementCount > 0 || document.getElementById('retainedFilms').childElementCount > 0;
  searchEmpty.hidden = !query || total === 0 || visible.length > 0;
  shelf.visible(visible);
  updateCount(total, visible.length);
}

function compatibilityLabel(item) {
  if (playbackReadyForCurrentBrowser(item)) return '可播放';
  switch (item.compatibilityStatus) {
    case 'checking': return '正在检查编码';
    case 'processing': return '正在修复播放';
    case 'prepared': return '请重新试播';
    case 'error': return '播放修复失败';
    default: return '待试播';
  }
}

function compatibilityBadgeStatus(item) {
  return playbackReadyForCurrentBrowser(item)
    ? 'ready'
    : item.compatibilityStatus || 'unchecked';
}

function formatProgressPercent(value) {
  const clamped = Math.max(0, Math.min(100, Number(value) || 0));
  if (clamped >= 100) return '100%';
  return `${clamped.toFixed(1)}%`;
}

function aiPackageLabel(item) {
  const aiPackage = item.aiPackage;
  if (!aiPackage) return '尚未准备观影包';
  if (aiPackage.status === 'failed' || aiPackage.status === 'error') return '观影包准备失败';
  if (aiPackage.status === 'ready') {
    const mode = aiPackage.aiReadiness?.experienceMode;
    if (mode === 'visual_only') return '画面已就绪';
    if (mode === 'dialogue_only') return '对白已就绪';
    return aiPackage.audioTrack?.status === 'ready' ? '观影包已就绪，含声音描述' : '观影包已就绪';
  }
  if (aiPackage.canStartViewing) {
    const percent = typeof aiPackage.progress?.percent === 'number' && Number.isFinite(aiPackage.progress.percent)
      ? ' · ' + formatProgressPercent(aiPackage.progress.percent) : '';
    return '起播缓冲已就绪，正在准备后续内容' + percent;
  }
  if (aiPackage.status === 'running') {
    return '正在准备观影包 · ' + formatProgressPercent(aiPackage.progress?.percent || 0);
  }
  return '观影包等待准备';
}

function aiExperienceWarning(item) {
  const aiPackage = item?.aiPackage || null;
  if (!aiPackage) {
    return '自己看可直接试播，和 AI 一起看请先准备观影包。';
  }
  if (aiPackage.status !== 'ready' && !aiPackage.canStartViewing) {
    return '起播缓冲尚未就绪，AI 暂时只能看到已准备的部分。';
  }

  const mode = aiPackage.aiReadiness?.experienceMode || 'raw';
  if (mode === 'visual_only') {
    return '已有画面，缺少对白字幕。AI 可以跟随场景和动作。';
  }
  if (mode === 'dialogue_only') {
    return '已有对白，缺少画面。AI 可以跟随字幕阅读。';
  }
  if (mode !== 'complete' && !aiPackage.canStartViewing) {
    return '观影包尚不完整，AI 可以读取已准备的部分。';
  }
  return null;
}

function aiUpgradeNotice(item) {
  const job = item?.aiUpgradeJob;
  const active = Boolean(item?.aiPreparationJobId && item.aiPreparationOperation === 'upgrade');
  if (active || job?.status !== 'done') return null;
  if (!['retained', 'unknown'].includes(job.oldPackageDisposition)) return null;
  const disposition = {
    retained: '旧包仍保留在升级备份位置。',
    unknown: '旧包回收结果待确认，请检查系统回收站。'
  }[job.oldPackageDisposition];
  const reason = job.message?.match(/(?:recycling could not complete|check the system trash): ([\s\S]+)$/i)?.[1];
  return [disposition, reason].filter(Boolean).join(' ');
}

function aiUpgradeSummary(item) {
  const job = item?.aiUpgradeJob;
  const active = Boolean(item?.aiPreparationJobId && item.aiPreparationOperation === 'upgrade');
  if (!active && job?.status !== 'error') return null;
  const percent = typeof job?.progress === 'number' && Number.isFinite(job.progress)
    ? Math.max(0, Math.min(100, job.progress)) : null;
  const label = job?.status === 'error' ? '升级已停止'
    : percent === null ? '升级中 · 正在读取进度' : `升级中 ${formatProgressPercent(percent)}`;
  const processedMs = typeof job?.preparedThroughMs === 'number' && Number.isFinite(job.preparedThroughMs)
    ? Math.max(0, job.preparedThroughMs) : null;
  const totalMs = typeof job?.durationMs === 'number' && Number.isFinite(job.durationMs) && job.durationMs > 0
    ? job.durationMs : null;
  const elapsed = processedMs !== null
    ? `已处理 ${formatFilmTime(processedMs)}${totalMs !== null ? ' / ' + formatFilmTime(totalMs) : ''}` : null;
  const packageState = item.aiPackage?.needsStoryboardUpgrade
    ? `当前观影包：旧版 v${item.aiPackage.packageVersion}，与升级任务分开保留`
    : item.aiPackage ? `当前观影包：v${item.aiPackage.packageVersion || '?'}` : '当前没有可用观影包';
  const stages = {
    'Preparing upgraded package; original package retained': '正在准备新观影包，原包仍可用',
    'Validating the upgraded viewing package': '正在校验新观影包',
    'Switching to the upgraded viewing package': '正在切换到新观影包',
    'Moving the previous viewing package to the system trash': '正在将旧包移入回收站',
    'Upgrade stopped; original package retained': '原观影包已保留'
  };
  return { label, details: [stages[job?.stage] || job?.stage, elapsed, job?.error, packageState].filter(Boolean).join(' · '), percent };
}

function aiAudioStatus(item) {
  const audio = item?.aiPackage?.audioTrack;
  if (!audio) return '';
  const labels = {
    unavailable: '声音描述尚未准备：本地音频环境不可用',
    failed: '声音描述准备失败',
    running: '正在准备声音描述',
    pending: '声音描述等待准备',
    not_prepared: '声音描述尚未准备',
    source_missing: '影片没有音轨',
    ready: '声音描述已准备'
  };
  return [labels[audio.status] || '声音描述状态：' + audio.status, audio.error || audio.note].filter(Boolean).join('：');
}

function aiPreparationButtonState(item, includeAudio = true) {
  const audioReady = item.aiPackage?.audioTrack?.status === 'source_missing'
    || (item.aiPackage?.audioTrack?.status === 'ready' && item.aiPackage?.audioTrack?.model === 'Labbeti/conette');
  if (item.aiPreparationJobId) {
    return { text: item.aiPreparationOperation === 'upgrade' ? aiUpgradeSummary(item).label : item.aiPackage ? aiPackageLabel(item) : '正在准备观影包', disabled: true };
  }
  if (item.aiPackage?.needsStoryboardUpgrade) return { text: '升级', disabled: false };
  if (item.aiPackage?.status === 'running' && item.aiPreparationResult?.status !== 'error') {
    return { text: aiPackageLabel(item), disabled: true };
  }
  const complete = item.aiPackage?.status === 'ready' && (includeAudio === false || audioReady);
  return {
    text: complete ? '观影包设置' : item.aiPackage ? '继续准备' : '准备观影包',
    disabled: false
  };
}

function aiBufferSummary(item) {
  const prepared = item?.aiPackage;
  const track = prepared?.viewingTrack;
  if (!track) return null;
  const durationMs = Math.max(0, Number(prepared.durationMs) || 0);
  const readyThroughMs = Math.max(0, Number(track.preparedThroughMs) || 0);
  const visualThroughMs = Math.max(0, Number(track.visualPreparedThroughMs) || 0);
  const audioThroughMs = Math.max(0, Number(track.audioPreparedThroughMs) || 0);
  const startTargetMs = Math.max(0, Number(track.initialBufferMs) || 0);
  const targetMs = durationMs ? Math.min(durationMs, startTargetMs) : startTargetMs;
  const complete = prepared.status === 'ready';
  const stopped = ['error', 'failed'].includes(prepared.status);
  const label = complete ? '观影包已就绪'
    : stopped ? '观影包准备中断'
      : prepared.canStartViewing ? '起播缓冲已就绪，可以一起看了'
        : '正在准备起播缓冲';
  const preparedRange = formatFilmTime(readyThroughMs) + (durationMs ? ' / ' + formatFilmTime(durationMs) : '');
  const details = [
    '已准备至 ' + preparedRange,
    !complete && targetMs ? '起播目标 ' + formatFilmTime(targetMs) : null,
    '画面 ' + formatFilmTime(visualThroughMs),
    track.audioRequested ? '声音 ' + formatFilmTime(audioThroughMs) : null,
    !complete && !stopped && prepared.canStartViewing ? '剩余内容正在后台准备' : null
  ].filter(Boolean);
  return { label, details: details.join(' · '), durationMs, readyThroughMs, preparedRange };
}

function renderCurrentAiBuffer() {
  const item = currentMedia();
  currentAiBuffer.hidden = !item;
  if (!item) return;

  const prepared = item.aiPackage;
  const upgrading = aiUpgradeSummary(item);
  const summary = aiBufferSummary(item);
  const ready = prepared?.status === 'ready';
  const running = prepared?.status === 'running' || Boolean(item.aiPreparationJobId);
  const stopped = item.aiPreparationResult?.status === 'error' || (upgrading
    ? item.aiUpgradeJob?.status === 'error'
    : ['error', 'failed'].includes(prepared?.status));
  const playheadMs = Math.max(0, Math.round(Number(videoPlayer.currentTime) * 1000) || 0);
  const catchingUp = running && !ready && !stopped && summary && playheadMs > summary.readyThroughMs;
  const committedPercent = summary?.durationMs ? 100 * (summary.readyThroughMs / summary.durationMs) : null;
  const liveJobPercent = typeof prepared?.progress?.percent === 'number' && Number.isFinite(prepared.progress.percent)
    ? prepared.progress.percent : null;
  const percent = upgrading ? upgrading.percent
    : ready ? 100
    : running && liveJobPercent !== null ? Math.max(committedPercent ?? 0, liveJobPercent)
    : committedPercent ?? liveJobPercent;

  const label = upgrading ? upgrading.label
    : stopped ? 'AI 准备中断'
    : ready ? 'AI 已就绪'
    : catchingUp ? 'AI 正在追赶进度'
    : prepared?.canStartViewing ? 'AI 起播缓冲已就绪'
    : running ? '正在准备 AI 观影包' : '尚未准备 AI 观影包';
  if (currentAiBufferLabel.textContent !== label) currentAiBufferLabel.textContent = label;
  currentAiBuffer.classList.toggle('error', stopped);
  const upgradeElapsed = upgrading && typeof item.aiUpgradeJob?.preparedThroughMs === 'number' && item.aiUpgradeJob?.durationMs
    ? `${formatFilmTime(item.aiUpgradeJob.preparedThroughMs)} / ${formatFilmTime(item.aiUpgradeJob.durationMs)}` : '';
  const detail = upgrading ? upgradeElapsed
    : running && !ready && !stopped && percent !== null
      ? (summary?.readyThroughMs ? `${formatProgressPercent(percent)} · ${summary.preparedRange}` : formatProgressPercent(percent))
      : summary?.preparedRange ?? (!prepared && !running ? '可在片库中准备' : '');
  if (currentAiBufferDetail.textContent !== detail) currentAiBufferDetail.textContent = detail;
  currentAiBufferDetail.hidden = !detail;

  const details = [
    upgrading?.details || summary?.details || label,
    item.storyboardProfile ? '分镜 · ' + profileLabels[item.storyboardProfile.mode]
      + (item.storyboardProfile.mode === 'full' ? ' ' + item.storyboardProfile.height + 'p' : '') : null,
    aiAudioStatus(item),
    item.aiPreparationResult?.message
  ].filter(Boolean).join(' · ');
  if (currentAiBuffer.title !== details) currentAiBuffer.title = details;

  const indeterminate = percent === null && running && !stopped;
  const clamped = Math.max(0, Math.min(100, percent ?? 0));
  currentAiBufferProgress.classList.toggle('is-indeterminate', indeterminate);
  if (indeterminate) {
    currentAiBufferProgress.removeAttribute('aria-valuenow');
    currentAiBufferFill.style.width = '38%';
  } else {
    currentAiBufferProgress.setAttribute('aria-valuenow', String(Math.round(clamped)));
    currentAiBufferFill.style.width = `${clamped.toFixed(2)}%`;
  }
}

function updateAiPreparationCard(item) {
  const card = [...mediaGrid.children].find((node) => node.dataset.mediaId === item.id);
  if (!card) return;
  const button = card.querySelector('.ai-prepare-button');
  const note = card.querySelector('.ai-package-note');
  if (!button || !note) return;
  const progressWrap = card.querySelector('.card-ai-progress');
  const hasProgressUi = Boolean(progressWrap?.dataset?.aiProgress);
  const state = aiPreparationButtonState(item, viewingSettings?.includeAudio !== false);
  const pollError = aiPreparationPollErrors.get(item.id);
  button.textContent = pollError && item.aiPreparationJobId ? '刷新准备进度' : state.text;
  button.disabled = aiPreparationStarting.has(item.id) || (!pollError && state.disabled);
  const upgrade = aiUpgradeSummary(item);
  const summary = upgrade || aiBufferSummary(item);
  const result = item.aiPreparationResult;
  const failed = result?.status === 'error' || item.aiUpgradeJob?.status === 'error'
    || ['failed', 'error'].includes(item.aiPackage?.status) || item.aiPackage?.audioTrack?.status === 'failed';
  note.classList.toggle('error', Boolean(pollError || failed));
  if (!item.aiPackage && !upgrade && !item.aiPreparationJobId) {
    if (hasProgressUi) progressWrap.hidden = true;
    note.textContent = pollError?.message || result?.message || aiExperienceWarning(item);
    note.title = '';
    return;
  }
  const partial = item.aiPackage?.status === 'ready' ? aiExperienceWarning(item) : null;
  const profileText = item.storyboardProfile
    ? profileLabels[item.storyboardProfile.mode]
      + (item.storyboardProfile.mode === 'full' ? ' ' + item.storyboardProfile.height + 'p' : '')
    : null;
  const fullDetails = [...new Set([
    upgrade && pollError?.message === item.aiUpgradeJob?.error ? null : pollError?.message,
    result?.status === 'error' ? result.message : null, item.aiPackage?.error,
    profileText ? '分镜 · ' + profileText : null,
    summary ? summary.label + ' · ' + summary.details : item.aiPreparationJobId && !item.aiPackage ? '正在准备观影包' : aiPackageLabel(item),
    failed && item.aiPackage?.canStartViewing ? '已准备的部分仍可观看。' : null,
    partial, aiAudioStatus(item)
  ].filter(Boolean))].join(' · ');

  const ready = !upgrade && item.aiPackage?.status === 'ready' && !failed;
  const running = Boolean(upgrade || item.aiPreparationJobId || item.aiPackage?.status === 'running');
  const committedPercent = summary?.durationMs ? 100 * (summary.readyThroughMs / summary.durationMs) : null;
  const liveJobPercent = typeof item.aiPackage?.progress?.percent === 'number' && Number.isFinite(item.aiPackage.progress.percent)
    ? item.aiPackage.progress.percent : null;
  const percent = upgrade ? upgrade.percent
    : ready ? 100
    : running && liveJobPercent !== null ? Math.max(committedPercent ?? 0, liveJobPercent)
    : committedPercent ?? liveJobPercent;

  if (hasProgressUi) {
    const labelNode = progressWrap.querySelector('.card-ai-progress-label');
    const valueNode = progressWrap.querySelector('.card-ai-progress-value');
    const trackNode = progressWrap.querySelector('.flow-progress-track');
    const fillNode = progressWrap.querySelector('.flow-progress-fill');
    const indeterminate = percent === null && running && !failed;
    const clamped = Math.max(0, Math.min(100, percent ?? 0));
    progressWrap.hidden = false;
    progressWrap.classList.toggle('is-error', Boolean(pollError || failed));
    progressWrap.classList.toggle('is-ready', ready);
    progressWrap.title = fullDetails;

    const statusLabel = upgrade ? upgrade.label
      : (pollError || failed) ? '准备中断'
      : ready ? [profileText, '已就绪'].filter(Boolean).join(' · ')
      : item.aiPackage?.canStartViewing ? '起播已就绪 · 准备中'
      : '准备观影包中';
    const valueLabel = ready
      ? (summary?.preparedRange || '100%')
      : indeterminate ? '准备中…' : formatProgressPercent(clamped);
    if (labelNode) labelNode.textContent = statusLabel;
    if (valueNode) valueNode.textContent = valueLabel;
    if (trackNode && fillNode) {
      trackNode.classList.toggle('is-indeterminate', indeterminate);
      if (indeterminate) {
        trackNode.removeAttribute('aria-valuenow');
        fillNode.style.width = '38%';
      } else {
        trackNode.setAttribute('aria-valuenow', String(Math.round(clamped)));
        fillNode.style.width = `${clamped.toFixed(2)}%`;
      }
    }

    if (ready && !pollError) {
      const track = item.aiPackage?.viewingTrack;
      const compactParts = [];
      if (track) {
        compactParts.push('画面 ' + formatFilmTime(Math.max(0, Number(track.visualPreparedThroughMs) || 0)));
        if (track.audioRequested) {
          compactParts.push('声音 ' + formatFilmTime(Math.max(0, Number(track.audioPreparedThroughMs) || 0)));
        }
      }
      if (partial) compactParts.push(partial);
      const upgradeNotice = typeof aiUpgradeNotice === 'function' ? aiUpgradeNotice(item) : null;
      if (upgradeNotice) compactParts.push(upgradeNotice);
      note.textContent = compactParts.join(' · ') || '观影包已就绪';
      note.title = fullDetails;
      return;
    }
  }

  note.textContent = fullDetails;
  note.title = fullDetails;
}

function showViewerProfile() {
  const edited = String(viewerProfile?.displayName || '').trim();
  const shownName = edited || 'user';
  currentNameLabel.textContent = shownName;
  identitySettings.title = `我的名字：${shownName}（点击修改）`;
  viewerNameSave.disabled = !nameDraftDirty || savingViewer;
  if (!nameDraftDirty && document.activeElement !== senderNameInput) {
    senderNameInput.value = viewerProfile.displayName;
  }
}

async function refreshViewerName() {
  const serial = ++nameReadSerial;
  let profile = await fetchJson('/api/participants/viewer');
  const previous = localStorage.getItem(STORAGE.senderName)?.trim();
  if (!profile.configured && previous && previous !== 'Viewer') {
    profile = await fetchJson('/api/participants/viewer', {
      method: 'POST',
      body: JSON.stringify({ name: previous, initializeOnly: true })
    });
  }
  if (serial !== nameReadSerial) return;
  if (profile.configured) localStorage.removeItem(STORAGE.senderName);
  viewerProfile = profile;
  showViewerProfile();
}

async function saveViewerName() {
  if (!nameDraftDirty || savingViewer) return;
  const revision = nameRevision;
  savingViewer = true;
  viewerNameSave.disabled = true;
  viewerNameStatus.textContent = '正在保存…';
  try {
    const profile = await fetchJson('/api/participants/viewer', {
      method: 'POST', body: JSON.stringify({ name: senderNameInput.value.trim() })
    });
    nameReadSerial++;
    viewerProfile = profile;
    if (revision === nameRevision) nameDraftDirty = false;
    viewerNameStatus.textContent = '观众名字已保存。';
  } catch {
    viewerNameStatus.textContent = '未能保存名字，请检查影院连接后重试。';
  } finally {
    savingViewer = false;
    showViewerProfile();
  }
}

async function refreshParticipantNames() {
  const serial = ++participantRefreshSerial;
  const roomId = selectedRoom?.id;
  notebook.reconnect();
  const tasks = [refreshViewerName()];
  if (viewingSettingsDialog.open && !document.querySelector('#settingsNames').hidden) tasks.push(aiProfiles.refresh());
  if (roomId) tasks.push((async () => {
    const snapshot = await fetchJson('/api/rooms/' + encodeURIComponent(roomId) + '/messages');
    if (serial !== participantRefreshSerial || selectedRoom?.id !== roomId) return;
    const names = new Map(snapshot.messages.map(message => [String(message.id), message.senderName]));
    for (const message of messages) {
      if (names.has(String(message.id))) message.senderName = names.get(String(message.id));
    }
    for (const node of document.querySelectorAll('[data-message-author]')) {
      const name = names.get(node.dataset.messageAuthor);
      if (name) node.textContent = name + (node.dataset.suffix || '');
    }
  })());
  await Promise.all(tasks);
}

function savedProgressFor(mediaId) {
  const value = Number(playbackProgress[mediaId]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function savePlaybackProgress({ force = false } = {}) {
  if (!activeMediaId || pendingRoomStart || !Number.isFinite(videoPlayer.currentTime)) return;
  const now = Date.now();
  if (!force && now - lastProgressWriteAt < 1500) return;
  playbackProgress[activeMediaId] = Math.max(0, Math.round(videoPlayer.currentTime * 1000));
  writeStoredObject(STORAGE.playbackProgress, playbackProgress);
  localStorage.setItem(STORAGE.lastMedia, activeMediaId);
  lastProgressWriteAt = now;
}

function showScreenActions({ linger = true } = {}) {
  playerShell.classList.add('controls-visible');
  clearTimeout(controlsHideTimer);
  if (!linger) return;
  controlsHideTimer = setTimeout(() => {
    if (!screenActions.matches(':focus-within')) {
      playerShell.classList.remove('controls-visible');
    }
  }, 1800);
}

function hideScreenActionsSoon() {
  clearTimeout(controlsHideTimer);
  controlsHideTimer = setTimeout(() => {
    if (!screenActions.matches(':focus-within')) {
      playerShell.classList.remove('controls-visible');
    }
  }, 260);
}

function setSidebarOpen(open) {
  sidebarOpen = open;
  closeInteractionPopover();
  cinemaWorkspace.classList.toggle('sidebar-open', open);
  sidebarHandle.setAttribute('aria-expanded', String(open));
  sidebarHandle.setAttribute('title', open ? '关闭房间侧栏' : '打开房间侧栏');
  sidebarHandle.setAttribute('aria-label', open ? '关闭房间侧栏' : '打开房间侧栏');
  sidebarHandle.querySelector('span[aria-hidden="true"]').textContent = open ? '▶' : '◀';
  if (open) {
    unreadCount = 0;
    renderUnread();
  }
  showScreenActions();
}

function setSidebarView(view) {
  const showMessages = view === 'messages';
  if (!showMessages) closeInteractionPopover();
  messagesPanel.hidden = !showMessages;
  sessionsPanel.hidden = showMessages;
  messagesTab.classList.toggle('active', showMessages);
  sessionsTab.classList.toggle('active', !showMessages);
  messagesTab.setAttribute('aria-selected', String(showMessages));
  sessionsTab.setAttribute('aria-selected', String(!showMessages));
  sidebarTitle.textContent = showMessages ? '房间消息' : '往期放映';
}

function renderUnread() {
  unreadBadge.hidden = unreadCount === 0;
  unreadBadge.textContent = String(Math.min(unreadCount, 99));
}

function clearDanmaku() {
  if (danmakuFrame !== null) cancelAnimationFrame(danmakuFrame);
  danmakuFrame = null;
  nextDanmakuLane = 0;
  pendingDanmaku.length = 0;
  danmakuLayer.replaceChildren();
}

const aiActivity = createAiActivity({
  fetchJson,
  formatTime: formatFilmTime,
  getRoom: () => activeRoom,
  getPosition: () => selectedRoom?.id === activeRoom?.id && activeMediaId === activeRoom?.mediaId && videoPlayer.readyState > 0 && Number.isFinite(videoPlayer.currentTime)
    ? Math.round(videoPlayer.currentTime * 1000) : activeRoom?.lastPositionMs
});

const notebook = createNotebook({
  fetchJson,
  getViewer: () => viewerProfile.name,
  interactionsOn: () => interactionsEnabled,
  video: videoPlayer,
  formatTime: formatFilmTime
});
function updateNotebookControls() {
  notebook.bind(selectedRoom, currentItems.find(item => item.id === selectedRoom?.mediaId)?.title || selectedRoom?.mediaTitle || '');
}

// Room interactions share the message timeline, but effects only play for live arrivals.
const INTERACTIONS = Object.freeze({
  notebook_peek: { icon: '📖', label: '翻翻小本本', content: '悄悄翻开了小本本', send: false },
  popcorn: { icon: '🍿', label: '递爆米花', content: '递来一桶爆米花' },
  cola: { icon: '🥤', label: '递可乐', content: '递来一杯可乐' },
  cheers: { icon: '🥂', label: '碰杯', content: '轻轻碰杯，一起看下去' }
});
const interactionToggle = document.querySelector('#interactionToggle');
const interactionLayers = [document.querySelector('#chatInteractionLayer'), document.querySelector('#screenInteractionLayer')];
let interactionsEnabled = false;
let interactionSettingPending = false;
const shownInteractions = new Set();
const interactionButtons = [];
let activeInteractionTrigger = null;

function isInteractionPopoverOpen() {
  return Boolean(interactionPopover?.matches(':popover-open'));
}

function syncInteractionTriggerState() {
  const open = isInteractionPopoverOpen();
  for (const trigger of interactionTriggers) {
    trigger.setAttribute('aria-expanded', String(open && trigger === activeInteractionTrigger));
  }
}

function closeInteractionPopover() {
  if (isInteractionPopoverOpen()) {
    try { interactionPopover.hidePopover(); } catch {}
  }
  activeInteractionTrigger = null;
  syncInteractionTriggerState();
}

function placeInteractionPopover() {
  if (!isInteractionPopoverOpen() || !activeInteractionTrigger) return;
  const anchor = activeInteractionTrigger.getBoundingClientRect();
  if (!anchor.width && !anchor.height) {
    closeInteractionPopover();
    return;
  }
  const margin = 8;
  const gap = 8;
  const x = Math.max(margin, Math.min(anchor.left, window.innerWidth - interactionPopover.offsetWidth - margin));
  const y = anchor.top >= interactionPopover.offsetHeight + gap + margin
    ? anchor.top - interactionPopover.offsetHeight - gap
    : Math.min(anchor.bottom + gap, window.innerHeight - interactionPopover.offsetHeight - margin);
  interactionPopover.style.left = `${x}px`;
  interactionPopover.style.top = `${Math.max(margin, y)}px`;
}

if (interactionPopover) {
  const bar = document.createElement('div');
  bar.className = 'interaction-buttons';
  for (const [kind, item] of Object.entries(INTERACTIONS)) {
    if (item.send === false) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.interaction = kind;
    button.setAttribute('aria-label', item.label);
    const icon = document.createElement('span');
    icon.className = 'interaction-btn-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = item.icon;
    const label = document.createElement('span');
    label.className = 'interaction-btn-label';
    label.textContent = item.label;
    button.append(icon, label);
    button.addEventListener('click', async () => {
      if (!interactionsEnabled || !roomIsWritable()) return;
      button.disabled = true;
      try { await sendRoomMessage(item.content, kind); }
      finally { updateInteractionControls(); }
    });
    bar.append(button);
    interactionButtons.push(button);
  }
  interactionPopover.append(bar);
  for (const trigger of interactionTriggers) {
    trigger.addEventListener('click', () => {
      activeInteractionTrigger = trigger;
    });
  }
  interactionPopover.addEventListener('toggle', () => {
    if (!isInteractionPopoverOpen()) activeInteractionTrigger = null;
    syncInteractionTriggerState();
    placeInteractionPopover();
  });
  window.addEventListener('scroll', placeInteractionPopover, { passive: true, capture: true });
  window.addEventListener('resize', placeInteractionPopover);
  document.addEventListener('fullscreenchange', () => requestAnimationFrame(placeInteractionPopover));
}

function updateInteractionControls() {
  const tip = interactionsEnabled ? '互动已开启' : '互动已关闭';
  interactionToggle.dataset.tip = tip;
  interactionToggle.setAttribute('aria-label', interactionsEnabled ? '互动已开启（点击关闭零食与碰杯互动）' : '互动已关闭（点击开启零食与碰杯互动）');
  interactionToggle.setAttribute('aria-pressed', String(interactionsEnabled));
  interactionToggle.classList.toggle('off', !interactionsEnabled);
  interactionToggle.disabled = interactionSettingPending;
  const canInteract = interactionsEnabled && roomIsWritable();
  for (const trigger of interactionTriggers) {
    trigger.hidden = !interactionsEnabled;
    trigger.disabled = !canInteract;
  }
  for (const button of interactionButtons) {
    button.disabled = !canInteract;
  }
  if (!canInteract) closeInteractionPopover();
  if (!interactionsEnabled) for (const layer of interactionLayers) layer.replaceChildren();
  quickMessages.updateControls();
}

async function refreshInteractionSettings() {
  if (interactionSettingPending) return;
  const setting = await fetchJson('/api/interaction-settings');
  const changed = interactionsEnabled !== Boolean(setting.enabled);
  interactionsEnabled = Boolean(setting.enabled);
  updateInteractionControls();
  updateDanmakuControls();
  if (changed) renderMessages();
}

interactionToggle.addEventListener('click', async () => {
  if (interactionSettingPending) return;
  interactionSettingPending = true;
  updateInteractionControls();
  try {
    const setting = await fetchJson('/api/interaction-settings', {
      method: 'POST', body: JSON.stringify({ enabled: !interactionsEnabled })
    });
    interactionsEnabled = Boolean(setting.enabled);
    renderMessages();
    updateDanmakuControls();
  } catch (error) { setPlayerNotice(error.message, true); }
  finally { interactionSettingPending = false; updateInteractionControls(); }
});

function showLiveInteraction(message) {
  if (!INTERACTIONS[message.interaction]) return;
  const key = `${message.sessionId || selectedRoom?.id}:${message.id}`;
  if (shownInteractions.has(key)) return;
  shownInteractions.add(key);
  if (shownInteractions.size > 512) shownInteractions.delete(shownInteractions.values().next().value);
  if (!interactionsEnabled || message.interaction === 'notebook_peek') return;
  const item = INTERACTIONS[message.interaction];
  const layer = document.fullscreenElement === cinemaWorkspace ? interactionLayers[1] : interactionLayers[0];
  layer.replaceChildren();
  const effect = document.createElement('div');
  effect.className = `interaction-effect interaction-${message.interaction}`;
  const icon = document.createElement('span');
  icon.className = 'interaction-main-icon';
  icon.textContent = item.icon;
  effect.append(icon);
  if (message.interaction === 'popcorn') {
    for (let index = 0; index < 7; index += 1) {
      const kernel = document.createElement('span');
      kernel.className = 'popcorn-kernel';
      kernel.textContent = '✿';
      kernel.style.setProperty('--kernel-x', `${(index - 3) * 22}px`);
      kernel.style.setProperty('--kernel-delay', `${index * 35}ms`);
      effect.append(kernel);
    }
  }
  const caption = document.createElement('span');
  caption.className = 'interaction-caption';
  caption.dataset.messageAuthor = String(message.id);
  caption.dataset.suffix = ' · ' + item.content;
  caption.textContent = message.senderName + caption.dataset.suffix;
  effect.append(caption);
  layer.append(effect);
  setTimeout(() => effect.remove(), 2200);
}

function spawnDanmaku(message) {
  if (message.interaction) return;
  if (!danmakuEnabled || !selectedRoom) return;
  const node = document.createElement('div');
  node.className = `danmaku-item danmaku-waiting sender-${message.senderKind || 'user'}`;

  const sender = document.createElement('b');
  sender.dataset.messageAuthor = String(message.id);
  sender.dataset.suffix = ':';
  sender.textContent = message.senderName + ':';
  const content = document.createElement('span');
  content.textContent = message.content;
  node.append(sender, content);
  node.addEventListener('animationend', () => node.remove(), { once: true });
  pendingDanmaku.push(node);
  danmakuLayer.append(node);
  if (danmakuFrame === null) danmakuFrame = requestAnimationFrame(releaseDanmaku);
}

function releaseDanmaku() {
  danmakuFrame = null;
  const layer = danmakuLayer.getBoundingClientRect();
  const blockers = Array.from(danmakuLayer.querySelectorAll('.danmaku-item:not(.danmaku-waiting)'),
    (node) => node.getBoundingClientRect());

  while (pendingDanmaku.length) {
    const node = pendingDanmaku[0];
    const { left, right, height } = node.getBoundingClientRect();
    let lane = null;
    for (let offset = 0; offset < 5; offset += 1) {
      const candidate = (nextDanmakuLane + offset) % 5;
      const topPercent = 2 + candidate * 12;
      const top = layer.top + layer.height * topPercent / 100;
      const bottom = top + height;
      if (candidate !== 0 && bottom > layer.bottom) continue;
      if (blockers.some((rect) => rect.right + 8 > left && rect.top < bottom + 4 && rect.bottom + 4 > top)) continue;
      lane = candidate;
      node.style.top = `${topPercent}%`;
      blockers.push({ top, bottom, right });
      break;
    }
    if (lane === null) break;
    pendingDanmaku.shift();
    node.classList.remove('danmaku-waiting');
    nextDanmakuLane = (lane + 1) % 5;
  }

  if (pendingDanmaku.length) danmakuFrame = requestAnimationFrame(releaseDanmaku);
}

function updateDanmakuControls() {
  const tip = danmakuEnabled ? '弹幕已开启' : '弹幕已关闭';
  danmakuToggle.dataset.tip = tip;
  danmakuToggle.setAttribute('aria-label', danmakuEnabled ? '弹幕已开启（点击关闭）' : '弹幕已关闭（点击开启）');
  danmakuToggle.setAttribute('aria-pressed', String(danmakuEnabled));
  danmakuToggle.classList.toggle('off', !danmakuEnabled);
  quickComposer.hidden = !roomIsWritable();

  if (!selectedRoom) {
    dockNote.textContent = '需要陪伴时，再开启房间。';
  } else if (selectedRoom.status === 'ended') {
    dockNote.textContent = danmakuEnabled ? '往期弹幕会随画面重现。' : '房间记录已静默留存。';
  } else if (!danmakuEnabled) {
    dockNote.textContent = '房间消息在侧栏静默更新。';
  } else {
    dockNote.textContent = '弹幕随画面流动。';
  }

  if (!danmakuEnabled) clearDanmaku();
}

function resetTimeline(positionMs = 0) {
  lastTimelineMs = Math.max(-1, positionMs - 1);
  timelineShown = new Set(
    messages
      .filter((message) => message.mediaTimeMs < positionMs)
      .map((message) => message.id)
  );
  clearDanmaku();
}

function processTimeline() {
  if (!selectedRoom || selectedRoom.mediaId !== activeMediaId || !danmakuEnabled || !Number.isFinite(videoPlayer.currentTime)) return;
  const currentMs = Math.round(videoPlayer.currentTime * 1000);

  if (lastTimelineMs < 0) lastTimelineMs = Math.max(-1, currentMs - 500);
  if (currentMs + 800 < lastTimelineMs || currentMs - lastTimelineMs > 4000) {
    resetTimeline(currentMs);
    return;
  }

  const due = [...messages]
    .sort((a, b) => a.mediaTimeMs - b.mediaTimeMs || a.id - b.id)
    .filter((message) => (
      !timelineShown.has(message.id)
      && message.mediaTimeMs > lastTimelineMs
      && message.mediaTimeMs <= currentMs + 300
    ));

  for (const message of due) {
    timelineShown.add(message.id);
    spawnDanmaku(message);
  }
  lastTimelineMs = currentMs;
}

function renderMessages() {
  messageList.replaceChildren();

  if (!selectedRoom) {
    const empty = document.createElement('div');
    empty.className = 'sidebar-empty';
    empty.innerHTML = '<p class="sidebar-empty-title">此刻银幕只属于你</p><p class="sidebar-empty-desc">开启一个新房间，或在「往期放映」里回看。</p>';
    messageList.append(empty);
    return;
  }

  if (messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sidebar-empty';
    empty.innerHTML = selectedRoom.status === 'active'
      ? '<p class="sidebar-empty-title">房间已开启，说第一句话吧。</p><p class="sidebar-empty-desc">把这一帧的心声，留在银幕旁。</p>'
      : '<p class="sidebar-empty-title">这场放映在安静中结束了。</p><p class="sidebar-empty-desc">没有留下文字记录。</p>';
    messageList.append(empty);
    return;
  }

  for (const message of messages) {
    if (message.interaction && !interactionsEnabled) continue;
    const item = document.createElement('article');
    item.className = `message-item sender-${message.senderKind || 'user'}`;
    if (INTERACTIONS[message.interaction]) item.classList.add('interaction-card');

    const header = document.createElement('div');
    const sender = document.createElement('strong');
    sender.dataset.messageAuthor = String(message.id);
    sender.textContent = message.senderName;
    const timeButton = document.createElement('button');
    timeButton.type = 'button';
    timeButton.textContent = formatFilmTime(message.mediaTimeMs);
    timeButton.disabled = !activeMediaId || activeMediaId !== selectedRoom.mediaId;
    timeButton.title = timeButton.disabled ? '原影片缺失 · 影片时间' : '跳到这段影片';
    timeButton.addEventListener('click', () => {
      videoPlayer.currentTime = message.mediaTimeMs / 1000;
      resetTimeline(message.mediaTimeMs);
    });
    const interaction = INTERACTIONS[message.interaction];
    if (selectedRoom.status === 'ended' && message.createdAt) {
      const sent = document.createElement('small');
      sent.className = 'archive-sent-at';
      sent.textContent = formatSessionDate(message.createdAt);
      item.append(sent);
    }
    if (interaction) {
      const action = document.createElement('span');
      action.textContent = message.content.replace(interaction.icon, '').trim();
      const icon = document.createElement('span');
      icon.textContent = interaction.icon;
      icon.setAttribute('aria-hidden', 'true');
      header.append(sender, action, icon, timeButton);
      item.append(header);
    } else {
      header.append(sender, timeButton);
      const content = document.createElement('p');
      content.textContent = message.content;
      item.append(header, content);
    }
    messageList.append(item);
  }
  messageList.scrollTop = messageList.scrollHeight;
}

const roomExportButton = document.querySelector('#roomExportButton');
const notebookExportButton = document.querySelector('#notebookExportButton');
const exportDialog = document.querySelector('#exportDialog');

function showExportDialog(notebookOnly) {
  if (!selectedRoom) return;
  const base = '/api/rooms/' + encodeURIComponent(selectedRoom.id) + (notebookOnly ? '/notebook/export' : '/export');
  document.querySelector('#exportTitle').textContent = notebookOnly ? '导出这部片的手记' : '导出这次放映';
  document.querySelector('#exportContext').textContent = '《' + selectedRoom.mediaTitle + '》 · 选择下载格式';
  document.querySelector('#exportHtml').href = base + '?format=html';
  document.querySelector('#exportText').href = base + '?format=txt';
  exportDialog.showModal();
}
roomExportButton.onclick = () => showExportDialog(false);
notebookExportButton.onclick = () => showExportDialog(true);
document.querySelector('#exportClose').onclick = () => exportDialog.close();

function setRoomDrawerOpen(open) {
  if (!roomSummaryBox || !roomDrawerBody || !roomDrawerHandle) return;
  roomSummaryBox.classList.toggle('open', open);
  roomDrawerHandle.setAttribute('aria-expanded', String(open));
  roomDrawerHandle.setAttribute('aria-label', open ? '收起房间选项' : '下拉展开房间选项');
  roomDrawerHandle.setAttribute('title', open ? '收起房间选项' : '拉下房间选项（名字与导出）');
  roomDrawerBody.setAttribute('aria-hidden', String(!open));
  roomDrawerBody.inert = !open;
}

if (roomDrawerHandle) {
  roomDrawerHandle.addEventListener('click', () => {
    setRoomDrawerOpen(!roomSummaryBox?.classList.contains('open'));
  });
}

function renderRoomState() {
  roomExportButton.hidden = !selectedRoom;
  if (roomExportHint) roomExportHint.hidden = Boolean(selectedRoom);
  aiActivity.updatePlayhead();
  const item = currentMedia();
  const playbackReady = Boolean(item && activeMediaPlayable && playbackReadyForCurrentBrowser(item));
  openRoomButton.disabled = !playbackReady || Boolean(activeRoom) || roomOpeningPending;
  openRoomButton.hidden = Boolean(activeRoom);
  endRoomButton.hidden = !activeRoom;
  sidebarComposer.hidden = !roomIsWritable();
  roomSummary.replaceChildren();
  roomSummary.hidden = true;

  if (!selectedRoom) {
    roomState.textContent = '单人观影';
    roomState.className = 'room-state';
    if (roomSummaryBox) roomSummaryBox.dataset.state = 'idle';
  } else if (selectedRoom.status === 'active') {
    roomState.textContent = '房间已开启';
    roomState.className = 'room-state active';
    if (roomSummaryBox) roomSummaryBox.dataset.state = 'active';
  } else {
    roomState.textContent = '房间回放';
    roomState.className = 'room-state archived';
    if (roomSummaryBox) roomSummaryBox.dataset.state = 'archived';
    if (!item || item.id !== selectedRoom.mediaId) {
      roomSummary.hidden = false;
      const info = document.createElement('p');
      info.className = 'room-film-desc';
      info.textContent = '原影片缺失，聊天和手记仍可阅读。';
      const relink = document.createElement('button');
      relink.type = 'button';
      relink.className = 'room-button';
      relink.textContent = '重新关联原影片';
      relink.onclick = () => {
        const input = document.querySelector('#archiveRelinkFile');
        input.dataset.roomId = selectedRoom.id;
        input.dataset.mediaId = selectedRoom.mediaId;
        input.click();
      };
      const clean = document.createElement('button');
      clean.type = 'button';
      clean.className = 'room-button';
      clean.textContent = '清理本片资料';
      clean.dataset.archiveCleanup = selectedRoom.mediaId;
      clean.onclick = () => openCleanup({
        target: { mediaId: selectedRoom.mediaId }, name: selectedRoom.mediaTitle,
        restoreFocus: () => (roomSummary.querySelector('[data-archive-cleanup]') || sessionsTab).focus()
      }).catch(error => setPlayerNotice(error.message, true));
      roomSummary.append(info, relink, clean);
    }
  }

  updateDanmakuControls();
  updateInteractionControls();
  updateNotebookControls();
  renderMessages();
  renderCurrentAiBuffer();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function chooseMedia(item, { force = false, seekMs = null, preserveRoom = false } = {}) {
  if (['checking', 'processing'].includes(item.compatibilityStatus)) {
    setPlayerNotice('影片正在准备，完成后即可播放。', true);
    return;
  }
  if (!force && activeRoom && activeRoom.mediaId !== item.id) {
    setPlayerNotice('请先结束当前房间，再切换影片。', true);
    return;
  }

  savePlaybackProgress({ force: true });

  if (!preserveRoom && !activeRoom) {
    selectedRoom = null;
    messages = [];
  }

  activeMediaId = item.id;
  activeMediaPlayable = false;
  playbackSkip.reset();
  const storedSeekMs = !Number.isFinite(seekMs) && !preserveRoom && !activeRoom
    ? savedProgressFor(item.id)
    : null;
  pendingSeekMs = Number.isFinite(seekMs) ? seekMs : storedSeekMs;
  localStorage.setItem(STORAGE.lastMedia, item.id);

  videoPlayer.pause();
  videoPlayer.src = item.streamUrl;
  setupSubtitles(item);
  videoPlayer.load();
  playerShell.classList.add('has-media');
  setNowPlayingTitle(item);
  setPlayerNotice('');

  document.querySelectorAll('.media-card').forEach((card) => {
    card.classList.toggle('active', card.dataset.mediaId === item.id);
  });
  renderRoomState();
}

async function pollPreparation(jobId, button, statusText) {
  while (true) {
    const { job } = await fetchJson(`/api/jobs/${jobId}`);

    if (job.status === 'checking') {
      button.textContent = '正在检查播放…';
    } else if (job.status === 'processing') {
      const stages = { 'Repairing audio only': '正在修复声音', 'Repairing video only': '正在修复画面',
        'Rewrapping streams without re-encoding': '正在重新封装', 'Preparing safest fallback': '正在转换为兼容格式' };
      button.textContent = `${stages[job.stage] || job.stage || '正在修复'} ${Math.round(job.progress || 0)}%`;
    } else if (job.status === 'done') {
      button.textContent = '请重新试播';
      statusText.hidden = false;
      statusText.classList.remove('error');
      statusText.textContent = '修复完成。请重新试播，画面和声音正常后点「确认可播放」。';
      await refreshLibrary();
      const replacement = currentItems.find((item) => item.id === (job.replacementMediaId || job.mediaId));
      if (replacement) chooseMedia(replacement, { force: true });
      return;
    } else if (job.status === 'error') {
      throw new Error(job.error || '播放修复失败。');
    }

    await delay(400);
  }
}

async function prepareMedia(item, button, statusText) {
  const repairMode = await choosePlaybackRepair(item);
  if (repairMode === undefined) return;

  button.disabled = true;
  button.textContent = '正在开始修复…';
  statusText.hidden = false;
  statusText.classList.remove('error');
  statusText.textContent = repairMode === 'audio'
    ? '保留画面，正在转换音频。'
    : repairMode === 'video'
      ? '保留声音，正在转换视频。'
      : repairMode === 'remux'
        ? '正在将原有画面和声音重新封装为 MP4。'
        : '正在准备兼容格式，符合要求的音视频轨会直接保留。';

  try {
    const payload = await fetchJson(`/api/media/${item.id}/prepare`, {
      method: 'POST',
      body: JSON.stringify({ repairMode })
    });
    await pollPreparation(payload.job.id, button, statusText);
  } catch (error) {
    console.error(error);
    button.disabled = false;
    button.textContent = '重新检查播放';
    statusText.textContent = error.message;
    statusText.hidden = false;
    statusText.classList.add('error');
  }
}

function applyAiPreparationJob(job, mediaId) {
  const item = currentItems.find((candidate) => candidate.id === mediaId);
  if (!item) return null;
  const terminal = ['done', 'error'].includes(job.status);
  item.aiPreparationJobId = terminal ? null : job.id;
  item.aiPreparationOperation = terminal ? null : job.operation;
  if (job.operation === 'upgrade') {
    aiPreparationResults.delete(mediaId);
    item.aiPreparationResult = null;
    aiUpgradeResults.delete(mediaId);
    const keepResult = job.status === 'error'
      || (job.status === 'done' && ['retained', 'unknown'].includes(job.oldPackageDisposition));
    item.aiUpgradeJob = terminal && !keepResult ? null : { ...job };
    if (terminal && keepResult) {
      const { aiPackage, ...result } = job;
      aiUpgradeResults.set(mediaId, result);
      while (aiUpgradeResults.size > 100) aiUpgradeResults.delete(aiUpgradeResults.keys().next().value);
    }
    // aiPackage is the canonical package, never the progress of its replacement.
    if (Object.hasOwn(job, 'aiPackage')) {
      item.aiPackage = job.aiPackage;
      if (job.aiPackage?.imageSettings?.mode) {
        item.storyboardProfile = {
          mode: job.aiPackage.imageSettings.mode,
          ...(job.aiPackage.imageSettings.mode === 'full' ? { height: job.aiPackage.imageSettings.storyboardHeight } : {})
        };
      }
    }
    updateAiPreparationCard(item);
    renderCurrentAiBuffer();
    return item;
  }
  item.aiUpgradeJob = null;
  aiUpgradeResults.delete(mediaId);
  aiPreparationResults.delete(mediaId);
  item.aiPreparationResult = terminal ? { status: job.status, message: job.status === 'error' ? job.error || job.message || '观影包准备失败。' : '' } : null;
  if (terminal) {
    aiPreparationResults.set(mediaId, item.aiPreparationResult);
    while (aiPreparationResults.size > 100) aiPreparationResults.delete(aiPreparationResults.keys().next().value);
  }
  item.aiPackage = {
    ...item.aiPackage,
    ...job.aiPackage,
    status: job.aiPackage?.status || (job.status === 'done' ? 'ready' : job.status === 'error' ? 'failed' : 'running'),
    progress: { ...item.aiPackage?.progress, percent: Number(job.progress) || 0 },
    ...Object.fromEntries(['viewingTrack', 'aiReadiness', 'dialogueTrack', 'audioTrack', 'durationMs', 'canStartViewing']
      .filter((key) => job[key] !== undefined).map((key) => [key, job[key]]))
  };
  updateAiPreparationCard(item);
  renderCurrentAiBuffer();
  return item;
}

async function pollAiPreparation(jobId, mediaId) {
  while (currentItems.some((item) => item.id === mediaId)) {
    const { job } = await fetchJson('/api/jobs/' + encodeURIComponent(jobId));
    applyAiPreparationJob(job, mediaId);
    if (job.status === 'done') {
      aiPreparationPollErrors.delete(mediaId);
      await refreshLibrary();
      return;
    }
    if (job.status === 'error') {
      throw Object.assign(new Error(job.error || '观影包准备失败，已完成的部分会保留。'), {
        code: 'AI_PREPARATION_FAILED'
      });
    }
    await delay(400);
  }
}

function startAiPreparationPolling(jobId, mediaId) {
  if (aiPreparationPolls.has(jobId)) return aiPreparationPolls.get(jobId);
  aiPreparationPollErrors.delete(mediaId);
  const item = currentItems.find((candidate) => candidate.id === mediaId);
  if (item) updateAiPreparationCard(item);
  const task = pollAiPreparation(jobId, mediaId).catch((error) => {
    const current = currentItems.find((candidate) => candidate.id === mediaId);
    if (!current) return;
    const interrupted = error.code !== 'AI_PREPARATION_FAILED';
    aiPreparationPollErrors.set(mediaId, {
      message: interrupted
        ? '暂时无法读取进度，任务可能仍在继续。点「刷新准备进度」重试。'
        : error.message
    });
    updateAiPreparationCard(current);
    renderCurrentAiBuffer();
  }).finally(() => aiPreparationPolls.delete(jobId));
  aiPreparationPolls.set(jobId, task);
  return task;
}

async function prepareAiMedia(item, button, statusText) {
  if (aiPreparationStarting.size) return;
  if (item.aiPreparationJobId) {
    await startAiPreparationPolling(item.aiPreparationJobId, item.id);
    return;
  }
  const upgrading = Boolean(item.aiPackage?.needsStoryboardUpgrade);
  if (!viewingSettings) {
    await openViewingSettings();
    return;
  }
  // One shared settings dialog owns the choice until it is cancelled or submitted.
  aiPreparationStarting.add(item.id);
  button.disabled = true;
  try {
    if (shouldRemindBeforePreparation(item, viewingSettings)) {
      const decision = await new Promise(resolve => {
        skipReminderDialog.returnValue = 'cancel';
        skipReminderDialog.addEventListener('close', () => resolve(skipReminderDialog.returnValue), { once: true });
        skipReminderDialog.showModal();
      });
      if (decision === 'fill') {
        void openFilmSettings(item, () => {
          mediaGrid.querySelector('[data-media-id="' + CSS.escape(item.id) + '"] .ai-prepare-button')?.focus();
        }, { editSkip: true });
      }
      if (decision !== 'continue') return;
    }
    if (!upgrading && !viewingSettings.configured) {
      await openViewingSettings();
      if (viewingSettings) setViewingSettingsStatus('请先保存观影设置，再开始准备这部影片。');
      return;
    }
    const audioOnly = !upgrading && item.aiPackage?.status === 'ready';
    const choice = await chooseAiDialogueTrack(item);
    if (!choice) return;
    const { dialogueTrackId, storyboardProfile } = choice;

    const currentProfile = item.storyboardProfile || item.aiPackage?.storyboardProfile;
    const rebuilding = upgrading || (item.aiPackage && JSON.stringify(currentProfile) !== JSON.stringify(storyboardProfile));

    const selectedTrack = (item.subtitleTracks || []).find((track) => track.id === dialogueTrackId) || null;
    if (upgrading) {
      aiUpgradeResults.delete(item.id);
      item.aiUpgradeJob = null;
    }
    aiPreparationResults.delete(item.id);
    item.aiPreparationResult = null;
    aiPreparationPollErrors.delete(item.id);
    button.textContent = upgrading ? '开始升级…' : '正在开始准备…';
    statusText.hidden = false;
    statusText.classList.remove('error');
    statusText.textContent = rebuilding
      ? '正在生成新版观影包，校验完成后会替换旧包。'
      : audioOnly
      ? '继续准备观影包，复用已完成的资料…'
      : selectedTrack
        ? '正在使用' + subtitleOptionLabel(selectedTrack) + '作为 AI 的对白字幕。'
        : '未选择对白字幕，将准备可用的观影资料。';

    const payload = await fetchJson('/api/media/' + item.id + (upgrading ? '/upgrade-ai' : '/prepare-ai'), {
      method: 'POST',
      body: JSON.stringify({ ...(dialogueTrackId ? { dialogueTrackId } : {}), ...(storyboardProfile ? { storyboardProfile } : {}) })
    });
    applyAiPreparationJob(payload.job, item.id);
    statusText.hidden = true;
    aiPreparationStarting.delete(item.id);
    await startAiPreparationPolling(payload.job.id, item.id);
  } catch (error) {
    if (error.code === 'AUDIO_SETUP_REQUIRED') {
      await openViewingSettings();
      setViewingSettingsStatus(error.message, true);
      return;
    }
    console.error(error);
    const message = error.status ? error.message
      : '暂时无法确认任务是否开始，请刷新片库查看进度。';
    aiPreparationPollErrors.set(item.id, { message });
    statusText.hidden = true;
  } finally {
    aiPreparationStarting.delete(item.id);
    const current = currentItems.find((candidate) => candidate.id === item.id);
    if (current) updateAiPreparationCard(current);
  }
}

function resetDeletedMediaState(mediaId) {
  aiPreparationPollErrors.delete(mediaId);
  delete playbackProgress[mediaId];
  delete subtitleChoices[mediaId];
  delete directPlayReady[mediaId];
  writeStoredObject(STORAGE.playbackProgress, playbackProgress);
  writeStoredObject(STORAGE.subtitleChoices, subtitleChoices);
  writeStoredObject(STORAGE.directPlayReady, directPlayReady);
  if (localStorage.getItem(STORAGE.lastMedia) === mediaId) {
    localStorage.removeItem(STORAGE.lastMedia);
  }
  if (activeMediaId === mediaId) {
    activeMediaId = null;
    activeMediaPlayable = false;
    videoPlayer.pause();
    videoPlayer.removeAttribute('src');
    setupSubtitles(null);
    videoPlayer.load();
    playerShell.classList.remove('has-media');
    setNowPlayingTitle(null);
    setPlayerNotice('');
  }
}

const recordDialog = document.querySelector('#recordDialog');
const recordConfirm = document.querySelector('#recordConfirm');
const recordCancel = document.querySelector('#recordCancel');
const recordEffect = document.querySelector('#recordDialogEffect');
const recordError = document.querySelector('#recordDialogError');
let recordAction = null;
let recordBusy = false;
function showRecordDialog(action) {
  if (recordDialog.open) return;
  recordAction = action;
  document.querySelector('#recordDialogTitle').textContent = action.title;
  document.querySelector('#recordDialogContext').textContent = action.context;
  recordConfirm.disabled = false;
  recordConfirm.textContent = '删除这次房间记录';
  recordEffect.textContent = action.effect;
  recordError.hidden = true;
  recordDialog.showModal();
  recordCancel.focus();
}
function closeRecordDialog() {
  const action = recordAction;
  recordAction = null;
  recordDialog.close();
  action?.restoreFocus();
}
recordCancel.onclick = closeRecordDialog;
recordDialog.oncancel = (event) => {
  event.preventDefault();
  if (!recordBusy) closeRecordDialog();
};
recordConfirm.onclick = async () => {
  if (recordBusy || recordConfirm.disabled) return;
  recordBusy = true;
  recordCancel.disabled = recordConfirm.disabled = true;
  try {
    await recordAction.run();
    closeRecordDialog();
  } catch (error) {
    recordError.textContent = error.message;
    recordError.hidden = false;
  } finally {
    recordBusy = false;
    recordCancel.disabled = recordConfirm.disabled = false;
  }
};

async function refreshAfterCleanup(mediaIds, selected) {
  const affected = new Set(mediaIds);
  for (const id of affected) {
    if (selected.package || selected.video) {
      aiPreparationResults.delete(id);
      aiUpgradeResults.delete(id);
      aiPreparationPollErrors.delete(id);
    }
    if (selected.video) resetDeletedMediaState(id);
  }
  if (selected.records && affected.has(selectedRoom?.mediaId)) {
    selectedRoom = null;
    messages = [];
    resetTimeline(0);
  }
  await refreshLibrary();
  await refreshRooms({ restoreActive: false });
  if (selected.video && selectedRoom?.status === 'ended' && affected.has(selectedRoom.mediaId)) {
    await loadArchivedRoom(selectedRoom.id);
  }
  if (selected.subtitles && affected.has(activeMediaId)) setupSubtitles(currentMedia());
}
function deleteMedia(item) {
  return openCleanup({
    target: { mediaId: item.id }, name: item.title,
    restoreFocus: () => (mediaGrid.querySelector('[data-media-id="' + item.id + '"] .media-delete-button') || rescanButton).focus()
  }).catch(error => setPlayerNotice(error.message, true));
}

function paintSubtitleJobStatus(status, job, offline = false) {
  status.textContent = subtitleJobSummary(job, offline);
  status.hidden = !status.textContent;
  status.classList.toggle('error', offline || ['failed', 'interrupted'].includes(job?.status));
}

function updateSubtitleJobStatus(mediaId, job, offline = false) {
  const item = currentItems.find((entry) => entry.id === mediaId);
  if (!item) return;
  item.subtitleJob = job;
  const card = mediaGrid.querySelector('[data-media-id="' + CSS.escape(mediaId) + '"]');
  const status = card?.querySelector('.film-subtitle-job');
  if (status) paintSubtitleJobStatus(status, job, offline);
}

function renderMedia(items) {
  const previous = currentMedia();
  for (const item of items) {
    if (item.aiPreparationJobId) aiPreparationResults.delete(item.id);
    else if (aiPreparationResults.has(item.id)) item.aiPreparationResult = { ...aiPreparationResults.get(item.id) };
    if (item.aiPreparationJobId && item.aiPreparationOperation === 'upgrade') {
      aiUpgradeResults.delete(item.id);
    } else if (aiUpgradeResults.has(item.id)) {
      item.aiUpgradeJob = { ...aiUpgradeResults.get(item.id) };
    }
  }
  currentItems = items;
  shelf.paint();
  const active = currentMedia();
  if (active) {
    setNowPlayingTitle(active);
    const signature = (item) => JSON.stringify(item?.subtitleTracks || []);
    if (signature(previous) !== signature(active)) {
      const localLabel = subtitleSelect.value === 'local' ? videoPlayer.querySelector('track[data-owc-subtitle]')?.label : null;
      if (localLabel) renderSubtitleOptions(active, { localLabel, selectedValue: 'local' });
      else setupSubtitles(active);
    }
  }
  mediaGrid.replaceChildren();
  updateCount(items.length);
  emptyState.hidden = items.length !== 0;

  items.forEach((item) => {
    const card = document.createElement('article');
    card.className = 'media-card';
    card.dataset.mediaId = item.id;
    card.dataset.collection = item.collectionPath || '';
    card.dataset.searchText = normalizeSearch([
      item.title,
      item.relativePath,
      item.extension,
      item.videoCodec,
      item.audioCodec
    ].filter(Boolean).join(' '));
    card.classList.toggle('active', item.id === activeMediaId);

    const playButton = document.createElement('button');
    playButton.type = 'button';
    playButton.className = 'media-play';
    const lockedByRoom = Boolean(activeRoom && activeRoom.mediaId !== item.id);
    const preparationActive = ['checking', 'processing'].includes(item.compatibilityStatus);
    playButton.disabled = lockedByRoom || preparationActive;
    playButton.title = lockedByRoom
      ? '请先结束当前房间，再切换影片。'
      : preparationActive
        ? '播放修复完成后即可试播。'
        : '在当前浏览器试播这部影片。';

    const title = document.createElement('strong');
    title.textContent = item.title;
    title.title = item.title;

    const details = document.createElement('small');
    const codecs = [item.videoCodec, item.audioCodec].filter(Boolean).join(' + ');
    details.textContent = `${item.extension.replace('.', '').toUpperCase()} · ${formatBytes(item.size)}${codecs ? ` · ${codecs.toUpperCase()}` : ''}`;

    const badge = document.createElement('span');
    badge.className = `compatibility-badge status-${compatibilityBadgeStatus(item)}`;
    badge.textContent = compatibilityLabel(item);

    const metadata = document.createElement('span');
    metadata.className = 'film-metadata';
    metadata.append(details, badge);
    playButton.append(title, metadata);
    playButton.addEventListener('click', () => chooseMedia(item));

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'media-delete-button';
    deleteButton.setAttribute('aria-label', `为《${item.title}》释放空间`);
    deleteButton.title = '释放空间';
    deleteButton.textContent = '×';
    deleteButton.addEventListener('click', () => deleteMedia(item));

    const header = document.createElement('div');
    header.className = 'film-card-header';
    const tools = shelf.controls(item);
    header.append(playButton, tools);
    card.append(header, deleteButton);

    const actionArea = document.createElement('div');
    actionArea.className = 'media-actions';
    const actionButtons = document.createElement('div');
    actionButtons.className = 'media-action-buttons';

    const statusText = document.createElement('p');
    statusText.className = 'compatibility-note';
    statusText.classList.toggle('error', Boolean(item.compatibilityError));
    statusText.hidden = !item.compatibilityError;
    statusText.textContent = item.compatibilityError || '';

    if (!playbackReadyForCurrentBrowser(item)) {
      const readyButton = document.createElement('button');
      readyButton.type = 'button';
      readyButton.className = 'prepare-button ready-confirm-button';
      readyButton.textContent = '确认可播放';
      readyButton.disabled = !canConfirmDirectPlay(item);
      readyButton.title = canConfirmDirectPlay(item)
        ? '确认此浏览器的画面和声音都能正常播放。'
        : '请先选择这部影片，试播画面和声音。';
      readyButton.addEventListener('click', () => confirmDirectPlayReady(item));

      const prepareButton = document.createElement('button');
      prepareButton.type = 'button';
      prepareButton.className = 'prepare-button';
      prepareButton.textContent = item.compatibilityStatus === 'error'
        ? '重新检查播放'
        : item.compatibilityStatus === 'prepared'
          ? '调整播放修复'
          : '检查播放';
      prepareButton.disabled = ['checking', 'processing'].includes(item.compatibilityStatus);
      prepareButton.addEventListener('click', () => prepareMedia(item, prepareButton, statusText));
      actionButtons.append(readyButton, prepareButton);
    }

    const aiButton = document.createElement('button');
    aiButton.type = 'button';
    aiButton.className = 'prepare-button ai-prepare-button';
    const aiButtonState = aiPreparationButtonState(item, viewingSettings?.includeAudio !== false);
    aiButton.textContent = aiButtonState.text;
    aiButton.disabled = aiButtonState.disabled;
    aiButton.addEventListener('click', () => prepareAiMedia(item, aiButton, statusText));
    actionButtons.append(aiButton);

    const aiProgress = document.createElement('div');
    aiProgress.className = 'card-ai-progress';
    aiProgress.dataset.aiProgress = 'true';
    aiProgress.hidden = true;
    const aiProgressHead = document.createElement('div');
    aiProgressHead.className = 'card-ai-progress-head';
    const aiProgressLabel = document.createElement('span');
    aiProgressLabel.className = 'card-ai-progress-label';
    const aiProgressValue = document.createElement('span');
    aiProgressValue.className = 'card-ai-progress-value';
    aiProgressHead.append(aiProgressLabel, aiProgressValue);
    const aiProgressTrack = document.createElement('div');
    aiProgressTrack.className = 'flow-progress-track';
    aiProgressTrack.setAttribute('role', 'progressbar');
    aiProgressTrack.setAttribute('aria-valuemin', '0');
    aiProgressTrack.setAttribute('aria-valuemax', '100');
    aiProgressTrack.setAttribute('aria-valuenow', '0');
    aiProgressTrack.setAttribute('aria-label', '观影包准备进度');
    const aiProgressFill = document.createElement('div');
    aiProgressFill.className = 'flow-progress-fill';
    aiProgressTrack.append(aiProgressFill);
    aiProgress.append(aiProgressHead, aiProgressTrack);

    const aiStatus = document.createElement('p');
    aiStatus.className = 'ai-package-note';

    const subtitleStatus = document.createElement('p');
    subtitleStatus.className = 'compatibility-note film-subtitle-job';
    paintSubtitleJobStatus(subtitleStatus, item.subtitleJob);
    actionArea.append(actionButtons, aiProgress, aiStatus, subtitleStatus, statusText);
    card.append(actionArea);

    mediaGrid.append(card);
    updateAiPreparationCard(item);
  });

  applyMediaFilter();

  if (activeMediaId && !items.some((item) => item.id === activeMediaId)) {
    activeMediaId = null;
    activeMediaPlayable = false;
    videoPlayer.removeAttribute('src');
    setupSubtitles(null);
    videoPlayer.load();
    playerShell.classList.remove('has-media');
    setNowPlayingTitle(null);
    setPlayerNotice('');
  }
  renderRoomState();
  filmSubtitleSettings.reconcile(items);
  for (const item of items) {
    if (item.aiPreparationJobId && !aiPreparationPollErrors.has(item.id)) {
      void startAiPreparationPolling(item.aiPreparationJobId, item.id);
    }
  }
}

async function fetchMedia() {
  const payload = await fetchJson('/api/media');
  return payload.items || [];
}

let libraryRequest = 0;
let subtitleRefreshQueued = false;
let subtitleRefreshScheduled = false;

function scheduleSubtitleLibraryRefresh() {
  subtitleRefreshQueued = true;
  if (subtitleRefreshScheduled) return;
  subtitleRefreshScheduled = true;
  setTimeout(async () => {
    subtitleRefreshQueued = false;
    try {
      await refreshLibrary();
    } finally {
      subtitleRefreshScheduled = false;
      if (subtitleRefreshQueued) scheduleSubtitleLibraryRefresh();
    }
  }, 150);
}

async function refreshLibrary({ rescan = false } = {}) {
  const request = ++libraryRequest;
  rescanButton.disabled = true;
  rescanButton.classList.add('is-scanning');
  rescanButton.dataset.tip = rescan ? '正在扫描…' : '正在读取…';
  rescanButton.setAttribute('aria-label', rescan ? '正在扫描片库' : '正在读取片库');

  try {
    let items;
    if (rescan) {
      const payload = await fetchJson('/api/media/rescan', { method: 'POST' });
      items = payload.items || [];
    } else {
      items = await fetchMedia();
    }
    const library = await fetchJson('/api/library');
    if (request !== libraryRequest) return;
    shelf.update(library);
    renderMedia(items);
    serverStatus.textContent = '片库已连接';
    serverStatus.classList.add('online');
  } catch (error) {
    console.error(error);
    if (request !== libraryRequest) return;
    serverStatus.textContent = '片库暂时不可用';
    serverStatus.classList.remove('online');
    setPlayerNotice(error.message, true);
  } finally {
    if (request === libraryRequest) {
      rescanButton.disabled = false;
      rescanButton.classList.remove('is-scanning');
      rescanButton.dataset.tip = '重新扫描';
      rescanButton.setAttribute('aria-label', '重新扫描片库');
    }
  }
}

function renderSessions() {
  sessionList.replaceChildren();
  const pastRooms = rooms.filter((room) => room.status === 'ended');
  if (pastRooms.length === 0) {
    expandedSessionGroups.clear();
    const empty = document.createElement('div');
    empty.className = 'sidebar-empty';
    empty.innerHTML = '<div class="sidebar-history-symbol" aria-hidden="true">◷</div><p class="sidebar-empty-title">往期放映，等待收录</p><p class="sidebar-empty-desc">结束后的放映与留下的话语会陈列在这里。</p>';
    sessionList.append(empty);
    return;
  }

  const groups = new Map();
  for (const room of pastRooms) {
    const key = sessionGroupKey(room);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        title: room.mediaTitle,
        mediaAvailable: room.mediaAvailable !== false,
        rooms: []
      });
    }
    const entry = groups.get(key);
    if (room.mediaAvailable !== false) entry.mediaAvailable = true;
    entry.rooms.push(room);
  }

  for (const groupKey of [...expandedSessionGroups]) {
    if (!groups.has(groupKey)) expandedSessionGroups.delete(groupKey);
  }

  for (const groupData of groups.values()) {
    const hasActiveRoom = groupData.rooms.some((room) => selectedRoom?.id === room.id);
    const isOpen = expandedSessionGroups.has(groupData.key);

    const groupEl = document.createElement('section');
    groupEl.className = 'session-group';
    groupEl.classList.toggle('open', isOpen);
    groupEl.classList.toggle('has-active', hasActiveRoom);

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'session-group-header';
    header.setAttribute('aria-expanded', String(isOpen));

    const titleWrap = document.createElement('div');
    titleWrap.className = 'session-group-title';
    const title = document.createElement('strong');
    title.textContent = groupData.title;
    titleWrap.append(title);
    if (!groupData.mediaAvailable) {
      const missing = document.createElement('span');
      missing.className = 'session-group-missing';
      missing.textContent = '原片缺失';
      titleWrap.append(missing);
    }

    const aside = document.createElement('span');
    aside.className = 'session-group-aside';
    const count = document.createElement('span');
    count.className = 'session-group-count';
    count.textContent = `${groupData.rooms.length} 场`;
    aside.append(count);
    aside.insertAdjacentHTML(
      'beforeend',
      '<svg class="session-group-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg>'
    );

    header.append(titleWrap, aside);

    const body = document.createElement('div');
    body.className = 'session-group-body';
    body.setAttribute('aria-hidden', String(!isOpen));
    body.inert = !isOpen;

    const inner = document.createElement('div');
    inner.className = 'session-group-inner';

    const rows = document.createElement('div');
    rows.className = 'session-group-rows';

    for (const room of groupData.rooms) {
      const row = document.createElement('div');
      row.className = 'session-row';
      row.classList.toggle('active', selectedRoom?.id === room.id);

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'session-row-main';
      main.title = room.mediaAvailable === false ? '原片缺失 · 可回看房间记录' : '回看房间';

      const dateEl = document.createElement('span');
      dateEl.className = 'session-row-date';
      dateEl.textContent = formatSessionRowDate(room.openedAt);

      const countEl = document.createElement('span');
      countEl.className = 'session-row-meta';
      countEl.textContent = `${room.messageCount} 条`;

      main.append(dateEl, countEl);
      main.addEventListener('click', () => loadArchivedRoom(room.id));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'archive-remove';
      remove.dataset.roomId = room.id;
      remove.textContent = '删除';
      remove.title = '删除这次房间记录';
      remove.setAttribute('aria-label', '删除这次房间记录');
      remove.onclick = async (event) => {
        event.stopPropagation();
        if (remove.disabled || recordDialog.open) return;
        remove.disabled = true;
        try {
          const { preview } = await fetchJson('/api/rooms/' + room.id + '/delete-preview');
          showRecordDialog({
            title: '删除这次房间记录',
            context: '《' + (preview.title || room.mediaTitle) + '》 · ' + formatSessionDate(room.openedAt) + ' · ' + (preview.messageCount ?? room.messageCount) + ' 条消息',
            effect: preview.lastRoom
              ? '这是本片最后一次放映，同时删除本片小本本（共 ' + preview.entryCount + ' 条）。'
              : '删除这次放映的房间和聊天记录。其他放映与本片小本本会保留。',
            restoreFocus: () => (sessionList.querySelector('[data-room-id="' + room.id + '"]') || sessionsTab).focus(),
            run: async () => {
              await fetchJson('/api/rooms/' + room.id, { method: 'DELETE', body: JSON.stringify({ confirmRoomId: room.id, revision: preview.revision }) });
              if (selectedRoom?.id === room.id) { selectedRoom = null; messages = []; resetTimeline(0); }
              await refreshRooms({ restoreActive: false });
            }
          });
        } catch (error) { setPlayerNotice(error.message, true); }
        finally { remove.disabled = false; }
      };

      row.append(main, remove);
      rows.append(row);
    }

    inner.append(rows);
    body.append(inner);

    header.addEventListener('click', () => {
      const nextOpen = !groupEl.classList.contains('open');
      if (nextOpen) expandedSessionGroups.add(groupData.key);
      else expandedSessionGroups.delete(groupData.key);
      groupEl.classList.toggle('open', nextOpen);
      header.setAttribute('aria-expanded', String(nextOpen));
      body.setAttribute('aria-hidden', String(!nextOpen));
      body.inert = !nextOpen;
    });

    groupEl.append(header, body);
    sessionList.append(groupEl);
  }
}

async function refreshRooms({ restoreActive = true } = {}) {
  try {
    const payload = await fetchJson('/api/rooms');
    activeRoom = payload.activeRoom || null;
    rooms = payload.rooms || [];
    if (selectedRoom) selectedRoom = rooms.find((room) => room.id === selectedRoom.id) || selectedRoom;
    renderSessions();

    if (restoreActive && activeRoom) {
      selectedRoom = activeRoom;
      const item = currentItems.find((candidate) => candidate.id === activeRoom.mediaId);
      if (item) {
        chooseMedia(item, { force: true, seekMs: activeRoom.lastPositionMs, preserveRoom: true });
        if (activeRoom.resumeFromMs != null && activeRoom.seekVersion === 0) {
          pendingRoomStart = { positionMs: activeRoom.lastPositionMs, resume: true };
        }
      }
      await loadRoomMessages(activeRoom.id, { beginPolling: true, quiet: true });
      return;
    }

    if (!activeMediaId && !selectedRoom) {
      const lastMediaId = localStorage.getItem(STORAGE.lastMedia);
      const remembered = currentItems.find((item) => (
        item.id === lastMediaId && !['checking', 'processing'].includes(item.compatibilityStatus)
      ));
      if (remembered) chooseMedia(remembered);
      else renderRoomState();
    } else {
      renderRoomState();
    }
  } catch (error) {
    console.error(error);
    setPlayerNotice(error.message, true);
  }
}

function askRoomOpening({ automaticMode, warning, resume }) {
  roomOpeningMessage.value = '';
  roomOpeningMessageLabel.hidden = !automaticMode;
  roomOpeningHelp.hidden = !automaticMode;
  if (automaticMode) {
    const destination = automaticMode === 'chat' ? 'ChatGPT' : 'Codex';
    roomOpeningHelp.textContent = `影片开始播放后，这段话会随第一批观影内容一起发给 ${destination}。`;
  }
  roomOpeningMessage.hidden = !automaticMode;
  roomOpeningSubmit.value = resume ? 'resume' : 'open';
  roomOpeningSubmit.textContent = resume ? `从 ${formatFilmTime(resume.lastPositionMs)} 继续` : '开房';
  roomOpeningRestart.hidden = !resume;
  roomOpeningWarning.textContent = warning ?? '';
  roomOpeningWarning.hidden = !warning;
  roomOpeningDialog.returnValue = '';
  return new Promise((resolve) => {
    roomOpeningDialog.addEventListener('close', () => {
      const choice = roomOpeningDialog.returnValue;
      resolve(['open', 'resume', 'restart'].includes(choice) ? {
        openingMessage: roomOpeningMessage.value.trim(),
        resume: choice === 'resume' ? resume : null
      } : null);
    }, { once: true });
    roomOpeningDialog.showModal();
  });
}

async function openRoom() {
  const item = currentMedia();
  if (!item || activeRoom || roomOpeningPending) return;
  let opening = { openingMessage: '', resume: null };
  roomOpeningPending = true;
  openRoomButton.disabled = true;
  try {
    const [automaticMode, { resume }] = await Promise.all([
      readEnabledViewingMode(fetchJson),
      fetchJson('/api/rooms/resume?mediaId=' + encodeURIComponent(item.id)).catch((error) => {
        if (error.status === 404) return { resume: null };
        throw error;
      })
    ]);
    if (currentMedia()?.id !== item.id || activeRoom) return;
    const warning = aiExperienceWarning(item);
    if (automaticMode || resume) {
      opening = await askRoomOpening({ automaticMode, warning, resume });
      if (!opening || currentMedia()?.id !== item.id || activeRoom) return;
    } else if (warning && !window.confirm(`${warning}\n\n现在打开房间吗？`)) {
      return;
    }
    const { openingMessage } = opening;
    const { room, mcpResumePrompt } = await fetchJson('/api/rooms/open', {
      method: 'POST',
      body: JSON.stringify({
        mediaId: item.id,
        ...(openingMessage ? { openingMessage } : {}),
        ...(opening.resume ? { resume: opening.resume, includeMcpResumePrompt: !automaticMode } : {})
      })
    });
    activeRoom = room;
    selectedRoom = room;
    messages = [];
    if (currentMedia()?.id !== item.id) {
      chooseMedia(item, { force: true, seekMs: room.lastPositionMs, preserveRoom: true });
    }
    if (resume) {
      pendingRoomStart = { positionMs: room.lastPositionMs, resume: room.resumeFromMs != null };
      if (activeMediaPlayable) applyRoomStartPosition();
      else resetTimeline(room.lastPositionMs);
    } else {
      resetTimeline(Math.round(videoPlayer.currentTime * 1000));
    }
    setPlayerNotice('');
    setSidebarView('messages');
    setSidebarOpen(true);
    renderRoomState();
    schedulePlaybackSync();
    await refreshRooms({ restoreActive: false });
    startMessagePolling();
    if (mcpResumePrompt && opening.resume && roomIsWritable() && activeRoom.id === room.id) {
      mcpResumeDialog.show({
        ...mcpResumePrompt,
        roomId: room.id,
        title: room.mediaTitle,
        time: formatFilmTime(room.resumeFromMs)
      });
    }
  } catch (error) {
    setPlayerNotice(error.code === 'ROOM_RESUME_STALE' ? '上次的房间进度已更新。请再次点「开启房间」。' : error.message, true);
  } finally {
    roomOpeningPending = false;
    renderRoomState();
    if (!opening) openRoomButton.focus();
  }
}

function resetToSoloRoomView() {
  mcpResumeDialog.close();
  messagePollToken += 1;
  activeRoom = null;
  selectedRoom = null;
  pendingRoomStart = null;
  messages = [];
  unreadCount = 0;
  renderUnread();
  resetTimeline(Math.round((videoPlayer.currentTime || 0) * 1000));
  renderRoomState();
}

async function endRoom() {
  if (!activeRoom) return;
  endRoomButton.disabled = true;
  try {
    await fetchJson(`/api/rooms/${activeRoom.id}/end`, {
      method: 'POST',
      body: JSON.stringify({ mediaTimeMs: pendingRoomStart?.positionMs ?? Math.round(videoPlayer.currentTime * 1000) })
    });
    resetToSoloRoomView();
    await refreshRooms({ restoreActive: false });
  } catch (error) {
    setPlayerNotice(error.message, true);
  } finally {
    endRoomButton.disabled = false;
  }
}

async function loadRoomMessages(roomId, { beginPolling = false, quiet = false } = {}) {
  try {
    const payload = await fetchJson(`/api/rooms/${roomId}/messages`);
    selectedRoom = payload.room;
    messages = payload.messages || [];
    resetTimeline(Math.round(videoPlayer.currentTime * 1000));
    renderRoomState();
    if (beginPolling && selectedRoom.status === 'active') startMessagePolling();
  } catch (error) {
    if (!quiet) setPlayerNotice(error.message, true);
  }
}

async function loadArchivedRoom(roomId) {
  if (activeRoom) {
    setPlayerNotice('请先结束当前房间，再打开历史放映。', true);
    return;
  }
  try {
    const payload = await fetchJson(`/api/rooms/${roomId}`);
    selectedRoom = payload.room;
    expandedSessionGroups.add(sessionGroupKey(selectedRoom));
    messages = payload.messages || [];
    const item = currentItems.find((candidate) => candidate.id === selectedRoom.mediaId);
    if (item && selectedRoom.mediaAvailable !== false) {
      chooseMedia(item, { force: true, seekMs: 0, preserveRoom: true });
    } else {
      savePlaybackProgress({ force: true });
      activeMediaId = null;
      activeMediaPlayable = false;
      pendingSeekMs = null;
      playbackSkip.reset();
      videoPlayer.pause();
      videoPlayer.removeAttribute('src');
      setupSubtitles(null);
      videoPlayer.load();
      playerShell.classList.remove('has-media');
      setNowPlayingTitle({ title: selectedRoom.mediaTitle });
      setPlayerNotice('');
    }
    resetTimeline(0);
    setSidebarView('messages');
    setSidebarOpen(true);
    renderSessions();
    renderRoomState();
  } catch (error) {
    setPlayerNotice(error.message, true);
  }
}

document.querySelector('#archiveRelinkFile').onchange = async (event) => {
  const input = event.target;
  const [file] = input.files;
  const { roomId, mediaId } = input.dataset;
  input.value = '';
  if (!file || selectedRoom?.id !== roomId) return;
  try {
    const query = new URLSearchParams({ name: file.name });
    await fetchJson('/api/media/' + encodeURIComponent(mediaId) + '/relink?' + query, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file
    });
    await refreshLibrary();
    await refreshRooms({ restoreActive: false });
    if (selectedRoom?.id === roomId) await loadArchivedRoom(roomId);
  } catch (error) { setPlayerNotice(error.message, true); }
};

function connectMessageEvents() {
  if (messageEvents || typeof EventSource === 'undefined') return;
  messageEvents = new EventSource('/api/events');
  let connectedBefore = false;
  messageEvents.onopen = () => {
    messageEventsConnected = true;
    if (connectedBefore) void refreshLibrary();
    connectedBefore = true;
    aiActivity.notify();
    void refreshAutomaticViewingSettings();
    void refreshParticipantNames().catch(console.error);
    // Every reconnect reconciles snapshots; events themselves are not message history.
    messageSettingsRefresh = messageSettingsRefresh.then(() => refreshInteractionSettings()).catch(console.error);
    void messageSettingsRefresh.then(() => requestMessageRefresh?.());
  };
  messageEvents.onerror = () => {
    messageEventsConnected = false;
    requestMessageRefresh?.();
  };
  messageEvents.onmessage = (event) => {
    let notification;
    try { notification = JSON.parse(event.data); } catch { return; }
    if (notification.type === 'watch-bridge-playback') return;
    if (notification.type === 'watch-bridge-settings') {
      void refreshAutomaticViewingSettings();
      return;
    }
    if (notification.type === 'watch-bridge-chat') {
      void chatSettings.refresh();
      aiActivity.notify();
      return;
    }
    if (notification.type === 'library-changed') {
      void refreshLibrary().then(() => refreshRooms({ restoreActive: false }));
      return;
    }
    if (notification.type === 'subtitle-library-changed') {
      scheduleSubtitleLibraryRefresh();
      return;
    }
    if (notification.type === 'ai-activity') {
      aiActivity.notify();
      return;
    }
    if (notification.type === 'participant-name') {
      aiActivity.notify();
      void refreshParticipantNames().catch(console.error);
      return;
    }
    if (['notebook', 'notebook-edit'].includes(notification.type)) {
      notebook.notify(notification);
      return;
    }
    if (notification.type === 'settings') {
      messageSettingsRefresh = messageSettingsRefresh
        .then(() => Promise.all([refreshInteractionSettings(), quickMessages.refresh()]))
        .catch(console.error);
      void messageSettingsRefresh.then(() => requestMessageRefresh?.());
    } else if (notification.roomId === activeRoom?.id) requestMessageRefresh?.();
  };
}

function startMessagePolling() {
  const token = ++messagePollToken;
  const roomId = activeRoom?.id;
  let running = false;
  let dirty = false;
  let timer;
  const current = () => token === messagePollToken && activeRoom?.id === roomId;
  const refresh = async () => {
    if (!current()) { clearTimeout(timer); return; }
    clearTimeout(timer);
    if (running) { dirty = true; return; }
    running = true;
    try {
      await messageSettingsRefresh;
      // Settings are pushed separately. Only the fallback refreshes them periodically.
      if (!messageEventsConnected) await refreshInteractionSettings();
      const payload = await fetchJson(`/api/rooms/${roomId}/messages`);
      if (!current()) return;
      if (payload.room.status !== 'active') {
        resetToSoloRoomView();
        void refreshRooms({ restoreActive: false });
        return;
      }
      const existingIds = new Set(messages.map(message => message.id));
      const incoming = (payload.messages || []).filter(message => !existingIds.has(message.id));
      const fetchedIds = new Set((payload.messages || []).map(message => message.id));
      // Preserve a just-sent message if this GET snapshot began before its POST committed.
      messages = [...(payload.messages || []), ...messages.filter(message => !fetchedIds.has(message.id))];
      selectedRoom = payload.room;
      activeRoom = payload.room;
      renderRoomState();
      for (const message of incoming) {
        timelineShown.add(message.id);
        showLiveInteraction(message);
        if (danmakuEnabled) spawnDanmaku(message);
      }
      if (incoming.length && !sidebarOpen) { unreadCount += incoming.length; renderUnread(); }
    } catch (error) { console.error(error); }
    finally {
      running = false;
      if (current()) {
        if (dirty) { dirty = false; void refresh(); }
        else timer = setTimeout(refresh, messageEventsConnected ? 30000 : 3000);
      }
    }
  };
  requestMessageRefresh = () => { void refresh(); };
  connectMessageEvents();
  void refresh();
}

async function sendRoomMessage(content, interaction = null) {
  if (interaction && (!interactionsEnabled || !INTERACTIONS[interaction])) return;
  const cleanContent = String(content || '').trim();
  if (!roomIsWritable() || !cleanContent) return;
  const roomId = activeRoom.id;
  try {
    while (videoPlayer.seeking && activeRoom?.id === roomId) await waitForPlayerSeek();
    if (!roomIsWritable() || activeRoom.id !== roomId) return;
    const mediaTimeMs = Math.round(videoPlayer.currentTime * 1000);
    await schedulePlaybackSync({ immediate: true });
    if (!roomIsWritable() || activeRoom.id !== roomId) return;
    const senderName = viewerProfile.name;
    const payload = await fetchJson(`/api/rooms/${roomId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        senderName,
        senderKind: 'user',
        content: cleanContent,
        ...(interaction ? { interaction } : {}),
        mediaTimeMs
      })
    });
    if (selectedRoom?.id !== roomId) return;
    if (!messages.some((message) => message.id === payload.message.id)) {
      messages.push(payload.message);
      renderMessages();
      timelineShown.add(payload.message.id);
      showLiveInteraction(payload.message);
      if (danmakuEnabled) spawnDanmaku(payload.message);
    }
  } catch (error) {
    setPlayerNotice(error.message, true);
  }
}

function waitForPlayerSeek() {
  return new Promise((resolve, reject) => {
    const pending = new AbortController();
    const options = { signal: pending.signal };
    videoPlayer.addEventListener('seeked', () => {
      pending.abort();
      resolve();
    }, options);
    function interrupt() {
      pending.abort();
      reject(new Error('影片跳转未完成，请重发消息。'));
    }
    videoPlayer.addEventListener('emptied', interrupt, options);
    videoPlayer.addEventListener('error', interrupt, options);
  });
}

const queuePlaybackSync = createPlaybackSync({
  async send({ roomId, ...playback }) {
    if (!roomIsWritable() || activeRoom.id !== roomId) return;
    const payload = await fetchJson(`/api/rooms/${roomId}/playback`, {
      method: 'POST',
      body: JSON.stringify(playback)
    });
    if (roomIsWritable() && activeRoom.id === roomId) {
      activeRoom = payload.room;
      selectedRoom = payload.room;
    }
  },
  onError: (error) => console.error(error)
});

function schedulePlaybackSync({ seeked = false, immediate = false } = {}) {
  if (!roomIsWritable() || pendingRoomStart || videoPlayer.seeking) return;
  const update = {
    roomId: activeRoom.id,
    mediaTimeMs: Math.round(videoPlayer.currentTime * 1000),
    playbackState: videoPlayer.paused ? 'paused' : 'playing',
    seeked
  };
  if (seeked || bridgePlaybackSample?.roomId !== update.roomId) bridgePlaybackSample = update;
  return queuePlaybackSync(update, { immediate });
}

function seekProgrammatically(timeMs) {
  if (videoPlayer.currentTime === timeMs / 1000) return;
  playbackSkip.programmaticSeek(timeMs);
  videoPlayer.currentTime = timeMs / 1000;
}

function applyRoomStartPosition() {
  const { positionMs, resume } = pendingRoomStart;
  pendingSeekMs = null;
  videoPlayer.pause();
  playbackSkip.reset();
  const durationMs = Number.isFinite(videoPlayer.duration) ? videoPlayer.duration * 1000 : Infinity;
  const startMs = Math.min(positionMs, durationMs);
  if (resume) {
    // Resume inside a skipped range the same way as explicitly seeking into it.
    if (videoPlayer.currentTime !== startMs / 1000) videoPlayer.currentTime = startMs / 1000;
    else playbackSkip.finishSeek(startMs);
  } else {
    seekProgrammatically(startMs);
  }
  if (!videoPlayer.seeking) pendingRoomStart = null;
  resetTimeline(startMs);
}

function skipDuringPlayback() {
  if (!activeMediaPlayable || pendingRoomStart || videoPlayer.paused || videoPlayer.ended || videoPlayer.seeking) return false;
  const timeMs = videoPlayer.currentTime * 1000;
  const targetMs = playbackSkip.nextTarget(timeMs);
  const toMs = Math.min(targetMs ?? timeMs, videoPlayer.duration * 1000);
  if (!(toMs > timeMs)) return false;
  seekProgrammatically(toMs);
  return true;
}

rescanButton.addEventListener('click', () => refreshLibrary({ rescan: true }));
libraryToggle.addEventListener('click', () => {
  setLibraryCollapsed(!librarySection.classList.contains('collapsed'));
});
librarySearch.addEventListener('input', () => {
  if (normalizeSearch(librarySearch.value)) setLibraryCollapsed(false);
  applyMediaFilter();
});
viewingSettingsButton.addEventListener('click', () => void openViewingSettings('names'));
identitySettings.addEventListener('click', () => {
  void openViewingSettings('names');
  senderNameInput.focus();
});
for (const button of viewingSettingsDialog.querySelectorAll('[data-settings-page]')) {
  button.addEventListener('click', () => void openViewingSettings(button.dataset.settingsPage));
}
viewingSettingsRetry.addEventListener('click', () => { void loadViewingCadence().catch(() => {}); });
viewingSettingsClose.addEventListener('click', () => viewingSettingsDialog.close());

viewingSettingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (viewingSettingsLoading || viewingSettingsSaving || !viewingSettings) return;
  const seconds = viewingIntervalInput.valueAsNumber;
  const initialBufferMinutes = Number(initialBufferSelect.value);
  if (!Number.isFinite(seconds) || seconds < 0.5 || seconds > 30) {
    viewingIntervalInput.setCustomValidity('请输入 0.5 至 30 秒之间的数字。');
    viewingIntervalInput.reportValidity();
    return;
  }
  if (![15, 30].includes(initialBufferMinutes)) {
    initialBufferSelect.setCustomValidity('请选择起步缓冲时长。');
    initialBufferSelect.reportValidity();
    return;
  }
  viewingSettingsSaving = true;
  viewingSettingsRetry.hidden = true;
  syncViewingSettingsControls();
  setViewingSettingsStatus('正在保存观影设置…');
  try {
    const { settings } = await fetchJson('/api/viewing-settings', {
      method: 'POST',
      body: JSON.stringify({
        intervalSeconds: seconds, initialBufferMinutes, includeAudio: includeAudioInput.checked,
        skipIntroOutroPrompt: skipIntroOutroPromptInput.checked,
        aiOnlineTimeoutSeconds: aiOnlineTimeoutInput.valueAsNumber
      })
    });
    viewingDraftDirty = false;
    applyViewingCadence(settings);
    setViewingSettingsStatus('已保存 · 每 ' + settings.intervalSeconds + ' 秒检查一次 · 起步缓冲 '
      + settings.initialBufferMinutes + ' 分钟。');
  } catch (error) {
    viewingSettingsRetry.hidden = false;
    setViewingSettingsStatus(error.status
      ? '未能保存观影设置，请核对选项后重试。'
      : '保存结果尚未确认。点击“重新读取”核对已经保存的值，连接中断时先恢复影院连接。', true);
  } finally {
    viewingSettingsSaving = false;
    syncViewingSettingsControls();
  }
});
for (const input of [viewingIntervalInput, aiOnlineTimeoutInput, initialBufferSelect, includeAudioInput, skipIntroOutroPromptInput]) {
  input.addEventListener('input', () => {
    input.setCustomValidity('');
    viewingDraftDirty = true;
    if (!viewingSettingsLoading && !viewingSettingsSaving) setViewingSettingsStatus('设置已修改，点击“保存设置”确认。');
  });
}

openRoomButton.addEventListener('click', openRoom);
roomOpeningMessage.addEventListener('input', () => {
  if (roomOpeningSubmit.value === 'open') {
    roomOpeningSubmit.textContent = roomOpeningMessage.value.trim() ? '保存并开房' : '开房';
  }
});
endRoomButton.addEventListener('click', endRoom);
sidebarHandle.addEventListener('click', (event) => {
  setSidebarOpen(!sidebarOpen);
  event.currentTarget.blur();
});
closeSidebarButton.addEventListener('click', () => setSidebarOpen(false));
messagesTab.addEventListener('click', () => setSidebarView('messages'));
sessionsTab.addEventListener('click', () => setSidebarView('sessions'));

senderNameInput.addEventListener('input', () => {
  nameRevision++;
  nameDraftDirty = senderNameInput.value.trim() !== viewerProfile.displayName;
  viewerNameSave.disabled = !nameDraftDirty || savingViewer;
  viewerNameStatus.textContent = '';
});
viewerNameForm.addEventListener('submit', event => {
  event.preventDefault();
  void saveViewerName();
});

danmakuToggle.addEventListener('click', () => {
  danmakuEnabled = !danmakuEnabled;
  localStorage.setItem(STORAGE.danmaku, String(danmakuEnabled));
  updateDanmakuControls();
});

subtitleSelect.addEventListener('change', () => {
  if (subtitleSelect.value === 'local') return;
  void applySubtitleChoice(subtitleSelect.value);
});

addSubtitleButton.addEventListener('click', () => {
  if (currentMedia()) subtitleFileInput.click();
});

subtitleFileInput.addEventListener('change', async () => {
  const [file] = subtitleFileInput.files || [];
  subtitleFileInput.value = '';
  if (!file) return;
  try {
    await addLocalSubtitle(file);
    setPlayerNotice(`已添加本地字幕 · ${file.name}`);
  } catch (error) {
    setPlayerNotice(error.message, true);
  }
});

quickComposer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = quickMessageInput.value;
  quickMessageInput.value = '';
  await sendRoomMessage(content);
});

sidebarComposer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = sidebarMessageInput.value;
  sidebarMessageInput.value = '';
  await sendRoomMessage(content);
});

sidebarMessageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sidebarComposer.requestSubmit();
  }
});

fullscreenButton.addEventListener('click', async (event) => {
  try {
    if (document.fullscreenElement === cinemaWorkspace) await document.exitFullscreen();
    else await cinemaWorkspace.requestFullscreen();
  } catch (error) {
    setPlayerNotice(`无法进入全屏：${error.message}`, true);
  } finally {
    event.currentTarget.blur();
  }
});

document.addEventListener('fullscreenchange', () => {
  const active = document.fullscreenElement === cinemaWorkspace;
  fullscreenButton.setAttribute('title', active ? '退出全屏' : '影院全屏');
  fullscreenButton.setAttribute('aria-label', active ? '退出全屏' : '影院全屏');
  showScreenActions();
});

screenFrame.addEventListener('pointerenter', () => showScreenActions());
screenFrame.addEventListener('pointermove', () => showScreenActions());
screenFrame.addEventListener('pointerleave', hideScreenActionsSoon);
screenFrame.addEventListener('focusin', () => showScreenActions());
screenFrame.addEventListener('focusout', hideScreenActionsSoon);

videoPlayer.addEventListener('error', () => {
  const mediaError = videoPlayer.error;
  if (!mediaError) return;
  activeMediaPlayable = false;
  const item = currentMedia();
  if (item?.compatibilityStatus !== 'ready') clearBrowserDirectPlayReady(item);
  renderMedia(currentItems);
  renderRoomState();
  const canFallback = item && item.compatibilityStatus !== 'ready';
  setPlayerNotice(
    canFallback
      ? '此浏览器无法播放原文件，可在片库点「检查播放」检查兼容性。'
      : '无法播放这部影片。',
    true
  );
});

videoPlayer.addEventListener('loadedmetadata', () => {
  if (!activeMediaId) return;
  activeMediaPlayable = true;
  const activeItem = currentMedia();
  if (Number.isFinite(videoPlayer.duration) && videoPlayer.duration > 0) {
    setNowPlayingDuration(videoPlayer.duration * 1000);
  }
  renderMedia(currentItems);
  renderRoomState();
  if (pendingRoomStart) {
    applyRoomStartPosition();
  } else if (pendingSeekMs !== null) {
    const durationMs = Number.isFinite(videoPlayer.duration) ? videoPlayer.duration * 1000 : Infinity;
    const safeSeekMs = Math.max(0, Math.min(durationMs, pendingSeekMs));
    if (!activeRoom && Number.isFinite(durationMs) && safeSeekMs > durationMs - 12000) {
      seekProgrammatically(0);
      resetTimeline(0);
    } else {
      seekProgrammatically(safeSeekMs);
      resetTimeline(safeSeekMs);
    }
    pendingSeekMs = null;
  } else {
    resetTimeline(Math.round(videoPlayer.currentTime * 1000));
  }
  const needsViewerConfirmation = Boolean(activeItem && !playbackReadyForCurrentBrowser(activeItem));
  setPlayerNotice(needsViewerConfirmation ? '确认画面和声音后，点「确认可播放」' : '');
});

videoPlayer.addEventListener('timeupdate', () => {
  if (skipDuringPlayback()) return;
  if (roomIsWritable() && !videoPlayer.paused && !videoPlayer.seeking) {
    const lastPositionMs = bridgePlaybackSample?.roomId === activeRoom.id
      ? bridgePlaybackSample.mediaTimeMs : activeRoom.lastPositionMs;
    const mediaTimeMs = Math.round(videoPlayer.currentTime * 1000);
    if (mediaTimeMs - lastPositionMs >= watchBridge.intervalMs()) {
      bridgePlaybackSample = { roomId: activeRoom.id, mediaTimeMs };
      schedulePlaybackSync();
    }
  }
  aiActivity.updatePlayhead();
  processTimeline();
  savePlaybackProgress();
  renderCurrentAiBuffer();
});
videoPlayer.addEventListener('play', () => {
  if (!skipDuringPlayback()) schedulePlaybackSync();
});
videoPlayer.addEventListener('pause', () => {
  savePlaybackProgress({ force: true });
  schedulePlaybackSync();
});
videoPlayer.addEventListener('ended', () => savePlaybackProgress({ force: true }));
videoPlayer.addEventListener('seeking', () => playbackSkip.beginSeek());
videoPlayer.addEventListener('seeked', () => {
  const roomStart = pendingRoomStart;
  pendingRoomStart = null;
  playbackSkip.finishSeek(videoPlayer.currentTime * 1000);
  resetTimeline(Math.round(videoPlayer.currentTime * 1000));
  savePlaybackProgress({ force: true });
  if (!roomStart) schedulePlaybackSync({ seeked: true });
  else if (!videoPlayer.paused && !skipDuringPlayback()) schedulePlaybackSync();
});

window.addEventListener('pagehide', () => savePlaybackProgress({ force: true }));
window.addEventListener('beforeunload', () => savePlaybackProgress({ force: true }));

// Use the saved cadence for local playback progress, so fast AI polls
// do not repeatedly observe the same 3-second-old playhead.
installPlaybackHeartbeat();

updateDanmakuControls();
setSidebarView('messages');
setLibraryCollapsed(localStorage.getItem(STORAGE.libraryCollapsed) === 'true', { persist: false });
window.addEventListener('resize', syncLibraryBrowseHeight);
if ('ResizeObserver' in window) {
  const libraryHeightObserver = new ResizeObserver(syncLibraryBrowseHeight);
  libraryHeightObserver.observe(cinemaWorkspace);
}
syncLibraryBrowseHeight();
await refreshViewerName().catch(error => console.warn('Cinema name unavailable:', error));
await refreshInteractionSettings().catch((error) => console.warn('Interaction settings unavailable:', error));
await quickMessages.refresh().catch((error) => console.warn('Quick messages unavailable:', error));
await refreshLibrary();
await loadViewingCadence({ promptInitial: !currentItems.some(item => item.aiPackage?.needsStoryboardUpgrade) })
  .catch((error) => console.warn('Viewing settings unavailable:', error));
await refreshRooms();

// Receive settings updates even while no room is active.
connectMessageEvents();
