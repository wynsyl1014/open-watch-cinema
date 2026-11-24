import { MAX_REMEMBERED_FRAMES } from '../runtime/configuration.mjs';

// One final playback check belongs to the adapter, after text and images are assembled.
export function assertViewingPlayback(tick, room, roomId) {
  if (!room || room.status !== 'active' || room.id !== roomId
      || room.seekVersion !== tick.playback.seekVersion
      || !Number.isSafeInteger(room.lastPositionMs)
      || room.lastPositionMs < (tick.playback.timeMs ?? tick.playback.playheadMs)
      || (Number.isSafeInteger(tick.playback.deliveryHorizonMs)
        && (!Number.isSafeInteger(room.deliveryHorizonMs) || room.deliveryHorizonMs < tick.range.toMs))) {
    throw Object.assign(new Error('Playback changed during catch-up. Read the new position with the same cursors.'), {
      code: 'PLAYBACK_CHANGED'
    });
  }
}

// This preserves every prepared selection. Delivery no longer re-selects two pictures.
export function selectInlineStoryboards(tick) {
  const fromMs = tick.range.fromMs;
  const throughMs = Math.min(tick.range.toMs,
    tick.playback.deliveryHorizonMs ?? tick.playback.timeMs ?? tick.playback.playheadMs);
  return (tick.storyboards || []).filter((frame) => {
    if (!frame.storyboardRef || frame.mediaTimeMs > throughMs) return false;
    if (tick.packageVersion !== 3 && !tick.deliveryTimeline
        && !(tick.range.bootstrap || tick.range.seekDetected
          || (throughMs > fromMs && frame.mediaTimeMs >= fromMs))) return false;
    return true;
  }).sort((a, b) => a.mediaTimeMs - b.mediaTimeMs);
}

export function formatFilmTime(value) {
  const ms = Math.max(0, Math.trunc(Number(value) || 0));
  const seconds = Math.floor(ms / 1000);
  const clock = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  return ms % 1000 ? clock + '.' + String(ms % 1000).padStart(3, '0') : clock;
}

function fallbackSegments(tick) {
  const entries = [
    ...(tick.dialogueDelta || []).map((item, index) => ({
      ...item, id: 'dialogue-' + index, type: 'dialogue', availableAtMs: item.fromMs
    })),
    ...(tick.audioDescriptions || []).map((item) => ({ ...item, type: 'sound', availableAtMs: item.fromMs })),
    ...selectInlineStoryboards(tick).map((frame) => ({
      ...frame, id: 'image-' + frame.storyboardRef, type: 'image',
      fromMs: frame.mediaTimeMs, toMs: frame.mediaTimeMs, availableAtMs: frame.mediaTimeMs
    })),
    ...(tick.motionEvents || []).map((item, index) => ({
      ...item, id: 'motion-' + index, type: 'motion', availableAtMs: item.toMs
    }))
  ];
  return [{
    id: 'window-' + tick.range.fromMs, fromMs: tick.range.fromMs,
    toMs: tick.range.toMs, entries
  }];
}

