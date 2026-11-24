import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createChatScreening, DEFAULT_INSTRUCTIONS } from '../../watch-bridge/adapters/chat/screening.mjs';

const cursorMeta = 'open-watch-cinema/bridgeCursors';
const block = text => ({ type: 'text', text });
const pausedAtDelivery = block('交付时影片已暂停。');
const defaultPrompt = (viewerName = '房间用户') => block('观影项目指令\n' + DEFAULT_INSTRUCTIONS.replaceAll('{{viewerName}}', viewerName));
const picture = { type: 'image', mimeType: 'image/jpeg', data: '/9j/2Q==' };

function cinema(t, { createControlTools, openManualMcp, checkpoint = [], loadPendingImage = async () => picture } = {}) {
  let time = 0;
  let room = null;
  let viewerMessage = 0;
  let viewerName = '房间用户';
  let opening = 'opening message';
  let saved = checkpoint;
  const watchers = [];
  const state = { enabled: true, instructions: 'project instructions' };
  const make = () => {
    const screening = createChatScreening({
      cinemaRoot: '/cinema', getRoom: () => room, getSettings: () => state, getLatestViewerMessageId: () => viewerMessage,
      getIntervalMs: () => 6000, getLookaheadMs: () => state.lookaheadMs ?? 0,
      getProfileId: () => 'profile', getViewerName: () => viewerName, getOpeningMessage: () => opening,
      now: () => time, wallClock: () => 1000 + time, onChange() {},
      readCheckpoint: () => structuredClone(saved),
      writeCheckpoint: value => { saved = structuredClone(value); },
      loadPendingImage,
      openManualMcp,
      createControlTools,
      watch(options) {
        const watcher = { options, wakes: 0 };
        watchers.push(watcher);
        options.onConnect({
          wake: () => watcher.wakes++,
          async callTool(name, args, options) {
            return { content: [block(name === 'cinema_notebook' ? 'notebook' : JSON.stringify({ name, args, options }))] };
          }
        });
        return new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      }
    });
    t.after(() => screening.close());
    screening.start('http://127.0.0.1:4182');
    return screening;
  };
  const watch = () => watchers.at(-1);
  return {
    state, make, watch, watchers,
    checkpoint: () => structuredClone(saved),
    viewer: id => { viewerMessage = id; },
    viewerName: name => { viewerName = name; },
    opening: message => { opening = message; },
    time: ms => { time = ms; },
    room: patch => {
      room = patch ? { id: 'first', seekVersion: 1, playbackState: 'paused', lastPositionMs: 0, ...patch } : null;
    },
    packet(content, { reason = 'interval', includesPlayback = true, mediaMs = room.lastPositionMs,
      messageId = viewerMessage, messagesOnly = false, blockTimes = [] } = {}) {
      const refs = content.flatMap((item, index) => item.type === 'image'
        ? [{ index, ref: item.testRef ?? 'fixture/' + index, mediaTimeMs: mediaMs, throughMs: item.testTimeMs ?? mediaMs }] : []);
      content = content.map(({ testRef, testTimeMs, ...item }) => item);
      const tick = watch().options.retainTickResult({ content,
        _meta: { [cursorMeta]: { mediaMs, messageId, seekVersion: room.seekVersion },
          'open-watch-cinema/bridgeFrameRefs': refs, 'open-watch-cinema/bridgeBlockThroughMs': blockTimes } });
      watch().options.onTick(tick, {
        state: { seekVersion: room.seekVersion, playheadMs: room.lastPositionMs, latestViewerMessageId: viewerMessage },
        results: [tick], reason, includesPlayback, messagesOnly
      });
    }
  };
}

function app(screening, cardId = 'card-1', sessionId = 'chat-1') {
  return (action, body) => screening.command({ actor: 'app', action, sessionId, cardId, ...body });
}

function ack(screening, sessionId = 'chat-1') {
  return screening.command({ actor: 'model', action: 'ack', sessionId });
}

async function claim(control, claimId) {
  const { state, batchId } = await control('poll');
  assert.equal(state, 'ready');
  const ids = { batchId, claimId };
  return { result: await control('result', ids), ids };
}

test('requires explicit card start and room, and attaches the intro only to the first playback batch', async t => {
  const fixture = cinema(t);
  const screening = fixture.make();
  const control = app(screening);
  const other = app(screening, 'card-2', 'chat-2');
  assert.equal((await control('open')).started, false);
  assert.equal((await control('start')).status, 'waiting_room');
  assert.equal(fixture.watchers.length, 0);

  fixture.room({ resumeFromMs: 12000, lastPositionMs: 12000 });
  screening.reconcile();
  assert.equal((await control('poll')).status, 'watching');
  await other('open');
  await assert.rejects(other('start'), /active ChatGPT conversation/);
  assert.equal(fixture.watchers.length, 1);
  fixture.viewer(1);
  fixture.packet([block('pause chat')], { reason: 'chat', includesPlayback: false });
  const pause = await claim(control, 'pause');
  assert.deepEqual(pause.result.content, [pausedAtDelivery, block('观影项目指令\nproject instructions'), block('pause chat')]);
  assert.equal((await control('poll')).status, 'waiting_receipt');
  await assert.rejects(control('result', pause.ids), /no longer available/);
  await assert.rejects(ack(screening, 'chat-2'), /No pending/);
  assert.deepEqual(await ack(screening), { ok: true });

  fixture.time(999);
  assert.deepEqual(await ack(screening), { ok: true, duplicate: true });
  fixture.room({ resumeFromMs: 12000, lastPositionMs: 20000, playbackState: 'playing' });
  fixture.packet([block('movie dialogue'), picture], { mediaMs: 19800 });
  assert.equal((await control('poll')).status, 'cooldown');
  assert.equal((await control('poll')).batchId, undefined);
  fixture.time(1000);
  const playback = await claim(control, 'playing');
  assert.deepEqual(playback.result.content, [
    block('房间用户的开场白\nopening message'),
    block('这是同一部影片的新放映房间，从上次结束的位置 0:12 接着看。\n影片共用手记'),
    block('notebook'), block('movie dialogue'), picture
  ]);
  assert.equal(playback.result._meta['open-watch-cinema/filmSeconds'], 19.8);
  await control('stop');
  assert.equal((await control('submitted', playback.ids)).lastSubmittedSeconds, 19.8);
  await ack(screening);

  const restarted = fixture.make();
  const newCard = app(restarted, 'card-3');
  await newCard('open');
  await newCard('start');
  assert.equal(fixture.watch().options.resumeCursors.mediaMs, 19800);
  fixture.packet([block('later')]);
  assert.equal((await newCard('poll')).status, 'cooldown');
  fixture.time(1999);
  assert.equal((await newCard('poll')).batchId, undefined);
  fixture.time(2000);
  assert.deepEqual((await claim(newCard, 'later')).result.content, [block('later')]);
});

