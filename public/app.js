import { createPlaybackSync } from './playback-sync.js';

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
  return 'line:96%,end position:50%,center size:96% align:center';
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
const playerMessage = document.querySelector('#playerMessage');
const fullscreenButton = document.querySelector('#fullscreenButton');
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
const endRoomButton = document.querySelector('#endRoomButton');
const sidebarHandle = document.querySelector('#sidebarHandle');
const closeSidebarButton = document.querySelector('#closeSidebarButton');
const unreadBadge = document.querySelector('#unreadBadge');
const sidebarTitle = document.querySelector('#sidebarTitle');
const messagesTab = document.querySelector('#messagesTab');
const sessionsTab = document.querySelector('#sessionsTab');
const messagesPanel = document.querySelector('#messagesPanel');
const sessionsPanel = document.querySelector('#sessionsPanel');
const roomSummary = document.querySelector('#roomSummary');
const messageList = document.querySelector('#messageList');
const sidebarComposer = document.querySelector('#sidebarComposer');
const identitySettings = document.querySelector('#identitySettings');
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
const subtitleDiscoveryPromises = new Map();
let currentItems = [];
let activeRoom = null;
let selectedRoom = null;
let rooms = [];
let messages = [];
let sidebarOpen = false;
let unreadCount = 0;
let messagePollToken = 0;
let pendingSeekMs = null;
let timelineShown = new Set();
let lastTimelineMs = -1;
let danmakuLane = 0;
let controlsHideTimer = null;
let lastProgressWriteAt = 0;
let danmakuEnabled = localStorage.getItem(STORAGE.danmaku) !== 'false';
let playbackProgress = readStoredObject(STORAGE.playbackProgress);
let subtitleChoices = readStoredObject(STORAGE.subtitleChoices);
let directPlayReady = readStoredObject(STORAGE.directPlayReady);
let activeSubtitleObjectUrls = [];
let subtitleLoadToken = 0;

const storedName = localStorage.getItem(STORAGE.senderName) || 'Viewer';
senderNameInput.value = storedName;
currentNameLabel.textContent = storedName;

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
  setPlayerNotice('Marked Ready for this browser. Picture and sound were confirmed by the viewer.');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown size';
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
  if (!value) return 'Unknown time';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
  return payload;
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
  playbackRepairDialogTitle.textContent = `Repair playback for ${item.title}`;
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
  if (tracks.length === 0) return Promise.resolve(null);

  aiSubtitleDialogTitle.textContent = `Choose subtitles for ${item.title}`;
  aiSubtitleOptions.replaceChildren();
  const preferredTrackId = preferredAiDialogueTrackId(item);

  for (const track of tracks) {
    const option = document.createElement('label');
    option.className = 'ai-subtitle-option';

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'aiDialogueTrack';
    input.value = track.id;
    input.checked = track.id === preferredTrackId;

    const label = document.createElement('span');
    const notes = [track.default ? 'default' : null, track.forced ? 'forced' : null].filter(Boolean);
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
      resolve(aiSubtitleDialog.returnValue === 'confirm' ? selected?.value || null : undefined);
    };
    aiSubtitleDialog.addEventListener('cancel', handleCancel, { once: true });
    aiSubtitleDialog.addEventListener('close', handleClose, { once: true });
    aiSubtitleDialog.showModal();
  });
}

