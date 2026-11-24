import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { formatFilmTime } from '../../../mcp/viewing/viewing-feed.mjs';
import { watchCinema } from '../../session.mjs';
import { openMcpClient } from '../../mcp-client.mjs';
import { describeDeliveryBlocks, materializeDelivery, nextDeliveryBatch, readPendingImage } from './delivery.mjs';
import { activityFields, CHAT_MANUAL_TIMEOUT_MS, chatToolGroup, createChatControlTools, isChatToolEnabled, validActivityRequest } from './tools.mjs';
import { renderViewingInstructions } from '../../instructions.mjs';
import { DEFAULT_INSTRUCTIONS, NOTEBOOK_GUIDANCE } from './instructions.mjs';

const CURSORS = 'open-watch-cinema/bridgeCursors';
const VIEWER_ACTUAL = 'open-watch-cinema/viewerActualMs';
const COOLDOWN_MS = 1000;
const CARD_LEASE_MS = 60000;
const RECEIPT_TIMEOUT_MS = 120000;
const READY_IMAGE_LIMIT = 16;
const UNKNOWN_RECEIPT = 'ChatGPT 未确认接收这批内容。可在原对话等回执，或停止卡片后在新对话开始。';

const textBlock = text => ({ type: 'text', text });
const rejected = message => Object.assign(new Error(message), { status: 409 });
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const submissionOf = ({ batchId, claimId, cardId, roomId, seconds }) => ({ batchId, claimId, cardId, roomId, seconds });

export { DEFAULT_INSTRUCTIONS } from './instructions.mjs';

