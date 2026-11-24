import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { addSessionMessage, deleteArchivedRoom, endSession, getSession,
  listIndexedMedia, listSessionMessages, openDatabase, openSession, syncMediaIndex } from '../../src/storage/database.mjs';
import { initializeNotebook, readNotebook, writeNotebook } from '../../src/storage/notebook.mjs';

test('delete one ended screening atomically and retain the shared film notebook and other screenings', t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  initializeNotebook(db);
  db.exec('create table notebook_peeks(room_id text, request_id text, primary key(room_id,request_id))');
  const film = { id: 'a'.repeat(24), title: 'First title', relativePath: 'episode/movie.mp4',
    extension: '.mp4', size: 123, modifiedAt: new Date().toISOString() };
  syncMediaIndex(db, [film]);
  const open = () => openSession(db, { mediaId: film.id, mediaTitle: film.title });
  const first = open();
  const entry = writeNotebook(db, first, { text: 'First impression' }, { kind: 'ai', id: 'author' });
  writeNotebook(db, first, { id: entry.id, expectedVersion: entry.version, text: 'Shared impression' }, { kind: 'user', id: 'viewer' });
  addSessionMessage(db, first.id, { content: 'first screening', mediaTimeMs: 0 });
  db.prepare('insert into notebook_peeks values (?,?)').run(first.id, 'peek1');
  const observation = db.prepare(`insert into watch_observations(session_id,sequence_no,from_ms,to_ms,kind,engine,metrics_json,created_at)
    values(?,1,0,1,'motion','test','{}','now')`).run(first.id);
  db.prepare(`insert into watch_observation_frames(observation_id,media_time_ms,relative_path,frame_reason,created_at)
    values(?,0,'frame.jpg','motion','now')`).run(observation.lastInsertRowid);
  endSession(db, first.id);

  const second = open();
  addSessionMessage(db, second.id, { content: 'second screening', mediaTimeMs: 0 });
  db.prepare('insert into notebook_peeks values (?,?)').run(second.id, 'peek2');
  assert.throws(() => deleteArchivedRoom(db, second.id), { code: 'ROOM_ACTIVE' });
  const count = table => db.prepare(`select count(*) as n from ${table}`).get().n;
  const eventCount = count('notebook_change_events');
  assert.ok(eventCount > 0);
  db.exec("create trigger test_rollback before delete on watch_sessions begin select raise(abort,'injected'); end");
  assert.throws(() => deleteArchivedRoom(db, first.id), /injected/);
  assert.equal(count('notebook_change_events'), eventCount);
  assert.equal(count('notebook_peeks'), 2);
  db.exec('drop trigger test_rollback');

  assert.deepEqual(deleteArchivedRoom(db, first.id), { roomId: first.id, deleted: true });
  assert.deepEqual(deleteArchivedRoom(db, first.id), { roomId: first.id, deleted: false });
  assert.equal(getSession(db, first.id), null);
  assert.equal(count('watch_observations'), 0);
  assert.equal(count('watch_observation_frames'), 0);
  assert.equal(count('notebook_change_events'), 0);
  assert.deepEqual(db.prepare('select room_id from notebook_peeks').all().map(row => row.room_id), [second.id]);
  assert.equal(getSession(db, second.id).status, 'active');
  assert.equal(listSessionMessages(db, second.id)[0].content, 'second screening');
  assert.equal(readNotebook(db, film.id, 0).entries[0].text, 'Shared impression');
  assert.equal(listIndexedMedia(db)[0].id, film.id);

  endSession(db, second.id);
  syncMediaIndex(db, [{ ...film, title: 'Latest title' }]);
  syncMediaIndex(db, []);
  assert.equal(getSession(db, second.id).mediaTitle, 'Latest title');
  assert.equal(readNotebook(db, film.id, 0).entries[0].text, 'Shared impression');
});

test('archived HTTP notebooks remain readable without the movie and reject live actions', { timeout: 12000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cinema-archive-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = join(root, '影院记录');
  await mkdir(records);
  const db = openDatabase(join(records, 'open-watch-cinema.sqlite'));
  initializeNotebook(db);
  const room = openSession(db, { mediaId: 'b'.repeat(24), mediaTitle: 'Released film' });
  writeNotebook(db, room, { kind: 'character', name: '旅人' });
  endSession(db, room.id);
  db.close();

  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(done => probe.close(done));
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: resolve(import.meta.dirname, '../..'),
    env: { ...process.env, PORT: String(port), OPEN_BROWSER: '0', LOCAL_DATA_ROOT: root }, stdio: 'ignore' });
  const exit = once(child, 'exit');
  t.after(async () => { child.kill(); await exit; });
  const deadline = Date.now() + 8000;
  while (!(await fetch(base + '/api/health').then(r => r.ok, () => false))) {
    if (child.exitCode !== null || Date.now() >= deadline) throw new Error('Isolated cinema failed to start');
    await delay(40);
  }
  const api = base + '/api/rooms/' + room.id;
  const read = await fetch(api + '/notebook');
  assert.equal(read.status, 200);
  const notebook = await read.json();
  assert.equal(notebook.readOnly, true);
  assert.equal(notebook.entries[0].name, '旅人');
  for (const path of ['/notebook', '/notebook/peek', '/ai-tick']) {
    assert.equal((await fetch(api + path, { method: 'POST', body: '{}' })).status, 409);
  }
  assert.equal((await fetch(base + '/api/ai/notebook')).status, 409);
  assert.equal((await fetch(base + '/api/ai/tick', { method: 'POST', body: '{}' })).status, 409);
});
