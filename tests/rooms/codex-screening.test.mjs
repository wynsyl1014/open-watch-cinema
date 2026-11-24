import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCodexScreening } from '../../src/delivery/codex-screening.mjs';
import { endSession, getRoomOpeningMessage, listSessionMessages, openDatabase, openSession } from '../../src/storage/database.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'owc-codex-screening-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = join(root, 'watch-bridge', 'adapters', 'codex');
  await mkdir(adapter, { recursive: true });
  for (const name of ['runner.mjs', 'setup.mjs', 'instructions.mjs']) await writeFile(join(adapter, name), '');
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const children = [];
  const context = {
    room: { id: 'room-a', playbackState: 'paused', mediaTitle: 'Fixture Film', openedAt: '2026-11-24T15:53:27.315Z' },
    profile: 'ai-a', viewer: '放映员'
  };
  function spawn() {
    const sent = [];
    const child = Object.assign(new EventEmitter(), {
      connected: true, sent,
      send(message, done) { sent.push(message); done(); },
      finish() { this.connected = false; this.emit('close'); },
      kill() { this.finish(); }
    });
    children.push(child);
    return child;
  }
  const options = {
    db, cinemaRoot: root, dataRoot: join(root, 'private-data'), getRoom: () => context.room,
    getProfileId: () => context.profile, getProfileName: () => 'Fixture AI', getViewerName: () => context.viewer,
    onChange() {}, spawn
  };
  return { context, children, db, create: () => createCodexScreening(options) };
}

test('autostart follows the room, reports readiness while paused, and stops when the room ends', async t => {
  const { context, children, create } = await fixture(t);
  const codex = create();
  codex.start('http://127.0.0.1:4182');
  assert.equal(codex.settings().enabled, false);
  assert.equal(children.length, 0);
  codex.setSettings({ enabled: true, authMode: 'isolated', model: 'gpt-5.4' });
  const [child] = children;
  const [start] = child.sent;
  assert.equal(start.roomId, 'room-a');
  assert.equal(start.config.authMode, 'isolated');
  assert.equal(start.config.profileId, 'ai-a');
  assert.equal(start.config.profileName, 'Fixture AI');
  assert.equal(start.config.viewerName, '放映员');
  assert.equal(start.config.filmTitle, 'Fixture Film');
  assert.equal(start.config.roomOpenedAt, context.room.openedAt);
  assert.equal(start.config.model, 'gpt-5.4');
  assert.equal(codex.status().online, false);
  child.emit('message', { type: 'ready', roomId: 'room-a' });
  assert.equal(codex.status().online, true);
  assert.equal(codex.status().paused, true);
  assert.equal(codex.status().connectionId, start.connectionId);
  context.room = null;
  codex.reconcile();
  assert.deepEqual(child.sent.at(-1), { type: 'stop' });
  assert.equal(codex.status(), null);
  child.finish();
  assert.equal(children.length, 1);
});

test('an acknowledged checkpoint during shutdown resumes the same bound thread and profile', async t => {
  const { context, children, create } = await fixture(t);
  const codex = create();
  codex.setSettings({ enabled: true, model: 'gpt-5.4', instructions: '和 {{viewerName}} 一起看。' });
  codex.start('http://127.0.0.1:4182');
  const [child] = children;
  child.emit('message', { type: 'thread', roomId: 'room-a', threadId: 'thread-1', accountId: 'account-1' });
  assert.deepEqual(child.sent.at(-1), { type: 'thread-saved', roomId: 'room-a', threadId: 'thread-1' });
  const closed = codex.close();
  const cursors = { messageId: 41, mediaMs: 8000, seekVersion: 3 };
  child.emit('message', { type: 'observed', roomId: 'room-a', threadId: 'thread-1', turnId: 'turn-1', batchId: 'batch-1', cursors });
  assert.deepEqual(child.sent.at(-1), { type: 'observed-saved', roomId: 'room-a', threadId: 'thread-1', turnId: 'turn-1', batchId: 'batch-1' });
  child.finish();
  await closed;
  context.profile = 'ai-b';
  context.viewer = '新昵称';
  const restarted = create();
  restarted.setSettings({ authMode: 'isolated', model: 'gpt-5.5', instructions: '下一场的指令。' });
  restarted.start('http://127.0.0.1:4182');
  const start = children[1].sent[0];
  assert.equal(start.threadId, 'thread-1');
  assert.equal(start.accountId, 'account-1');
  assert.deepEqual(start.cursors, cursors);
  assert.equal(start.config.profileId, 'ai-a');
  assert.equal(start.config.authMode, 'inherit');
  assert.equal(start.config.model, 'gpt-5.4');
  assert.equal(start.config.viewerName, '新昵称');
  assert.equal(start.config.instructions, '和 {{viewerName}} 一起看。');
  assert.equal(restarted.settings().instructions, '下一场的指令。');
  const final = restarted.close();
  children[1].finish();
  await final;
});

