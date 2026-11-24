import { randomUUID } from 'node:crypto';
import { initializeParticipants, setParticipantName } from './participants.mjs';
import { DatabaseSync } from 'node:sqlite';

const ROOM_RESUME_KEY = 'watch_bridge_room_resume';

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`pragma table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`alter table ${tableName} add column ${columnName} ${definition}`);
  }
}

// Older installations enforce the filename across both live and historical media.
// Rebuild that table in one SQLite transaction, retaining all columns and row IDs.
function migrateMediaPathIndex(db) {
  const indexes = db.prepare("select name from pragma_index_list('media') where origin = 'u'").all();
  const legacy = indexes.some(({name}) => {
    const columns = db.prepare('select name from pragma_index_info(?)').all(name);
    return columns.length === 1 && columns[0].name === 'relative_path';
  });
  const createActiveIndex = 'create unique index if not exists media_active_path on media(relative_path) where present = 1';
  if (!legacy) {
    db.exec(createActiveIndex);
    return;
  }
  const definition = db.prepare("select sql from sqlite_schema where type = 'table' and name = 'media'").get().sql;
  const rebuilt = definition.replace(/^(create table\s+)(?:"media"|media)\s*\(/i, '$1media_path_migration (')
    .replace(/(relative_path\s+text\s+not\s+null)\s+unique/i, '$1');
  if (!rebuilt.includes('media_path_migration (') || /relative_path\s+text\s+not\s+null\s+unique/i.test(rebuilt)) {
    throw new Error('Unrecognized legacy media schema.');
  }
  const objects = db.prepare("select sql from sqlite_schema where tbl_name = 'media' and type in ('index','trigger') and sql is not null").all();
  db.exec('pragma foreign_keys = off');
  try {
    db.exec('begin immediate');
    try {
      db.exec(rebuilt);
      db.exec('insert into media_path_migration select * from media');
      db.exec('drop table media');
      db.exec('alter table media_path_migration rename to media');
      for (const {sql} of objects) db.exec(sql);
      db.exec(createActiveIndex);
      db.exec('commit');
    } catch (error) {
      db.exec('rollback');
      throw error;
    }
  } finally {
    db.exec('pragma foreign_keys = on');
  }
}

function sessionProjection() {
  return `
    select
      s.id,
      s.media_id as mediaId,
      coalesce(f.title, s.media_title) as mediaTitle,
      s.status,
      s.opened_at as openedAt,
      s.ended_at as endedAt,
      s.last_position_ms as lastPositionMs,
      (select json_extract(value, '$.lastPositionMs') from settings
       where key = '${ROOM_RESUME_KEY}' and json_extract(value, '$.roomId') = s.id) as resumeFromMs,
      s.playback_state as playbackState,
      s.playback_version as playbackVersion,
      s.seek_version as seekVersion,
      s.updated_at as updatedAt,
      count(m.id) as messageCount
    from watch_sessions s
    left join media f on f.id = s.media_id
    left join watch_messages m on m.session_id = s.id
  `;
}

export function openDatabase(databasePath) {
  const db = new DatabaseSync(databasePath);
  db.exec(`
    pragma journal_mode = WAL;
    pragma foreign_keys = ON;

    create table if not exists media (
      id text primary key,
      title text not null,
      relative_path text not null,
      extension text not null,
      byte_size integer not null,
      modified_at text not null,
      present integer not null default 1,
      scanned_at text not null
    );

    create table if not exists settings (
      key text primary key,
      value text not null,
      updated_at text not null
    );

    create table if not exists watch_sessions (
      id text primary key,
      media_id text not null,
      media_title text not null,
      status text not null check (status in ('active', 'ended')),
      opened_at text not null,
      ended_at text,
      last_position_ms integer not null default 0,
      playback_state text not null default 'paused' check (playback_state in ('playing', 'paused')),
      playback_version integer not null default 0,
      updated_at text not null
    );

    create unique index if not exists watch_sessions_one_active
      on watch_sessions(status)
      where status = 'active';

    create table if not exists watch_messages (
      id integer primary key autoincrement,
      session_id text not null references watch_sessions(id) on delete cascade,
      media_id text not null,
      sender_name text not null,
      sender_kind text not null default 'user' check (sender_kind in ('user', 'ai', 'system')),
      sender_identity text,
      content text not null,
      media_time_ms integer not null check (media_time_ms >= 0),
      created_at text not null
    );

    create index if not exists watch_messages_session_time
      on watch_messages(session_id, media_time_ms, id);

    create table if not exists watch_observations (
      id integer primary key autoincrement,
      session_id text not null references watch_sessions(id) on delete cascade,
      sequence_no integer not null,
      from_ms integer not null check (from_ms >= 0),
      to_ms integer not null check (to_ms >= from_ms),
      kind text not null,
      engine text not null,
      scene_score real not null default 0,
      motion_score real not null default 0,
      metrics_json text not null,
      created_at text not null,
      unique(session_id, sequence_no)
    );

    create index if not exists watch_observations_session_sequence
      on watch_observations(session_id, sequence_no);

    create table if not exists watch_observation_frames (
      id integer primary key autoincrement,
      observation_id integer not null references watch_observations(id) on delete cascade,
      media_time_ms integer not null check (media_time_ms >= 0),
      relative_path text not null,
      frame_reason text not null,
      perceptual_hash text,
      created_at text not null
    );
  `);

  migrateMediaPathIndex(db);
  ensureColumn(db, 'watch_messages', 'interaction', 'text');
  ensureColumn(db, 'watch_sessions', 'seek_version', 'integer not null default 0');
  ensureColumn(db, 'media', 'compatibility_status', "text not null default 'unchecked'");
  ensureColumn(db, 'media', 'container_name', 'text');
  ensureColumn(db, 'media', 'video_codec', 'text');
  ensureColumn(db, 'media', 'audio_codec', 'text');
  ensureColumn(db, 'media', 'compatibility_note', 'text');
  ensureColumn(db, 'media', 'compatibility_error', 'text');
  ensureColumn(db, 'media', 'processed_at', 'text');
  ensureColumn(db, 'watch_messages', 'sender_identity', 'text');

  db.prepare(`
    update media
    set compatibility_status = 'error',
        compatibility_error = 'Preparation was interrupted. Run it again.'
    where compatibility_status in ('checking', 'processing')
  `).run();

  initializeParticipants(db);
  return db;
}

export function syncMediaIndex(db, items) {
  const now = new Date().toISOString();
  const markMissing = db.prepare('update media set present = 0');
  const upsert = db.prepare(`
    insert into media (
      id, title, relative_path, extension, byte_size, modified_at, present, scanned_at
    ) values (?, ?, ?, ?, ?, ?, 1, ?)
    on conflict(id) do update set
      title = excluded.title,
      relative_path = excluded.relative_path,
      extension = excluded.extension,
      byte_size = excluded.byte_size,
      modified_at = excluded.modified_at,
      present = 1,
      scanned_at = excluded.scanned_at,
      compatibility_status = case
        when media.byte_size <> excluded.byte_size or media.modified_at <> excluded.modified_at
          then 'unchecked'
        else media.compatibility_status
      end,
      compatibility_error = case
        when media.byte_size <> excluded.byte_size or media.modified_at <> excluded.modified_at
          then null
        else media.compatibility_error
      end
  `);

  db.exec('begin immediate');
  try {
    markMissing.run();
    for (const item of items) {
      upsert.run(
        item.id,
        item.title,
        item.relativePath,
        item.extension,
        item.size,
        item.modifiedAt,
        now
      );
    }
    db.exec('commit');
  } catch (error) {
    db.exec('rollback');
    throw error;
  }
}

export function setMediaCompatibility(db, id, details) {
  const current = db.prepare('select id from media where id = ? and present = 1').get(id);
  if (!current) return false;

  db.prepare(`
    update media
    set compatibility_status = ?,
        container_name = ?,
        video_codec = ?,
        audio_codec = ?,
        compatibility_note = ?,
        compatibility_error = ?,
        processed_at = ?
    where id = ?
  `).run(
    details.status,
    details.containerName ?? null,
    details.videoCodec ?? null,
    details.audioCodec ?? null,
    details.note ?? null,
    details.error ?? null,
    details.processedAt ?? null,
    id
  );
  return true;
}

export function listIndexedMedia(db) {
  return db.prepare(`
    select
      id,
      title,
      relative_path as relativePath,
      extension,
      byte_size as size,
      modified_at as modifiedAt,
      compatibility_status as compatibilityStatus,
      container_name as containerName,
      video_codec as videoCodec,
      audio_codec as audioCodec,
      compatibility_note as compatibilityNote,
      compatibility_error as compatibilityError,
      processed_at as processedAt
    from media
    where present = 1
    order by title collate nocase
  `).all();
}

export function getActiveSession(db) {
  return db.prepare(`
    ${sessionProjection()}
    where s.status = 'active'
    group by s.id
    limit 1
  `).get() || null;
}

export function getSession(db, sessionId) {
  return db.prepare(`
    ${sessionProjection()}
    where s.id = ?
    group by s.id
  `).get(sessionId) || null;
}

export function listSessions(db, { limit = 40 } = {}) {
  return db.prepare(`
    ${sessionProjection()}
    group by s.id
    order by s.opened_at desc
    limit ?
  `).all(limit);
}

const OPENING_MESSAGE_KEY = 'watch_bridge_room_opening';

export function latestRoomResume(db, mediaId) {
  const room = db.prepare(`
    select media_id as mediaId, id as roomId, last_position_ms as lastPositionMs
    from watch_sessions
    where media_id = ? and status = 'ended'
    order by ended_at desc, rowid desc
    limit 1
  `).get(mediaId);
  return room?.lastPositionMs > 0 ? room : null;
}

export function getRoomOpeningMessage(db, roomId) {
  const row = db.prepare('select value from settings where key = ?').get(OPENING_MESSAGE_KEY);
  const opening = row && JSON.parse(row.value);
  return opening?.roomId === roomId ? opening.message : null;
}

export function openSession(db, { mediaId, mediaTitle, openingMessage, resume }) {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.exec('begin immediate');
  try {
    if (getActiveSession(db)) {
      throw new Error('A room is already open. End it before opening another room.');
    }
    let resumeFromMs = 0;
    if (resume) {
      const latest = latestRoomResume(db, mediaId);
      if (!latest || latest.roomId !== resume.roomId || latest.lastPositionMs !== resume.lastPositionMs) {
        throw Object.assign(new Error('续看位置已变化，请重新选择开场位置。'), { code: 'ROOM_RESUME_STALE' });
      }
      resumeFromMs = latest.lastPositionMs;
    }
    db.prepare(`
      insert into watch_sessions (
        id, media_id, media_title, status, opened_at, last_position_ms, updated_at
      ) values (?, ?, ?, 'active', ?, ?, ?)
    `).run(id, mediaId, mediaTitle, now, resumeFromMs, now);
    if (resumeFromMs > 0) {
      db.prepare(`insert into settings (key, value, updated_at) values (?, ?, ?)
        on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`)
        .run(ROOM_RESUME_KEY, JSON.stringify({ roomId: id, lastPositionMs: resumeFromMs }), now);
    }
    if (openingMessage) {
      db.prepare(`insert into settings (key, value, updated_at) values (?, ?, ?)
        on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`)
        .run(OPENING_MESSAGE_KEY, JSON.stringify({ roomId: id, message: openingMessage }), now);
    }
    db.exec('commit');
  } catch (error) {
    db.exec('rollback');
    throw error;
  }
  return getSession(db, id);
}

export function endSession(db, sessionId, { lastPositionMs } = {}) {
  const session = getSession(db, sessionId);
  if (!session) throw new Error('Room not found.');
  if (session.status === 'ended') return session;

  const now = new Date().toISOString();
  db.exec('begin immediate');
  try {
    db.prepare(`
      update watch_sessions
      set status = 'ended',
          ended_at = ?,
          last_position_ms = coalesce(?, last_position_ms),
          playback_state = 'paused',
          playback_version = playback_version + 1,
          updated_at = ?
      where id = ? and status = 'active'
    `).run(now, lastPositionMs === undefined ? null : Math.max(0, Math.round(lastPositionMs)), now, sessionId);
    db.prepare("delete from settings where key in (?, ?) and json_extract(value, '$.roomId') = ?")
      .run(OPENING_MESSAGE_KEY, ROOM_RESUME_KEY, sessionId);
    db.exec('commit');
  } catch (error) {
    db.exec('rollback');
    throw error;
  }
  return getSession(db, sessionId);
}

export function deleteArchivedRoom(db, roomId) {
  db.exec('begin immediate');
  try {
    const room = db.prepare('select status from watch_sessions where id = ?').get(roomId);
    if (room && room.status !== 'ended') {
      throw Object.assign(new Error('请先结束当前房间，再删除这次观影记录。'),
        { status: 409, statusCode: 409, code: 'ROOM_ACTIVE' });
    }
    if (room) {
      const exists = db.prepare("select 1 from sqlite_schema where type = 'table' and name = ?");
      for (const table of ['notebook_change_events', 'notebook_peeks']) {
        if (exists.get(table)) db.prepare(`delete from ${table} where room_id = ?`).run(roomId);
      }
      db.prepare("delete from watch_sessions where id = ? and status = 'ended'").run(roomId);
    }
    db.exec('commit');
    return { roomId, deleted: Boolean(room) };
  } catch (error) {
    db.exec('rollback');
    throw error;
  }
}

export function updateSessionPlayback(db, sessionId, {
  mediaTimeMs,
  playbackState,
  seeked = false
}) {
  const session = getSession(db, sessionId);
  if (!session) throw new Error('Room not found.');
  if (session.status !== 'active') throw new Error('Archived rooms are read-only.');

  const normalizedState = playbackState === 'playing' ? 'playing' : 'paused';
  const now = new Date().toISOString();
  db.prepare(`
    update watch_sessions
    set last_position_ms = ?,
        playback_state = ?,
        playback_version = playback_version + 1,
        seek_version = seek_version + ?,
        updated_at = ?
    where id = ? and status = 'active'
  `).run(Math.max(0, Math.round(mediaTimeMs)), normalizedState, seeked ? 1 : 0, now, sessionId);
  return getSession(db, sessionId);
}

const messageProjection = `
  select m.id, m.session_id as sessionId, m.media_id as mediaId,
    case when p.id is not null then coalesce(nullif(p.display_name,''), case p.kind when 'user' then 'user' else 'AI' end)
         when m.sender_kind='user' and m.sender_identity='viewer' then 'user'
         else m.sender_name end as senderName,
    m.sender_kind as senderKind, m.sender_identity as senderIdentity,
    m.content, m.interaction, m.media_time_ms as mediaTimeMs, m.created_at as createdAt
  from watch_messages m left join cinema_participants p
    on p.kind=m.sender_kind and p.id=m.sender_identity
