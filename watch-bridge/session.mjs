import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { followCinemaState } from './cinema-state.mjs';
import { openMcpClient } from './mcp-client.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const TICK = 'open_watch_cinema_tick';
const CURSORS = 'open-watch-cinema/bridgeCursors';
const MORE_IMAGE_PAGES = 'open-watch-cinema/bridgeMoreImagePages';
const HAS_MATERIAL = 'open-watch-cinema/bridgeHasMaterial';
const ROOM_ENDED = Symbol('room ended');

function localOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('The cinema URL must be a local HTTP origin.');
  }
  return url.origin;
}

function tickStatus(result) {
  if (result?.content?.length !== 1 || result.content[0].type !== 'text') return {};
  try {
    return JSON.parse(result.content[0].text) ?? {};
  } catch {
    return {};
  }
}

async function abortable(promise, signal) {
  signal.throwIfAborted();
  const stopped = Promise.withResolvers();
  const cancel = () => stopped.reject(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    return await Promise.race([promise, stopped.promise]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

export async function watchCinema({
  cinemaUrl = 'http://127.0.0.1:4182',
  cinemaRoot = DEFAULT_ROOT,
  roomId: expectedRoomId,
  profileId,
  connectionId,
  resumeCursors,
  enableHistory,
  trackImageRefs,
  feedToken,
  drainPaused = false,
  retainTickResult = result => result,
  discardTickResults = () => {},
  getIntervalMs = state => state.intervalMs,
  onConnect,
  onPlaybackState,
  canReadInterval = () => true,
  onTick,
  signal: callerSignal
}) {
  if (typeof onTick !== 'function') throw new TypeError('An onTick callback is required.');
  const origin = localOrigin(cinemaUrl);
  const stop = new AbortController();
  const signal = callerSignal ? AbortSignal.any([stop.signal, callerSignal]) : stop.signal;
  let mcp;
  let latest;
  let roomId;
  let playbackSeek;
  let pendingPause;
  let changed = Promise.withResolvers();
  const stateReader = followCinemaState({
    cinemaUrl: origin,
    signal,
    onState(state) {
      if (!roomId && expectedRoomId && state.roomId !== expectedRoomId) {
        stop.abort(new Error('The selected cinema screening is no longer active.'));
        return;
      }
      if (roomId && state.roomId !== roomId) {
        stop.abort(ROOM_ENDED);
        return;
      }
      roomId = state.roomId;
      if (state.playbackState === 'playing') playbackSeek = state.seekVersion;
      // Preserve a pause observed while the consumer is still handling a packet.
      if (latest?.roomId === roomId && latest.playbackState === 'playing'
        && state.playbackState === 'paused') pendingPause = state;
      latest = Object.freeze(state);
      onPlaybackState?.(latest);
      changed.resolve();
    }
  }).catch(error => {
    if (!signal.aborted) stop.abort(error);
  });

  function readChange() {
    return abortable(changed.promise, signal);
  }

  async function deliver(result, state, reason, buffered, hasPlayed, messagesOnly) {
    signal.throwIfAborted();
    const results = [...buffered, result];
    const delivery = buffered.length
      ? { ...result, content: results.flatMap(packet => packet.content) }
      : result;
    await abortable(Promise.resolve().then(() => onTick(delivery, {
      state, reason, results, signal, includesPlayback: hasPlayed, messagesOnly
    })), signal);
  }

  try {
    while (!roomId) {
      await readChange();
      changed = Promise.withResolvers();
    }

    const start = latest;
    const newSeek = drainPaused && resumeCursors?.seekVersion !== start.seekVersion
      && resumeCursors && Number.isFinite(start.chatPlayback?.fromMs);
    const atOpening = drainPaused && start.playheadMs === (start.resumeFromMs ?? 0);
    const startingCursors = newSeek || (atOpening && !resumeCursors) ? {
      mediaMs: start.chatPlayback?.fromMs ?? start.resumeFromMs ?? 0,
      seekVersion: start.seekVersion, messageId: resumeCursors?.messageId ?? 0, observationSequence: 0,
      notebookEventId: resumeCursors?.notebookEventId ?? 0
    } : resumeCursors;
    mcp = openMcpClient({
      script: resolve(cinemaRoot, 'mcp', 'server.mjs'), cinemaUrl: origin,
      roomId: expectedRoomId, profileId, connectionId, resumeCursors: startingCursors, enableHistory, trackImageRefs, feedToken,
      onFailure: error => stop.abort(error)
    });
    await mcp.initialize(signal);
    if (onConnect) await abortable(Promise.resolve().then(() => onConnect({
      signal,
      wake: () => changed.resolve(),
      listTools: () => mcp.listTools(signal),
      callTool: (name, args, options) => mcp.callTool(name, args, signal, options)
    })), signal);

    let anchorMs = start.playheadMs;
    let attemptedThroughMs = start.playheadMs;
    let seekVersion = start.seekVersion;
    let mediaThroughMs = startingCursors?.mediaMs ?? start.playheadMs;
    let pausedWithoutProgress;
    let viewerMessageId = resumeCursors?.messageId ?? (expectedRoomId ? 0 : start.latestViewerMessageId ?? 0);
    const buffered = [];

    while (true) {
      signal.throwIfAborted();
      const state = latest;
      changed = Promise.withResolvers();
      const playing = state.playbackState === 'playing';
      const seek = state.seekVersion !== seekVersion;
      if (seek) {
        // A rewind must not expose any buffered pictures from the old position.
        seekVersion = state.seekVersion;
        anchorMs = state.playheadMs;
        attemptedThroughMs = state.playheadMs;
        buffered.length = 0;
        mediaThroughMs = state.chatPlayback?.fromMs ?? state.playheadMs;
        pausedWithoutProgress = undefined;
      }
      const chat = state.latestViewerMessageId > viewerMessageId;
      const due = playing && state.playheadMs - anchorMs >= getIntervalMs(state) && canReadInterval();
      const transitionedPause = pendingPause?.seekVersion === seekVersion
        && pendingPause.playheadMs > attemptedThroughMs;
      const previouslyWatching = playbackSeek === seekVersion
        || (resumeCursors?.seekVersion === seekVersion && Number.isFinite(resumeCursors?.mediaMs));
      const pausedThrough = state.chatPlayback
        ? state.chatPlayback.throughMs
        : previouslyWatching ? state.playheadMs : null;
      const capture = drainPaused
        ? !playing && previouslyWatching && Number.isFinite(pausedThrough) && pausedThrough > mediaThroughMs
          && pausedThrough !== pausedWithoutProgress && canReadInterval()
        : transitionedPause;
      if (playing) pausedWithoutProgress = undefined;
      pendingPause = undefined;

      const reason = chat ? 'chat' : due ? 'interval' : capture ? 'pause' : null;
      if (!reason) {
        await readChange();
        continue;
      }

      const hasPlayed = playbackSeek === seekVersion || (drainPaused && previouslyWatching && Number.isFinite(pausedThrough)
        && pausedThrough > (state.chatPlayback?.fromMs ?? state.resumeFromMs ?? 0));
      const feedMessagesOnly = Boolean(feedToken && chat);
      if (!feedMessagesOnly) attemptedThroughMs = state.playheadMs;
      let result;
      let unavailable;
      for (const backoff of [0, 250, 500]) {
        if (backoff) await delay(backoff, undefined, { signal });
        if (latest.seekVersion !== seekVersion) break;
        result = await mcp.callTool(TICK, {}, signal, { feedMessagesOnly });
        if (!Array.isArray(result?.content)) throw new Error('The cinema tick returned an invalid MCP result.');
        const status = tickStatus(result);
        unavailable = result.isError || status.state === 'waiting';
        if (!chat || !unavailable || (result.isError && !status.retryable)) break;
      }
      signal.throwIfAborted();
      if (latest.seekVersion !== seekVersion) continue;
      if (reason === 'pause' && !drainPaused) {
        buffered.push(result);
        continue;
      }
      let stalePage = feedToken && result.isError && tickStatus(result).error === 'PLAYBACK_CHANGED';
      while (!stalePage && trackImageRefs && result._meta?.[MORE_IMAGE_PAGES]) {
        buffered.push(retainTickResult(result));
        result = await mcp.callTool(TICK, {}, signal);
        if (!Array.isArray(result?.content) || result.isError || tickStatus(result).state === 'waiting') {
          if (latest.seekVersion !== seekVersion) break;
          if (feedToken && result?.isError && tickStatus(result).error === 'PLAYBACK_CHANGED') {
            stalePage = true;
            break;
          }
          throw new Error('Cinema could not finish assembling the current storyboard pages.');
        }
      }
      if (stalePage) {
        discardTickResults(buffered.splice(0));
        if (latest === state) await readChange();
        continue;
      }
      if (latest.seekVersion !== seekVersion) continue;
      const nextMediaMs = result._meta?.[CURSORS]?.mediaMs;
      if (!result.isError && (reason === 'pause' || (feedToken && !feedMessagesOnly))) {
        if (!Number.isFinite(nextMediaMs) || nextMediaMs <= mediaThroughMs) pausedWithoutProgress = pausedThrough;
        if (![...buffered, result].some(page => page._meta?.[HAS_MATERIAL])) {
          if (Number.isFinite(nextMediaMs)) mediaThroughMs = nextMediaMs;
          if (reason === 'interval') anchorMs = state.playheadMs;
          buffered.length = 0;
          continue;
        }
      }
      if (!feedMessagesOnly) {
        if (Number.isFinite(nextMediaMs)) mediaThroughMs = nextMediaMs;
        anchorMs = state.playheadMs;
      }
      await deliver(retainTickResult(result), state, reason, buffered.splice(0), !feedMessagesOnly && hasPlayed, feedMessagesOnly);
      if (chat && unavailable) throw new Error('The cinema tick could not read the new viewer message.');
      const deliveredViewerCursor = result._meta?.[CURSORS]?.messageId;
      viewerMessageId = Number.isSafeInteger(deliveredViewerCursor)
        ? Math.min(deliveredViewerCursor, state.latestViewerMessageId ?? 0)
        : state.latestViewerMessageId ?? 0;
    }
  } catch (error) {
    if (signal.aborted && (error === signal.reason || error?.name === 'AbortError')) {
      if (signal.reason === ROOM_ENDED || callerSignal?.aborted) return;
      throw signal.reason;
    }
    throw error;
  } finally {
    stop.abort();
    await Promise.all([stateReader, mcp?.close()]);
  }
}
