import { createHash } from 'node:crypto';

function conflict(message, code = 'CLEANUP_CHANGED') {
  return Object.assign(new Error(message), { code, status: 409, statusCode: 409 });
}

export function initializeFilmCleanup(db) {
  db.exec(`create table if not exists film_cleanup_receipts (
    id text primary key, payload text not null
  )`);
}

function transaction(db, mode, fn) {
  db.exec('begin ' + mode);
  try {
    const result = fn();
    db.exec('commit');
    return result;
  } catch (error) {
    db.exec('rollback');
    throw error;
  }
}

const catalog = `
  with identities(id) as (
    select id from media union select media_id from watch_sessions union select media_id from notebook_revisions
  )
  select i.id, coalesce(m.title, (select s.media_title from watch_sessions s where s.media_id=i.id
      order by s.opened_at desc, s.id desc limit 1), '影片手记') as title,
    m.relative_path as relativePath, coalesce(m.present,0) as present
  from identities i left join media m on m.id=i.id`;

export function knownCleanupFilms(db) {
  return db.prepare(catalog + ' order by i.id').all().map(row => ({ ...row, present: Boolean(row.present) }));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// Stream immutable revisions and room children through the hash, keeping large transcripts out of receipts.
function hashRows(hash, rows) {
  let count = 0;
  hash.update('[');
  for (const row of rows) {
    hash.update(JSON.stringify(row)).update('\n');
    count++;
  }
  hash.update(']');
  return count;
}

function roomRecord(db, room, mediaTitle) {
  const hash = createHash('sha256').update(JSON.stringify(room));
  const rows = query => db.prepare(query).iterate(room.id);
  const messageCount = hashRows(hash, rows('select * from watch_messages where session_id=? order by id'));
  const observationCount = hashRows(hash, rows('select * from watch_observations where session_id=? order by id'));
  const frameCount = hashRows(hash, rows(`select f.* from watch_observation_frames f join watch_observations o
    on o.id=f.observation_id where o.session_id=? order by f.id`));
  hashRows(hash, rows('select * from notebook_change_events where room_id=? order by id'));
  if (db.prepare("select 1 from sqlite_schema where name='notebook_peeks' and type='table'").get()) {
    hashRows(hash, rows('select request_id from notebook_peeks where room_id=? order by request_id'));
  }
  return { id: room.id, mediaId: room.media_id, mediaTitle, openedAt: room.opened_at, endedAt: room.ended_at,
    status: room.status, messageCount, observationCount, frameCount, revision: hash.digest('hex') };
}

function bookFingerprint(db, id, versionCutoff, eventCutoff) {
  const hash = createHash('sha256');
  const notebookRevisionCount = hashRows(hash, db.prepare(
    'select * from notebook_revisions where media_id=? and version<=? order by version').iterate(id,versionCutoff));
  hashRows(hash, db.prepare('select * from notebook_change_events where media_id=? and id<=? order by id').iterate(id,eventCutoff));
  return { notebookRevisionCount, notebookRevision: hash.digest('hex') };
}

function bookRecord(db, id) {
  const { versionCutoff, eventCutoff, notebookEntryCount } = db.prepare(`
    select (select coalesce(max(version),0) from notebook_revisions where media_id=?) versionCutoff,
      (select coalesce(max(id),0) from notebook_change_events where media_id=?) eventCutoff,
      (select count(*) from notebook_revisions where deleted=0 and version in
        (select max(version) from notebook_revisions where media_id=? group by entry_id)) notebookEntryCount`).get(id,id,id);
  return { notebookEntryCount, versionCutoff, eventCutoff, ...bookFingerprint(db, id, versionCutoff, eventCutoff) };
}

function snapshot(db, mediaIds) {
  const lookup = new Map(knownCleanupFilms(db).map(f => [f.id, f]));
  if (!Array.isArray(mediaIds) || new Set(mediaIds).size !== mediaIds.length) throw new TypeError('影片选择无效。');
  const films = [...mediaIds].sort().map(mediaId => {
    const film = lookup.get(mediaId);
    if (!film) throw conflict('影片记录已变化，请重新查看清理范围。');
    const rooms = db.prepare('select * from watch_sessions where media_id=? order by opened_at,id').all(mediaId)
      .map(room => roomRecord(db, room, film.title));
    const total = key => rooms.reduce((sum, room) => sum + room[key], 0);
    return { mediaId, title: film.title, relativePath: film.relativePath, present: film.present,
      rooms, roomCount: rooms.length, activeRoomCount: rooms.filter(r => r.status === 'active').length,
      messageCount: total('messageCount'), observationCount: total('observationCount'), frameCount: total('frameCount'),
      roomsRevision: digest(rooms), ...bookRecord(db, mediaId) };
  });
  return { films, revision: digest(films) };
}

export function previewCleanupRecords(db, mediaIds) {
  return transaction(db, 'deferred', () => snapshot(db, mediaIds));
}

export function pendingCleanups(db) {
  return db.prepare('select payload from film_cleanup_receipts order by rowid').all().map(row => JSON.parse(row.payload));
}

export function approveCleanup(db, { id, preview, scopes, filesystem }) {
  const records = scopes?.records ?? (scopes?.rooms === scopes?.notebook ? scopes?.rooms : undefined);
  if (typeof id !== 'string' || !id.length || id.length > 128 || !Array.isArray(preview?.films)
      || typeof records !== 'boolean') {
    throw new TypeError('清理确认资料无效。');
  }
  return transaction(db, 'immediate', () => {
    const ids = preview.films.map(f => f.mediaId);
    const current = snapshot(db, ids);
    const approved = new Map(preview.films.map(f => [f.mediaId, f]));
    for (const f of current.films) {
      if (f.activeRoomCount) throw conflict('请先结束正在放映的房间。', 'ROOM_ACTIVE');
      const old = approved.get(f.mediaId);
      if (old.title !== f.title || old.relativePath !== f.relativePath || old.present !== f.present
          || (records && old.roomsRevision !== f.roomsRevision)
          || (records && old.notebookRevision !== f.notebookRevision)) {
        throw conflict('预览后的清理范围已变化，请重新预览。');
      }
    }
    const receipt = { id, scopes: { records }, preview: current, filesystem };
    for (const pending of pendingCleanups(db)) {
      if (pending.id === id || pending.preview.films.some(f => approved.has(f.mediaId))) {
        throw conflict('这些资料已有清理任务等待完成。', 'CLEANUP_BUSY');
      }
    }
    db.prepare('insert into film_cleanup_receipts(id,payload) values(?,?)').run(id, JSON.stringify(receipt));
    return receipt;
  });
}

// The coordinator may discard an approval only while its filesystem phase is known to be untouched.
export function cancelCleanup(db, id) {
  return Boolean(db.prepare('delete from film_cleanup_receipts where id=?').run(id).changes);
}

function eraseRoom(db, id) {
  db.prepare('delete from notebook_change_events where room_id=?').run(id);
  if (db.prepare("select 1 from sqlite_schema where name='notebook_peeks' and type='table'").get()) {
    db.prepare('delete from notebook_peeks where room_id=?').run(id);
  }
  db.prepare("delete from watch_sessions where id=? and status='ended'").run(id);
}

function roomSnapshot(db, room) {
  if (room.status !== 'ended') throw conflict('请先结束当前房间。', 'ROOM_ACTIVE');
  const [film] = snapshot(db, [room.media_id]).films;
  const revision = digest([room.id, film.title, film.roomsRevision, film.notebookRevision]);
  const target = film.rooms.find(value => value.id === room.id);
  return { roomId: room.id, mediaId: film.mediaId, title: film.title, openedAt: target.openedAt,
    messageCount: target.messageCount, revision, lastRoom: film.roomCount === 1, roomCount: film.roomCount,
    entryCount: film.notebookEntryCount, notebookRevisionCount: film.notebookRevisionCount };
}

export function previewRoomCleanup(db, roomId) {
  return transaction(db, 'deferred', () => {
    const room = db.prepare('select * from watch_sessions where id=?').get(roomId);
    if (!room) throw Object.assign(new Error('找不到这次放映记录。'), { code:'ROOM_NOT_FOUND', status:404, statusCode:404 });
    return roomSnapshot(db, room);
  });
}

export function deleteRoomWithNotebook(db, roomId, expectedRevision) {
  return transaction(db, 'immediate', () => {
    const room = db.prepare('select * from watch_sessions where id=?').get(roomId);
    if (!room) return { roomId, deleted:false, lastRoom:false, notebookDeleted:false };
    if (pendingCleanups(db).some(receipt => receipt.preview.films.some(f => f.mediaId === room.media_id))) {
      throw conflict('此片已有清理任务等待完成。', 'CLEANUP_BUSY');
    }
    const preview = roomSnapshot(db, room);
    if (expectedRevision !== preview.revision) throw conflict('房间或手记已变化，请重新预览。');
    eraseRoom(db, roomId);
    if (preview.lastRoom) {
      db.prepare('delete from notebook_change_events where media_id=?').run(room.media_id);
      db.prepare('delete from notebook_revisions where media_id=?').run(room.media_id);
    }
    return { roomId, deleted:true, lastRoom:preview.lastRoom, notebookDeleted:preview.lastRoom && preview.notebookRevisionCount > 0 };
  });
}

export function finishCleanup(db, id) {
  return transaction(db, 'immediate', () => {
    const row = db.prepare('select payload from film_cleanup_receipts where id=?').get(id);
    if (!row) return { id, completed: false };
    const { preview, scopes } = JSON.parse(row.payload);
    for (const film of preview.films) {
      if (db.prepare("select 1 from watch_sessions where media_id=? and status='active'").get(film.mediaId)) {
        throw conflict('影片正在放映，清理尚未完成。', 'ROOM_ACTIVE');
      }
      if (scopes.records) {
        const prior = bookFingerprint(db, film.mediaId, film.versionCutoff, film.eventCutoff);
        if (prior.notebookRevision !== film.notebookRevision) throw conflict('手记的已确认内容发生变化，已保留记录。');
        for (const approved of film.rooms) {
          const room = db.prepare('select * from watch_sessions where id=?').get(approved.id);
          if (!room) continue;
          if (room.status !== 'ended' || room.media_id !== film.mediaId
              || roomRecord(db, room, film.title).revision !== approved.revision) {
            throw conflict('历史房间新增或修改了内容，已保留记录。');
          }
          eraseRoom(db, room.id);
        }
        // Both tables are append-only with AUTOINCREMENT keys. A post-approval revision stores its complete entry.
        db.prepare('delete from notebook_change_events where media_id=? and id<=?').run(film.mediaId, film.eventCutoff);
        db.prepare('delete from notebook_revisions where media_id=? and version<=?').run(film.mediaId, film.versionCutoff);
      }
    }
    db.prepare('delete from film_cleanup_receipts where id=?').run(id);
    return { id, completed: true };
  });
}