test('a confirmed paused first delivery retains only the playback introduction after restart', async t => {
  const fixture = cinema(t);
  fixture.state.instructions = null;
  fixture.room({ resumeFromMs: 12000, lastPositionMs: 12000 });
  fixture.viewer(1);
  const firstRun = fixture.make();
  const firstCard = app(firstRun);
  await firstCard('open');
  await firstCard('start');
  fixture.packet([block('first viewer message')], { reason: 'chat', includesPlayback: false });
  const { result, ids } = await claim(firstCard, 'paused-first');
  assert.match(DEFAULT_INSTRUCTIONS, /cinema_finish_turn\(\{\}\).*完成本轮观影.*空参数/);
  assert.deepEqual(result.content, [pausedAtDelivery, defaultPrompt(), block('first viewer message')]);
  await firstCard('abandon', ids);
  fixture.packet([block('first viewer message')], { reason: 'chat', includesPlayback: false });
  const retry = await claim(firstCard, 'paused-retry');
  assert.deepEqual(retry.result.content, result.content);
  await firstCard('submitted', retry.ids);
  await ack(firstRun);
  await firstRun.close();

  fixture.time(190000);
  fixture.room({ resumeFromMs: 12000, lastPositionMs: 12000 });
  const restarted = fixture.make();
  const newCard = app(restarted, 'restarted-card');
  await newCard('open');
  await newCard('start');
  fixture.viewer(2);
  fixture.packet([block('second viewer message')], { reason: 'chat', includesPlayback: false });
  assert.deepEqual((await claim(newCard, 'paused-second')).result.content, [pausedAtDelivery, block('second viewer message')]);
  await ack(restarted);
  fixture.time(191000);
  fixture.viewerName('');
  fixture.room({ resumeFromMs: 12000, lastPositionMs: 18000, playbackState: 'playing' });
  fixture.packet([block('first playback')]);
  assert.deepEqual((await claim(newCard, 'playing')).result.content, [
    block('开场白\nopening message'),
    block('这是同一部影片的新放映房间，从上次结束的位置 0:12 接着看。\n影片共用手记'),
    block('notebook'), block('first playback')
  ]);
});

test('first playback without any room message or opening has no sender label', async t => {
  const fixture = cinema(t);
  fixture.state.instructions = null;
  fixture.opening(null);
  fixture.room({ playbackState: 'playing', lastPositionMs: 6000 });
  const control = app(fixture.make());
  await control('open');
  await control('start');
  fixture.packet([block('first playback'), picture]);
  assert.match(DEFAULT_INSTRUCTIONS, /暂停中的跟片轮次.*cinema_notebook.*集中整理进共用手记.*播放中先聊电影，只有 \{\{viewerName\}\} 点名才整理手记/);
  assert.match(DEFAULT_INSTRUCTIONS, /cinema_post_message/);
  assert.match(DEFAULT_INSTRUCTIONS, /cinema_inspect_frame/);
  assert.deepEqual((await claim(control, 'first')).result.content, [
    defaultPrompt(), block('first playback'), picture
  ]);
});

test('first delivery expands viewer names in a saved custom prompt', async t => {
  const fixture = cinema(t);
  fixture.state.instructions = '和 {{viewerName}} 看片，等 {{viewerName}} 发消息。';
  fixture.viewerName('鹿鹿$&');
  fixture.opening(null);
  fixture.room({ playbackState: 'playing', lastPositionMs: 6000 });
  const control = app(fixture.make());
  await control('open');
  await control('start');
  fixture.packet([block('first playback')]);
  assert.deepEqual((await claim(control, 'first')).result.content, [
    block('观影项目指令\n和 鹿鹿$& 看片，等 鹿鹿$& 发消息。'), block('first playback')
  ]);
});

