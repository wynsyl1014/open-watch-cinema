const TIMESTAMP_PATTERN = /^(?:(\d{1,}):)?(\d{2}):(\d{2})\.(\d{3})$/;

function parseTimestamp(value) {
  const match = TIMESTAMP_PATTERN.exec(String(value || '').trim());
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  return (((hours * 60) + minutes) * 60 + seconds) * 1000 + milliseconds;
}

function formatTimestamp(milliseconds) {
  const safe = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const millis = safe % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function flattenCueText(text) {
  return String(text || '')
    .replace(/\n+/g, ' ')
    .replace(/[\t ]+/g, ' ')
    .trim();
}

function escapeCueText(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function parseWebVtt(text) {
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
    const cueText = lines.slice(timingIndex + 1).join('\n').trim();
    if (fromMs === null || toMs === null || toMs <= fromMs || !cueText) continue;
    cues.push({ fromMs, toMs, text: cueText });
  }
  return cues;
}

function cueSettings() {
  return 'line:-1 position:50% size:96% align:center';
}

function buildWebVtt(cues, { bilingual = false } = {}) {
  const blocks = cues.map((cue) => {
    const text = bilingual ? cue.text : flattenCueText(cue.text);
    return `${formatTimestamp(cue.fromMs)} --> ${formatTimestamp(cue.toMs)} ${cueSettings()}\n${text}`;
  });
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}

export function styleWebVttForPlayback(text) {
  return buildWebVtt(parseWebVtt(text));
}

function activeText(cues, startIndex, fromMs, toMs) {
  let index = startIndex;
  while (index < cues.length && cues[index].toMs <= fromMs) index += 1;
  const pieces = [];
  let cursor = index;
  while (cursor < cues.length && cues[cursor].fromMs < toMs) {
    if (cues[cursor].toMs > fromMs) {
      const text = flattenCueText(cues[cursor].text);
      if (text && pieces.at(-1) !== text) pieces.push(text);
    }
    cursor += 1;
  }
  return { index, text: pieces.join(' ') };
}

export function mergeBilingualWebVtt(chineseText, englishText) {
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
    const chinese = activeText(chineseCues, chineseIndex, fromMs, toMs);
    const english = activeText(englishCues, englishIndex, fromMs, toMs);
    chineseIndex = chinese.index;
    englishIndex = english.index;
    if (!chinese.text && !english.text) continue;

    const lines = [];
    if (chinese.text) lines.push(`<c.zh>${escapeCueText(chinese.text)}</c>`);
    if (english.text) lines.push(`<c.en>${escapeCueText(english.text)}</c>`);
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
