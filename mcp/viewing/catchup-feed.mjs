export const DEFAULT_CATCHUP_MAX_WINDOWS = 32;
export const DEFAULT_CATCHUP_TEXT_BUDGET = 70_000;

const cursorFields = ['mediaMs', 'seekVersion', 'messageId', 'observationSequence', 'notebookEventId'];

function viewingError(code, message) {
  return Object.assign(new Error(message), { code });
}

function validatePayload(payload) {
  if (!payload || !payload.tick || !payload.state?.roomId || !payload.state?.cursors) {
    throw viewingError('INVALID_VIEWING_RESPONSE', 'Cinema did not return a valid managed tick for catch-up.');
  }
  const { tick, state } = payload;
  const images = tick.packageVersion === 3 ? tick.segments : tick.storyboards;
  if (!tick.playback || !tick.range || !Array.isArray(tick.dialogueDelta)
      || !Array.isArray(tick.audioDescriptions) || !Array.isArray(tick.newMessages)
      || !Array.isArray(images)) {
    throw viewingError('INVALID_VIEWING_RESPONSE', 'Cinema returned a malformed catch-up tick.');
  }
  for (const name of cursorFields) {
    const value = state.cursors[name];
    if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw viewingError('INVALID_VIEWING_RESPONSE', 'Invalid private catch-up cursor: ' + name);
    }
  }
}

function cursorSignature(cursor) {
  return cursorFields.map((field) => String(cursor?.[field] ?? '')).join(':');
}

function uniqueKey(item, type) {
  if (type === 'dialogue') {
    return JSON.stringify([item.fromMs, item.toMs, item.text, item.speaker ?? null]);
  }
  if (type === 'audio') {
    return String(item.id ?? JSON.stringify([item.fromMs, item.toMs, item.text]));
  }
  if (type === 'frame') return String(item.storyboardRef) + ':' + item.mediaTimeMs;
  return JSON.stringify([item.fromMs, item.toMs, item.kind, item.direction]);
}

const byTime = (left, right) =>
  (left.fromMs ?? left.mediaTimeMs ?? 0) - (right.fromMs ?? right.mediaTimeMs ?? 0)
  || (left.toMs ?? 0) - (right.toMs ?? 0);