test('prioritizes new viewer messages and delivers buffered playback during pause', async t => {
  const fixture = cinema(t);
  const screening = fixture.make();
  const control = app(screening);
  fixture.room({ playbackState: 'playing', lastPositionMs: 6000 });
  await control('open');
  await control('start');
  fixture.packet([block('early'), picture]);
  assert.equal(fixture.watch().options.canReadInterval(), false);
  fixture.room({ playbackState: 'playing', lastPositionMs: 20000 });
  assert.equal((await control('poll')).state, 'ready');
  assert.equal(fixture.watch().options.canReadInterval(), false);
  fixture.viewer(1);
  fixture.packet([block('later'), picture], { messageId: 0 });
  assert.equal((await control('poll')).state, 'watching');
  fixture.room({ lastPositionMs: 20000 });
  fixture.packet([block('new message')], { reason: 'chat' });
  const { result } = await claim(control, 'merged');
  assert.deepEqual(result.content.slice(-5), [block('early'), picture, block('later'), picture, block('new message')]);
  await ack(screening);
  fixture.time(1000);
  fixture.packet([block('queued playback')]);
  assert.equal((await control('poll')).state, 'ready');
});

test('seek expires unclaimed content and uses a late receipt only for the previous claim', async t => {
  const fixture = cinema(t);
  const screening = fixture.make();
  const control = app(screening);
  fixture.room({ playbackState: 'playing', lastPositionMs: 8000 });
  await control('open');
  await control('start');
  fixture.packet([block('old queue')]);
  const obsolete = await control('poll');
  fixture.room({ playbackState: 'playing', lastPositionMs: 18000, seekVersion: 2 });
  screening.reconcile();
  await assert.rejects(control('result', { batchId: obsolete.batchId, claimId: 'obsolete' }), /no longer available/);
  fixture.packet([block('claimed old'), picture]);
  const old = await claim(control, 'claimed');
  fixture.room({ playbackState: 'playing', lastPositionMs: 28000, seekVersion: 3 });
  screening.reconcile();
  fixture.packet([block('new queue')]);
  assert.equal((await control('poll')).state, 'pending');
  await control('submitted', old.ids);
  await ack(screening);
  assert.equal(fixture.watch().options.resumeCursors.mediaMs, undefined);
  assert.equal((await control('poll')).status, 'cooldown');
  fixture.packet([block('new seek'), picture]);
  fixture.time(1000);
  assert.deepEqual((await claim(control, 'new')).result.content, [block('new seek'), picture]);
});

test('unknown outcomes stay fenced while an explicitly unsent claim can be read again', async t => {
  const fixture = cinema(t);
  const screening = fixture.make();
  const control = app(screening);
  fixture.room({ playbackState: 'playing', lastPositionMs: 6000 });
  await control('open');
  await control('start');
  fixture.packet([block('claimed')]);
  const pending = await claim(control, 'pending');
  assert.equal((await control('failed', pending.ids)).status, 'unconfirmed');
  await assert.rejects(control('start'), /未确认/);
  const replacement = app(screening, 'card-2');
  await replacement('open');
  await control('stop');
  await assert.rejects(replacement('start'), /未确认/);
  assert.equal((await control('abandon', pending.ids)).started, false);
  assert.equal((await replacement('start')).started, true);
  fixture.packet([block('retried content')]);
  assert.equal((await claim(replacement, 'retry')).result.content.at(-1).text, 'claimed');
});

test('a lost claim response stays fenced across backend restart and a new room', async t => {
  const fixture = cinema(t);
  fixture.state.instructions = null;
  const before = fixture.make();
  const oldCard = app(before);
  fixture.room({ playbackState: 'playing', lastPositionMs: 6000 });
  await oldCard('open');
  await oldCard('start');
  fixture.packet([block('old room')]);
  await claim(oldCard, 'lost-response');
  await before.close();

  fixture.room({ id: 'second', playbackState: 'playing', lastPositionMs: 8000 });
  fixture.time(120001);
  const after = fixture.make();
  const newCard = app(after, 'card-2');
  await newCard('open');
  assert.equal((await newCard('start')).status, 'waiting_receipt');
  await delay(5);
  assert.equal((await newCard('poll')).status, 'unconfirmed');
  await ack(after);
  assert.equal((await newCard('poll')).status, 'cooldown');
  assert.equal(fixture.watch().options.resumeCursors, undefined);
  assert.equal(fixture.checkpoint()[0].progress.notebookGuidanceDelivered, undefined);
  fixture.time(121001);
  fixture.packet([block('new room')]);
  assert.deepEqual((await claim(newCard, 'new')).result.content, [
    defaultPrompt(), block('房间用户的开场白\nopening message'), block('new room')
  ]);
});

test('optional groups reject stale calls and only the started Chat can manage the cinema outside a room', async t => {
  const executions = [];
  let controlsSignal;
  const fixture = cinema(t, {
    createControlTools({ signal }) {
      controlsSignal = signal;
      return (name, args) => ({ name, args });
    }
  });
  const screening = fixture.make();
  const control = app(screening);
  const tool = (name, args, sessionId = 'chat-1') =>
    screening.command({ actor: 'model', action: 'tool', sessionId, tool: name, arguments: args });
  const settings = () => screening.command({ actor: 'service', action: 'tool-settings' });
  assert.deepEqual(await settings(), { enabled: true, enableManual: false, enableHistory: false, enableControl: false });
  await assert.rejects(tool('cinema_manage'), /关闭/);
  fixture.state.enableControl = true;
  await assert.rejects(tool('cinema_manage'), /开始观影/);
  await control('open');
  await control('start');
  await assert.rejects(tool('cinema_manage', {}, 'chat-2'), /开始观影/);
  assert.deepEqual(await tool('cinema_manage', { action: 'list_media' }), {
    name: 'cinema_manage', args: { action: 'list_media' }
  });
  assert.equal(controlsSignal.aborted, false);
  fixture.state.enableControl = false;
  screening.reconcile();
  assert.equal(controlsSignal.aborted, true);
  await assert.rejects(tool('cinema_manage'), /关闭/);
  fixture.room({ playbackState: 'playing', lastPositionMs: 6000 });
  screening.reconcile();
  fixture.packet([block('scene')]);
  await claim(control, 'scene');
  await assert.rejects(tool('cinema_read_window'), /关闭/);
  fixture.state.enableHistory = true;
  assert.deepEqual(await settings(), { enabled: true, enableManual: false, enableHistory: true, enableControl: false });
  const history = await tool('cinema_read_window', { fromMs: 1, toMs: 2 });
  executions.push(JSON.parse(history.content[0].text));
  assert.deepEqual(executions, [
    { name: 'cinema_read_window', args: { fromMs: 1, toMs: 2 }, options: { expectedSeekVersion: 1 } }
  ]);
});

