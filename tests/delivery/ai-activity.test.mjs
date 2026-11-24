import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createAiActivity } from '../../src/delivery/ai-activity.mjs';

function fixture(t) {
  let time = 100_000;
  let name = 'Elias';
  let updates = 0;
  let roomId = 'screen';
  const activity = createAiActivity({
    now: () => time, resolveName: () => name, getActiveRoomId: () => roomId, onChange: () => updates++
  });
  t.after(() => activity.close());
  const connectionId = randomUUID();
  const send = (op, seq, data = {}) => activity.report({ op, seq, connectionId, profileId: 'elias', ...data });
  function call(seq, data = {}) {
    const body = { callId: randomUUID(), tool: 'open_watch_cinema_tick', startedAt: time - 20, finishedAt: time,
      isError: false, content: [{ type: 'text', text: '一段对白' }], ...data };
    send('call', seq, body);
    return body.callId;
  }
  return { activity, connectionId, send, call, advance: (ms) => { time += ms; },
    setRoom: (id) => { roomId = id; activity.refreshOnlineStatus(); },
    rename: (value) => { name = value; }, updates: () => updates };
}

test('late calls remain recorded; presence, profile and delivered progress follow their own sequence', (t) => {
  const f = fixture(t);
  const row = () => f.activity.list().connections[0];
  f.send('heartbeat', 1, { profileId: null });
  assert.equal(row(), undefined);
  f.advance(100);
  f.send('heartbeat', 8);
  const id = f.call(7, { progress: { roomId: 'screen', mediaMs: 3_000, seekVersion: 1 } });
  f.call(5, { progress: { roomId: 'early', mediaMs: 8_000, seekVersion: 0 } });
  f.call(7, { callId: id, content: [{ type: 'text', text: '重试' }] });
  assert.equal(row().callCount, 2);
  assert.equal(row().profileId, 'elias');
  assert.equal(row().online, true);
  assert.deepEqual(row().progress, { roomId: 'screen', mediaMs: 3_000, seekVersion: 1 });
  assert.equal(f.activity.result(f.connectionId, id).content[0].text, '一段对白');
  f.call(9, { progress: { roomId: 'screen', mediaMs: 500, seekVersion: 2 } });
  f.rename('沈晏');
  assert.equal(row().name, '沈晏');
  assert.equal(row().progress.mediaMs, 500);
  f.advance(30_000);
  assert.equal(row().online, false);
  f.send('heartbeat', 6);
  assert.equal(row().online, false);
  f.send('heartbeat', 10);
  assert.equal(row().online, false);
  f.call(11, { viewingRoomId: 'screen' });
  assert.equal(row().online, true);
  f.send('close', 12);
  f.send('heartbeat', 10);
  f.call(4);
  assert.equal(row().callCount, 5);
  assert.equal(row().online, false);
  assert.ok(row().closedAt);
});

test('watching expires from the last valid tick and stays scoped to the active room', (t) => {
  const f = fixture(t);
  const row = () => f.activity.list().connections[0];
  f.setRoom(null);
  f.send('heartbeat', 1);
  assert.equal(row(), undefined);
  f.call(2, { tool: 'cinema_manage' });
  assert.equal(row().online, false);
  f.setRoom('screen');
  f.call(3, { isError: true });
  f.call(4, { viewingRoomId: 'other' });
  assert.equal(row().online, false);
  f.call(5, { progress: { roomId: 'screen', mediaMs: 600 } });
  assert.equal(row().online, true);
  f.advance(29_000);
  f.call(6, { viewingRoomId: 'screen' });
  f.advance(2_000);
  assert.equal(row().online, true);
  assert.equal(row().progress.mediaMs, 600);
  f.activity.setOnlineTimeout(5);
  f.advance(3_000);
  f.send('heartbeat', 7);
  assert.equal(row().online, false);
  f.call(8, { viewingRoomId: 'screen' });
  assert.equal(row().online, true);
  f.setRoom('next');
  assert.equal(row().online, false);
  f.call(9, { viewingRoomId: 'screen' });
  assert.equal(row().online, false);
  f.call(10, { viewingRoomId: 'next' });
  assert.equal(row().online, true);
  f.setRoom(null);
  assert.equal(row().online, false);
  assert.equal(row().callCount, 8);
});

