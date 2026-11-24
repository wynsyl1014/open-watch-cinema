import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openDatabase, openSession, endSession, addSessionMessage, getSession, syncMediaIndex } from '../../src/storage/database.mjs';
import { initializeNotebook, readNotebook, writeNotebook } from '../../src/storage/notebook.mjs';
import { approveCleanup, cancelCleanup, finishCleanup, initializeFilmCleanup, knownCleanupFilms, pendingCleanups,
  previewCleanupRecords, previewRoomCleanup, deleteRoomWithNotebook } from '../../src/storage/film-cleanup.mjs';

const first = 'a'.repeat(24), second = 'b'.repeat(24);
const stamp = '2026-11-22T09:00:00.000Z';
const source = id => ({ id, title: id===first ? '甲' : '乙', relativePath: '系列/一/' + id + '.mp4', extension: '.mp4',
  size: 100, modifiedAt: stamp });
const actor = { kind:'user', id:'viewer' };
function initialized(path = ':memory:') {
  const db = openDatabase(path);
  initializeNotebook(db);
  initializeFilmCleanup(db);
  db.exec('create table if not exists notebook_peeks(room_id text,request_id text,primary key(room_id,request_id))');
  return db;
}
function watched(db, id) {
  const room = openSession(db,{mediaId:id,mediaTitle:source(id).title});
  addSessionMessage(db,room.id,{mediaTimeMs:1,content:'留言'});
  const entry = writeNotebook(db,room,{text:'旧句'},actor);
  writeNotebook(db,room,{id:entry.id,expectedVersion:entry.version,text:'改句'},actor);
  db.prepare('insert into notebook_peeks values(?,?)').run(room.id,'request');
  endSession(db,room.id);
  return room;
}
const request = (db, mediaIds, records = true, id = 'batch') =>
  ({id,scopes:{records},filesystem:{scope:'folder',relativePath:'系列'},preview:previewCleanupRecords(db,mediaIds)});

test('previews include missing films by last catalog path, reject changed records, and protect active rooms', t => {
  const db = initialized(); t.after(()=>db.close());
  syncMediaIndex(db,[source(first), source(second)]);
  const room = watched(db,first);
  syncMediaIndex(db,[source(second)]);
  assert.equal(knownCleanupFilms(db).find(f=>f.id===first).relativePath, source(first).relativePath);
  assert.equal(knownCleanupFilms(db).find(f=>f.id===first).present, false);
  const original = request(db,[first]);
  const [film] = original.preview.films;
  assert.equal(film.roomCount,1); assert.equal(film.notebookRevisionCount,2); assert.equal(film.notebookEntryCount,1);
  assert.equal(film.rooms[0].id,room.id); assert.equal(film.rooms[0].messageCount,1);
  const changed = openSession(db,{mediaId:first,mediaTitle:'甲'});
  assert.throws(()=>approveCleanup(db,original),{code:'ROOM_ACTIVE'});
  endSession(db,changed.id);
  assert.throws(()=>approveCleanup(db,original),{code:'CLEANUP_CHANGED'});
  const clean = request(db,[first]);
  approveCleanup(db,clean);
  assert.throws(()=>approveCleanup(db,{...clean,id:'overlap'}),{code:'CLEANUP_BUSY'});
  assert.equal(cancelCleanup(db,clean.id),true);
  assert.equal(getSession(db,room.id).id,room.id);
  assert.equal(readNotebook(db,first,0).entries.length,1);
});