test('caps a merged backlog at 16, retries the exact prefix, then resumes its untouched tail after restart', async t => {
  const image = index => ({ ...picture, data: Buffer.from('storyboard ' + index).toString('base64') });
  let imageReads = 0;
  const fixture = cinema(t, {
    loadPendingImage: async ({ frame }) => {
      imageReads++;
      return image(Number(frame.ref.slice('storyboard-'.length)));
    }
  });
  function images(from, through) {
    return Array.from({ length: through - from + 1 }, (_, offset) => from + offset)
      .flatMap(index => [block('caption and dialogue ' + index),
        { ...image(index), testRef: 'storyboard-' + index, testTimeMs: index * 1000 }]);
  }
  fixture.state.instructions = null;
  fixture.room({ lastPositionMs: 25000, resumeFromMs: 1000 });
  fixture.viewer(1);
  const before = fixture.make();
  const card = app(before);
  await card('open');
  await card('start');
  fixture.packet(images(1, 17), { reason: 'pause', mediaMs: 17000 });
  fixture.packet([...images(18, 21), block('last spoken line')], { reason: 'pause', mediaMs: 25000 });
  const one = await claim(card, 'first-packet');
  assert.match(one.result.content[0].text, /房间用户 已暂停在 0:25/);
  assert.equal(one.result.content.filter(item => item.type === 'image').length, 16);
  assert.equal(one.result.content.at(-1).data, image(16).data);
  assert.equal(one.result._meta['open-watch-cinema/filmSeconds'], 16);
  assert.equal(one.result.content.some(item => item.text === 'caption and dialogue 17'), false);
  assert.equal(one.result.content.filter(item => item.text === 'notebook').length, 1);
  assert.equal(one.result.content.filter(item => item.text?.includes('集中整理进共用手记')).length, 1);

  await card('failed', { ...one.ids, definitive: true });
  const retry = await claim(card, 'same-packet');
  assert.deepEqual(retry.result, one.result);
  assert.equal(imageReads, 0);
  await card('submitted', retry.ids);
  let state = fixture.checkpoint()[0];
  assert.equal(state.progress.pendingDelivery.position, 0);
  assert.equal(state.progress.cursors, undefined);
  assert.equal((await card('poll')).state, 'pending');
  fixture.time(3500);
  assert.equal((await card('poll')).state, 'pending');
  assert.equal((await card('poll')).batchId, undefined);
  assert.equal(JSON.stringify(state).includes(image(1).data), false);
  await ack(before);
  state = fixture.checkpoint()[0];
  assert.equal(state.progress.pendingDelivery.blocks[0].text, 'caption and dialogue 17');
  assert.equal(state.progress.cursors, undefined);
  assert.ok(state.progress.pauseNoticeKey);
  assert.equal(state.progress.notebookGuidanceDelivered, true);
  await before.close();

  const after = fixture.make();
  const renewed = app(after, 'new-card');
  await renewed('open');
  await renewed('start');
  assert.equal(fixture.watch().options.resumeCursors.mediaMs, 25000);
  fixture.time(4499);
  assert.equal((await renewed('poll')).state, 'watching');
  fixture.time(4500);
  const two = await claim(renewed, 'tail-after-restart');
  assert.deepEqual(two.result.content,
    [pausedAtDelivery, ...images(17, 21).map(({ testRef, testTimeMs, ...item }) => item), block('last spoken line')]);
  assert.equal(two.result._meta['open-watch-cinema/filmSeconds'], 25);
  assert.equal(imageReads, 5);
  await ack(after);
  state = fixture.checkpoint()[0];
  assert.equal(state.progress.pendingDelivery, undefined);
  assert.equal(state.progress.cursors.mediaMs, 25000);
});

test('legacy whole-packet flight still accepts its late acknowledgement', async t => {
  const fixture = cinema(t, { checkpoint: [{
    sessionId: 'chat-1', progress: { roomId: 'first', profileId: 'profile', introDelivered: false },
    flight: { batchId: 'old-flight', claimId: 'old-claim', cardId: 'old-card', seekVersion: 1, roomId: 'first',
      intro: true, cursors: { seekVersion: 1, mediaMs: 5000 }, seconds: 5, claimedAt: 1000, received: false }
  }] });
  fixture.room({ lastPositionMs: 6000 });
  const screening = fixture.make();
  assert.deepEqual(await ack(screening), { ok: true });
  assert.equal(fixture.checkpoint()[0].progress.cursors.mediaMs, 5000);
  assert.equal(fixture.checkpoint()[0].progress.introDelivered, true);
});