`;

export function listSessionMessages(db, sessionId, { afterId = 0, limit = null, ids = null } = {}) {
  if (ids !== null) {
    if (!Array.isArray(ids) || ids.length > 250 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) {
      throw new TypeError('Expected at most 250 positive message IDs.');
    }
    return db.prepare(messageProjection + ' where m.session_id = ? and m.id in (select value from json_each(?)) order by m.id')
      .all(sessionId, JSON.stringify(ids));
  }
  const normalizedAfterId = Math.max(0, Math.round(Number(afterId) || 0));
  const projection = messageProjection + ' where m.session_id = ? and m.id > ? order by m.id';
  if (limit === null || limit === undefined) {
    return db.prepare(projection).all(sessionId, normalizedAfterId);
  }
  const normalizedLimit = Math.max(1, Math.min(500, Math.round(Number(limit) || 1)));
  return db.prepare(`${projection}\nlimit ?`).all(sessionId, normalizedAfterId, normalizedLimit);
}

export function addSessionMessage(db, sessionId, {
  senderName,
  senderKind = 'user',
  senderIdentity = null,
  content,
  interaction = null,
  mediaTimeMs
}) {
  const session = getSession(db, sessionId);
  if (!session) throw new Error('Room not found.');
  if (session.status !== 'active') throw new Error('Archived rooms are read-only.');

  const cleanName = String(senderName || '').trim().slice(0, 60);
  const cleanIdentity = String(senderIdentity || '').trim().slice(0, 120) || null;
  const actions = { popcorn: '递来一桶爆米花 🍿', cola: '递来一杯可乐 🥤', cheers: '举杯碰一碰 🥂', notebook_peek: '翻开了你的小本本 📖' };
  if (interaction !== null && !Object.hasOwn(actions, interaction)) throw new Error('Unknown cinema interaction.');
  if (interaction && !getInteractionSettings(db).enabled) throw new Error('Cinema interactions are switched off.');
  const cleanContent = interaction ? actions[interaction] : String(content || '').trim().slice(0, 800);
  const cleanKind = ['user', 'ai', 'system'].includes(senderKind) ? senderKind : 'user';
  if (!cleanName && cleanKind !== 'user' && !cleanIdentity) throw new Error('A sender name is required.');
  if (!cleanContent) throw new Error('Message content is required.');

  const actorId = cleanKind === 'user' ? 'viewer' : cleanKind === 'ai' ? cleanIdentity : null;
  // A first visit can post with the fallback label before the viewer has chosen a name.
  const fallbackViewer = cleanKind === 'user' && ['', 'user', 'Viewer'].includes(cleanName);
  if (actorId && !fallbackViewer) {
    setParticipantName(db, { kind: cleanKind, id: actorId }, cleanName, { initializeOnly: true });
  }
  const now = new Date().toISOString();
  const result = db.prepare(`
    insert into watch_messages (
      session_id, media_id, sender_name, sender_kind, sender_identity, content, interaction, media_time_ms, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    session.mediaId,
    actorId ? '' : cleanName,
    cleanKind,
    actorId,
    cleanContent,
    interaction,
    Math.max(0, Math.round(mediaTimeMs)),
    now
  );

  return db.prepare(messageProjection + ' where m.id = ?').get(result.lastInsertRowid);
}