// Read-only aggregation of managed HTTP ticks under the movie-time release policy.
// Incoming server cursors remain private and are NOT committed by this helper.
// The caller must attach/validate any requested frames first and then commit.
export async function collectViewingCatchup({
  requestTick,
  identity,
  roomId = null,
  cursors = {},
  limits = {},
  maxWindows = DEFAULT_CATCHUP_MAX_WINDOWS,
  maxTextCharacters = DEFAULT_CATCHUP_TEXT_BUDGET,
  signal,
  timeBudgetMs = Infinity
}) {
  if (typeof requestTick !== 'function') throw new TypeError('requestTick is required.');
  if (!Number.isSafeInteger(maxWindows) || maxWindows < 1 || maxWindows > 128) {
    throw new RangeError('maxWindows must be between 1 and 128.');
  }
  if (!Number.isSafeInteger(maxTextCharacters) || maxTextCharacters < 1000 || maxTextCharacters > 1_000_000) {
    throw new RangeError('maxTextCharacters must be between 1000 and 1000000.');
  }
  if (timeBudgetMs !== Infinity && (!Number.isSafeInteger(timeBudgetMs) || timeBudgetMs < 1 || timeBudgetMs > 2_147_483_647)) {
    throw new RangeError('timeBudgetMs must be a positive signed 32-bit integer or Infinity.');
  }
  signal?.throwIfAborted();
  const budgetSignal = timeBudgetMs === Infinity ? null : AbortSignal.timeout(timeBudgetMs);
  const requestSignal = signal && budgetSignal ? AbortSignal.any([signal, budgetSignal]) : signal || budgetSignal;

  let privateRoomId = roomId;
  let privateCursors = { ...cursors };
  let first = null;
  let last = null;
  let expectedSeekVersion = null;
  let usedTextCharacters = 0;
  let pages = 0;
  let pendingReason = null;
  let caughtUp = false;
  let recommendedNextPollMs;
  let viewingSettings;
  let skipPrompt;
  const segmentPages = [];
  const pendingAudioRanges = [];
  const dialogueMap = new Map();
  const audioMap = new Map();
  const frameMap = new Map();
  const motionMap = new Map();
  const messages = [];
  const notebookChanges = [];

  for (let index = 0; index < maxWindows; index += 1) {
    signal?.throwIfAborted();
    let payload;
    try {
      requestSignal?.throwIfAborted();
      payload = await requestTick({
        consumerIdentity: identity,
        roomId: privateRoomId,
        cursors: { ...privateCursors },
        limits,
        signal: requestSignal
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (!budgetSignal?.aborted) throw error;
      if (pages === 0) {
        throw viewingError('CATCHUP_BUDGET_EXHAUSTED', 'The catch-up time budget ended before the first page was ready.');
      }
      pendingReason = 'time_budget';
      break;
    }
    signal?.throwIfAborted();
    validatePayload(payload);
    const { tick, state } = payload;
    // On the first page, managed HTTP intentionally rebinds a stale client to
    // a newly opened room and resets its cursors. Later transitions are stale.
    if (pages > 0 && privateRoomId && privateRoomId !== state.roomId) {
      throw viewingError('PLAYBACK_CHANGED', 'Active cinema room changed during catch-up. Retry without advancing cursors.');
    }
    if (expectedSeekVersion !== null && tick.playback.seekVersion !== expectedSeekVersion) {
      throw viewingError('PLAYBACK_CHANGED', 'Cinema seek changed during catch-up. Retry without advancing cursors.');
    }
    if (!first) {
      first = tick;
      expectedSeekVersion = tick.playback.seekVersion;
    }

    const textDelta = JSON.stringify({
      messages: tick.newMessages,
      notebookChanges: tick.notebookChanges,
      dialogue: tick.dialogueDelta,
      audio: tick.audioDescriptions,
      segments: tick.segments
    }).length;
    if (pages > 0 && usedTextCharacters + textDelta > maxTextCharacters) {
      pendingReason = 'text_budget';
      break;
    }

    // The HTTP tick owns its per-range bounds and each content type's release time.
    pages += 1;
    if (tick.skipRangeKey !== last?.skipRangeKey) skipPrompt = undefined;
    if (tick.skipPrompt) skipPrompt = tick.skipPrompt;
    last = tick;
    if (Number.isSafeInteger(payload.recommendedNextPollMs)) recommendedNextPollMs = payload.recommendedNextPollMs;
    usedTextCharacters += textDelta;
    if (!viewingSettings && payload.viewingSettings) viewingSettings = payload.viewingSettings;
    if (tick.packageVersion === 3) segmentPages.push(tick.segments);
    pendingAudioRanges.push(...(tick.pendingAudioRanges || []));
    notebookChanges.push(...(tick.notebookChanges || []));
    for (const message of tick.newMessages) messages.push(message);
    for (const dialogue of tick.dialogueDelta) {
      dialogueMap.set(uniqueKey(dialogue, 'dialogue'), dialogue);
    }
    for (const audio of tick.audioDescriptions) {
      audioMap.set(uniqueKey(audio, 'audio'), audio);
    }
    if (tick.packageVersion !== 3) {
      for (const frame of tick.storyboards) {
        if (!frame.storyboardRef) continue;
        frameMap.set(uniqueKey(frame, 'frame'), {
          ...frame,
          // The visualGroup ID is local to one legacy HTTP tick.
          visualGroup: frame.visualGroup === undefined
            ? undefined : String(index) + ':' + String(frame.visualGroup)
        });
      }
    }
    for (const event of tick.motionEvents || []) {
      motionMap.set(uniqueKey(event, 'motion'), event);
    }

    const previousSignature = cursorSignature(privateCursors);
    privateCursors = { ...state.cursors };
    privateRoomId = state.roomId;
    if (tick.awaitingPreparation) {
      pendingReason = 'preparing';
      break;
    }
    if (!tick.more) {
      caughtUp = true;
      break;
    }
    if (cursorSignature(privateCursors) === previousSignature) {
      pendingReason = 'no_cursor_progress';
      break;
    }
  }

  signal?.throwIfAborted();
  if (!last || !first) throw viewingError('INVALID_VIEWING_RESPONSE', 'Cinema catch-up produced no viewing packet.');
  const remaining = !caughtUp;
  if (remaining && !pendingReason) pendingReason = 'page_limit';
  const segments = last.packageVersion === 3 ? mergeViewingSegments(...segmentPages) : null;
  const frames = segments
    ? segments.flatMap(section => section.entries.filter(entry => entry.type === 'image'))
    : [...frameMap.values()].sort(byTime);
  const allMotion = [...motionMap.values()].sort(byTime);
  const motion = allMotion;

  // Keep structured arrays for adapter continuity; only the ordered sections reach the model.
  const merged = {
    ...(skipPrompt && { skipPrompt }),
    playback: {
      ...last.playback,
      ...(first.playback.seeked ? { seeked: true } : {})
    },
    range: {
      fromMs: first.range.fromMs,
      toMs: last.range.toMs,
      bootstrap: Boolean(first.range.bootstrap),
      seekDetected: Boolean(first.range.seekDetected)
    },
    ...(last.packageVersion === 3 ? {
      packageVersion: 3,
      viewingIntervalMs: last.viewingIntervalMs,
      ...(last.pairedCorners ? { pairedCorners: true } : {}),
      segments,
      pendingAudioRanges: combinePendingAudioRanges(pendingAudioRanges),
      ...(last.awaitingPreparation ? { awaitingPreparation: true } : {})
    } : {}),
    newMessages: messages,
    ...(notebookChanges.length ? { notebookChanges } : {}),
    dialogueDelta: [...dialogueMap.values()].sort(byTime),
    audioStatus: last.audioStatus,
    audioDescriptions: [...audioMap.values()].sort((a, b) =>
      a.availableAtMs - b.availableAtMs || a.fromMs - b.fromMs
    ),
    storyboards: frames,
    motionEvents: motion,
    catchup: {
      windowsRead: pages,
      deliveredFromMs: first.range.fromMs,
      deliveredThroughMs: last.range.toMs,
      pending: remaining,
      ...(remaining ? { pendingReason } : {}),
      selectedImages: frames.length,
      eligibleImages: frames.length,
      motionEventsSummarized: allMotion.length - motion.length
    },
    ...(remaining ? { more: true } : {})
  };

  return {
    tick: merged,
    state: { roomId: privateRoomId, cursors: privateCursors },
    recommendedNextPollMs,
    viewingSettings
  };
}

export function mergeViewingSegments(...groups) {
  const sections = new Map();
  for (const segments of groups) {
    for (const section of segments || []) {
      const key = section.id || String(section.fromMs) + ':' + section.toMs;
      if (!sections.has(key)) sections.set(key, {
        id: key, fromMs: section.fromMs, toMs: section.toMs, entries: new Map()
      });
      const target = sections.get(key);
      for (const entry of section.entries || []) {
        target.entries.set(entry.id || JSON.stringify(entry), entry);
      }
    }
  }
  return [...sections.values()].map((section) => ({
    ...section,
    // A shared release time keeps the package order supplied by successive pages.
    entries: [...section.entries.values()].sort((a, b) =>
      a.fromMs - b.fromMs || (a.availableAtMs ?? a.toMs) - (b.availableAtMs ?? b.toMs))
  })).filter((section) => section.entries.length).sort((a, b) => a.fromMs - b.fromMs);
}

export function combinePendingAudioRanges(ranges) {
  const chunks = new Map();
  for (const range of ranges || []) {
    if (!range || typeof range.chunkId !== 'string'
        || !Number.isSafeInteger(range.fromMs) || range.fromMs < 0
        || !Number.isSafeInteger(range.toMs) || range.toMs <= range.fromMs) continue;
    const previous = chunks.get(range.chunkId);
    chunks.set(range.chunkId, previous ? {
      chunkId: range.chunkId,
      fromMs: Math.min(previous.fromMs, range.fromMs),
      toMs: Math.max(previous.toMs, range.toMs)
    } : { chunkId: range.chunkId, fromMs: range.fromMs, toMs: range.toMs });
  }
  return [...chunks.values()].sort((a, b) => a.fromMs - b.fromMs);
}

// The caller commits returned pending ranges only after final playback validation.
export async function collectPendingAudio({
  requestWindow, ranges = [], deliveredIds = new Set(), roomId, seekVersion,
  playheadMs, gateAudioAtEnd = false, signal, maxWindows = DEFAULT_CATCHUP_MAX_WINDOWS,
  maxTextCharacters = DEFAULT_CATCHUP_TEXT_BUDGET, timeBudgetMs = Infinity
}) {
  signal?.throwIfAborted();
  const work = combinePendingAudioRanges(ranges);
  const remaining = [];
  const sections = [];
  const seen = new Set(deliveredIds);
  const timeout = timeBudgetMs === Infinity ? null : AbortSignal.timeout(timeBudgetMs);
  const requestSignal = signal && timeout ? AbortSignal.any([signal, timeout]) : signal || timeout;
  let characters = 0;
  let reads = 0;
  for (let index = 0; index < work.length; index += 1) {
    signal?.throwIfAborted();
    const range = work[index];
    if (reads >= maxWindows || characters >= maxTextCharacters || timeout?.aborted) {
      remaining.push(...work.slice(index));
      break;
    }
    const throughMs = Math.min(range.toMs, playheadMs);
    if (throughMs <= range.fromMs) { remaining.push(range); continue; }
    let payload;
    try {
      requestSignal?.throwIfAborted();
      payload = await requestWindow({ ...range, toMs: throughMs, signal: requestSignal });
    } catch (error) {
      signal?.throwIfAborted();
      if (!timeout?.aborted) throw error;
      remaining.push(...work.slice(index));
      break;
    }
    signal?.throwIfAborted();
    reads += 1;
    if (payload?.room?.id !== roomId || payload.room.status !== 'active'
        || payload.room.seekVersion !== seekVersion) {
      throw viewingError('PLAYBACK_CHANGED', 'Playback changed while supplementing sound.');
    }
    const window = payload.window;
    if (!window || !Number.isSafeInteger(window.nextCursorMs)
        || !Array.isArray(window.segments) || !Array.isArray(window.pendingAudioRanges)) {
      throw viewingError('INVALID_VIEWING_RESPONSE', 'Cinema returned an invalid sound window.');
    }
    const nextSections = window.segments.map((section) => ({
      id: section.id, fromMs: section.fromMs, toMs: section.toMs,
      entries: section.entries.filter((entry) => entry.type === 'sound'
        && (gateAudioAtEnd ? entry.toMs : entry.fromMs) <= playheadMs && !seen.has(entry.id))
        .map((entry) => ({ ...entry, availableAtMs: gateAudioAtEnd ? entry.toMs : entry.fromMs }))
    })).filter((section) => section.entries.length);
    const added = JSON.stringify(nextSections).length;
    if (sections.length && characters + added > maxTextCharacters) {
      remaining.push(...work.slice(index));
      break;
    }
    sections.push(...nextSections);
    characters += added;
    for (const section of nextSections) for (const entry of section.entries) seen.add(entry.id);
    remaining.push(...window.pendingAudioRanges);
    const nextMs = Math.max(range.fromMs, Math.min(window.nextCursorMs, throughMs));
    if (nextMs < range.toMs) remaining.push({ ...range, fromMs: nextMs });
  }
  return { segments: mergeViewingSegments(sections), pendingAudioRanges: combinePendingAudioRanges(remaining) };
}