test('1-second receipt window prefetches while busy and never waits for an extra film read after it expires', async t => {
  const fixture = cinema(t);
  const screening = fixture.make();
  const control = app(screening);
  fixture.room({ playbackState: 'playing', lastPositionMs: 6000 });
  await control('open');
  await control('start');
  fixture.packet([block('first ready')]);
  const first = await claim(control, 'first');
  await control('submitted', first.ids);
  assert.equal(fixture.watch().options.canReadInterval(), true);
  fixture.packet([block('second ready')]);
  fixture.viewer(1);
  fixture.room({ playbackState: 'playing', lastPositionMs: 37000 });
  const viewerMessage = block('**房间用户的房间留言 · 0:37**\n\n第一行\n第二行');
  fixture.packet([viewerMessage], { reason: 'chat', includesPlayback: false, messagesOnly: true });
  await ack(screening);
  fixture.time(999);
  assert.equal((await control('poll')).batchId, undefined);
  fixture.time(1000);
  const second = await claim(control, 'viewer-priority');
  assert.deepEqual(second.result.content, [viewerMessage, block('second ready')]);
  await ack(screening);
  assert.equal(fixture.checkpoint()[0].progress.cursors.messageId, 1);
  fixture.time(2000);
  assert.equal((await control('poll')).batchId, undefined);
});

test('pause and disabling lookahead hold only the future tail and deliver new viewer messages separately', async t => {
  const fixture = cinema(t);
  fixture.state.lookaheadMs = 20000;
  const screening = fixture.make();
  const control = app(screening);
  fixture.room({ playbackState: 'playing', lastPositionMs: 30000 });
  await control('open');
  await control('start');
  assert.equal(screening.authorizeFeed(fixture.watch().options.feedToken, 'first'), true);
  assert.equal(screening.authorizeFeed('not-the-capability', 'first'), false);
  fixture.packet([block('already played'), block('before the future frame'), block('beyond the pause point')],
    { mediaMs: 50000, blockTimes: [20000, 29000, 49000] });
  fixture.room({ playbackState: 'paused', lastPositionMs: 30000 });
  const past = await claim(control, 'playback-prefix');
  assert.equal(past.result.content.at(-1).text, 'before the future frame');
  await ack(screening);
  fixture.time(1000);
  assert.equal((await control('poll')).batchId, undefined);
  fixture.viewer(2);
  fixture.packet([block('new viewer message')], { reason: 'chat', messagesOnly: true, includesPlayback: false, mediaMs: 50000 });
  assert.deepEqual((await claim(control, 'urgent')).result.content, [pausedAtDelivery, block('new viewer message')]);
  await ack(screening);
  assert.equal(fixture.checkpoint()[0].progress.viewerMessageId, 2);
  assert.equal(fixture.checkpoint()[0].progress.cursors, undefined);
  fixture.state.lookaheadMs = 0;
  fixture.time(2000);
  fixture.room({ playbackState: 'playing', lastPositionMs: 48000 });
  assert.equal((await control('poll')).batchId, undefined);
  fixture.room({ playbackState: 'playing', lastPositionMs: 49000 });
  assert.deepEqual((await claim(control, 'future-now-played')).result.content, [block('beyond the pause point')]);
});

test('a combined poll atomically claims under its caller ID and preserves exact abandon recovery', async t => {
  const fixture = cinema(t);
  const screening = fixture.make();
  const control = app(screening);
  fixture.room({ playbackState: 'playing', lastPositionMs: 6000 });
  await control('open');
  await control('start');
  assert.equal((await control('poll', { claimId: 'nothing-yet' })).packet, undefined);
  fixture.packet([block('prepare once')]);
  const first = await control('poll', { claimId: 'combined' });
  assert.equal(first.packet.content.at(-1).text, 'prepare once');
  assert.equal(first.state.state, 'pending');
  assert.equal((await control('poll', { claimId: 'parallel-or-retry' })).packet, undefined);
  await control('abandon', { batchId: 'combined', claimId: 'combined' });
  const recovered = await control('poll', { claimId: 'after-loss' });
  assert.deepEqual(recovered.packet, first.packet);
  assert.equal(recovered.state.state, 'pending');
});

test('a canceled combined poll does not persist a claim, and concurrent or foreign callers cannot take it', async t => {
  const entered = Promise.withResolvers();
  const unblock = Promise.withResolvers();
  const fixture = cinema(t, {
    checkpoint: [{
      sessionId: 'chat-1', progress: { roomId: 'first', profileId: 'profile', introDelivered: true,
        pendingDelivery: { id: 'persisted', position: 0, seekVersion: 1, cursors: { mediaMs: 4000, seekVersion: 1 },
          blocks: [{ type: 'image', throughMs: 4000, hash: createHash('sha256').update(picture.data, 'base64').digest('hex') }] }
      }
    }],
    async loadPendingImage({ signal }) {
      entered.resolve();
      await unblock.promise;
      signal.throwIfAborted();
      return picture;
    }
  });
  fixture.room({ playbackState: 'playing', lastPositionMs: 6000 });
  const screening = fixture.make();
  const control = app(screening);
  await control('open');
  await control('start');
  const abort = new AbortController();
  const first = screening.command({ actor: 'app', action: 'poll', cardId: 'card-1',
    sessionId: 'chat-1', claimId: 'canceled' }, { signal: abort.signal });
  await Promise.race([entered.promise, first.then(() => assert.fail('Claim completed without materializing the image.'))]);
  assert.equal((await control('poll', { claimId: 'concurrent' })).packet, undefined);
  await assert.rejects(app(screening, 'card-1', 'chat-2')('poll', { claimId: 'foreign' }), /no longer active/);
  abort.abort();
  unblock.resolve();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(fixture.checkpoint()[0].flight, undefined);
  const retry = await control('poll', { claimId: 'valid' });
  assert.deepEqual(retry.packet.content, [picture]);
  assert.equal(fixture.checkpoint()[0].flight.claimId, 'valid');
});