test('selecting a missing profile and correcting unbound preferences starts with the new values', async t => {
  const { context, children, create } = await fixture(t);
  const codex = create();
  context.profile = null;
  codex.setSettings({ enabled: true });
  codex.start('http://127.0.0.1:4182');
  assert.equal(codex.needsProfile(), true);
  context.profile = 'ai-b';
  codex.reconcile({ retry: true });
  const [first] = children;
  assert.equal(first.sent[0].config.profileId, 'ai-b');
  codex.setSettings({ authMode: 'isolated' });
  assert.deepEqual(first.sent.at(-1), { type: 'stop' });
  first.finish();
  const [, second] = children;
  assert.equal(second.sent[0].config.authMode, 'isolated');
  assert.equal(second.sent[0].threadId, undefined);
  const closed = codex.close();
  second.finish();
  await closed;
});

test('a room opening is private, survives a pending start, and keeps its delivery checkpoint across restart', async t => {
  const { context, children, db, create } = await fixture(t);
  const film = { mediaId: 'fixture-film', mediaTitle: 'Fixture Film' };
  const archived = openSession(db, film);
  endSession(db, archived.id, { lastPositionMs: 7000 });
  const resume = { roomId: archived.id, lastPositionMs: 7000 };
  const openingMessage = 'Ready to watch?\nLet’s start.';
  const codex = create();
  context.room = null;
  context.profile = null;
  codex.setSettings({ enabled: true, openingPrompt: 'Old global opening' });
  codex.start('http://127.0.0.1:4182');
  context.room = openSession(db, { ...film, openingMessage, resume });
  const { id } = context.room;
  codex.reconcile();
  assert.equal(codex.needsProfile(), true);
  assert.equal(children.length, 0);
  assert.equal(context.room.openingMessage, undefined);
  assert.deepEqual(listSessionMessages(db, id), []);
  assert.throws(() => openSession(db, { ...film, openingMessage: 'Second opening' }), /already open/);
  await codex.close();

  const resumed = create();
  context.profile = 'ai-a';
  resumed.start('http://127.0.0.1:4182');
  const [child] = children;
  const [start] = child.sent;
  assert.equal(start.config.openingMessage, openingMessage);
  assert.equal(start.config.resumeFromMs, 7000);
  assert.equal(start.config.openingPrompt, undefined);
  assert.equal(start.openingDelivered, false);
  child.emit('message', { type: 'thread', roomId: id, threadId: 'thread-1' });
  const cursors = { messageId: 41, mediaMs: 8000, seekVersion: 3 };
  child.emit('message', { type: 'observed', roomId: id, threadId: 'thread-1', cursors });
  child.emit('message', { type: 'observed', roomId: id, threadId: 'thread-1',
    turnId: 'opening-turn', batchId: 'opening-batch', openingDelivered: true });
  assert.deepEqual(child.sent.at(-1), {
    type: 'observed-saved', roomId: id, threadId: 'thread-1', turnId: 'opening-turn', batchId: 'opening-batch'
  });
  const closed = resumed.close();
  child.finish();
  await closed;

  const restarted = create();
  restarted.start('http://127.0.0.1:4182');
  const [, restartedChild] = children;
  assert.equal(restartedChild.sent[0].openingDelivered, true);
  assert.equal(restartedChild.sent[0].config.resumeFromMs, 7000);
  assert.deepEqual(restartedChild.sent[0].cursors, cursors);
  endSession(db, id);
  assert.equal(getRoomOpeningMessage(db, id), null);
  context.room = openSession(db, film);
  restarted.reconcile();
  restartedChild.finish();
  const [, , newChild] = children;
  assert.equal(newChild.sent[0].config.openingMessage, null);
  assert.equal(newChild.sent[0].config.resumeFromMs, null);
  assert.equal(newChild.sent[0].openingDelivered, false);
  assert.equal(restarted.settings().openingPrompt, 'Old global opening');
  const final = restarted.close();
  newChild.finish();
  await final;
});
