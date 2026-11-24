import { hasStoryboardCornerMarks } from '../visuals/image-settings.mjs';
import { selectVisualArc, similarComposition } from '../visuals/storyboard-selection.mjs';
import { skipRangeAt } from '../media/skip-ranges.mjs';

const DEFAULT_LIMITS = Object.freeze({
  maxStoryboards: 5,
  maxMotionEvents: 8
});

function safeInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function cinemaTickRange({
  playheadMs, mediaCursorMs, seekVersion, cursorSeekVersion,
  initialWindowMs, maxAdvanceMs, mediaFloorMs = 0, deliveryHorizonMs, messagesOnly = false
}) {
  const mediaLimitMs = deliveryHorizonMs ?? playheadMs;
  if (messagesOnly) return {
    fromMs: mediaLimitMs, toMs: mediaLimitMs, playheadMs, deliveryHorizonMs: mediaLimitMs,
    retainedMediaCursorMs: mediaCursorMs ?? 0, messagesOnly: true
  };
  const bootstrap = mediaCursorMs === undefined;
  const seekDetected = !bootstrap && (
    cursorSeekVersion !== seekVersion || (deliveryHorizonMs === undefined && mediaCursorMs > playheadMs)
  );
  const requestedFromMs = bootstrap || seekDetected
    ? Math.max(0, playheadMs - initialWindowMs)
    : Math.min(mediaCursorMs, mediaLimitMs);
  const fromMs = Math.min(mediaLimitMs, Math.max(mediaFloorMs, requestedFromMs));
  return {
    fromMs,
    toMs: Math.min(mediaLimitMs, fromMs + maxAdvanceMs),
    playheadMs,
    ...(deliveryHorizonMs !== undefined && { deliveryHorizonMs }),
    ...(deliveryHorizonMs !== undefined && !seekDetected && mediaCursorMs > mediaLimitMs
      && { retainedMediaCursorMs: mediaCursorMs }),
    seekDetected,
    bootstrap
  };
}

function selectStoryboards(observations, maximum) {
  const candidates = observations
    .filter((observation) => observation?.storyboard?.storyboardRef)
    .map((observation) => ({
      fromMs: safeInteger(observation.fromMs),
      toMs: safeInteger(observation.toMs, safeInteger(observation.fromMs)),
      kind: observation.kind || 'visual_event',
      mediaTimeMs: safeInteger(
        observation.storyboard.mediaTimeMs,
        safeInteger(observation.fromMs)
      ),
      frameReason: observation.storyboard.frameReason || observation.kind || 'visual_event',
      hash: observation.storyboard.perceptualHash,
      rgb: observation.storyboard.averageRgb || observation.metrics?.averageRgb,
      storyboardRef: observation.storyboard.storyboardRef
    }));
  const compositions = [];
  for (const frame of candidates) {
    let group = compositions.findIndex((other) => (
      frame.storyboardRef === other.storyboardRef || similarComposition(frame, other)
    ));
    if (group < 0) {
      group = compositions.length;
      compositions.push(frame);
    }
    frame.visualGroup = group;
  }
  return selectVisualArc(candidates, maximum).map(({ hash, rgb, ...item }) => item);
}

function compactMotionEvent(observation) {
  const metrics = observation?.metrics || {};
  const direction = metrics.motionDirection && metrics.motionDirection !== 'still'
    ? metrics.motionDirection
    : null;
  return {
    fromMs: safeInteger(observation.fromMs),
    toMs: safeInteger(observation.toMs, safeInteger(observation.fromMs)),
    kind: observation.kind || 'visual_event',
    direction
  };
}

function selectMotionEvents(observations, liveObservations, maximum) {
  const precomputed = observations
    .filter((observation) => (
      observation.kind === 'scene_change'
      || observation.kind === 'motion_peak'
      || Number(observation.motionScore) >= 0.45
    ))
    .map((observation) => compactMotionEvent(observation));
  const live = liveObservations
    .filter((observation) => (
      observation.kind === 'scene_change'
      || observation.kind === 'motion_peak'
      || Number(observation.motionScore) >= 0.45
    ))
    .map((observation) => compactMotionEvent(observation));

  return [...precomputed, ...live]
    .sort((left, right) => left.fromMs - right.fromMs)
    .slice(-maximum);
}

function compactDialogue(cue) {
  return {
    fromMs: safeInteger(cue.fromMs),
    toMs: safeInteger(cue.toMs, safeInteger(cue.fromMs)),
    text: String(cue.text || ''),
    ...(cue.speaker ? { speaker: cue.speaker } : {})
  };
}

function compactMessage(message) {
  return {
    content: message.content,
    senderName: String(message.senderName || '').trim() || 'user',
    ...(message.interaction ? { interaction: message.interaction } : {}),
    mediaTimeMs: safeInteger(message.mediaTimeMs)
  };
}