test('an ongoing default screening gets the updated notebook guidance once on a natural round', async t => {
  const fixture = cinema(t, { checkpoint: [{
    sessionId: 'chat-1',
    progress: { roomId: 'first', profileId: 'profile', instructionsDelivered: true, introDelivered: true }
  }] });
  fixture.state.instructions = null;
  fixture.room({ playbackState: 'playing', lastPositionMs: 10000 });
  const screening = fixture.make();
  const control = app(screening);
  await control('open');
  await control('start');
  fixture.room({ playbackState: 'paused', lastPositionMs: 10000 });
  screening.reconcile();
  assert.notEqual((await control('poll')).state, 'ready');

  const capturedWhilePlaying = block('取片时人类实际播放位置 0:08 · 播放中');
  fixture.packet([capturedWhilePlaying], { reason: 'pause' });
  const first = await claim(control, 'first-update');
  assert.match(first.result.content[0].text, /交付时.*暂停/);
  assert.match(first.result.content[0].text, /集中整理进共用手记.*房间用户 点名/);
  assert.deepEqual(first.result.content.slice(1), [capturedWhilePlaying]);
  await control('abandon', first.ids);
  assert.equal(fixture.checkpoint()[0].progress.notebookGuidanceDelivered, undefined);
  const retry = await claim(control, 'retry-update');
  assert.deepEqual(retry.result, first.result);
  await ack(screening);
  assert.equal(fixture.checkpoint()[0].progress.notebookGuidanceDelivered, true);

  fixture.time(1000);
  fixture.viewer(1);
  const capturedWhilePaused = block('取片时人类实际播放位置 0:10 · 已暂停');
  fixture.packet([capturedWhilePaused], { reason: 'chat', includesPlayback: false });
  fixture.room({ playbackState: 'playing', lastPositionMs: 11000 });
  assert.deepEqual((await claim(control, 'resumed')).result.content, [capturedWhilePaused]);
});

test('an ongoing screening keeps custom notebook guidance in charge', async t => {
  const fixture = cinema(t, { checkpoint: [{
    sessionId: 'chat-1',
    progress: { roomId: 'first', profileId: 'profile', instructionsDelivered: true, introDelivered: true }
  }] });
  fixture.state.instructions = '只整理我点名的手记。';
  fixture.room({ playbackState: 'paused', lastPositionMs: 10000 });
  const screening = fixture.make();
  const control = app(screening);
  await control('open');
  await control('start');
  fixture.viewer(1);
  fixture.packet([block('晚点再记')], { reason: 'chat', includesPlayback: false });
  assert.deepEqual((await claim(control, 'custom')).result.content, [pausedAtDelivery, block('晚点再记')]);
  await ack(screening);
  assert.equal(fixture.checkpoint()[0].progress.notebookGuidanceDelivered, undefined);
  assert.equal(fixture.state.instructions, '只整理我点名的手记。');
});

test('an in-flight batch survives an idle 60-second lease and a 104-second receipt restores the same card', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = cinema(t);
  fixture.room({ playbackState: 'playing', lastPositionMs: 6000 });
  const screening = fixture.make();
  const control = app(screening);
  const modelTool = () => screening.command({ actor: 'model', action: 'tool', sessionId: 'chat-1',
    tool: 'cinema_notebook', arguments: { action: 'read' } });
  let clock = 0;
  function advance(ms) {
    clock += ms;
    fixture.time(clock);
    t.mock.timers.tick(ms);
  }

  await control('open');
  await control('start');
  fixture.packet([block('held through transport outage')]);
  const batch = await claim(control, 'recover');
  const connectionId = screening.connection().connectionId;
  advance(59999);
  assert.equal(screening.status(), 'waiting_receipt');
  advance(1);
  assert.equal(screening.status(), 'waiting_receipt');
  assert.equal(screening.connection().connectionId, connectionId);
  assert.deepEqual((await modelTool()).content, [block('notebook')]);
  advance(44000);
  assert.deepEqual(await ack(screening), { ok: true });
  assert.equal(screening.status(), 'cooldown');
  assert.equal(screening.connection().connectionId, connectionId);
  assert.equal((await control('open')).lastSubmittedSeconds, 6);
  assert.equal(fixture.checkpoint()[0].lastSubmission.batchId, batch.ids.batchId);
  assert.equal((await control('submitted', batch.ids)).lastSubmittedSeconds, 6);
  advance(999);
  assert.equal(screening.status(), 'cooldown');
  advance(1);
  assert.equal(screening.status(), 'watching');
  advance(58999);
  assert.equal(screening.status(), 'watching');
  advance(1);
  assert.equal(screening.status(), 'waiting_card');
});