test('ordered text/image results are lazy, isolated between connections, and keep exact image bytes', (t) => {
  const f = fixture(t);
  const data = Buffer.from([255, 216, 0, 45, 255, 217]);
  const picture = { type: 'image', mimeType: 'image/jpeg', data: data.toString('base64') };
  const content = [{ type: 'text', text: '开场\n第二行' }, picture, { type: 'text', text: '' }, picture];
  const callId = f.call(1, { content });
  const other = randomUUID();
  f.call(1, { connectionId: other, callId, content: [{ type: 'text', text: '另一个连接' }] });
  assert.equal(f.activity.list().totalCalls, 2);
  assert.equal(f.activity.calls(f.connectionId).calls[0].imageCount, 2);
  assert.equal(f.activity.calls(f.connectionId).calls[0].content, undefined);
  assert.deepEqual(f.activity.result(f.connectionId, callId).content, [
    content[0], { type: 'image', mimeType: 'image/jpeg', index: 1, byteLength: data.length },
    content[2], { type: 'image', mimeType: 'image/jpeg', index: 3, byteLength: data.length }
  ]);
  assert.deepEqual(f.activity.image(f.connectionId, callId, 3), { mimeType: 'image/jpeg', data });
  assert.equal(f.activity.image(other, callId, 1), null);
  assert.equal(f.activity.image(f.connectionId, callId, 2), null);
  assert.equal(f.activity.result(other, randomUUID()), null);
  assert.equal(f.activity.calls(randomUUID()), null);
  assert.throws(() => f.call(3, { content: [content[0], { ...picture, data: '####' }] }), TypeError);
  assert.equal(f.activity.list().totalCalls, 2);
});

test('all pages and results survive call volume; a transport omission keeps its real counts and timing', (t) => {
  const f = fixture(t);
  const first = f.call(1);
  for (let i = 2; i <= 270; i++) {
    f.advance(1);
    f.call(i);
  }
  const omitted = f.call(271, { content: undefined, contentOmitted: true, blockCount: 1025, imageCount: 12 });
  const firstPage = f.activity.calls(f.connectionId, { limit: 200 });
  assert.equal(firstPage.calls.length, 200);
  assert.equal(firstPage.nextOffset, 200);
  const secondPage = f.activity.calls(f.connectionId, { offset: firstPage.nextOffset, limit: 200 });
  assert.equal(secondPage.calls.length, 71);
  assert.equal(secondPage.nextOffset, null);
  assert.equal(secondPage.calls.at(-1).callId, first);
  assert.equal(f.activity.result(f.connectionId, first).content[0].text, '一段对白');
  assert.deepEqual(f.activity.result(f.connectionId, omitted), { callId: omitted, available: false, content: [] });
  const latest = f.activity.list().connections[0].lastCall;
  assert.equal(latest.imageCount, 12);
  assert.equal(latest.blockCount, 1025);
  assert.equal(latest.resultAvailable, false);
  assert.equal(f.activity.list().totalCalls, 271);
});

test('adapter loss counters use the highest cumulative report independently of stored calls', (t) => {
  const f = fixture(t);
  const row = () => f.activity.list().connections.find(c => c.connectionId === f.connectionId);
  f.send('heartbeat', 1);
  assert.equal(row(), undefined);
  f.send('heartbeat', 3, { droppedCalls: 4 });
  f.send('heartbeat', 3, { droppedCalls: 4 });
  f.send('heartbeat', 2, { droppedCalls: 1 });
  f.send('heartbeat', 4);
  f.call(5);
  assert.equal(row().droppedCalls, 4);
  assert.equal(row().callCount, 1);
  f.send('close', 7, { droppedCalls: 6 });
  f.send('heartbeat', 6, { droppedCalls: 5 });
  assert.equal(row().droppedCalls, 6);
  assert.equal(row().online, false);
  assert.equal(f.activity.calls(f.connectionId).totalCalls, 1);
  assert.equal(f.activity.list().totalCalls, 1);
  assert.throws(() => f.send('heartbeat', 8, { droppedCalls: -1 }), TypeError);
});

test('routine heartbeats do not repaint and rapid calls coalesce into one change', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  const advance = (ms) => { f.advance(ms); t.mock.timers.tick(ms); };
  f.send('heartbeat', 1);
  f.call(2);
  f.call(3, { viewingRoomId: 'screen' });
  advance(100);
  assert.equal(f.updates(), 1);
  advance(10_000);
  f.send('heartbeat', 4);
  assert.equal(f.updates(), 1);
  advance(19_900);
  advance(100);
  assert.equal(f.updates(), 2);
  assert.equal(f.activity.list().connections[0].online, false);
  f.activity.close();
  const fresh = createAiActivity();
  try {
    assert.deepEqual(fresh.list(), { connections: [], evictedConnections: 0, totalCalls: 0 });
  } finally {
    fresh.close();
  }
});