function compactViewingEntry(entry, gateAudioAtEnd) {
  const common = {
    id: entry.id, type: entry.type, fromMs: entry.fromMs, toMs: entry.toMs,
    availableAtMs: entry.type === 'sound' && !gateAudioAtEnd ? entry.fromMs : entry.availableAtMs
  };
  if (entry.type === 'image') {
    return { ...common, storyboardRef: entry.storyboardRef, mediaTimeMs: entry.fromMs,
      panelTimesMs: entry.panelTimesMs, frameReason: entry.frameReason,
      ...(entry.parts ? { parts: entry.parts.map(({ ref, mediaTimeMs }) => ({ ref, mediaTimeMs })) } : {}) };
  }
  return { ...common, text: entry.text,
    ...(entry.speaker ? { speaker: entry.speaker } : {}),
    ...(entry.type === 'motion' ? { kind: entry.kind, direction: entry.direction } : {}) };
}

function viewingSegments(window, revealThroughMs, gateAudioAtEnd) {
  return (window.segments || []).map((segment) => ({
    id: segment.id, fromMs: segment.fromMs, toMs: segment.toMs,
    entries: segment.entries.filter((entry) =>
      (entry.type === 'sound' && !gateAudioAtEnd ? entry.fromMs : entry.availableAtMs) <= revealThroughMs)
      .map(entry => compactViewingEntry(entry, gateAudioAtEnd))
  })).filter((segment) => segment.entries.length);
}