test('an unresolved submission keeps one flight until the 120-second deadline and a late receipt can still recover', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = cinema(t);
  fixture.room({ playbackState: 'playing', lastPositionMs: 6000 });
  const screening = fixture.make();
  const control = app(screening);
  const modelTool = () => screening.command({ actor: 'model', action: 'tool', sessionId: 'chat-1',
    tool: 'cinema_notebook', arguments: { action: 'read' } });
  let clock = 0;
  function advance(ms) {
    clock += ms;
    fixture.time(clock);
    t.mock.timers.tick(ms);
  }

  await control('open');
  await control('start');
  fixture.packet([block('possibly accepted')]);
  const first = await claim(control, 'original');
  advance(40000);
  assert.equal((await control('failed', first.ids)).status, 'unconfirmed');
  advance(20000);
  assert.deepEqual((await modelTool()).content, [block('notebook')]);
  advance(59999);
  assert.equal((await control('poll', { claimId: 'still-open-card' })).packet, undefined);
  assert.deepEqual((await modelTool()).content, [block('notebook')]);
  advance(1);
  assert.equal(screening.status(), 'unconfirmed');
  await assert.rejects(modelTool(), /no longer current/);
  const offered = await control('poll', { claimId: 'same-packet-must-not-replay' });
  assert.equal(offered.packet, undefined);
  assert.equal(fixture.checkpoint()[0].flight.batchId, first.ids.batchId);
  advance(3000);
  assert.deepEqual(await ack(screening), { ok: true });
  assert.equal((await control('open')).lastSubmittedSeconds, 6);
  assert.equal(screening.status(), 'cooldown');
  assert.equal(fixture.watchers.length, 2);
  fixture.packet([block('next actual delivery')]);
  advance(1000);
  const next = await claim(control, 'fresh-batch');
  assert.equal(next.result.content.at(-1).text, 'next actual delivery');
});

test('a restarted card uses the later acknowledged batch even if its film timestamp is earlier', async t => {
  const fixture = cinema(t, { checkpoint: [{
    sessionId: 'chat-1', receiptAt: 1000, progress: { roomId: 'first', profileId: 'profile',
      introDelivered: true, cursors: { seekVersion: 1, mediaMs: 100000 } },
    lastSubmission: { batchId: 'previous', claimId: 'old', cardId: 'old-card', roomId: 'first', seconds: 99 },
    flight: { batchId: 'last-ack', claimId: 'new', cardId: 'old-card', roomId: 'first', seekVersion: 1,
      claimedAt: 500, seconds: 86, received: true }
  }] });
  fixture.room({ lastPositionMs: 86000 });
  const screening = fixture.make();
  const control = app(screening, 'reopened');
  assert.equal((await control('open')).lastSubmittedSeconds, 86);
  assert.equal((await control('start')).lastSubmittedSeconds, 86);
});

test('an absent card releases its slot at the receipt deadline without reactivating on a late ACK', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = cinema(t);
  fixture.room({ playbackState: 'playing', lastPositionMs: 6000 });
  const screening = fixture.make();
  const old = app(screening);
  const other = app(screening, 'other-card', 'chat-2');
  let clock = 0;
  function advance(ms) {
    clock += ms;
    fixture.time(clock);
    t.mock.timers.tick(ms);
  }

  await old('open');
  await old('start');
  fixture.packet([block('original film')]);
  const sent = await claim(old, 'old-claim');
  advance(60000);
  assert.equal(screening.status(), 'waiting_receipt');
  await other('open');
  await assert.rejects(other('start'), /active ChatGPT conversation/);
  advance(59999);
  assert.equal(screening.status(), 'waiting_receipt');
  advance(1);
  assert.equal(screening.status(), 'waiting_card');
  assert.equal(screening.connection(), null);
  await assert.rejects(old('start'), /回执超时/);
  await other('start');
  assert.equal(screening.status(), 'watching');
  const otherConnection = screening.connection().connectionId;
  assert.deepEqual(await ack(screening), { ok: true });
  assert.equal(screening.connection().connectionId, otherConnection);
  assert.equal(fixture.checkpoint().find(s => s.sessionId === 'chat-1').lastSubmission.batchId, sent.ids.batchId);
  assert.equal((await other('poll')).batchId, undefined);
  await other('stop');
  const reopened = app(screening, 'reopened');
  await reopened('open');
  assert.equal((await reopened('start')).started, true);
  assert.equal(fixture.watch().options.resumeCursors.mediaMs, 6000);
  assert.equal((await reopened('poll')).batchId, undefined);
});

test('explicit Stop ends an in-flight card immediately and a later receipt does not restart it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = cinema(t);
  fixture.room({ playbackState: 'playing', lastPositionMs: 6000 });
  const screening = fixture.make();
  const control = app(screening);
  await control('open');
  await control('start');
  fixture.packet([block('interrupted playback')]);
  await claim(control, 'stopped-claim');
  await control('stop');
  assert.equal(screening.status(), 'waiting_card');
  assert.equal(screening.connection(), null);
  await assert.rejects(screening.command({ actor: 'model', action: 'tool', sessionId: 'chat-1',
    tool: 'cinema_notebook', arguments: { action: 'read' } }), /no longer current/);
  fixture.time(104000);
  t.mock.timers.tick(104000);
  assert.deepEqual(await ack(screening), { ok: true });
  assert.equal(screening.connection(), null);
  assert.equal((await control('poll')).started, false);
  assert.equal((await control('start')).started, true);
  assert.equal(fixture.watch().options.resumeCursors.mediaMs, 6000);
});