function appendSubtitleTrack({ src, label, language = 'und' }) {
  const element = document.createElement('track');
  element.dataset.owcSubtitle = 'true';
  element.kind = 'subtitles';
  element.label = label;
  element.srclang = language;
  element.src = src;
  element.default = true;
  element.addEventListener('load', () => {
    element.track.mode = 'showing';
  }, { once: true });
  element.addEventListener('error', () => {
    setPlayerNotice('The subtitle track could not be loaded.', true);
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
  off.textContent = 'Subtitles off';
  subtitleSelect.append(off);

  const bilingualValue = bilingualChoiceValue(item);
  if (bilingualValue) {
    const option = document.createElement('option');
    option.value = bilingualValue;
    option.textContent = '双语 · 简中 + English';
    subtitleSelect.append(option);
  }

  for (const track of item?.subtitleTracks || []) {
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

async function discoverEmbeddedSubtitles(item) {
  if (!item || (item.subtitleTracks || []).length > 0) return item;
  const existing = subtitleDiscoveryPromises.get(item.id);
  if (existing) return existing;

  const discovery = (async () => {
    try {
      const payload = await fetchJson(`/api/media/${item.id}/subtitles/prepare`, { method: 'POST' });
      if (payload.media) {
        Object.assign(item, payload.media);
        if (activeMediaId === item.id) setupSubtitles(item);
      }
      return item;
    } catch (error) {
      subtitleDiscoveryPromises.delete(item.id);
      console.warn('Embedded subtitle discovery failed:', error);
      return item;
    }
  })();

  subtitleDiscoveryPromises.set(item.id, discovery);
  return discovery;
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
  playerMessage.classList.toggle('error', isError);
}

function normalizeSearch(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().trim();
}

function updateCount(total, visible = total) {
  const filtered = Boolean(normalizeSearch(librarySearch.value));
  if (filtered) {
    mediaCount.textContent = `${visible} of ${total} films`;
    return;
  }
  mediaCount.textContent = `${total} ${total === 1 ? 'film' : 'films'}`;
}

function setLibraryCollapsed(collapsed, { persist = true } = {}) {
  librarySection.classList.toggle('collapsed', collapsed);
  libraryToggle.setAttribute('aria-expanded', String(!collapsed));
  libraryToggle.setAttribute('title', collapsed ? 'Expand film strip' : 'Collapse film strip');
  libraryToggle.querySelector('i[aria-hidden="true"]').textContent = collapsed ? '⌄' : '⌃';
  libraryBody.setAttribute('aria-hidden', String(collapsed));
  libraryBody.inert = collapsed;
  if (persist) localStorage.setItem(STORAGE.libraryCollapsed, String(collapsed));
}

function syncLibraryBrowseHeight() {
  const height = Math.round(cinemaWorkspace.getBoundingClientRect().height);
  if (height > 0) librarySection.style.setProperty('--cinema-workspace-height', `${height}px`);
}

function applyMediaFilter() {
  const query = normalizeSearch(librarySearch.value);
  let visible = 0;

  document.querySelectorAll('.media-card').forEach((card) => {
    const matches = !query || card.dataset.searchText.includes(query);
    card.hidden = !matches;
    if (matches) visible += 1;
  });

  emptyState.hidden = currentItems.length !== 0;
  searchEmpty.hidden = currentItems.length === 0 || visible !== 0;
  updateCount(currentItems.length, visible);
}

function compatibilityLabel(item) {
  if (playbackReadyForCurrentBrowser(item)) return 'Ready';
  switch (item.compatibilityStatus) {
    case 'checking': return 'Checking codecs';
    case 'processing': return 'Preparing file';
    case 'prepared': return 'Retest playback';
    case 'error': return 'Preparation failed';
    default: return 'Not confirmed';
  }
}

function compatibilityBadgeStatus(item) {
  return playbackReadyForCurrentBrowser(item)
    ? 'ready'
    : item.compatibilityStatus || 'unchecked';
}

function aiPackageLabel(item) {
  const aiPackage = item.aiPackage;
  if (!aiPackage) return 'AI package not prepared';
  if (aiPackage.status === 'ready') {
    const mode = aiPackage.aiReadiness?.experienceMode;
    if (mode === 'visual_only') return 'AI ready · visual only';
    if (mode === 'dialogue_only') return 'AI ready · dialogue only';
    return 'AI package ready';
  }
  if (aiPackage.status === 'running') {
    return `AI preparing · ${Math.round(aiPackage.progress?.percent || 0)}%`;
  }
  if (aiPackage.status === 'failed' || aiPackage.status === 'error') return 'AI preparation failed';
  return 'AI package pending';
}

function aiExperienceWarning(item) {
  const aiPackage = item?.aiPackage || null;
  if (!aiPackage) {
    return 'AI preparation has not been run. The room can still open, but AI will not receive an indexed visual or dialogue track.';
  }
  if (aiPackage.status !== 'ready') {
    return 'The AI package is not complete. The room can still open, but AI context may be missing or unavailable.';
  }

  const mode = aiPackage.aiReadiness?.experienceMode || 'raw';
  if (mode === 'visual_only') {
    return 'Visual analysis is ready, but timed dialogue is missing. AI can follow scenes and actions, but may misunderstand names, relationships, and plot.';
  }
  if (mode === 'dialogue_only') {
    return 'Timed dialogue is ready, but visual analysis is missing. AI can read the conversation, but cannot follow actions, framing, or visual clues.';
  }
  if (mode !== 'complete') {
    return 'This AI package is incomplete. The room can still open, but the viewing experience may be limited.';
  }
  return null;
}

function confirmAiExperience(item) {
  const warning = aiExperienceWarning(item);
  if (!warning) return true;
  return window.confirm(`${warning}\n\nOpen the room anyway?`);
}

function saveViewerName({ collapse = false } = {}) {
  const name = senderNameInput.value.trim() || 'Viewer';
  senderNameInput.value = name;
  currentNameLabel.textContent = name;
  localStorage.setItem(STORAGE.senderName, name);
  if (collapse) identitySettings.open = false;
  return name;
}

function savedProgressFor(mediaId) {
  const value = Number(playbackProgress[mediaId]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function savePlaybackProgress({ force = false } = {}) {
  if (!activeMediaId || !Number.isFinite(videoPlayer.currentTime)) return;
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
  cinemaWorkspace.classList.toggle('sidebar-open', open);
  sidebarHandle.setAttribute('aria-expanded', String(open));
  sidebarHandle.setAttribute('title', open ? 'Close room sidebar' : 'Open room sidebar');
  sidebarHandle.querySelector('span[aria-hidden="true"]').textContent = open ? '▶' : '◀';
  if (open) {
    unreadCount = 0;
    renderUnread();
  }
  showScreenActions();
}

function setSidebarView(view) {
  const showMessages = view === 'messages';
  messagesPanel.hidden = !showMessages;
  sessionsPanel.hidden = showMessages;
  messagesTab.classList.toggle('active', showMessages);
  sessionsTab.classList.toggle('active', !showMessages);
  messagesTab.setAttribute('aria-selected', String(showMessages));
  sessionsTab.setAttribute('aria-selected', String(!showMessages));
  sidebarTitle.textContent = showMessages ? 'Room messages' : 'Past sessions';
}

function renderUnread() {
  unreadBadge.hidden = unreadCount === 0;
  unreadBadge.textContent = String(Math.min(unreadCount, 99));
}

function clearDanmaku() {
  danmakuLayer.replaceChildren();
}

function spawnDanmaku(message) {
  if (!danmakuEnabled || !selectedRoom) return;
  const node = document.createElement('div');
  node.className = `danmaku-item sender-${message.senderKind || 'user'}`;
  node.style.setProperty('--lane', String(danmakuLane % 5));
  node.style.setProperty('--travel-seconds', String(Math.min(15, 8 + message.content.length * 0.08)));
  danmakuLane += 1;

  const sender = document.createElement('b');
  sender.textContent = `${message.senderName}:`;
  const content = document.createElement('span');
  content.textContent = message.content;
  node.append(sender, content);
  node.addEventListener('animationend', () => node.remove(), { once: true });
  danmakuLayer.append(node);
}

function updateDanmakuControls() {
  danmakuToggle.textContent = danmakuEnabled ? 'Danmaku on' : 'Danmaku off';
  danmakuToggle.setAttribute('aria-pressed', String(danmakuEnabled));
  danmakuToggle.classList.toggle('off', !danmakuEnabled);
  quickComposer.hidden = !(danmakuEnabled && roomIsWritable());

  if (!selectedRoom) {
    dockNote.textContent = 'Open the room when the story asks for company.';
  } else if (selectedRoom.status === 'ended') {
    dockNote.textContent = danmakuEnabled ? 'Old words return with their frames.' : 'The room remembers quietly.';
  } else if (!danmakuEnabled) {
    dockNote.textContent = 'The room is speaking off-screen.';
  } else {
    dockNote.textContent = 'Words drift with the frame.';
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
  if (!selectedRoom || !danmakuEnabled || !Number.isFinite(videoPlayer.currentTime)) return;
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
    const empty = document.createElement('p');
    empty.className = 'sidebar-empty';
    empty.textContent = 'Open a room, or return to one that has already ended.';
    messageList.append(empty);
    return;
  }

  if (messages.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'sidebar-empty';
    empty.textContent = selectedRoom.status === 'active'
      ? 'The room is open. Say the first thing.'
      : 'This room ended in silence.';
    messageList.append(empty);
    return;
  }

  for (const message of messages) {
    const item = document.createElement('article');
    item.className = `message-item sender-${message.senderKind || 'user'}`;

    const header = document.createElement('div');
    const sender = document.createElement('strong');
    sender.textContent = message.senderName;
    const timeButton = document.createElement('button');
    timeButton.type = 'button';
    timeButton.textContent = formatFilmTime(message.mediaTimeMs);
    timeButton.title = 'Jump to this frame';
    timeButton.addEventListener('click', () => {
      videoPlayer.currentTime = message.mediaTimeMs / 1000;
      resetTimeline(message.mediaTimeMs);
    });
    header.append(sender, timeButton);

    const content = document.createElement('p');
    content.textContent = message.content;
    item.append(header, content);
    messageList.append(item);
  }
  messageList.scrollTop = messageList.scrollHeight;
}

function renderRoomState() {
  const item = currentMedia();
  const playbackReady = Boolean(item && activeMediaPlayable && playbackReadyForCurrentBrowser(item));
  openRoomButton.disabled = !playbackReady || Boolean(activeRoom);
  openRoomButton.hidden = Boolean(activeRoom);
  endRoomButton.hidden = !activeRoom;
  sidebarComposer.hidden = !roomIsWritable();

  if (!selectedRoom) {
    roomState.textContent = 'Solo viewing';
    roomState.className = 'room-state';
    roomSummary.innerHTML = '<strong>No room is open.</strong><p>The screen is yours alone.</p>';
  } else if (selectedRoom.status === 'active') {
    roomState.textContent = 'Room open';
    roomState.className = 'room-state active';
    roomSummary.innerHTML = `<strong>Live room · ${escapeHtml(selectedRoom.mediaTitle)}</strong><p>Every word is held beside this frame.</p>`;
  } else {
    roomState.textContent = 'Archive replay';
    roomState.className = 'room-state archived';
    roomSummary.innerHTML = `<strong>Read-only · ${escapeHtml(selectedRoom.mediaTitle)}</strong><p>Closed ${escapeHtml(formatSessionDate(selectedRoom.endedAt))}. The room still knows the way back.</p>`;
  }

  updateDanmakuControls();
  renderMessages();
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
    setPlayerNotice('This film is being prepared. Wait for the preparation to finish.', true);
    return;
  }
  if (!force && activeRoom && activeRoom.mediaId !== item.id) {
    setPlayerNotice('End the open room before changing the film.', true);
    return;
  }

  savePlaybackProgress({ force: true });

  if (!preserveRoom && !activeRoom) {
    selectedRoom = null;
    messages = [];
  }

  activeMediaId = item.id;
  activeMediaPlayable = false;
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
  nowPlayingTitle.textContent = item.title;
  const codecs = [item.videoCodec, item.audioCodec].filter(Boolean).join(' + ').toUpperCase();
  setPlayerNotice(`${formatBytes(item.size)}${codecs ? ` · ${codecs}` : ''}`);

  document.querySelectorAll('.media-card').forEach((card) => {
    card.classList.toggle('active', card.dataset.mediaId === item.id);
  });
  renderRoomState();
}

async function pollPreparation(jobId, button, statusText) {
  while (true) {
    const { job } = await fetchJson(`/api/jobs/${jobId}`);

    if (job.status === 'checking') {
      button.textContent = 'Planning repair…';
    } else if (job.status === 'processing') {
      button.textContent = `${job.stage || 'Repairing'} ${Math.round(job.progress || 0)}%`;
    } else if (job.status === 'done') {
      button.textContent = 'Retest playback';
      statusText.hidden = false;
      statusText.classList.remove('error');
      statusText.textContent = job.message || 'Playback repair finished. Test picture and sound, then Mark Ready if both are good.';
      await refreshLibrary();
      const replacement = currentItems.find((item) => item.id === (job.replacementMediaId || job.mediaId));
      if (replacement) chooseMedia(replacement, { force: true });
      return;
    } else if (job.status === 'error') {
      throw new Error(job.error || 'Playback repair failed.');
    }

    await delay(900);
  }
}

async function prepareMedia(item, button, statusText) {
  const repairMode = await choosePlaybackRepair(item);
  if (repairMode === undefined) return;

  button.disabled = true;
  button.textContent = 'Starting repair…';
  statusText.hidden = false;
  statusText.classList.remove('error');
  statusText.textContent = repairMode === 'audio'
    ? 'Keeping the picture and converting only audio.'
    : repairMode === 'video'
      ? 'Keeping the audio and converting only video.'
      : repairMode === 'remux'
        ? 'Rewrapping the existing streams into MP4 without re-encoding.'
        : 'Using the safest fallback while copying any stream that already matches it.';

  try {
    const payload = await fetchJson(`/api/media/${item.id}/prepare`, {
      method: 'POST',
      body: JSON.stringify({ repairMode })
    });
    await pollPreparation(payload.job.id, button, statusText);
  } catch (error) {
    console.error(error);
    button.disabled = false;
    button.textContent = 'Try playback repair again';
    statusText.textContent = error.message;
    statusText.hidden = false;
    statusText.classList.add('error');
  }
}

async function pollAiPreparation(jobId, button, statusText) {
  while (true) {
    const { job } = await fetchJson(`/api/jobs/${jobId}`);
    if (job.status === 'queued') {
      button.textContent = 'Queuing AI package…';
    } else if (job.status === 'processing') {
      button.textContent = `Preparing AI ${Math.round(job.progress || 0)}%`;
      statusText.hidden = false;
      statusText.textContent = job.stage || 'Analyzing visual and dialogue tracks…';
    } else if (job.status === 'done') {
      button.textContent = job.experienceMode === 'visual_only' ? 'AI ready · visual only' : 'AI package ready';
      statusText.hidden = false;
      statusText.textContent = job.message || 'AI package ready.';
      await refreshLibrary();
      return;
    } else if (job.status === 'error') {
      throw new Error(job.error || 'AI preparation failed.');
    }
    await delay(900);
  }
}

async function prepareAiMedia(item, button, statusText) {
  await discoverEmbeddedSubtitles(item);
  const dialogueTrackId = await chooseAiDialogueTrack(item);
  if (dialogueTrackId === undefined) return;

  const selectedTrack = (item.subtitleTracks || []).find((track) => track.id === dialogueTrackId) || null;
  button.disabled = true;
  button.textContent = 'Starting AI preparation…';
  statusText.hidden = false;
  statusText.classList.remove('error');
  statusText.textContent = selectedTrack
    ? `Preparing visual analysis with ${subtitleOptionLabel(selectedTrack)} as the AI dialogue track.`
    : 'No timed subtitle track was found. The AI package will prepare visual analysis only.';

  try {
    const payload = await fetchJson(`/api/media/${item.id}/prepare-ai`, {
      method: 'POST',
      body: JSON.stringify(dialogueTrackId ? { dialogueTrackId } : {})
    });
    await pollAiPreparation(payload.job.id, button, statusText);
  } catch (error) {
    console.error(error);
    button.disabled = false;
    button.textContent = 'Try AI preparation again';
    statusText.textContent = error.message;
    statusText.hidden = false;
    statusText.classList.add('error');
  }
}

function resetDeletedMediaState(mediaId) {
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
    nowPlayingTitle.textContent = 'Nothing selected';
    setPlayerNotice('The curtain is waiting.');
  }
}

function deletePreviewText(item, preview) {
  const lines = [
    `Delete “${item.title}” and every linked local asset?`,
    '',
    `Film file: ${preview.mediaFile.exists ? formatBytes(preview.mediaFile.bytes) : 'already missing'}`,
    `Subtitle bundle: ${preview.subtitleBundle.exists ? 'delete' : 'none'}`,
    `AI package: ${preview.aiPackage.exists ? 'delete' : 'none'}`,
    `Watch rooms: ${preview.records.sessionCount}`,
    `Messages: ${preview.records.messageCount}`,
    '',
    'This cannot be undone.'
  ];
  return lines.join('\n');
}

async function deleteMedia(item, button) {
  button.disabled = true;
  try {
    const { preview } = await fetchJson(`/api/media/${item.id}/delete-preview`);
    if (!window.confirm(deletePreviewText(item, preview))) return;
    await fetchJson(`/api/media/${item.id}`, {
      method: 'DELETE',
      body: JSON.stringify({
        cascade: true,
        confirmMediaId: item.id
      })
    });
    resetDeletedMediaState(item.id);
    await Promise.all([
      refreshLibrary({ rescan: true }),
      refreshRooms({ restoreActive: false })
    ]);
  } catch (error) {
    setPlayerNotice(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderMedia(items) {
  currentItems = items;
  mediaGrid.replaceChildren();
  updateCount(items.length);
  emptyState.hidden = items.length !== 0;

  items.forEach((item, index) => {
    const card = document.createElement('article');
    card.className = 'media-card';
    card.dataset.mediaId = item.id;
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
      ? 'End the open room before changing films.'
      : preparationActive
        ? 'Wait for playback preparation to finish.'
        : 'Try this film directly in the current browser.';

    const number = document.createElement('span');
    number.className = 'card-index';
    number.textContent = String(index + 1).padStart(2, '0');

    const title = document.createElement('strong');
    title.textContent = item.title;

    const details = document.createElement('small');
    const codecs = [item.videoCodec, item.audioCodec].filter(Boolean).join(' + ');
    details.textContent = `${item.extension.replace('.', '').toUpperCase()} · ${formatBytes(item.size)}${codecs ? ` · ${codecs.toUpperCase()}` : ''}`;

    const badge = document.createElement('span');
    badge.className = `compatibility-badge status-${compatibilityBadgeStatus(item)}`;
    badge.textContent = compatibilityLabel(item);

    playButton.append(number, title, details, badge);
    playButton.addEventListener('click', () => chooseMedia(item));

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'media-delete-button';
    deleteButton.setAttribute('aria-label', `Delete ${item.title} and linked assets`);
    deleteButton.title = 'Delete film and linked local assets';
    deleteButton.textContent = '⌫';
    deleteButton.disabled = Boolean(activeRoom?.mediaId === item.id);
    deleteButton.addEventListener('click', () => deleteMedia(item, deleteButton));

    card.append(playButton, deleteButton);

    const actionArea = document.createElement('div');
    actionArea.className = 'media-actions';
    const actionButtons = document.createElement('div');
    actionButtons.className = 'media-action-buttons';

    const statusText = document.createElement('p');
    statusText.className = 'compatibility-note';
    statusText.hidden = !item.compatibilityError;
    statusText.textContent = item.compatibilityError || '';

    if (!playbackReadyForCurrentBrowser(item)) {
      const readyButton = document.createElement('button');
      readyButton.type = 'button';
      readyButton.className = 'prepare-button ready-confirm-button';
      readyButton.textContent = 'Mark Ready';
      readyButton.disabled = !canConfirmDirectPlay(item);
      readyButton.title = canConfirmDirectPlay(item)
        ? 'Confirm that picture and sound both work in this browser.'
        : 'Select this film and test picture and sound first.';
      readyButton.addEventListener('click', () => confirmDirectPlayReady(item));

      const prepareButton = document.createElement('button');
      prepareButton.type = 'button';
      prepareButton.className = 'prepare-button';
      prepareButton.textContent = item.compatibilityStatus === 'error'
        ? 'Try playback repair again'
        : item.compatibilityStatus === 'prepared'
          ? 'Adjust playback repair'
          : 'Check & prepare playback';
      prepareButton.disabled = ['checking', 'processing'].includes(item.compatibilityStatus);
      prepareButton.addEventListener('click', () => prepareMedia(item, prepareButton, statusText));
      actionButtons.append(readyButton, prepareButton);
    }

    const aiButton = document.createElement('button');
    aiButton.type = 'button';
    aiButton.className = 'prepare-button ai-prepare-button';
    aiButton.textContent = item.aiPackage?.status === 'ready'
      ? aiPackageLabel(item)
      : 'Prepare for AI viewing';
    aiButton.disabled = item.aiPackage?.status === 'ready' || item.aiPackage?.status === 'running';
    aiButton.addEventListener('click', () => prepareAiMedia(item, aiButton, statusText));
    actionButtons.append(aiButton);

    const aiStatus = document.createElement('p');
    const aiWarning = aiExperienceWarning(item);
    aiStatus.className = 'ai-package-note';
    aiStatus.classList.toggle('warning', Boolean(aiWarning));
    aiStatus.textContent = aiWarning || aiPackageLabel(item);

    actionArea.append(actionButtons, aiStatus, statusText);
    card.append(actionArea);

    mediaGrid.append(card);
  });

  applyMediaFilter();

  if (activeMediaId && !items.some((item) => item.id === activeMediaId)) {
    activeMediaId = null;
    activeMediaPlayable = false;
    videoPlayer.removeAttribute('src');
    setupSubtitles(null);
    videoPlayer.load();
    playerShell.classList.remove('has-media');
    nowPlayingTitle.textContent = 'Nothing selected';
    setPlayerNotice('The curtain is waiting.');
  }
  renderRoomState();
}

async function fetchMedia() {
  const payload = await fetchJson('/api/media');
  return payload.items || [];
}

async function refreshLibrary({ rescan = false } = {}) {
  rescanButton.disabled = true;
  rescanButton.textContent = rescan ? 'Scanning…' : 'Loading…';

  try {
    let items;
    if (rescan) {
      const payload = await fetchJson('/api/media/rescan', { method: 'POST' });
      items = payload.items || [];
    } else {
      items = await fetchMedia();
    }
    renderMedia(items);
    serverStatus.textContent = 'Projector ready';
    serverStatus.classList.add('online');
  } catch (error) {
    console.error(error);
    serverStatus.textContent = 'Projector offline';
    serverStatus.classList.remove('online');
    setPlayerNotice('The projector could not find the reel.', true);
  } finally {
    rescanButton.disabled = false;
    rescanButton.innerHTML = '<span aria-hidden="true">↻</span> Rescan';
  }
}

function renderSessions() {
  sessionList.replaceChildren();
  const pastRooms = rooms.filter((room) => room.status === 'ended');
  if (pastRooms.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'sidebar-empty';
    empty.textContent = 'No curtain calls yet.';
    sessionList.append(empty);
    return;
  }

  for (const room of pastRooms) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'session-card';
    button.classList.toggle('active', selectedRoom?.id === room.id);

    const title = document.createElement('strong');
    title.textContent = room.mediaTitle;
    const meta = document.createElement('span');
    meta.textContent = `${formatSessionDate(room.openedAt)} · ${room.messageCount} messages`;
    const state = document.createElement('small');
    state.textContent = 'Read-only replay';
    button.append(title, meta, state);
    button.addEventListener('click', () => loadArchivedRoom(room.id));
    sessionList.append(button);
  }
}

async function refreshRooms({ restoreActive = true } = {}) {
  try {
    const payload = await fetchJson('/api/rooms');
    activeRoom = payload.activeRoom || null;
    rooms = payload.rooms || [];
    renderSessions();

    if (restoreActive && activeRoom) {
      selectedRoom = activeRoom;
      const item = currentItems.find((candidate) => candidate.id === activeRoom.mediaId);
      if (item) chooseMedia(item, { force: true, seekMs: activeRoom.lastPositionMs, preserveRoom: true });
      await loadRoomMessages(activeRoom.id, { beginPolling: true, quiet: true });
      return;
    }

    if (!activeMediaId) {
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

async function openRoom() {
  const item = currentMedia();
  if (!item || !confirmAiExperience(item)) return;
  openRoomButton.disabled = true;
  try {
    const payload = await fetchJson('/api/rooms/open', {
      method: 'POST',
      body: JSON.stringify({ mediaId: item.id })
    });
    activeRoom = payload.room;
    selectedRoom = payload.room;
    messages = [];
    resetTimeline(Math.round(videoPlayer.currentTime * 1000));
    setSidebarView('messages');
    setSidebarOpen(true);
    renderRoomState();
    await refreshRooms({ restoreActive: false });
    startMessagePolling();
  } catch (error) {
    setPlayerNotice(error.message, true);
  } finally {
    renderRoomState();
  }
}

async function endRoom() {
  if (!activeRoom) return;
  endRoomButton.disabled = true;
  try {
    const payload = await fetchJson(`/api/rooms/${activeRoom.id}/end`, {
      method: 'POST',
      body: JSON.stringify({ mediaTimeMs: Math.round(videoPlayer.currentTime * 1000) })
    });
    messagePollToken += 1;
    activeRoom = null;
    selectedRoom = payload.room;
    renderRoomState();
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
    setPlayerNotice('End the live room before opening a past session.', true);
    return;
  }
  try {
    const payload = await fetchJson(`/api/rooms/${roomId}`);
    selectedRoom = payload.room;
    messages = payload.messages || [];
    const item = currentItems.find((candidate) => candidate.id === selectedRoom.mediaId);
    if (!item) throw new Error('This film is no longer on the reel.');
    chooseMedia(item, { force: true, seekMs: 0, preserveRoom: true });
    resetTimeline(0);
    setSidebarView('messages');
    setSidebarOpen(true);
    renderSessions();
    renderRoomState();
  } catch (error) {
    setPlayerNotice(error.message, true);
  }
}

function startMessagePolling() {
  const token = ++messagePollToken;

  void (async function poll() {
    while (token === messagePollToken && activeRoom) {
      try {
        const payload = await fetchJson(`/api/rooms/${activeRoom.id}/messages`);
        const existingIds = new Set(messages.map((message) => message.id));
        const incoming = (payload.messages || []).filter((message) => !existingIds.has(message.id));
        messages = payload.messages || [];
        selectedRoom = payload.room;
        activeRoom = payload.room.status === 'active' ? payload.room : null;
        renderRoomState();

        for (const message of incoming) {
          timelineShown.add(message.id);
          if (danmakuEnabled) spawnDanmaku(message);
        }
        if (incoming.length && !sidebarOpen) {
          unreadCount += incoming.length;
          renderUnread();
        }
      } catch (error) {
        console.error(error);
      }
      await delay(1000);
    }
  })();
}

async function sendRoomMessage(content) {
  const cleanContent = String(content || '').trim();
  if (!roomIsWritable() || !cleanContent) return;
  const senderName = saveViewerName({ collapse: true });

  try {
    const payload = await fetchJson(`/api/rooms/${activeRoom.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        senderName,
        senderKind: 'user',
        content: cleanContent,
        mediaTimeMs: Math.round(videoPlayer.currentTime * 1000)
      })
    });
    if (!messages.some((message) => message.id === payload.message.id)) {
      messages.push(payload.message);
      renderMessages();
      timelineShown.add(payload.message.id);
      if (danmakuEnabled) spawnDanmaku(payload.message);
    }
  } catch (error) {
    setPlayerNotice(error.message, true);
  }
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

function schedulePlaybackSync({ seeked = false } = {}) {
  if (!roomIsWritable() || videoPlayer.seeking) return;
  queuePlaybackSync({
    roomId: activeRoom.id,
    mediaTimeMs: Math.round(videoPlayer.currentTime * 1000),
    playbackState: videoPlayer.paused ? 'paused' : 'playing',
    seeked
  });
}

rescanButton.addEventListener('click', () => refreshLibrary({ rescan: true }));
libraryToggle.addEventListener('click', () => {
  setLibraryCollapsed(!librarySection.classList.contains('collapsed'));
});
librarySearch.addEventListener('input', () => {
  if (normalizeSearch(librarySearch.value)) setLibraryCollapsed(false);
  applyMediaFilter();
});
openRoomButton.addEventListener('click', openRoom);
endRoomButton.addEventListener('click', endRoom);
sidebarHandle.addEventListener('click', (event) => {
  setSidebarOpen(!sidebarOpen);
  event.currentTarget.blur();
});
closeSidebarButton.addEventListener('click', () => setSidebarOpen(false));
messagesTab.addEventListener('click', () => setSidebarView('messages'));
sessionsTab.addEventListener('click', () => setSidebarView('sessions'));

senderNameInput.addEventListener('input', () => {
  currentNameLabel.textContent = senderNameInput.value.trim() || 'Viewer';
});
senderNameInput.addEventListener('change', () => saveViewerName());
senderNameInput.addEventListener('blur', () => saveViewerName());
senderNameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    saveViewerName({ collapse: true });
    senderNameInput.blur();
  }
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
    setPlayerNotice(`Local subtitle added · ${file.name}`);
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

fullscreenButton.addEventListener('click', async (event) => {
  try {
    if (document.fullscreenElement === cinemaWorkspace) await document.exitFullscreen();
    else await cinemaWorkspace.requestFullscreen();
  } catch (error) {
    setPlayerNotice(`Full screen could not open: ${error.message}`, true);
  } finally {
    event.currentTarget.blur();
  }
});

document.addEventListener('fullscreenchange', () => {
  const active = document.fullscreenElement === cinemaWorkspace;
  fullscreenButton.setAttribute('title', active ? 'Exit full screen' : 'Cinema full screen');
  fullscreenButton.setAttribute('aria-label', active ? 'Exit full screen' : 'Cinema full screen');
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
      ? 'This browser could not play the original file. Use Check & prepare playback below.'
      : 'This reel could not be projected.',
    true
  );
});

videoPlayer.addEventListener('loadedmetadata', () => {
  if (!activeMediaId) return;
  activeMediaPlayable = true;
  const activeItem = currentMedia();
  renderMedia(currentItems);
  renderRoomState();
  if (pendingSeekMs !== null) {
    const durationMs = Number.isFinite(videoPlayer.duration) ? videoPlayer.duration * 1000 : Infinity;
    const safeSeekMs = Math.max(0, Math.min(durationMs, pendingSeekMs));
    if (!activeRoom && Number.isFinite(durationMs) && safeSeekMs > durationMs - 12000) {
      videoPlayer.currentTime = 0;
      resetTimeline(0);
    } else {
      videoPlayer.currentTime = safeSeekMs / 1000;
      resetTimeline(safeSeekMs);
    }
    pendingSeekMs = null;
  } else {
    resetTimeline(Math.round(videoPlayer.currentTime * 1000));
  }
  const duration = Number.isFinite(videoPlayer.duration)
    ? `${Math.floor(videoPlayer.duration / 60)}m ${Math.round(videoPlayer.duration % 60)}s`
    : 'A timeless reel';
  const codecs = [activeItem?.videoCodec, activeItem?.audioCodec].filter(Boolean).join(' + ').toUpperCase();
  const baseNotice = `${duration}${codecs ? ` · ${codecs}` : ''}`;
  const needsSubtitleDiscovery = Boolean(activeItem && (activeItem.subtitleTracks || []).length === 0);
  const needsViewerConfirmation = Boolean(activeItem && !playbackReadyForCurrentBrowser(activeItem));
  const initialNotes = [
    baseNotice,
    needsViewerConfirmation ? 'test picture & sound, then Mark Ready' : null,
    needsSubtitleDiscovery ? 'extracting embedded subtitles…' : null
  ].filter(Boolean);
  setPlayerNotice(initialNotes.join(' · '));

  if (needsSubtitleDiscovery) {
    void discoverEmbeddedSubtitles(activeItem).then((updatedItem) => {
      if (!updatedItem || currentMedia()?.id !== updatedItem.id) return;
      const subtitleCount = (updatedItem.subtitleTracks || []).length;
      const subtitleNote = subtitleCount
        ? `${subtitleCount} subtitle tracks ready`
        : 'no extractable subtitle tracks found';
      const confirmationNote = playbackReadyForCurrentBrowser(updatedItem)
        ? null
        : 'test picture & sound, then Mark Ready';
      setPlayerNotice([baseNotice, confirmationNote, subtitleNote].filter(Boolean).join(' · '));
    });
  }
});

videoPlayer.addEventListener('timeupdate', () => {
  processTimeline();
  savePlaybackProgress();
});
videoPlayer.addEventListener('play', schedulePlaybackSync);
videoPlayer.addEventListener('pause', () => {
  savePlaybackProgress({ force: true });
  schedulePlaybackSync();
});
videoPlayer.addEventListener('ended', () => savePlaybackProgress({ force: true }));
videoPlayer.addEventListener('seeked', () => {
  resetTimeline(Math.round(videoPlayer.currentTime * 1000));
  savePlaybackProgress({ force: true });
  schedulePlaybackSync({ seeked: true });
});

window.addEventListener('pagehide', () => savePlaybackProgress({ force: true }));
window.addEventListener('beforeunload', () => savePlaybackProgress({ force: true }));

setInterval(() => {
  if (activeRoom && !videoPlayer.paused) schedulePlaybackSync();
}, 3000);

updateDanmakuControls();
setSidebarView('messages');
setLibraryCollapsed(localStorage.getItem(STORAGE.libraryCollapsed) === 'true', { persist: false });
window.addEventListener('resize', syncLibraryBrowseHeight);
if ('ResizeObserver' in window) {
  const libraryHeightObserver = new ResizeObserver(syncLibraryBrowseHeight);
  libraryHeightObserver.observe(cinemaWorkspace);
}
syncLibraryBrowseHeight();
await refreshLibrary();
await refreshRooms();