function viewingSegments(tick) {
  const source = Array.isArray(tick.segments) ? tick.segments : fallbackSegments(tick);
  const playhead = tick.playback.deliveryHorizonMs ?? tick.playback.timeMs ?? tick.playback.playheadMs;
  const sections = new Map(source.map((section) => [section.id, {
    id: section.id, fromMs: section.fromMs, toMs: section.toMs,
    entries: (section.entries || []).map((entry) => entry.type === 'sound' && tick.playback.deliveryHorizonMs === undefined
      ? { ...entry, availableAtMs: entry.fromMs } : { ...entry }).filter((entry) =>
      (entry.availableAtMs ?? entry.fromMs) <= playhead)
  }]));
  const interval = tick.viewingIntervalMs;
  // Live motion observations are carried beside the prepared section list.
  // Include those notes once, without repeating the same prepared event.
  if (Array.isArray(tick.segments)) {
    const motionKey = (entry) => JSON.stringify([entry.fromMs, entry.toMs, entry.kind, entry.direction ?? null]);
    const known = new Set([...sections.values()].flatMap((section) =>
      section.entries.filter((entry) => entry.type === 'motion').map(motionKey)));
    for (const [index, event] of (tick.motionEvents || []).entries()) {
      if ((event.toMs ?? event.fromMs) > playhead || known.has(motionKey(event))) continue;
      known.add(motionKey(event));
      let section = [...sections.values()].find((item) => event.fromMs >= item.fromMs && event.fromMs < item.toMs);
      if (!section) {
        const fromMs = Number.isSafeInteger(interval) && interval > 0
          ? Math.floor(event.fromMs / interval) * interval : event.fromMs;
        const id = 'motion-section-' + fromMs;
        if (!sections.has(id)) sections.set(id, {
          id, fromMs, toMs: Number.isSafeInteger(interval) && interval > 0 ? fromMs + interval : fromMs,
          entries: []
        });
        section = sections.get(id);
      }
      section.entries.push({ ...event, id: 'motion-extra-' + index, type: 'motion',
        availableAtMs: event.toMs ?? event.fromMs });
    }
  }
  for (const [index, message] of (tick.newMessages || []).entries()) {
    if (message.interaction) continue;
    const at = message.mediaTimeMs;
    let section = [...sections.values()].find((item) => at >= item.fromMs && at < item.toMs);
    if (!section) {
      const fromMs = Number.isSafeInteger(interval) && interval > 0
        ? Math.floor(at / interval) * interval : at;
      const id = 'messages-' + fromMs;
      if (!sections.has(id)) sections.set(id, {
        id, fromMs, toMs: Number.isSafeInteger(interval) && interval > 0 ? fromMs + interval : at,
        entries: []
      });
      section = sections.get(id);
    }
    // Equal viewer text can be two distinct messages; never deduplicate it.
    section.entries.push({
      id: 'message-' + index, type: 'message', fromMs: at, toMs: at,
      availableAtMs: at, text: message.content, senderName: message.senderName, messageId: message.messageId
    });
  }
  return [...sections.values()].filter((section) => section.entries.length)
    .sort((a, b) => a.fromMs - b.fromMs)
    .map((section) => ({
      ...section, entries: section.entries.sort((a, b) => a.fromMs - b.fromMs)
    }));
}

function motionText(entry) {
  if (entry.text) return entry.text;
  const direction = {
    left: '向左', right: '向右', up: '向上', down: '向下',
    'up-left': '向左上', 'up-right': '向右上',
    'down-left': '向左下', 'down-right': '向右下'
  }[entry.direction];
  return entry.kind === 'scene_change' ? '镜头切换'
    : direction ? '画面运动' + direction
    : entry.kind === 'motion_peak' ? '画面运动明显' : '';
}

function entryText(entry) {
  const at = formatFilmTime(entry.fromMs);
  if (entry.type === 'dialogue') return at + ' · ' + (entry.speaker ? entry.speaker : '对白') + '：“' + entry.text + '”';
  if (entry.type === 'sound') return at + '–' + formatFilmTime(entry.toMs) + ' · 声音：' + entry.text;
  if (entry.type === 'message') return at + ' · ' + (String(entry.senderName || '').trim() || 'user') + '：' + entry.text;
  if (entry.type === 'motion') {
    const text = motionText(entry);
    return text ? at + ' · 画面动态：' + text : '';
  }
  return '';
}

const EXISTING_STORYBOARD_MAX_BYTES = 1_572_864; // The former 2 MiB Base64 bridge limit.

// Only moments depicted by this JPEG are inspection aliases. A crop’s arrow may
// additionally name its anchor in an earlier JPEG.
function captionClock(ms) {
  const clock = formatFilmTime(ms);
  return ms % 1000 ? clock.replace(/0+$/, '') : clock;
}