test('cardless Chat tools use bound room and conversation cursors; card start waits for a manual call', async t => {
  const clients = [];
  const release = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let delayed = true;
  const fixture = cinema(t, { openManualMcp(options) {
    const calls = [];
    clients.push({ options, calls });
    return { async initialize() {}, async close() {},
      async callTool(name, args, signal, scope) {
        calls.push({ name, args, scope });
        if (delayed) { delayed = false; entered.resolve(); await release.promise; }
        signal.throwIfAborted();
        return { content: [block(name)], _meta: { [cursorMeta]: { mediaMs: 4100, seekVersion: 1, messageId: 4 } } };
      }
    };
  } });
  const screening = fixture.make();
  const model = (tool, sessionId = 'chat-1') => screening.command({ actor: 'model', action: 'tool', sessionId, tool });
  const control = app(screening);
  fixture.state.enableManual = true;
  await assert.rejects(model('open_watch_cinema_tick'), /开启观影房间/);
  fixture.room({ lastPositionMs: 5000 });
  await control('open');
  const reading = model('open_watch_cinema_tick');
  await entered.promise;
  await assert.rejects(control('start'), /执行完/);
  await assert.rejects(model('open_watch_cinema_tick'), /正在处理/);
  release.resolve();
  assert.deepEqual(await reading, { content: [block('open_watch_cinema_tick')] });
  assert.equal(clients[0].options.roomId, 'first');
  assert.deepEqual(clients[0].calls[0].scope, { expectedSeekVersion: 1 });
  await control('start');
  assert.equal(fixture.watch().options.resumeCursors.mediaMs, 4100);
  assert.match((await model('open_watch_cinema_tick')).content[0].text, /已开启自动/);
  await model('open_watch_cinema_tick', 'chat-2');
  assert.equal(clients[1].options.resumeCursors, null);
  await control('stop');
  await model('cinema_post_message');
  assert.equal(clients[2].options.resumeCursors.mediaMs, 4100);
  fixture.room({seekVersion: 2, lastPositionMs: 2000});
  screening.reconcile();
  await model('open_watch_cinema_tick');
  assert.equal(clients[3].calls[0].scope.expectedSeekVersion, 2);
  fixture.state.enableManual = false;
  screening.reconcile();
  await assert.rejects(model('open_watch_cinema_tick'), /关闭/);
});

test('a partial manual tick persists its ordered tail and hands it to the card without rerendering', async t => {
  let page = 0;
  const fixture = cinema(t, { openManualMcp() {
    return { async initialize() {}, async close() {}, async callTool() {
      page++;
      if (page === 1) return { content: [block('first page')], _meta: {
        [cursorMeta]: {mediaMs: 0, seekVersion: 1},
        'open-watch-cinema/bridgeMoreImagePages': true
      } };
      return { content: [block('tail')], _meta: {
        [cursorMeta]: {mediaMs: 9000, seekVersion: 1},
        'open-watch-cinema/bridgeBlockThroughMs': [9000]
      } };
    } };
  } });
  fixture.state.enableManual = true;
  fixture.room({lastPositionMs: 9000});
  const first = fixture.make();
  const tick = screening => screening.command({actor: 'model', action: 'tool', sessionId: 'chat-1', tool: 'open_watch_cinema_tick'});
  assert.deepEqual(await tick(first), {content: [block('first page')]});
  assert.equal(fixture.checkpoint()[0].progress.cursors.mediaMs, 0);
  assert.deepEqual(fixture.checkpoint()[0].progress.pendingDelivery.blocks, [{...block('tail'), throughMs: 9000}]);
  await first.close();
  const rebooted = fixture.make();
  fixture.room({lastPositionMs: 8000});
  await assert.rejects(tick(rebooted), /尚未播放/);
  fixture.room({lastPositionMs: 9000});
  const control = app(rebooted);
  await control('open');
  await control('start');
  assert.equal(fixture.watch().options.resumeCursors.mediaMs, 9000);
  const {result} = await claim(control, 'tail');
  assert(result.content.some(item => item.text === 'tail'));
  assert(result.content.some(item => item.text === '观影项目指令\nproject instructions'));
  assert(!result.content.some(item => item.text === 'first page'));
  await ack(rebooted);
  assert.equal(fixture.checkpoint()[0].progress.cursors.mediaMs, 9000);
  assert.equal(page, 2);
});

test('a stopped Chat waits for its receipt and hands the already played auto tail to manual tick after posting', async t => {
  const calls = [];
  const fixture = cinema(t, { openManualMcp() {
    return { async initialize() {}, async close() {}, async callTool(name) {
      calls.push(name);
      return { content: [block('posted')] };
    } };
  } });
  fixture.state.enableManual = true;
  fixture.room({lastPositionMs: 20000});
  const screening = fixture.make();
  const control = app(screening);
  await control('open');
  await control('start');
  fixture.packet(Array.from({length: 17}, (_, index) => ({
    ...picture, testRef: 'frame-' + index, testTimeMs: index === 16 ? 20000 : 16000
  })));
  const { result } = await claim(control, 'partial');
  assert.equal(result.content.filter(item => item.type === 'image').length, 16);
  await control('stop');
  const call = tool => screening.command({actor:'model', action:'tool', sessionId:'chat-1', tool});
  await assert.rejects(call('open_watch_cinema_tick'), /未确认/);
  await ack(screening);
  await call('cinema_post_message');
  fixture.room({lastPositionMs: 19000});
  await assert.rejects(call('open_watch_cinema_tick'), /尚未播放/);
  fixture.room({lastPositionMs: 20000});
  assert.equal((await call('open_watch_cinema_tick')).content.filter(item => item.type === 'image').length, 1);
  assert.equal(fixture.checkpoint()[0].progress.cursors.mediaMs, 20000);
  assert.deepEqual(calls, ['cinema_post_message']);
  fixture.room(null);
  screening.reconcile();
  await assert.rejects(call('cinema_post_message'), /开启观影房间/);
});