test('reopened receipts clean only approved rooms and revision ranges while preserving newer writes and identities',async t=>{
  const root = await mkdtemp(join(tmpdir(),'cinema-cleanup-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'cinema.sqlite');
  let db=initialized(path);
  syncMediaIndex(db,[source(first),source(second)]);
  const old=watched(db,first), untouched=watched(db,second);
  const identityCount=db.prepare('select count(*) n from cinema_participants').get().n;
  const approved=request(db,[first]);
  approveCleanup(db,approved);
  db.close();
  db=initialized(path); t.after(()=>db.close());
  assert.deepEqual(pendingCleanups(db)[0].filesystem,approved.filesystem);
  const newer=watched(db,first);
  const saved=readNotebook(db,first,0).entries.find(e=>e.sourceRoomId===newer.id);
  assert.deepEqual(finishCleanup(db,'batch'),{id:'batch',completed:true});
  assert.deepEqual(finishCleanup(db,'batch'),{id:'batch',completed:false});
  assert.equal(getSession(db,old.id),null);
  assert.ok(getSession(db,newer.id));
  assert.ok(getSession(db,untouched.id));
  assert.deepEqual(readNotebook(db,first,0).entries.map(e=>e.id),[saved.id]);
  assert.equal(db.prepare('select count(*) n from notebook_revisions where media_id=? and version<=?')
    .get(first,approved.preview.films[0].versionCutoff).n,0);
  assert.equal(db.prepare('select count(*) n from notebook_change_events where room_id=?').get(newer.id).n,1);
  assert.equal(db.prepare('select count(*) n from notebook_peeks where room_id=?').get(old.id).n,0);
  assert.equal(db.prepare('select count(*) n from cinema_participants').get().n,identityCount);
  assert.equal(knownCleanupFilms(db).find(f=>f.id===first).id,first);
  assert.deepEqual(pendingCleanups(db),[]);
});

test('changed approved room children prevent a batch cascade and its durable receipt survives rollback',t=>{
  const db=initialized();t.after(()=>db.close());
  syncMediaIndex(db,[source(first),source(second)]);
  const a=watched(db,first), b=watched(db,second);
  const approval=request(db,[first,second]);
  approveCleanup(db,approval);
  db.prepare('insert into notebook_peeks values(?,?)').run(b.id,'later');
  assert.throws(()=>finishCleanup(db,approval.id),{code:'CLEANUP_CHANGED'});
  assert.ok(getSession(db,a.id));assert.ok(getSession(db,b.id));
  assert.equal(readNotebook(db,first,0).entries.length,1);
  assert.equal(pendingCleanups(db).length,1);
});

test('single room confirmation follows current sibling count and deletes all notebook versions only with the final room', t => {
  const db=initialized();t.after(()=>db.close());
  syncMediaIndex(db,[source(first),source(second)]);
  const one=watched(db,first), otherFilm=watched(db,second);
  const original=previewRoomCleanup(db,one.id);
  assert.equal(original.lastRoom,true);
  const another=watched(db,first);
  assert.throws(()=>deleteRoomWithNotebook(db,one.id,original.revision),{code:'CLEANUP_CHANGED'});
  const updated=previewRoomCleanup(db,one.id);
  assert.equal(updated.lastRoom,false);
  assert.equal(deleteRoomWithNotebook(db,one.id,updated.revision).notebookDeleted,false);
  assert.equal(readNotebook(db,first,0).entries.length,2);
  const final=previewRoomCleanup(db,another.id);
  assert.equal(final.lastRoom,true);
  assert.equal(final.notebookRevisionCount,4);
  assert.equal(deleteRoomWithNotebook(db,another.id,final.revision).notebookDeleted,true);
  assert.equal(deleteRoomWithNotebook(db,another.id,final.revision).deleted,false);
  assert.equal(db.prepare('select count(*) n from notebook_revisions where media_id=?').get(first).n,0);
  assert.equal(db.prepare('select count(*) n from notebook_change_events where media_id=?').get(first).n,0);
  assert.equal(readNotebook(db,second,0).entries.length,1);
  assert.ok(getSession(db,otherFilm.id));
});

test('a files-only cleanup retains every room, note revision, event and film identity', t => {
  const db = initialized();
  t.after(() => db.close());
  syncMediaIndex(db, [source(first)]);
  const old = watched(db, first);
  const approval = request(db, [first], false);
  approveCleanup(db, approval);
  syncMediaIndex(db, []);
  assert.equal(finishCleanup(db, approval.id).completed, true);
  const latest = previewCleanupRecords(db, [first]).films[0];
  assert.equal(latest.present, false);
  assert.equal(latest.rooms[0].id, old.id);
  assert.equal(latest.roomsRevision, approval.preview.films[0].roomsRevision);
  assert.equal(latest.notebookRevision, approval.preview.films[0].notebookRevision);
});
