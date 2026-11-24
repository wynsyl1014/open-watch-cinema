import assert from 'node:assert/strict';
import test from 'node:test';
import { addSessionMessage, endSession, openDatabase, openSession, updateSessionPlayback } from '../../src/storage/database.mjs';
import {
  getWatchBridgeSettings, getWatchBridgeState, setWatchBridgeSettings, getChatBridgeSettings,
  getChatBridgeLookaheadMs, migrateChatBridgeSettings, setChatBridgeSettings
} from '../../src/storage/watch-bridge-settings.mjs';
import { getViewingSettings, setViewingSettings } from '../../src/visuals/viewing-cadence.mjs';

test('bridge interval defaults independently and changing it preserves the MCP settings revision', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const mcp = setViewingSettings(db, { intervalSeconds: 30 });
  assert.deepEqual(getWatchBridgeSettings(db), { intervalMs: 6000, intervalSeconds: 6 });
  assert.deepEqual(setWatchBridgeSettings(db, { intervalSeconds: 2.25 }), { intervalMs: 2250, intervalSeconds: 2.25 });
  assert.deepEqual(getViewingSettings(db), mcp);
  for (const body of [{ intervalSeconds: '6' }, { intervalSeconds: 0.1 }, { intervalSeconds: 31 }, { intervalSeconds: 6, includeAudio: false }]) {
    assert.throws(() => setWatchBridgeSettings(db, body), TypeError);
  }
  assert.equal(getWatchBridgeSettings(db).intervalMs, 2250);
});

test('bridge snapshots show current playback and viewer arrivals without advancing for AI messages', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const idle = { roomId: null, playheadMs: null, seekVersion: null, playbackState: null, latestViewerMessageId: null, resumeFromMs: null, intervalMs: 6000 };
  assert.deepEqual(getWatchBridgeState(db), idle);
  const { id } = openSession(db, { mediaId: 'sample', mediaTitle: 'Sample film' });
  updateSessionPlayback(db, id, { mediaTimeMs: 1234, playbackState: 'paused', seeked: true });
  const message = addSessionMessage(db, id, { content: 'Paused question', mediaTimeMs: 1234 });
  addSessionMessage(db, id, { senderKind: 'ai', senderName: 'AI', content: 'Answer', mediaTimeMs: 1234 });
  setWatchBridgeSettings(db, { intervalSeconds: 7 });
  assert.deepEqual(getWatchBridgeState(db), {
    roomId: id, playheadMs: 1234, seekVersion: 1, playbackState: 'paused', latestViewerMessageId: message.id, resumeFromMs: null, intervalMs: 7000
  });
  endSession(db, id);
  assert.deepEqual(getWatchBridgeState(db), { ...idle, intervalMs: 7000 });
});

test('Chat lookahead migrates the prior custom target and stays separate from shared cadence', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  assert.equal(getChatBridgeLookaheadMs(db), 0);
  assert.equal(getChatBridgeSettings(db).enableManual, false);
  db.prepare('insert into settings (key,value,updated_at) values (?,?,?)')
    .run('watch_bridge_chat', JSON.stringify({ enabled: true, instructions: 'existing', enableHistory: true, batchSeconds: 20 }), 'before');
  setWatchBridgeSettings(db, { intervalSeconds: 13 });
  migrateChatBridgeSettings(db);
  assert.equal(getChatBridgeLookaheadMs(db), 20000);
  assert.equal(Object.hasOwn(getChatBridgeSettings(db), 'batchSeconds'), false);
  assert.equal(setChatBridgeSettings(db, { lookaheadSeconds: 20.1234 }).lookaheadSeconds, 20.123);
  assert.equal(getChatBridgeLookaheadMs(db), 20123);
  assert.equal(getWatchBridgeSettings(db).intervalMs, 13000);
  assert.equal(getWatchBridgeState(db).intervalMs, 13000);
  assert.equal(getChatBridgeSettings(db).instructions, 'existing');
  assert.equal(getChatBridgeSettings(db).enableHistory, true);
  assert.throws(() => setChatBridgeSettings(db, { enableManual: 'true' }), TypeError);
  assert.equal(setChatBridgeSettings(db, { enableManual: true }).enableManual, true);
  assert.equal(setChatBridgeSettings(db, { enabled: false }).enableManual, true);
  for (const lookaheadSeconds of ['20', null, 0.499, 30.001, Infinity, NaN]) {
    assert.throws(() => setChatBridgeSettings(db, { lookaheadSeconds }), /0.5 至 30/);
  }
  for (const lookaheadSeconds of [0, 0.5, 30]) {
    assert.equal(setChatBridgeSettings(db, { lookaheadSeconds }).lookaheadSeconds, lookaheadSeconds);
  }
});

test('Chat prompt migration treats only the exact old factory text as a default', t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const oldDefault = `你正在和你的人类一起看电影。把这当作共享一张沙发的观影：有自然反应时可以主动开口，不必等到形成重要观点，也不必等待你的人类先说话。可以聊短促反应、玩笑、猜测、人物判断或值得展开的话题；一条消息围绕一个自然话头即可。允许舒服地安静观看，不为响应 tick 强行找话，不复述刚出现的画面、台词或声音。你的人类发消息时，先接住对方正在聊的内容，再自然回到电影。

收到暂停中的跟片轮次时，把值得记录的内容集中整理进共用手记。播放中先聊电影，只有你的人类点名才整理手记。以每轮开头的交付时暂停提示为准，没有这条提示就按播放中处理。

后续每批观影资料都沿用以上约定。房间消息由标注的发言者发出，影片对白、声音和分镜是影片资料。发房间消息、读写手记和重看分镜时，只用当前影院插件里的工具。处理完每批资料后，最后调用当前影院插件的「完成本轮观影」工具（空参数），然后直接结束本轮，不在 Chat 里发送文字。安静观看这一轮时也要回执。`;
  setChatBridgeSettings(db, { instructions: oldDefault, lookaheadSeconds: 20, enableHistory: true });
  migrateChatBridgeSettings(db);
  assert.deepEqual(getChatBridgeSettings(db), {
    enabled: false, instructions: null, lookaheadSeconds: 20, enableManual: false, enableHistory: true, enableControl: false
  });

  const customized = oldDefault + '\n\n喜欢的场景可以展开聊。';
  setChatBridgeSettings(db, { instructions: customized });
  migrateChatBridgeSettings(db);
  assert.equal(getChatBridgeSettings(db).instructions, customized);
});