export function storyboardTiming(metadata, fallbackMs, panels = metadata.panelTimesMs) {
  const times = [];
  let text = '';
  for (const view of Array.isArray(metadata.views) ? metadata.views : []) {
    if (!view) continue;
    const at = view.mediaTimeMs ?? panels?.[view.sourceIndex];
    if (!Number.isSafeInteger(at) || at < 0) continue;
    const anchor = view.anchorTimeMs;
    if (view.type === 'crop' && Number.isSafeInteger(anchor) && anchor >= 0 && anchor <= at) {
      if (times.at(-1) !== anchor) text += (text ? ' · ' : '') + captionClock(anchor);
      text += ' → ' + captionClock(at);
    } else {
      text += (text ? ' · ' : '') + captionClock(at);
    }
    times.push(at);
  }
  if (times.length) return { times, text };
  const displayed = panels?.length ? [...new Set(panels)] : [fallbackMs];
  return { times: displayed, text: displayed.map(captionClock).join(' · ') };
}

export function notebookChangeNotice(changes) {
  return { type: 'text', text: '观影笔记更新\n' + changes.map(event =>
    formatFilmTime(event.atMs) + ' · ' + event.content).join('\n') };
}

function viewerMessageBlock(message) {
  const name = (String(message.senderName || '').trim() || 'user')
    .replace(/[\\`*_\[\]<>~|&]/g, '\\$&');
  return { type: 'text', text: '**' + name + '的房间留言 · ' +
    formatFilmTime(message.mediaTimeMs) + '**\n\n' + message.content };
}

// A soft first-image budget guarantees progress. Queued entries contain references only.
export async function buildViewingFeed(payload, {
  fetchFrame, signal, maxImageBytes = EXISTING_STORYBOARD_MAX_BYTES,
  imageBudgetBytes = Infinity, openingText = '', trackImageRefs = false, formatViewerMessages = false, maxImages = Infinity
}) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes < 1) throw new RangeError('Invalid per-image budget.');
  if (imageBudgetBytes !== Infinity && (!Number.isSafeInteger(imageBudgetBytes) || imageBudgetBytes < 1)) {
    throw new RangeError('Invalid total image budget.');
  }
  const source = payload.tick;
  const isViewerMessage = message => message.senderKind === 'user' && !message.interaction;
  const viewerMessages = formatViewerMessages ? (source.newMessages || []).filter(isViewerMessage) : [];
  const tick = viewerMessages.length
    ? { ...source, newMessages: source.newMessages.filter(message => !isViewerMessage(message)) }
    : source;
  const sections = viewingSegments(tick);
  const timeline = sections.flatMap(section => section.entries.flatMap(entry =>
    entry.type === 'image' && entry.parts
      ? entry.parts.map((part, partIndex) => ({ section, entry, part, partIndex }))
      : [{ section, entry }]));
  const selected = timeline.filter(({ entry }) => entry.type === 'image');
  const fetched = new Map();
  const mcpContent = [];
  const imageRefs = [];
  const blockThroughMs = [];
  const addBlock = (block, throughMs = null) => {
    mcpContent.push(block);
    if (trackImageRefs) blockThroughMs.push(throughMs);
  };
  for (const message of viewerMessages) addBlock(viewerMessageBlock(message));
  if (tick.notebookChanges?.length) {
    addBlock(notebookChangeNotice(tick.notebookChanges));
  }
  const interactions = (tick.newMessages || []).filter((message) => message.interaction);
  let hasMaterial = Boolean(viewerMessages.length || tick.notebookChanges?.length || interactions.length || tick.skipPrompt);
  if (interactions.length) {
    addBlock({ type: 'text', text: '房间互动\n' + interactions.map((message) =>
      formatFilmTime(message.mediaTimeMs) + ' · '
      + (String(message.senderName || '').trim() || 'user') + '：' + message.content
    ).join('\n') });
  }
  const frameSelections = new Map();
  const deliveredAudioIds = [];
  const playhead = tick.playback.timeMs ?? tick.playback.playheadMs;
  const authorized = Number.isSafeInteger(tick.playback.deliveryHorizonMs);
  let text = (openingText ? openingText + '\n' : '')
    + (authorized ? '取片时人类实际播放位置 ' : '播放位置 ') + formatFilmTime(playhead) + ' · '
    + (tick.playback.state === 'playing' ? '播放中' : '已暂停')
    + (tick.playback.seeked ? ' · 已跳转' : '')
    + (tick.skipPrompt ? '\n' + tick.skipPrompt : '');
  if (authorized && tick.range.toMs > playhead) text += '\n取片时可见提前资料至 ' + formatFilmTime(tick.range.toMs);
  let textThroughMs = null;
  let currentSection = null;
  let frameOffset = 0;
  let usedImageBytes = 0;
  let hdSelectionIndex = -1;
  let stopIndex = timeline.length;
  let deliveredThroughMs = tick.range.fromMs;
  const flush = () => {
    if (text) addBlock({ type: 'text', text }, textThroughMs);
    text = '';
    textThroughMs = null;
  };
  const append = (line, throughMs = null) => {
    text += (text ? '\n' : '') + line;
    if (throughMs !== null) textThroughMs = Math.max(textThroughMs ?? 0, throughMs);
  };
  if (authorized) flush();
  const heading = (section) => {
    if (currentSection !== section.id) {
      append('\n' + formatFilmTime(section.fromMs) + '–' + formatFilmTime(section.toMs));
      currentSection = section.id;
    }
  };
  const fetchOne = async ({ entry, part }) => {
    try {
      signal?.throwIfAborted();
      const frame = { ...entry, storyboardRef: part?.ref ?? entry.storyboardRef,
        mediaTimeMs: entry.mediaTimeMs ?? entry.fromMs };
      const { image, metadata = {} } = await fetchFrame(frame, { signal });
      signal?.throwIfAborted();
      if (!image?.data || image.mimeType !== 'image/jpeg') throw new Error('Selected image unavailable.');
      const bytes = Buffer.byteLength(image.data, 'base64');
      if (bytes > maxImageBytes) throw new Error('Selected image exceeds the delivery budget.');
      const panels = metadata.panelTimesMs ?? entry.panelTimesMs;
      const panelsMs = Array.isArray(panels) && panels.length >= 1 && panels.length <= 3
        && panels.every((ms) => Number.isSafeInteger(ms) && ms >= 0 && ms <= frame.mediaTimeMs)
        ? panels : null;
      // A multi-part group without view metadata still gives each part its own time.
      const captionPanels = part && !metadata.views?.length ? null : panelsMs;
      const timing = storyboardTiming(metadata, part?.mediaTimeMs ?? frame.mediaTimeMs, captionPanels);
      return { image, bytes, frame, timing,
        hdAvailable: metadata.hdAvailable === true };
    } catch (error) {
      signal?.throwIfAborted();
      if (error?.name === 'AbortError' || ['PLAYBACK_CHANGED', 'CHAT_FEED_UNAVAILABLE'].includes(error?.code)) throw error;
      // A missing individual image does not remove dialogue or other images.
      return null;
    }
  };

  let deliveredImageCount = 0;
  for (let index = 0; index < timeline.length; index += 1) {
    signal?.throwIfAborted();
    const pending = timeline[index];
    const { section, entry } = pending;
    if (entry.type === 'image') {
      if (deliveredImageCount === maxImages) {
        stopIndex = index;
        break;
      }
      if (!fetched.has(pending)) {
        // Two requests overlap, while a large backlog never starts every image at once.
        const batch = selected.slice(frameOffset, frameOffset + 2);
        const results = await Promise.all(batch.map(fetchOne));
        for (let n = 0; n < batch.length; n += 1) fetched.set(batch[n], results[n]);
        frameOffset += batch.length;
      }
      const item = fetched.get(pending);
      fetched.delete(pending);
      if (!item) continue;
      if (usedImageBytes > 0 && usedImageBytes + item.bytes > imageBudgetBytes) {
        stopIndex = index;
        break;
      }
      heading(section);
      const gateMs = Math.max(entry.availableAtMs ?? entry.fromMs, ...item.timing.times);
      append(item.timing.text, gateMs);
      flush();
      hasMaterial = true;
      if (trackImageRefs) imageRefs.push({ index: mcpContent.length, ref: item.frame.storyboardRef,
        mediaTimeMs: item.frame.mediaTimeMs, throughMs: Math.max(...item.timing.times) });
      addBlock(item.image, gateMs);
      usedImageBytes += item.bytes;
      deliveredImageCount++;
      if (!frameSelections.has(entry.fromMs)) {
        if (item.hdAvailable) hdSelectionIndex = frameSelections.size;
        frameSelections.set(entry.fromMs, { atMs: entry.fromMs, parts: [] });
      }
      frameSelections.get(entry.fromMs).parts.push({ ref: item.frame.storyboardRef, ...item.timing });
    } else {
      const line = entryText(entry);
      if (!line) continue;
      heading(section);
      append(line, entry.type === 'message' ? null : entry.availableAtMs ?? entry.fromMs);
      hasMaterial = true;
      if (entry.type === 'sound' && entry.id) deliveredAudioIds.push(entry.id);
    }
    deliveredThroughMs = Math.max(deliveredThroughMs, entry.fromMs);
  }
  signal?.throwIfAborted();
  let remainingTick = null;
  if (stopIndex < timeline.length) {
    const remaining = new Map();
    let queuedEntry;
    for (const { section, entry, partIndex } of timeline.slice(stopIndex)) {
      if (entry === queuedEntry) continue;
      queuedEntry = entry;
      if (!remaining.has(section.id)) remaining.set(section.id, { ...section, entries: [] });
      remaining.get(section.id).entries.push(partIndex > 0 ? { ...entry, parts: entry.parts.slice(partIndex) } : entry);
    }
    const segments = [...remaining.values()];
    const { skipPrompt, ...viewing } = tick;
    remainingTick = {
      ...viewing, deliveryTimeline: true, segments,
      newMessages: [], notebookChanges: [], dialogueDelta: [], audioDescriptions: [], motionEvents: [],
      storyboards: segments.flatMap(section => section.entries.filter(entry => entry.type === 'image'))
        .map(entry => ({ ...entry, mediaTimeMs: entry.mediaTimeMs ?? entry.fromMs }))
    };
  }
  const deliveredFrames = [...frameSelections.values()];
  if (hdSelectionIndex >= 0 && deliveredFrames.length - hdSelectionIndex <= MAX_REMEMBERED_FRAMES) {
    const { atMs } = deliveredFrames[hdSelectionIndex];
    append(formatFilmTime(atMs) + ' 可看高清单帧：cinema_inspect_frame({atMs:' + atMs + ', quality:"hd"})', atMs);
  }
  if (remainingTick || ((tick.more || tick.catchup?.pending) && !tick.awaitingPreparation)) {
    append('\n待续：还有已播放的内容下次送达。');
  }
  if (!remainingTick && tick.awaitingPreparation) {
    append('\n正在准备后续观影内容。');
  }
  flush();
  return { mcpContent, frameSelections: deliveredFrames, deliveredAudioIds, remainingTick,
    ...(trackImageRefs && { imageRefs, hasMaterial, blockThroughMs }),
    deliveredThroughMs: remainingTick ? Math.min(tick.range.toMs, deliveredThroughMs) : tick.range.toMs };
}
