import { selectVisualArc, similarComposition } from './storyboard-selection.mjs';

const DEFAULT_LIMITS = Object.freeze({
  maxStoryboards: 5,
  maxMotionEvents: 8
});

function safeInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function selectStoryboards(observations, maximum) {
  const candidates = observations
    .filter((observation) => observation?.storyboard?.storyboardRef)
    .map((observation) => ({
      fromMs: safeInteger(observation.fromMs),
      toMs: safeInteger(observation.toMs, safeInteger(observation.fromMs)),
      kind: observation.kind || 'visual_event',
      sceneScore: Math.max(0, Number(observation.sceneScore) || 0),
      motionScore: Math.max(0, Number(observation.motionScore) || 0),
      mediaTimeMs: safeInteger(
        observation.storyboard.mediaTimeMs,
        safeInteger(observation.fromMs)
      ),
      frameReason: observation.storyboard.frameReason || observation.kind || 'visual_event',
      hash: observation.storyboard.perceptualHash,
      rgb: observation.storyboard.averageRgb || observation.metrics?.averageRgb,
      storyboardRef: observation.storyboard.storyboardRef,
    }));
  const compositions = [];
  for (const frame of candidates) {
    let group = compositions.findIndex((other) => (
      frame.storyboardRef === other.storyboardRef || similarComposition(frame, other)
    ));
    if (group < 0) { group = compositions.length; compositions.push(frame); }
    frame.visualGroup = group;
  }
  return selectVisualArc(candidates, maximum).map(({ hash, rgb, ...item }) => item);
}

function compactMotionEvent(observation, source = 'precomputed') {
  const metrics = observation?.metrics || {};
  const direction = metrics.motionDirection && metrics.motionDirection !== 'still'
    ? metrics.motionDirection
    : null;
  return {
    source,
    fromMs: safeInteger(observation.fromMs),
    toMs: safeInteger(observation.toMs, safeInteger(observation.fromMs)),
    kind: observation.kind || 'visual_event',
    sceneScore: Math.max(0, Number(observation.sceneScore) || 0),
    motionScore: Math.max(0, Number(observation.motionScore) || 0),
    motionDirection: direction,
    sequenceNo: Number.isSafeInteger(observation.sequenceNo) ? observation.sequenceNo : null
  };
}

function selectMotionEvents(observations, liveObservations, maximum) {
  const precomputed = observations
    .filter((observation) => (
      observation.kind === 'scene_change'
      || observation.kind === 'motion_peak'
      || Number(observation.motionScore) >= 0.45
    ))
    .map((observation) => compactMotionEvent(observation, 'precomputed'));
  const live = liveObservations
    .filter((observation) => (
      observation.kind === 'scene_change'
      || observation.kind === 'motion_peak'
      || Number(observation.motionScore) >= 0.45
    ))
    .map((observation) => compactMotionEvent(observation, 'live'));

  return [...precomputed, ...live]
    .sort((left, right) => left.fromMs - right.fromMs || left.source.localeCompare(right.source))
    .slice(-maximum);
}

function compactDialogue(cue) {
  return {
    cueId: cue.cueId || null,
    fromMs: safeInteger(cue.fromMs),
    toMs: safeInteger(cue.toMs, safeInteger(cue.fromMs)),
    text: String(cue.text || ''),
    speaker: cue.speaker || null,
    language: cue.language || null,
    sourceChunkId: cue.sourceChunkId || null
  };
}

function compactMessage(message) {
  return {
    id: safeInteger(message.id),
    senderName: message.senderName,
    senderKind: message.senderKind,
    content: message.content,
    mediaTimeMs: safeInteger(message.mediaTimeMs),
    createdAt: message.createdAt
  };
}

export function cinemaTickRange({
  playheadMs, mediaCursorMs, seekVersion, cursorSeekVersion,
  initialWindowMs, maxAdvanceMs
}) {
  const bootstrap = mediaCursorMs === undefined;
  const seekDetected = !bootstrap && (
    cursorSeekVersion !== seekVersion || mediaCursorMs > playheadMs
  );
  const fromMs = bootstrap || seekDetected
    ? Math.max(0, playheadMs - initialWindowMs)
    : Math.min(mediaCursorMs, playheadMs);
  return {
    fromMs,
    toMs: Math.min(playheadMs, fromMs + maxAdvanceMs),
    playheadMs,
    seekDetected,
    bootstrap
  };
}

export function buildCinemaTick({
  room,
  window,
  messages = [],
  consumerName = null,
  liveObservations = [],
  inputCursors = {},
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
  const cleanConsumerName = typeof consumerName === 'string' ? consumerName.trim() : '';
  const deliveredMessages = cleanConsumerName
    ? exactMessages.filter((message) => !(
      message.senderKind === 'ai'
      && String(message.senderName || '').trim() === cleanConsumerName
    ))
    : exactMessages;
  const exactLiveObservations = Array.isArray(liveObservations) ? liveObservations : [];

  const requestedFromMs = safeInteger(targetRange.fromMs);
  const requestedToMs = safeInteger(targetRange.toMs, requestedFromMs);
  const revealThroughMs = safeInteger(window.revealThroughMs, requestedToMs);
  const gatedLiveObservations = exactLiveObservations.filter(
    (observation) => safeInteger(observation.fromMs) < revealThroughMs
  );
  const liveObservationDeferred = gatedLiveObservations.length < exactLiveObservations.length;
  const mediaHasMore = Boolean(
    targetRange.playheadMs > requestedToMs
    || window.hasMore
    || window.dialogueHasMore
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

  return {
    tickVersion: 1,
    room: {
      id: room.id,
      mediaId: room.mediaId,
      mediaTitle: room.mediaTitle,
      status: room.status
    },
    playback: {
      playheadMs: safeInteger(targetRange.playheadMs),
      state: room.playbackState,
      version: safeInteger(room.playbackVersion),
      seekVersion: safeInteger(room.seekVersion),
      updatedAt: room.updatedAt
    },
    range: {
      fromMs: requestedFromMs,
      toMs: requestedToMs,
      revealThroughMs,
      seekDetected: Boolean(targetRange.seekDetected),
      bootstrap: Boolean(targetRange.bootstrap)
    },
    newMessages: deliveredMessages.map(compactMessage),
    dialogueDelta: dialogue.map(compactDialogue),
    storyboards: selectStoryboards(observations, maxStoryboards),
    motionEvents: selectMotionEvents(
      observations,
      gatedLiveObservations,
      maxMotionEvents
    ),
    cursors: {
      mediaMs: requestedToMs,
      seekVersion: safeInteger(room.seekVersion),
      messageId: lastMessageId,
      observationSequence: lastObservationSequence
    },
    more: {
      media: mediaHasMore,
      messages: Boolean(messageHasMore),
      observations: Boolean(observationHasMore || liveObservationDeferred),
      any: Boolean(
        mediaHasMore
        || messageHasMore
        || observationHasMore
        || liveObservationDeferred
      )
    },
    availability: {
      visualStatus: window.visualStatus || null,
      dialogueTrack: window.dialogueTrack || null,
      aiReadiness: window.aiReadiness || null
    },
    compacted: {
      rawVisualMetricsOmitted: true,
      selfMessagesOmitted: exactMessages.length - deliveredMessages.length,
      detailedWindowToolAvailable: true
    }
  };
}
