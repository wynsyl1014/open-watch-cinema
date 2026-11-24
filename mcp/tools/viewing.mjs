import { assertViewingPlayback, buildViewingFeed, notebookChangeNotice } from '../viewing/viewing-feed.mjs';
import { collectViewingCatchup, collectPendingAudio, combinePendingAudioRanges, mergeViewingSegments } from '../viewing/catchup-feed.mjs';

// One process owns one session. Dependencies are injected; importing this module starts nothing.
export function createViewingTools({
  clientState, bindSelectedProfile, requireString, cinemaError, cinemaRequest,
  describeViewingSettings, readFrame, rememberDeliveredFrames,
  inspectFrameAtTime, CATCHUP_TIME_BUDGET_MS, IMAGE_BUDGET_BYTES, TRACK_IMAGE_REFS, chatFeedToken, manualChat
}) {
  const chatHeaders = chatFeedToken ? { 'x-owc-chat-feed-token': chatFeedToken } : undefined;
  const readTick = ({ consumerIdentity, roomId, cursors, limits, signal }, messagesOnly = false) =>
    cinemaRequest('/api/ai/tick', {
      signal, retryRead: true, method: 'POST', ...(chatHeaders && { headers: chatHeaders }),
      body: JSON.stringify({ consumerIdentity, roomId, cursors, limits, ...(messagesOnly && { messagesOnly }) })
    });
  return [
    {
      order: 10,
      definition: {
        name: 'open_watch_cinema_tick',
        description: 'Catch up with the film as it plays. Receive timed dialogue, environmental sounds, short visual motion notes, storyboard images, and room messages in movie-time order. Continue when more played content is available.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      },
      async handler(args, { signal, request, feedMessagesOnly }) {
        if (clientState.tickInFlight) {
          return { state: 'waiting', reason: 'tick_in_progress' };
        }
        clientState.tickInFlight = true;
        let chatPageStart;
        try {
          const identity = await bindSelectedProfile({ signal });
          if (chatFeedToken && feedMessagesOnly) {
            const { tick, state } = await collectViewingCatchup({
              identity, roomId: clientState.bridgeRoomId, cursors: clientState.cursors,
              limits: { maxMessages: 100 }, signal, timeBudgetMs: CATCHUP_TIME_BUDGET_MS,
              requestTick: options => readTick(options, true)
            });
            const playback = await request('/api/rooms/' + encodeURIComponent(state.roomId) + '/playback-state', {
              headers: chatHeaders
            });
            assertViewingPlayback(tick, playback.room, state.roomId);
            const feed = await buildViewingFeed({ tick }, { signal, trackImageRefs: true, formatViewerMessages: true });
            clientState.cursors.messageId = state.cursors.messageId;
            if (clientState.pendingViewing) {
              clientState.pendingViewing.collected.state.cursors.messageId = state.cursors.messageId;
            }
            return { mcpContent: feed.mcpContent, bridgeCursors: { ...clientState.cursors },
              viewerActualMs: tick.playback.timeMs, deliveryHorizonMs: tick.playback.timeMs,
              bridgeBlockThroughMs: feed.blockThroughMs, bridgeHasMaterial: feed.hasMaterial };
          }
          const resumed = Boolean(clientState.pendingViewing);
          let packet = clientState.pendingViewing;
          if (chatFeedToken) chatPageStart = packet?.chatPageStart ?? { ...clientState.cursors };
          if (!packet) {
            const internalLimits = clientState.customLimits
              ? { ...clientState.limits }
              : { ...clientState.limits, maxAdvanceMs: 60_000, maxMessages: 100,
                  maxLiveObservations: 200, maxStoryboards: 12, maxMotionEvents: 30 };
            const collected = await collectViewingCatchup({
              identity, roomId: chatFeedToken ? clientState.bridgeRoomId : clientState.roomId,
              cursors: clientState.cursors, limits: internalLimits, signal,
              ...(manualChat && { maxWindows: 4 }),
              timeBudgetMs: CATCHUP_TIME_BUDGET_MS,
              requestTick: options => readTick(options)
            });
            const { tick, state } = collected;
            const resetContext = state.roomId !== clientState.roomId
              || tick.playback.seeked === true
              || tick.playback.seekVersion !== clientState.cursors.seekVersion;
            const deliveredIds = resetContext ? new Set() : new Set(clientState.deliveredAudioIds);
            let pendingAudioRanges = [];
            tick.audioDescriptions = (tick.audioDescriptions || []).filter((item) => !deliveredIds.has(item.id));
            if (tick.packageVersion === 3) {
              tick.segments = (tick.segments || []).map((section) => ({
                ...section, entries: section.entries.filter((entry) =>
                  entry.type !== 'sound' || !deliveredIds.has(entry.id))
              })).filter((section) => section.entries.length);
              const knownIds = new Set(deliveredIds);
              for (const section of tick.segments) for (const entry of section.entries) {
                if (entry.type === 'sound') knownIds.add(entry.id);
              }
              const supplemented = await collectPendingAudio({
                ranges: combinePendingAudioRanges([
                  ...(resetContext ? [] : clientState.pendingAudioRanges),
                  ...(tick.pendingAudioRanges || [])
                ]),
                deliveredIds: knownIds, roomId: state.roomId,
                seekVersion: tick.playback.seekVersion, playheadMs: chatFeedToken ? tick.range.toMs : tick.playback.timeMs,
                gateAudioAtEnd: Boolean(chatFeedToken),
                signal, timeBudgetMs: CATCHUP_TIME_BUDGET_MS,
                requestWindow: ({ fromMs, toMs, signal: audioSignal }) => {
                  const query = new URLSearchParams({
                    fromMs: String(fromMs), toMs: String(toMs), tracks: 'audio',
                    playheadMs: String(chatFeedToken ? tick.range.toMs : tick.playback.timeMs),
                    lookaheadMs: '0', maxAudioItems: '100'
                  });
                  return cinemaRequest('/api/rooms/' + encodeURIComponent(state.roomId) + '/ai-window?' + query,
                    { signal: audioSignal, ...(chatHeaders && { headers: chatHeaders }) });
                }
              });
              tick.segments = mergeViewingSegments(tick.segments, supplemented.segments);
              pendingAudioRanges = supplemented.pendingAudioRanges;
            }
            packet = { collected, pendingAudioRanges, deliveredIds, resetContext };
          }
          const { collected } = packet;
          const { tick, state, viewingSettings } = collected;
          const nextRoomId = state.roomId;
          const revision = viewingSettings?.revision;
          const settingsChanged = !resumed && revision && clientState.settingsRevision !== null
            && revision !== clientState.settingsRevision;
          if (resumed) {
            const messages = tick.segments.flatMap(section => section.entries)
              .filter(entry => entry.type === 'message' && Number.isSafeInteger(entry.messageId));
            for (let offset = 0; offset < messages.length; offset += 250) {
              const page = messages.slice(offset, offset + 250);
              const ids = page.map(entry => entry.messageId).join(',');
              const current = await request('/api/rooms/' + encodeURIComponent(nextRoomId) + '/messages?ids=' + ids);
              const names = new Map(current.messages.map(row => [row.id, row.senderName]));
              for (const entry of page) if (names.has(entry.messageId)) entry.senderName = names.get(entry.messageId);
            }
          }
          const showCornerGuide = tick.pairedCorners && !clientState.roomsWithCornerGuide.has(nextRoomId);
          const notices = [];
          if (settingsChanged) notices.push(describeViewingSettings(viewingSettings, true));
          if (showCornerGuide) notices.push('相同角标标出同一处，小窗取箭头后的时刻。');
          const feed = await buildViewingFeed({ tick }, {
            fetchFrame: (frame, { signal: frameSignal }) => readFrame(
              nextRoomId, frame.storyboardRef, frame.mediaTimeMs, 'storyboard', {
                signal: frameSignal
              }),
            signal,
            maxImageBytes: 1_572_864,
            imageBudgetBytes: IMAGE_BUDGET_BYTES,
            ...(manualChat && { maxImages: 16 }),
            openingText: notices.join('\n'),
            trackImageRefs: TRACK_IMAGE_REFS || manualChat
          });
          const playback = await request('/api/rooms/' + encodeURIComponent(nextRoomId) + '/playback-state',
            chatHeaders || resumed ? { headers: { ...chatHeaders,
              ...(resumed && { 'x-owc-notebook-after': String(clientState.cursors.notebookEventId ?? 0) }) } } : {});
          const room = playback.room;
          assertViewingPlayback(tick, room, nextRoomId);
          signal?.throwIfAborted();
  
          // No cursor crosses a queued, unsent entry. Commit the collected cursor only
          // when the packet has fully drained; its remainder contains references, not images.
          const previousEventCursor = clientState.cursors.notebookEventId;
          if (packet.resetContext) {
            clientState.frameSelections.clear();
            clientState.frameRoomId = null;
            clientState.cursors = { mediaMs: tick.range.fromMs,
              seekVersion: tick.playback.seekVersion, messageId: 0, observationSequence: 0 };
          }
          if (showCornerGuide) clientState.roomsWithCornerGuide.add(nextRoomId);
          clientState.roomId = nextRoomId;
          if (!feed.remainingTick) clientState.cursors = state.cursors;
          else if (state.cursors.skipRangeKey) clientState.cursors.skipRangeKey = state.cursors.skipRangeKey;
          else delete clientState.cursors.skipRangeKey;
          // A correction is delivered with the first text packet, independently of queued images.
          if (resumed && playback.notebookChanges?.length) {
            feed.mcpContent.unshift(notebookChangeNotice(playback.notebookChanges));
            feed.blockThroughMs?.unshift(null);
            feed.hasMaterial = true;
            for (const ref of feed.imageRefs ?? []) ref.index++;
          }
          const eventCursor = resumed ? (playback.notebookChanges?.at(-1)?.id ?? previousEventCursor) : state.cursors.notebookEventId;
          if (eventCursor !== undefined) clientState.cursors.notebookEventId = eventCursor;
          clientState.pendingAudioRanges = packet.pendingAudioRanges;
          clientState.deliveredAudioIds = new Set(packet.deliveredIds);
          for (const id of feed.deliveredAudioIds) clientState.deliveredAudioIds.add(id);
          clientState.pendingViewing = feed.remainingTick ? {
            ...packet, resetContext: false,
            ...(chatPageStart && { chatPageStart }),
            deliveredIds: new Set(clientState.deliveredAudioIds),
            collected: { ...collected, tick: feed.remainingTick }
          } : null;
          if (!resumed && revision) clientState.settingsRevision = revision;
          rememberDeliveredFrames(nextRoomId, feed.frameSelections);
          const progress = { roomId: nextRoomId, mediaMs: feed.deliveredThroughMs, seekVersion: tick.playback.seekVersion };
          return { mcpContent: feed.mcpContent,
            ...(clientState.bridgeRoomId ? { bridgeCursors: { ...clientState.cursors } } : {}),
            ...(feed.imageRefs?.length && { bridgeFrameRefs: feed.imageRefs }),
            ...((TRACK_IMAGE_REFS || manualChat) && feed.remainingTick && { bridgeMoreImagePages: true }),
            ...(TRACK_IMAGE_REFS && { bridgeHasMaterial: feed.hasMaterial }),
            ...((chatFeedToken || manualChat) && { viewerActualMs: tick.playback.timeMs,
              deliveryHorizonMs: feed.deliveredThroughMs, bridgeBlockThroughMs: feed.blockThroughMs }),
            ...(!tick.awaitingPreparation || tick.range.toMs > tick.range.fromMs
              ? { deliveredProgress: progress } : { viewingRoomId: nextRoomId }) };
        } catch (error) {
          if (['PLAYBACK_CHANGED', 'ROOM_UNAVAILABLE', 'RESOURCE_UNAVAILABLE', 'CHAT_FEED_UNAVAILABLE'].includes(error.code)) {
            if (chatPageStart && clientState.pendingViewing) {
              // The automatic bridge has not submitted any physical page of this logical
              // delivery. Re-read its data and notebook revisions from the pre-batch cursor.
              clientState.cursors = { ...chatPageStart, messageId: clientState.cursors.messageId };
            }
            clientState.pendingViewing = null;
            clientState.pendingAudioRanges = [];
            clientState.deliveredAudioIds.clear();
            clientState.frameSelections.clear();
          }
          throw error;
        } finally {
          clientState.tickInFlight = false;
        }
      }
    },
    {
      order: 13,
      definition: {
        name: 'cinema_inspect_frame',
        description: 'Re-read a delivered storyboard using a displayed film time in milliseconds. Use v3 viewing packages (recommended), which deliver finished storyboards including magnified detail crops in Full. quality:"hd" is only for un-upgraded legacy v2 packages that advertise an HD hint.',
        inputSchema: {
          type: 'object',
          properties: {
            atMs: { type: 'integer', minimum: 0 },
            quality: { type: 'string', enum: ['storyboard', 'hd'], default: 'storyboard' }
          },
          required: ['atMs'],
          additionalProperties: false
        }
      },
      async handler(args, { signal, request }) {
        return inspectFrameAtTime({
          atMs: args.atMs,
          quality: args.quality,
          signal,
          ...(args.storyboardRef !== undefined && args.roomId !== undefined
            ? { legacy: args } : {})
        });
      }
    },
    {
      order: 14,
      definition: {
        name: 'cinema_post_message',
        description: 'Share a comment, reaction, or reply in the active viewing room. Optionally pass interaction: popcorn, cola, or cheers for a snack/drink action. Messages are timestamped at the current playback position.',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', minLength: 1, maxLength: 800 },
            interaction: { type: 'string', enum: ['popcorn', 'cola', 'cheers'], description: 'Optional room interaction. Server supplies its display text; rejected when interactions are off.' }
          },
          required: ['content'],
          additionalProperties: false
        }
      },
      async handler(args, { signal, request }) {
        const content = requireString(args.content, 'content', { max: 800 });
        if (args.interaction !== undefined && !['popcorn', 'cola', 'cheers'].includes(args.interaction)) throw cinemaError('INVALID_ARGUMENT', 'Unknown interaction.');
        const senderIdentity = await bindSelectedProfile({ signal });
        return request('/api/ai/messages', {
          method: 'POST',
          body: JSON.stringify({
            senderIdentity,
            content,
            ...(args.interaction ? { interaction: args.interaction } : {})
          })
        });
      }
    }
  ];
}