export function buildCinemaTick({
  room,
  window,
  messages = [],
  includeMessageIds = false,
  notebookChanges = { events: [], hasMore: false },
  consumerIdentity = null,
  consumerName = null,
  liveObservations = [],
  inputCursors = {},
  skipRanges = [],
  viewerName = '',
  targetRange,
  messageHasMore = false,
  observationHasMore = false,
  limits = {}
}) {
  if (!room || typeof room !== 'object') throw new TypeError('room is required.');
  if (!window || typeof window !== 'object') throw new TypeError('window is required.');
  if (!targetRange || typeof targetRange !== 'object') throw new TypeError('targetRange is required.');

  const maxStoryboards = Math.max(
    1,
    Math.min(12, safeInteger(limits.maxStoryboards, DEFAULT_LIMITS.maxStoryboards))
  );
  const maxMotionEvents = Math.max(
    1,
    Math.min(30, safeInteger(limits.maxMotionEvents, DEFAULT_LIMITS.maxMotionEvents))
  );
  const observations = Array.isArray(window.observations) ? window.observations : [];
  const dialogue = Array.isArray(window.dialogue) ? window.dialogue : [];
  const exactMessages = Array.isArray(messages) ? messages : [];
  const cleanConsumerIdentity = typeof consumerIdentity === 'string' ? consumerIdentity.trim() : '';
  const cleanConsumerName = typeof consumerName === 'string' ? consumerName.trim() : '';
  const deliveredMessages = cleanConsumerIdentity
    ? exactMessages.filter((message) => !(
      message.senderKind === 'ai'
      && String(message.senderIdentity || '').trim() === cleanConsumerIdentity
    ))
    : cleanConsumerName
      ? exactMessages.filter((message) => !(
        message.senderKind === 'ai'
        && String(message.senderName || '').trim() === cleanConsumerName
      ))
      : exactMessages;
  const exactLiveObservations = Array.isArray(liveObservations) ? liveObservations : [];

  const requestedFromMs = safeInteger(targetRange.fromMs);
  const requestedToMs = safeInteger(targetRange.toMs, requestedFromMs);
  const mediaLimitMs = targetRange.deliveryHorizonMs ?? targetRange.playheadMs;
  const unified = window.packageVersion === 3;
  const deliveredToMs = unified
    ? Math.min(requestedToMs, safeInteger(window.nextCursorMs, requestedFromMs), mediaLimitMs)
    : requestedToMs;
  const revealThroughMs = Math.min(safeInteger(window.revealThroughMs, requestedToMs), mediaLimitMs);
  const chatHorizon = targetRange.deliveryHorizonMs !== undefined;
  const segments = unified ? viewingSegments(window, Math.min(requestedToMs, revealThroughMs), chatHorizon) : null;
  const entries = segments?.flatMap((segment) => segment.entries) || [];
  const gatedLiveObservations = exactLiveObservations.filter(
    (observation) => safeInteger(observation.fromMs) < Math.min(revealThroughMs, targetRange.playheadMs)
  );
  const visibleLiveObservations = gatedLiveObservations.filter(observation => !skipRangeAt(skipRanges, observation.fromMs));
  const liveObservationDeferred = gatedLiveObservations.length < exactLiveObservations.length;
  const mediaHasMore = Boolean(
    mediaLimitMs > deliveredToMs
    || window.hasMore
    || window.dialogueHasMore
    || window.audioHasMore
  );
  const lastMessageId = exactMessages.length > 0
    ? safeInteger(exactMessages.at(-1).id, safeInteger(inputCursors.messageId))
    : safeInteger(inputCursors.messageId);
  const lastObservationSequence = gatedLiveObservations.length > 0
    ? safeInteger(
      gatedLiveObservations.at(-1).sequenceNo,
      safeInteger(inputCursors.observationSequence)
    )
    : safeInteger(inputCursors.observationSequence);

  const skip = skipRangeAt(skipRanges, targetRange.playheadMs);
  const skipRangeKey = skip ? `${skip.kind}:${skip.fromMs}:${skip.toMs}` : null;
  const skipPrompt = skip && skipRangeKey !== inputCursors.skipRangeKey ? {
    intro: '正在播放片头（已设置跳过，未准备画面与声音）',
    outro: '正在播放片尾（已设置跳过，未准备画面与声音）',
    middle: `正在播放中间片段（${viewerName.trim() || '观众'}设置了跳过，未准备画面与声音）`
  }[skip.kind] : null;

  const tick = {
    playback: {
      timeMs: safeInteger(targetRange.playheadMs),
      ...(targetRange.deliveryHorizonMs !== undefined && { deliveryHorizonMs: mediaLimitMs }),
      state: room.playbackState,
      seekVersion: safeInteger(room.seekVersion),
      ...(targetRange.seekDetected ? { seeked: true } : {})
    },
    range: {
      fromMs: requestedFromMs,
      toMs: deliveredToMs,
      seekDetected: Boolean(targetRange.seekDetected),
      bootstrap: Boolean(targetRange.bootstrap)
    },
    ...(skipRangeKey && { skipRangeKey }),
    ...(skipPrompt && { skipPrompt }),
    newMessages: deliveredMessages.map(message => ({ ...compactMessage(message),
      ...(targetRange.messagesOnly && { senderKind: message.senderKind }),
      ...(includeMessageIds ? { messageId: message.id } : {}) })),
    ...(notebookChanges.events.length ? { notebookChanges: notebookChanges.events } : {}),
    ...(unified ? {
      packageVersion: 3,
      viewingIntervalMs: window.viewingIntervalMs,
      ...(hasStoryboardCornerMarks(window.imageSettings) ? { pairedCorners: true } : {}),
      segments,
      pendingAudioRanges: window.pendingAudioRanges || [],
      ...(window.awaitingPreparation ? { awaitingPreparation: true } : {})
    } : {}),
    dialogueDelta: dialogue.map(compactDialogue),
    audioStatus: window.audioTrack?.status || 'not_prepared',
    audioDescriptions: (window.audioDescriptions || [])
      .map((item) => ({ ...item, availableAtMs: chatHorizon ? item.toMs : item.fromMs }))
      .filter((item) => item.availableAtMs <= Math.min(requestedToMs, mediaLimitMs))
      .map(({ id, fromMs, toMs, availableAtMs, text, source, sourceChunkId }) => ({
        id, fromMs, toMs, availableAtMs, text, source, sourceChunkId
      })),
    storyboards: unified
      ? entries.filter((entry) => entry.type === 'image').map((entry) => ({
        id: entry.id, fromMs: entry.fromMs, toMs: entry.toMs,
        mediaTimeMs: entry.mediaTimeMs, storyboardRef: entry.storyboardRef,
        ...(entry.parts ? { parts: entry.parts } : {}),
        panelTimesMs: entry.panelTimesMs, frameReason: entry.frameReason, kind: entry.frameReason
      }))
      : selectStoryboards(observations, maxStoryboards),
    motionEvents: unified
      ? [
        ...entries.filter((entry) => entry.type === 'motion').map(({ fromMs, toMs, kind, direction, text }) => ({
          fromMs, toMs, kind, direction, text
        })),
        ...selectMotionEvents([], visibleLiveObservations, maxMotionEvents)
      ].sort((left, right) => left.fromMs - right.fromMs)
      : selectMotionEvents(observations, visibleLiveObservations, maxMotionEvents),
    ...(mediaHasMore || messageHasMore || notebookChanges.hasMore || observationHasMore || liveObservationDeferred
      ? { more: true }
      : {}),
  };
  Object.defineProperty(tick, 'internalCursors', {
    value: {
      mediaMs: targetRange.messagesOnly
        ? targetRange.retainedMediaCursorMs
        : Math.max(deliveredToMs, targetRange.retainedMediaCursorMs ?? 0),
      seekVersion: safeInteger(room.seekVersion),
      messageId: lastMessageId,
      ...(inputCursors.notebookEventId !== undefined ? {
        notebookEventId: notebookChanges.events.at(-1)?.id ?? inputCursors.notebookEventId
      } : {}),
      observationSequence: lastObservationSequence,
      ...(skipRangeKey && { skipRangeKey })
    },
    enumerable: false
  });
  return tick;
}
