import { DEFAULT_TICK_LIMITS, MAX_REMEMBERED_FRAMES } from '../runtime/configuration.mjs';
import { requireString, requireInteger, cinemaError } from '../runtime/validation.mjs';
import { storyboardTiming } from './viewing-feed.mjs';

export function createViewingSession({ cinemaRequest, profileId, expectedRoomId, resumeCursors, chatFeedToken }) {
  const clientState = {
    identity: null,
    roomId: expectedRoomId && resumeCursors ? expectedRoomId : null,
    cursors: { mediaMs: null, messageId: 0, observationSequence: 0, ...(expectedRoomId && resumeCursors) },
    bridgeRoomId: expectedRoomId,
    limits: { ...DEFAULT_TICK_LIMITS },
    customLimits: false,
    tickInFlight: false,
    frameRoomId: null,
    roomsWithCornerGuide: new Set(),
    frameSelections: new Map(),
    pendingViewing: null,
    pendingAudioRanges: [],
    deliveredAudioIds: new Set(),
    settingsRevision: null
  };

  // The selected profile belongs to new connections. Once bound, this connection keeps its ID.
  let binding = null;
  async function bindSelectedProfile({ optional = false, signal } = {}) {
    if (clientState.identity) return clientState.identity;
    if (!binding) {
      // Discovery may probe several addresses. Bound the whole lookup, including the handshake.
      binding = cinemaRequest('/api/participants/ai-profiles', { signal: AbortSignal.timeout(1000) })
        .then(({ profiles, selectedId }) => {
          if (!Array.isArray(profiles) || (selectedId !== null && (typeof selectedId !== 'string'
              || !selectedId || !profiles.some(profile => profile.id === selectedId)))) {
            throw new TypeError('影院返回的 AI 档案选择无效。');
          }
          const id = profileId ? profiles.find(profile => profile.id === profileId)?.id : selectedId;
          clientState.identity = id ?? null;
          return clientState.identity;
        }).finally(() => { binding = null; });
    }
    let id;
    try { id = await binding; }
    catch {
      signal?.throwIfAborted();
      if (optional) return null;
      throw cinemaError('AI_PROFILE_UNAVAILABLE', '暂时读不到影院的 AI 档案。请确认本地影院已启动，再试一次。');
    }
    signal?.throwIfAborted();
    if (!id && !optional) {
      throw cinemaError('AI_PROFILE_REQUIRED', '请在影院设置里选择或新建一个 AI 档案，然后再试一次。当前连接可以继续使用。');
    }
    return id;
  }

  async function readFrame(roomId, storyboardRef, mediaTimeMs, quality = 'storyboard', { signal } = {}) {
    const query = new URLSearchParams({
      storyboardRef,
      quality,
      mediaTimeMs: String(mediaTimeMs)
    });
    const { data, mimeType, metadata } = await cinemaRequest(
      `/api/rooms/${encodeURIComponent(roomId)}/ai-frame?${query}`, {
        signal, ...(chatFeedToken && { headers: { 'x-owc-chat-feed-token': chatFeedToken } })
      }, true);
    return { image: { type: 'image', data, mimeType }, metadata: metadata ?? {} };
  }

  function rememberDeliveredFrames(roomId, frames) {
    if (clientState.frameRoomId !== roomId) {
      clientState.frameRoomId = roomId;
      clientState.frameSelections.clear();
    }
    for (const frame of frames) {
      const parts = clientState.frameSelections.get(frame.atMs) ?? new Map();
      for (const part of frame.parts) parts.set(part.ref, part);
      clientState.frameSelections.delete(frame.atMs);
      clientState.frameSelections.set(frame.atMs, parts);
      if (clientState.frameSelections.size > MAX_REMEMBERED_FRAMES) {
        clientState.frameSelections.delete(clientState.frameSelections.keys().next().value);
      }
    }
  }

  async function inspectFrameAtTime({ atMs, quality = 'storyboard', legacy = null, signal }) {
    if (!['storyboard', 'hd'].includes(quality)) {
      throw new TypeError('quality must be storyboard or hd.');
    }
    let roomId;
    let groupMs;
    let parts;
    if (legacy) {
      roomId = requireString(legacy.roomId, 'roomId', { max: 80 });
      groupMs = requireInteger(legacy.mediaTimeMs, 'mediaTimeMs');
      parts = [{ ref: requireString(legacy.storyboardRef, 'storyboardRef', { max: 500 }) }];
    } else {
      const time = requireInteger(atMs, 'atMs');
      roomId = clientState.frameRoomId;
      if (roomId && roomId === clientState.roomId) {
        // The package is gated by group time. Also accept the actual moments printed on each JPEG.
        for (const [gate, remembered] of [...clientState.frameSelections].reverse()) {
          const matching = [...remembered.values()].filter(part => part.times.includes(time));
          if (matching.length) {
            groupMs = gate;
            parts = matching;
            break;
          }
        }
        // A package group can end after its last displayed time. Its existing lookup still works.
        if (!parts && clientState.frameSelections.has(time)) {
          groupMs = time;
          parts = [...clientState.frameSelections.get(time).values()];
        }
      }
      if (!parts?.length) {
        throw cinemaError('FRAME_UNAVAILABLE', 'That image time has not been shown in this viewing session.');
      }
    }

    const mcpContent = [];
    for (const part of quality === 'hd' ? parts.slice(0, 1) : parts) {
      const { image, metadata } = await readFrame(roomId, part.ref, groupMs, quality, { signal });
      if (!image.data) throw new Error('The selected film image is unavailable.');
      const text = quality === 'hd' ? storyboardTiming({}, groupMs).text
        : part.text ?? storyboardTiming(metadata, groupMs).text;
      mcpContent.push({ type: 'text', text }, image);
    }
    return { mcpContent };
  }

  return { clientState, bindSelectedProfile, readFrame, rememberDeliveredFrames, inspectFrameAtTime };
}