function hydrateObservation(row) {
  return {
    ...row,
    metrics: JSON.parse(row.metricsJson),
    metricsJson: undefined
  };
}

export function listSessionObservations(db, sessionId, { afterSequence = 0, limit = 200 } = {}) {
  return db.prepare(`
    select
      id,
      session_id as sessionId,
      sequence_no as sequenceNo,
      from_ms as fromMs,
      to_ms as toMs,
      kind,
      engine,
      scene_score as sceneScore,
      motion_score as motionScore,
      metrics_json as metricsJson,
      created_at as createdAt
    from watch_observations
    where session_id = ? and sequence_no > ?
    order by sequence_no
    limit ?
  `).all(sessionId, Math.max(0, Math.round(afterSequence)), Math.max(1, Math.min(500, Math.round(limit))))
    .map(hydrateObservation);
}

export function addSessionObservations(db, sessionId, { engine, observations }) {
  const session = getSession(db, sessionId);
  if (!session) throw new Error('Room not found.');
  if (session.status !== 'active') throw new Error('Archived rooms are read-only.');
  if (!Array.isArray(observations) || observations.length === 0) return [];

  const next = db.prepare(`
    select coalesce(max(sequence_no), 0) + 1 as nextSequence
    from watch_observations
    where session_id = ?
  `).get(sessionId).nextSequence;
  const insert = db.prepare(`
    insert into watch_observations (
      session_id, sequence_no, from_ms, to_ms, kind, engine,
      scene_score, motion_score, metrics_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();

  db.exec('begin immediate');
  try {
    observations.forEach((observation, index) => {
      const fromMs = Math.max(0, Math.round(Number(observation.fromMs) || 0));
      const toMs = Math.max(fromMs, Math.round(Number(observation.toMs) || fromMs));
      insert.run(
        sessionId,
        next + index,
        fromMs,
        toMs,
        String(observation.kind || 'heartbeat').slice(0, 80),
        String(engine || 'unknown').slice(0, 120),
        Math.max(0, Math.min(1, Number(observation.sceneScore) || 0)),
        Math.max(0, Math.min(1, Number(observation.motionScore) || 0)),
        JSON.stringify(observation.metrics || {}),
        now
      );
    });
    db.exec('commit');
  } catch (error) {
    db.exec('rollback');
    throw error;
  }

  return listSessionObservations(db, sessionId, { afterSequence: next - 1, limit: observations.length });
}

export function getMediaCascadeSummary(db, mediaId) {
  const sessionCounts = db.prepare(`
    select
      count(*) as sessionCount,
      sum(case when status = 'active' then 1 else 0 end) as activeSessionCount
    from watch_sessions
    where media_id = ?
  `).get(mediaId);
  const messageCount = db.prepare(`
    select count(*) as count
    from watch_messages
    where media_id = ?
  `).get(mediaId).count;
  const observationCount = db.prepare(`
    select count(*) as count
    from watch_observations o
    join watch_sessions s on s.id = o.session_id
    where s.media_id = ?
  `).get(mediaId).count;
  const frameCount = db.prepare(`
    select count(*) as count
    from watch_observation_frames f
    join watch_observations o on o.id = f.observation_id
    join watch_sessions s on s.id = o.session_id
    where s.media_id = ?
  `).get(mediaId).count;

  return {
    sessionCount: Number(sessionCounts.sessionCount || 0),
    activeSessionCount: Number(sessionCounts.activeSessionCount || 0),
    messageCount: Number(messageCount || 0),
    observationCount: Number(observationCount || 0),
    frameCount: Number(frameCount || 0)
  };
}

// A cinema-wide preference shared by every browser and AI participant.
export function getInteractionSettings(db) {
  return { enabled: db.prepare('select value from settings where key = ?').get('cinema_interactions_enabled')?.value !== 'false' };
}

export function setInteractionSettings(db, patch) {
  if (!patch || typeof patch.enabled !== 'boolean' || Object.keys(patch).some(key => key !== 'enabled')) {
    throw new TypeError('Interaction settings require only an enabled boolean.');
  }
  db.prepare('insert into settings (key, value, updated_at) values (?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at')
    .run('cinema_interactions_enabled', String(patch.enabled), new Date().toISOString());
  return getInteractionSettings(db);
}