export function createChatScreening({
  cinemaRoot, getRoom, getLatestViewerMessageId, getIntervalMs, getLookaheadMs = () => 0,
  getProfileId, getViewerName, getOpeningMessage, getSettings, onChange,
  readActivity,
  readCheckpoint = () => [], writeCheckpoint = () => {},
  watch = watchCinema, createControlTools = createChatControlTools, loadPendingImage = readPendingImage,
  openManualMcp = openMcpClient,
  now = () => performance.now(), wallClock = () => Date.now()
}) {
  let cinemaUrl;
  let card;
  let run;
  let failure;
  let lease;
  let receiptLimit;
  let cooldown;
  let shuttingDown = false;
  let controls;
  const closing = new Set();
  const connections = new Set();
  const cards = new Map();
  const manualConnections = new Map();
  const manualTails = new Set();
  const sessions = new Map(readCheckpoint().map(saved => [saved.sessionId, {
    ...saved,
    ...(saved.flight?.received && { lastSubmission: submissionOf(saved.flight) }),
    nextAt: saved.receiptAt === undefined
      ? -Infinity : now() + Math.max(0, COOLDOWN_MS - Math.max(0, wallClock() - saved.receiptAt))
  }]));

  function persist() {
    const roomId = getRoom()?.id;
    for (const [id, session] of sessions) {
      if (session.progress?.roomId !== roomId && (!session.flight || (session.flight.received
        && session.lastSubmission?.batchId === session.flight.batchId && session.nextAt <= now()))) {
        sessions.delete(id);
      }
    }
    writeCheckpoint([...sessions.values()].map(({ nextAt, ...saved }) => saved));
  }

  function stopRun() {
    if (!run) return;
    const previous = run;
    run = null;
    previous.controller.abort();
    closing.add(previous.closed);
    void previous.closed.then(() => closing.delete(previous.closed));
    onChange();
  }

  function pause() {
    clearTimeout(lease);
    clearTimeout(receiptLimit);
    clearTimeout(cooldown);
    if (card) card.started = false;
    stopControls();
    stopRun();
    onChange();
  }

  function stopControls() {
    controls?.controller.abort();
    controls = null;
  }

  function controlTools() {
    if (!controls) {
      const controller = new AbortController();
      const connectionId = randomUUID();
      connections.add(connectionId);
      controls = { controller, call: createControlTools({
        cinemaUrl, signal: controller.signal, connectionId,
        getProfileId: () => run?.profileId ?? getProfileId()
      }) };
    }
    return controls.call;
  }

  function refreshLease(duration = CARD_LEASE_MS) {
    clearTimeout(lease);
    const binding = card;
    lease = setTimeout(() => {
      if (card !== binding || !binding?.started) return;
      const session = sessions.get(binding.sessionId);
      const active = session?.flight;
      const room = getRoom();
      if (active && !active.received && active.cardId === binding.id
        && active.roomId === room?.id && active.seekVersion === room.seekVersion) {
        const remaining = receiptTimeLeft(active);
        if (remaining > 0) {
          refreshLease(remaining);
          return;
        }
        expireReceipt(session, active);
      }
      pause();
    }, duration);
    lease.unref?.();
  }

  function sessionFor(sessionId) {
    if (!sessions.has(sessionId)) sessions.set(sessionId, { sessionId, nextAt: -Infinity });
    return sessions.get(sessionId);
  }

  function reconcile() {
    const room = getRoom();
    const settings = getSettings();
    for (const connection of manualConnections.values()) {
      if (!settings.enableManual || connection.roomId !== room?.id || connection.seekVersion !== room.seekVersion) {
        closeManual(connection);
      }
    }
    let discarded = false;
    for (const { progress, flight } of sessions.values()) {
      if (progress && !flight && progress.roomId !== room?.id) discarded = true;
      if (progress?.pendingDelivery && (progress.roomId !== room?.id || progress.pendingDelivery.seekVersion !== room.seekVersion)) {
        delete progress.pendingDelivery;
        discarded = true;
      }
      if (progress?.priorityDelivery && (progress.roomId !== room?.id || progress.priorityDelivery.seekVersion !== room.seekVersion)) {
        delete progress.priorityDelivery;
        discarded = true;
      }
    }
    if (discarded) persist();
    if (!settings.enabled || !settings.enableControl || !card?.started) stopControls();
    if (failure && (failure.roomId !== room?.id || (failure.needsProfile && getProfileId()))) failure = null;
    if (run && (!settings.enabled || !card?.started || run.roomId !== room?.id ||
      run.seekVersion !== room.seekVersion || failure)) stopRun();
    if (!cinemaUrl || shuttingDown || run || !settings.enabled || !room || !card?.started || failure) return;
    const session = sessionFor(card.sessionId);
    const progress = session.progress?.roomId === room.id ? session.progress : null;
    const profileId = progress?.profileId ?? getProfileId();
    if (!profileId) {
      failure = { roomId: room.id, needsProfile: true, message: '请先在「名字与档案」选择观影档案。' };
      onChange();
      return;
    }
    session.progress = progress ?? { roomId: room.id, profileId, introDelivered: false };
    const current = run = {
      roomId: room.id, profileId, connectionId: randomUUID(), connectedAt: Date.now(), session,
      pendingAtStart: session.flight && !session.flight.received ? session.flight.batchId : null,
      seekVersion: room.seekVersion, controller: new AbortController(), queue: [], priorityQueue: [],
      readyImages: new Map(), feedToken: randomUUID()
    };
    connections.add(current.connectionId);
    current.closed = watch({
      cinemaUrl, cinemaRoot, roomId: room.id, profileId, connectionId: current.connectionId,
      resumeCursors: sourceCursors(session.progress),
      signal: current.controller.signal, enableHistory: true, trackImageRefs: true, drainPaused: true,
      feedToken: current.feedToken,
      retainTickResult: result => ({ ...result, content: describeDeliveryBlocks(result, (frame, image) => {
        if (current.readyImages.size < READY_IMAGE_LIMIT) current.readyImages.set(frame, image);
      }) }),
      discardTickResults: results => {
        for (const result of results) for (const frame of result.content) current.readyImages.delete(frame);
      },
      getIntervalMs,
      canReadInterval: () => !current.queue.length,
      onConnect(mcp) {
        if (run !== current) return;
        current.mcp = mcp;
        onChange();
      },
      onPlaybackState(state) {
        if (run !== current) return;
        current.playback = state;
        if (!session.progress.viewingStart) {
          session.progress.viewingStart = { seekVersion: state.seekVersion, mediaMs: state.playheadMs };
          persist();
        }
        if (state.seekVersion !== current.seekVersion) reconcile();
      },
      onTick(result, { state, results, includesPlayback, reason, messagesOnly }) {
        if (run !== current || current.seekVersion !== state.seekVersion) return;
        if (result.isError) {
          const setup = result.content.some(block => block.type === 'text' && block.text.includes('AI_PACKAGE_INCOMPLETE'));
          throw new Error(setup ? '请先为这部影片准备观影包，然后重新开始 Listener。' : '影院暂时无法提供这段观影内容。');
        }
        const queue = messagesOnly ? current.priorityQueue : current.queue;
        queue.push({
          blocks: result.content, includesPlayback, reason, state,
          viewerActualMs: result._meta?.[VIEWER_ACTUAL] ?? state.playheadMs,
          cursors: results.findLast(item => item._meta?.[CURSORS])?._meta[CURSORS]
        });
      }
    }).catch(error => {
      if (run === current) failure = { roomId: current.roomId, message: error.message };
    }).finally(() => {
      if (run !== current) return;
      run = null;
      onChange();
    });
    refreshReceiptLimit(session);
    refreshCooldown(session);
    onChange();
  }

  function sourceCursors(progress) {
    const cursor = progress.pendingDelivery?.cursors ?? progress.cursors ?? progress.viewingStart;
    const messageId = Math.max(cursor?.messageId ?? 0,
      progress.viewerMessageId ?? 0, progress.priorityDelivery?.cursors?.messageId ?? 0);
    return cursor || messageId ? { ...cursor, ...(messageId && { messageId }) } : undefined;
  }

  function closeManual(connection) {
    manualConnections.delete(connection.sessionId);
    clearTimeout(connection.idle);
    connection.controller.abort();
    const closed = connection.mcp.close();
    closing.add(closed);
    void closed.then(() => closing.delete(closed), () => closing.delete(closed));
  }

  async function manualTool(request, signal) {
    const room = getRoom();
    if (!cinemaUrl || shuttingDown || !room) throw rejected('请先在本机影院开启观影房间。');
    const session = sessionFor(request.sessionId);
    const progress = session.progress?.roomId === room.id ? session.progress : null;
    const profileId = progress?.profileId ?? getProfileId();
    if (!profileId) throw rejected('请先在「名字与档案」选择观影档案。');
    const tick = request.tool === 'open_watch_cinema_tick';
    if (tick && !session.flight?.received && session.flight?.roomId === room.id
      && session.flight.seekVersion === room.seekVersion) throw rejected(UNKNOWN_RECEIPT);
    let connection = manualConnections.get(request.sessionId);
    if (connection?.busy || manualTails.has(request.sessionId)) throw rejected('本对话的观影工具正在处理，请稍后再试。');
    const controller = connection?.controller ?? new AbortController();
    if (!connection) {
      if (manualConnections.size >= 8) throw rejected('影院当前有多条手动观影连接，请稍后再试。');
      connection = { sessionId: request.sessionId, roomId: room.id, seekVersion: room.seekVersion, controller };
    }
    const active = AbortSignal.any([controller.signal, AbortSignal.timeout(CHAT_MANUAL_TIMEOUT_MS), ...(signal ? [signal] : [])]);
    if (tick && progress) {
      const pending = progress.priorityDelivery?.position > 0 ? progress.priorityDelivery
        : progress.pendingDelivery?.position > 0 ? progress.pendingDelivery : null;
      if (pending) {
        if (connection.mcp) closeManual(connection);
        manualTails.add(request.sessionId);
        try {
          const tailSignal = AbortSignal.any([AbortSignal.timeout(CHAT_MANUAL_TIMEOUT_MS), ...(signal ? [signal] : [])]);
          return await deliverManualTail(session, pending, room, tailSignal);
        }
        finally { manualTails.delete(request.sessionId); }
      }
    }
    if (tick && progress?.cursors?.seekVersion === room.seekVersion && progress.cursors.mediaMs > room.lastPositionMs) {
      throw rejected('本对话已看过目前的播放位置。影片继续播放到已读位置后，可以再读取新的片段。');
    }
    if (!connection.mcp) {
      const resumeCursors = progress && sourceCursors({ ...progress, pendingDelivery: null, priorityDelivery: null });
      connection.mcp = openManualMcp({
        script: resolve(cinemaRoot, 'mcp', 'server.mjs'), cinemaUrl, roomId: room.id, profileId,
        connectionId: randomUUID(), resumeCursors,
        enableHistory: true, manualChat: true,
        onFailure: () => { if (manualConnections.get(request.sessionId) === connection) closeManual(connection); }
      });
      manualConnections.set(request.sessionId, connection);
    }
    clearTimeout(connection.idle);
    connection.busy = true;
    try {
      if (!connection.initialized) {
        await connection.mcp.initialize(active);
        connection.initialized = true;
      }
      const call = () => connection.mcp.callTool(request.tool, request.arguments, active, { expectedSeekVersion: room.seekVersion });
      const packet = await call();
      let tail;
      if (tick && !packet.isError && packet._meta?.['open-watch-cinema/bridgeMoreImagePages']) {
        const blocks = [];
        let page;
        do {
          page = await call();
          if (page.isError) throw rejected('影院暂时无法准备剩余分镜，请重新读取。');
          blocks.push(...describeDeliveryBlocks(page));
        } while (page._meta?.['open-watch-cinema/bridgeMoreImagePages']);
        tail = { id: randomUUID(), seekVersion: room.seekVersion, includesPlayback: true,
          position: packet.content.length, blocks, cursors: page._meta?.[CURSORS],
          viewerActualMs: page._meta?.[VIEWER_ACTUAL] };
      }
      active.throwIfAborted();
      const latest = getRoom();
      if (latest?.id !== room.id || latest.seekVersion !== room.seekVersion) throw rejected('观影位置已变化，请重新调用。');
      if (!packet.isError) {
        const updated = { ...(progress ?? { roomId: room.id, profileId, introDelivered: false }) };
        const cursors = packet._meta?.[CURSORS];
        if (tick && cursors) {
          if (updated.pendingDelivery?.position === 0) delete updated.pendingDelivery;
          if (updated.priorityDelivery?.position === 0) delete updated.priorityDelivery;
          updated.cursors = cursors;
          if (tail) updated.pendingDelivery = tail;
        }
        const previous = session.progress;
        session.progress = updated;
        try { persist(); }
        catch (error) {
          session.progress = previous;
          throw error;
        }
      }
      return { content: packet.content, ...(packet.isError && { isError: true }) };
    } catch (error) {
      if (manualConnections.get(request.sessionId) === connection) closeManual(connection);
      throw error;
    } finally {
      connection.busy = false;
      if (manualConnections.get(request.sessionId) === connection) {
        connection.idle = setTimeout(() => closeManual(connection), CARD_LEASE_MS);
        connection.idle.unref?.();
      }
    }
  }

  async function deliverManualTail(session, pending, room, signal) {
    const batch = nextDeliveryBatch(pending.blocks, room.lastPositionMs);
    if (!batch.count) throw rejected('下一段已准备的资料尚未播放，请继续播放后再调用。');
    const content = await materializeDelivery(batch.chunk, frame => loadPendingImage({
      cinemaUrl, roomId: room.id, seekVersion: room.seekVersion, frame, signal
    }));
    signal.throwIfAborted();
    const latest = getRoom();
    if (shuttingDown || !getSettings().enableManual || latest?.id !== room.id || latest.seekVersion !== room.seekVersion
      || nextDeliveryBatch(pending.blocks, latest.lastPositionMs).count < batch.count) {
      throw rejected('观影位置已变化，请重新调用。');
    }
    const previous = { ...session.progress };
    try {
      const priority = session.progress.priorityDelivery === pending;
      recordDelivery(session, {
        roomId: room.id, seekVersion: room.seekVersion, priority,
        deliveryId: pending.id, deliveryEnd: pending.position + batch.count,
        ...(batch.done && { cursors: pending.cursors })
      });
      persist();
    } catch (error) {
      session.progress = previous;
      throw error;
    }
    return { content };
  }

  function ensureSeek(current, seekVersion) {
    const room = getRoom();
    return run === current && room?.id === current.roomId && room.seekVersion === seekVersion;
  }

  function status() {
    if (!getSettings().enabled) return 'disabled';
    if (!card?.started) return 'waiting_card';
    if (!getRoom()) return 'waiting_room';
    if (failure) return failure.receipt ? 'unconfirmed' : 'error';
    if (run?.session.flight?.unconfirmed && !run.session.flight.received) return 'unconfirmed';
    if (run?.session.flight && !run.session.flight.received) return 'waiting_receipt';
    if (run && now() < run.session.nextAt) return 'cooldown';
    return run?.mcp ? 'watching' : 'connecting';
  }

  function connection() {
    const room = getRoom();
    if (!run || run.roomId !== room?.id) return null;
    const { connectionId, profileId, connectedAt, roomId } = run;
    return { connectionId, profileId, connectedAt, roomId, online: Boolean(run.mcp),
      connecting: !run.mcp, paused: room.playbackState === 'paused' };
  }

  function canClaim(current) {
    if (!current?.mcp || !ensureSeek(current, current.seekVersion)
      || now() < current.session.nextAt || (current.session.flight && !current.session.flight.received)) return false;
    return Boolean(readyLane(current));
  }

  function visibleThrough() {
    const room = getRoom();
    return room.lastPositionMs + (room.playbackState === 'playing' ? getLookaheadMs() : 0);
  }

  function readyLane(current) {
    const progress = current.session.progress;
    const priority = progress.priorityDelivery || current.priorityQueue.length > 0;
    if (progress.priorityDelivery) return 'priority';
    const latestViewerMessageId = getLatestViewerMessageId();
    const last = priority ? current.priorityQueue.at(-1) : current.queue.at(-1);
    const readMessageId = last?.cursors?.messageId ?? (priority ? last?.state.latestViewerMessageId : 0);
    const coveredMessageId = Math.max(readMessageId ?? 0, progress.viewerMessageId ?? 0,
      progress.cursors?.messageId ?? 0, progress.pendingDelivery?.cursors?.messageId ?? 0);
    if (coveredMessageId < latestViewerMessageId) return null;
    if (priority) return 'priority';
    const blocks = progress.pendingDelivery?.blocks ?? current.queue[0]?.blocks;
    return blocks && nextDeliveryBatch(blocks, visibleThrough()).count > 0 ? 'film' : null;
  }

  function poll(binding) {
    const started = card === binding && binding.started;
    const current = started ? run : null;
    const session = sessions.get(binding.sessionId);
    const ready = !current?.preparing && canClaim(current);
    if (ready) current.batchId ??= randomUUID();
    return {
      state: ready ? 'ready' : started && session?.flight && !session.flight.received ? 'pending' : current ? 'watching' : 'idle',
      ...(ready && { batchId: current.batchId }),
      started,
      roomOpen: Boolean(getRoom()),
      status: started || !getSettings().enabled ? status() : 'waiting_card',
      reason: started ? error() : null,
      lastSubmittedSeconds: session?.lastSubmission?.roomId === getRoom()?.id ? session?.lastSubmission?.seconds ?? null : null
    };
  }

  function error() {
    if (failure) return failure.message;
    if (run?.session.flight?.unconfirmed && !run.session.flight.received) {
      return UNKNOWN_RECEIPT;
    }
    return null;
  }

  function refreshReceiptLimit(session) {
    clearTimeout(receiptLimit);
    const active = session.flight;
    if (!active || active.received || card?.sessionId !== session.sessionId || !card.started || !run) return;
    receiptLimit = setTimeout(() => expireReceipt(session, active), Math.max(0, receiptTimeLeft(active)));
    receiptLimit.unref?.();
  }

  function receiptTimeLeft(active) {
    return RECEIPT_TIMEOUT_MS - (wallClock() - active.claimedAt);
  }

  function expireReceipt(session, active) {
    if (session.flight !== active || active.received || !run || card?.sessionId !== session.sessionId) return;
    active.unconfirmed = true;
    if (run.roomId === active.roomId) {
      failure = { roomId: run.roomId, receipt: true,
        message: '等待 ChatGPT 回执超时。可在原对话等回执，或停止卡片后在新对话开始。' };
      stopRun();
    }
    onChange();
  }

  function refreshCooldown(session) {
    clearTimeout(cooldown);
    const remaining = session.nextAt - now();
    if (remaining <= 0) return;
    cooldown = setTimeout(onChange, Math.ceil(remaining));
    cooldown.unref?.();
  }

  async function result(request, binding, signal) {
    const { batchId, claimId } = request;
    if (!validId(claimId) || !validId(batchId)) throw new TypeError('Invalid batch claim.');
    const current = run;
    if (card !== binding || !binding.started || current?.batchId !== batchId ||
      !canClaim(current) || current.preparing) {
      throw rejected('The cinema batch is no longer available.');
    }
    // Take a snapshot without draining the queue so a viewer message arriving during
    // the notebook lookup can join this delivery before the claim becomes visible.
    current.preparing = true;
    const { session, seekVersion, roomId } = current;
    const claimSignal = signal ? AbortSignal.any([signal, current.controller.signal]) : current.controller.signal;
    let priority = readyLane(current) === 'priority';
    let pendingKey = priority ? 'priorityDelivery' : 'pendingDelivery';
    let queue = priority ? current.priorityQueue : current.queue;
    let pending = session.progress[pendingKey];
    try {
      let delivery = pending ?? await prepareDelivery(current, binding, queue, priority);
      if (pending && pending.projectInstructions === undefined) {
        // A manual tool return has a durable film tail but no automatic onboarding.
        const prepared = await prepareDelivery(current, binding, [pending], priority);
        delivery = { ...prepared, position: pending.position };
      }
      let joinedViewerPackets = 0;
      if (priority && !pending) {
        const attached = await attachPreparedFilm(current, binding, delivery);
        if (attached) {
          joinedViewerPackets = delivery.packetCount;
          delivery = attached;
          priority = false;
          pendingKey = 'pendingDelivery';
          queue = current.queue;
          pending = session.progress[pendingKey];
        }
      }
      const batch = nextDeliveryBatch(delivery.blocks, visibleThrough());
      if (!batch.count) throw rejected('The cinema batch expired before submission.');
      const content = await materializeDelivery(batch.chunk, frame => current.readyImages.get(frame) ??
        loadPendingImage({ cinemaUrl, roomId, seekVersion, frame, feedToken: current.feedToken,
          signal: claimSignal }));
      claimSignal.throwIfAborted();
      if (!ensureSeek(current, seekVersion) || card !== binding || !binding.started
        || nextDeliveryBatch(delivery.blocks, visibleThrough()).count < batch.count) {
        throw rejected('The cinema batch expired before submission.');
      }
      const note = delivery.includesPlayback && pausedCatchUpNotice(current, batch.done);
      const defaultGuidance = delivery.notebookGuidanceInInstructions && delivery.position === 0;
      const priorInstructions = session.progress.instructionsDelivered ?? session.progress.introDelivered;
      const guidanceDue = !session.progress.notebookGuidanceDelivered
        && (defaultGuidance || (priorInstructions && getSettings().instructions == null));
      const context = [
        note?.text || (getRoom().playbackState === 'paused' ? '交付时影片已暂停。' : ''),
        guidanceDue && !defaultGuidance ? renderViewingInstructions(NOTEBOOK_GUIDANCE, getViewerName()) : ''
      ].filter(Boolean).join('\n');
      if (context) content.unshift(textBlock(context));
      const lastShown = batch.chunk.findLast(block => Number.isFinite(block.throughMs))?.throughMs;
      const mediaMs = priority ? delivery.viewerActualMs : batch.done ? delivery.cursors?.mediaMs : lastShown;
      const seconds = Number.isFinite(mediaMs) ? mediaMs / 1000 : null;
      const active = { batchId, claimId, cardId: binding.id, seekVersion, roomId,
        projectInstructions: delivery.projectInstructions, intro: delivery.intro, seconds, priority,
        viewerActualMs: delivery.viewerActualMs,
        ...(note && { pauseNoticeKey: note.key }),
        ...(guidanceDue && { notebookGuidance: true }),
        deliveryId: delivery.id, deliveryEnd: delivery.position + batch.count,
        ...(batch.done && { cursors: delivery.cursors }),
        claimedAt: wallClock(), received: false };
      const previous = session.flight;
      session.flight = active;
      session.progress[pendingKey] = delivery;
      try {
        persist();
      } catch (error) {
        session.flight = previous;
        if (pending) session.progress[pendingKey] = pending;
        else delete session.progress[pendingKey];
        throw error;
      }
      if (!pending) {
        queue.splice(0, delivery.packetCount);
        if (joinedViewerPackets) current.priorityQueue.splice(0, joinedViewerPackets);
        current.mcp.wake?.();
      }
      current.batchId = null;
      refreshReceiptLimit(session);
      onChange();
      return { content, _meta: { 'open-watch-cinema/filmSeconds': seconds } };
    } finally {
      current.preparing = false;
    }
  }

  async function attachPreparedFilm(current, binding, viewer) {
    const { progress } = current.session;
    const room = getRoom();
    if (progress.pendingDelivery || !current.queue.length || !room
      || (!progress.introDelivered && room.resumeFromMs > 0)) return null;
    const material = current.queue.flatMap(packet => packet.blocks);
    if (!nextDeliveryBatch(material, room.lastPositionMs).done
      || material.some(frame => frame.type === 'image' && !current.readyImages.has(frame))) return null;
    const film = await prepareDelivery(current, binding, current.queue, false, !viewer.projectInstructions);
    const blocks = viewer.blocks.concat(film.blocks);
    if (!nextDeliveryBatch(blocks, getRoom()?.lastPositionMs ?? -1).done) return null;
    const messageId = Math.max(film.cursors?.messageId ?? 0, viewer.cursors?.messageId ?? 0);
    return { ...film, blocks, viewerActualMs: viewer.viewerActualMs,
      projectInstructions: viewer.projectInstructions || film.projectInstructions,
      notebookGuidanceInInstructions: viewer.notebookGuidanceInInstructions || film.notebookGuidanceInInstructions,
      cursors: { ...film.cursors, messageId } };
  }

  function pausedCatchUpNotice(current, final) {
    const room = getRoom();
    if (room.playbackState !== 'paused') return null;
    const progress = current.session.progress;
    const playback = current.playback?.chatPlayback;
    if (playback?.throughMs === null) return null;
    const cursor = progress.cursors?.seekVersion === room.seekVersion ? progress.cursors.mediaMs : null;
    const through = room.lastPositionMs;
    const subscribedAt = progress.viewingStart?.seekVersion === room.seekVersion ? progress.viewingStart.mediaMs : null;
    const from = progress.lastDeliveredMedia?.seekVersion === room.seekVersion ? progress.lastDeliveredMedia.ms
      : cursor ?? subscribedAt ?? playback?.fromMs ?? room.resumeFromMs ?? 0;
    const key = JSON.stringify([room.seekVersion, through, playback?.pauseVersion ?? null]);
    if (progress.pauseNoticeKey === key || (final && through - from < getIntervalMs())) return null;
    const viewer = getViewerName() || '观众';
    return { key, text: '交付时，' + viewer + ' 已暂停在 ' + formatFilmTime(through)
      + '，正在等你跟上。接下来是此前已播放的观影资料。' };
  }

  async function prepareDelivery(current, binding, queue, priority, includeProjectInstructions = true) {
    const { session, seekVersion, roomId } = current;
    const room = getRoom();
    const projectInstructions = includeProjectInstructions && !(session.progress.instructionsDelivered ?? session.progress.introDelivered)
      && !(priority && session.progress.pendingDelivery?.projectInstructions);
    const intro = !priority && !session.progress.introDelivered && queue.some(packet => packet.includesPlayback);
    const introduction = [];
    const instructions = projectInstructions ? getSettings().instructions ?? DEFAULT_INSTRUCTIONS : '';
    if (instructions.trim()) introduction.push(textBlock('观影项目指令\n' + renderViewingInstructions(instructions, getViewerName())));
    if (intro) {
      const opening = getOpeningMessage(roomId);
      if (opening?.trim()) {
        const viewerName = getViewerName();
        introduction.push(textBlock((viewerName ? viewerName + '的开场白' : '开场白') + '\n' + opening));
      }
      if (room.resumeFromMs > 0) {
        const notebook = await current.mcp.callTool('cinema_notebook', { action: 'read' }, { expectedSeekVersion: seekVersion });
        if (!ensureSeek(current, seekVersion)) throw rejected('The cinema batch expired before submission.');
        if (notebook.isError) throw new Error('影院暂时无法读取继续观看需要的影片手记。');
        introduction.push(textBlock('这是同一部影片的新放映房间，从上次结束的位置 ' +
          formatFilmTime(room.resumeFromMs) + ' 接着看。\n影片共用手记'), ...describeDeliveryBlocks(notebook));
      }
    }
    if (!ensureSeek(current, seekVersion) || card !== binding || !binding.started
      || (!priority && !intro && !session.progress.introDelivered && queue.some(packet => packet.includesPlayback))) {
      throw rejected('The cinema batch changed before submission.');
    }
    return {
      id: randomUUID(), position: 0, seekVersion, intro, projectInstructions, packetCount: queue.length,
      ...(instructions === DEFAULT_INSTRUCTIONS && { notebookGuidanceInInstructions: true }),
      includesPlayback: queue.some(packet => packet.includesPlayback),
      viewerActualMs: queue.at(-1)?.viewerActualMs,
      cursors: queue.findLast(packet => packet.cursors)?.cursors,
      blocks: introduction.concat(queue.flatMap(packet => packet.blocks))
    };
  }

  function recordDelivery(session, active) {
    if (session.progress?.roomId === active.roomId) {
      const room = getRoom();
      const pendingKey = active.priority ? 'priorityDelivery' : 'pendingDelivery';
      const pending = session.progress[pendingKey];
      if (pending && pending.id === active.deliveryId && active.deliveryEnd > pending.position
        && room?.id === active.roomId && room.seekVersion === active.seekVersion) {
        const consumed = active.deliveryEnd - pending.position;
        if (run?.session === session) {
          for (const frame of pending.blocks.slice(0, consumed)) run.readyImages.delete(frame);
        }
        const blocks = pending.blocks.slice(consumed);
        if (blocks.length) {
          session.progress[pendingKey] = { ...pending, blocks, position: active.deliveryEnd };
        } else {
          delete session.progress[pendingKey];
          if (run?.session === session) run.mcp?.wake?.();
        }
      }
      if (active.priority && active.cursors) {
        session.progress.viewerMessageId = Math.max(session.progress.viewerMessageId ?? 0, active.cursors.messageId ?? 0);
      }
      if (!active.priority && active.cursors && room?.id === active.roomId) {
        if (room.seekVersion === active.seekVersion) session.progress.cursors = active.cursors;
        else {
          // Room messages remain valid across seeks. Film cursor and images do not.
          const previous = session.progress.cursors ?? {};
          session.progress.cursors = { ...previous,
            messageId: Math.max(previous.messageId ?? 0, active.cursors.messageId ?? 0),
            notebookEventId: Math.max(previous.notebookEventId ?? 0, active.cursors.notebookEventId ?? 0) };
        }
      }
      if (room?.id === active.roomId && room.seekVersion === active.seekVersion) {
        if (active.pauseNoticeKey) session.progress.pauseNoticeKey = active.pauseNoticeKey;
        if (!active.priority && Number.isFinite(active.seconds)) session.progress.lastDeliveredMedia = {
          seekVersion: active.seekVersion, ms: active.seconds * 1000
        };
        if (Number.isFinite(active.viewerActualMs)) session.progress.lastViewerActualMs = active.viewerActualMs;
      }
      if (active.projectInstructions ?? active.intro) session.progress.instructionsDelivered = true;
      if (active.notebookGuidance) session.progress.notebookGuidanceDelivered = true;
      if (active.intro) session.progress.introDelivered = true;
    }
  }

  function acknowledge(request) {
    const session = sessions.get(request.sessionId);
    const active = session?.flight;
    if (!active) throw rejected('No pending receipt for this ChatGPT conversation.');
    if (active.received) return { ok: true, duplicate: true };
    const previous = { nextAt: session.nextAt, receiptAt: session.receiptAt,
      progress: { ...session.progress }, lastSubmission: session.lastSubmission };
    try {
      active.received = true;
      session.receiptAt = wallClock();
      session.nextAt = now() + COOLDOWN_MS;
      session.lastSubmission = submissionOf(active);
      recordDelivery(session, active);
      persist();
    } catch (error) {
      active.received = false;
      Object.assign(session, previous);
      throw error;
    }
    if (card?.sessionId === request.sessionId) {
      clearTimeout(receiptLimit);
      const room = getRoom();
      if (card.started && active.cardId === card.id && active.roomId === room?.id
        && active.seekVersion === room.seekVersion) refreshLease();
      if (run?.pendingAtStart === active.batchId) stopRun();
      if (failure?.receipt) {
        failure = null;
      }
      reconcile();
      refreshCooldown(session);
      onChange();
    }
    return { ok: true };
  }

  function finishSubmission(request, binding) {
    const session = sessions.get(binding.sessionId);
    const active = session?.flight;
    if (active?.batchId !== request.batchId || active?.claimId !== request.claimId || active?.cardId !== binding.id) {
      if (request.action === 'submitted' && session?.lastSubmission?.batchId === request.batchId
        && session.lastSubmission.claimId === request.claimId && session.lastSubmission.cardId === binding.id) return poll(binding);
      throw rejected('The cinema submission expired.');
    }
    if (request.action === 'submitted') {
      if (!active.deliveryId) recordDelivery(session, active);
      session.lastSubmission = submissionOf(active);
      persist();
    } else if (!active.received && session.lastSubmission?.batchId === active.batchId) {
      throw rejected('The cinema submission was already accepted.');
    } else if (!active.received) {
      const confirmedUnsent = request.action === 'abandon' || request.definitive === true;
      if (confirmedUnsent) {
        session.flight = null;
        persist();
        if (card?.sessionId === binding.sessionId) {
          clearTimeout(receiptLimit);
          if (failure?.receipt) failure = null;
          reconcile();
        }
      } else {
        active.unconfirmed = true;
        persist();
        onChange();
      }
    }
    return poll(binding);
  }

  async function command(request, { signal } = {}) {
    if (request?.actor === 'service' && request.action === 'tool-settings') {
      const { enabled, enableManual, enableHistory, enableControl } = getSettings();
      return { enabled: enabled === true, enableManual: enableManual === true,
        enableHistory: enableHistory === true, enableControl: enableControl === true };
    }
    if (!validId(request?.sessionId) || !['app', 'model'].includes(request.actor)) {
      throw new TypeError('A bound ChatGPT conversation is required.');
    }
    const { sessionId, cardId, action } = request;
    if (request.actor === 'model') {
      if (action === 'ack') return acknowledge(request);
      const current = run;
      const active = current?.session.flight;
      if (action !== 'tool' || !chatToolGroup(request.tool)) throw new TypeError('Unknown ChatGPT tool.');
      const settings = getSettings();
      if (!isChatToolEnabled(request.tool, settings)) throw rejected('此工具组已在本机影院设置中关闭。');
      if (chatToolGroup(request.tool) === 'control') {
        if (!cinemaUrl || !settings.enabled || !card?.started || sessionId !== card.sessionId) {
          throw rejected('请先在本对话的影院卡片上开始观影。');
        }
        return controlTools()(request.tool, request.arguments, signal);
      }
      const automatic = card?.started && card.sessionId === sessionId;
      if (automatic && request.tool === 'open_watch_cinema_tick') {
        return { content: [textBlock('本对话已开启自动跟片。请等待影院卡片送达下一批，或先在卡片停止跟片。')] };
      }
      if (!automatic && settings.enableManual) return manualTool(request, signal);
      if (card?.sessionId !== sessionId || !current?.mcp || !active || active.received
        || active.roomId !== current.roomId || !ensureSeek(current, active.seekVersion)) {
        throw rejected('The viewing turn is no longer current.');
      }
      return current.mcp.callTool(request.tool, request.arguments, { expectedSeekVersion: active.seekVersion });
    }
    if (!validId(cardId)) throw new TypeError('A ChatGPT card ID is required.');
    let binding = cards.get(cardId);
    if (action === 'open' && !binding) {
      binding = { id: cardId, sessionId, started: false };
      cards.set(cardId, binding);
    }
    if (binding?.sessionId !== sessionId) throw rejected('This ChatGPT card is no longer active.');
    if (['submitted', 'failed', 'abandon'].includes(action)) return finishSubmission(request, binding);
    if (binding.replaced) throw rejected('This ChatGPT card was replaced.');
    if (Object.hasOwn(activityFields, action)) {
      if (!validActivityRequest(request)) throw new TypeError('无效的影院活动查询。');
      const data = readActivity(request);
      if (!data) throw rejected('这次影院运行中找不到这条记录。');
      return data;
    }
    if (action === 'open') return poll(binding);
    if (action === 'start') {
      if (!getSettings().enabled) throw rejected('Enable ChatGPT continuous viewing in the local cinema first.');
      const manual = manualConnections.get(sessionId);
      if (manual?.busy || manualTails.has(sessionId)) throw rejected('请等本对话的手动观影工具执行完再开始跟片。');
      if (card !== binding) {
        if (card?.started && card.sessionId !== sessionId) throw rejected('Stop the Listener in the active ChatGPT conversation first.');
        if (card) {
          pause();
          card.replaced = true;
        }
        if (card?.sessionId !== sessionId) failure = null;
        card = binding;
      }
      const active = sessionFor(sessionId).flight;
      if (active?.unconfirmed && !active.received) {
        throw rejected(failure?.message ?? UNKNOWN_RECEIPT);
      }
      if (manual) closeManual(manual);
      binding.started = true;
      failure = null;
      refreshLease();
      reconcile();
      onChange();
      return poll(binding);
    }
    if (action === 'stop') {
      if (card === binding) pause();
      return poll(binding);
    }
    if (card === binding && binding.started) refreshLease();
    if (action === 'poll') {
      if (card === binding) reconcile();
      const state = poll(binding);
      if (request.claimId === undefined) return state;
      if (!validId(request.claimId)) throw new TypeError('Invalid batch claim.');
      if (state.state !== 'ready') return { state };
      const claimId = request.claimId;
      run.batchId = claimId;
      const packet = await result({ batchId: claimId, claimId }, binding, signal);
      return { state: poll(binding), packet };
    }
    if (action === 'result') return result(request, binding, signal);
    throw new TypeError('Unknown ChatGPT card action.');
  }

  return {
    command, status, connection, reconcile, pause, isManaged: id => connections.has(id),
    authorizeFeed: (token, roomId) => Boolean(run && run.roomId === roomId && token === run.feedToken
      && ensureSeek(run, run.seekVersion)),
    error,
    start(url) { cinemaUrl = url; reconcile(); },
    close() {
      shuttingDown = true;
      pause();
      for (const connection of manualConnections.values()) closeManual(connection);
      return Promise.all(closing);
    }
  };
}
