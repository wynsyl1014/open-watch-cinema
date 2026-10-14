import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`pragma table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`alter table ${tableName} add column ${columnName} ${definition}`);
  }
}

function sessionProjection() {
  return `
    select
      s.id,
      s.media_id as mediaId,
      s.media_title as mediaTitle,
      s.status,
      s.opened_at as openedAt,
      s.ended_at as endedAt,
      s.last_position_ms as lastPositionMs,
      s.playback_state as playbackState,
      s.playback_version as playbackVersion,
      s.seek_version as seekVersion,
      s.updated_at as updatedAt,
      count(m.id) as messageCount
    from watch_sessions s
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
      relative_path text not null unique,
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

  ensureColumn(db, 'watch_sessions', 'seek_version', 'integer not null default 0');
  ensureColumn(db, 'media', 'compatibility_status', "text not null default 'unchecked'");
  ensureColumn(db, 'media', 'container_name', 'text');
  ensureColumn(db, 'media', 'video_codec', 'text');
  ensureColumn(db, 'media', 'audio_codec', 'text');
  ensureColumn(db, 'media', 'compatibility_note', 'text');
  ensureColumn(db, 'media', 'compatibility_error', 'text');
  ensureColumn(db, 'media', 'processed_at', 'text');

  db.prepare(`
    update media
    set compatibility_status = 'error',
        compatibility_error = 'Preparation was interrupted. Run it again.'
    where compatibility_status in ('checking', 'processing')
  `).run();

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

export function openSession(db, { mediaId, mediaTitle }) {
  if (getActiveSession(db)) {
    throw new Error('A room is already open. End it before opening another room.');
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    insert into watch_sessions (
      id, media_id, media_title, status, opened_at, updated_at
    ) values (?, ?, ?, 'active', ?, ?)
  `).run(id, mediaId, mediaTitle, now, now);
  return getSession(db, id);
}

export function endSession(db, sessionId, { lastPositionMs = 0 } = {}) {
  const session = getSession(db, sessionId);
  if (!session) throw new Error('Room not found.');
  if (session.status === 'ended') return session;

  const now = new Date().toISOString();
  db.prepare(`
    update watch_sessions
    set status = 'ended',
        ended_at = ?,
        last_position_ms = ?,
        playback_state = 'paused',
        playback_version = playback_version + 1,
        updated_at = ?
    where id = ? and status = 'active'
  `).run(now, Math.max(0, Math.round(lastPositionMs)), now, sessionId);
  return getSession(db, sessionId);
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

export function listSessionMessages(db, sessionId, { afterId = 0, limit = null } = {}) {
  const normalizedAfterId = Math.max(0, Math.round(Number(afterId) || 0));
  const projection = `
    select
      id,
      session_id as sessionId,
      media_id as mediaId,
      sender_name as senderName,
      sender_kind as senderKind,
      content,
      media_time_ms as mediaTimeMs,
      created_at as createdAt
    from watch_messages
    where session_id = ? and id > ?
    order by id
  `;
  if (limit === null || limit === undefined) {
    return db.prepare(projection).all(sessionId, normalizedAfterId);
  }
  const normalizedLimit = Math.max(1, Math.min(500, Math.round(Number(limit) || 1)));
  return db.prepare(`${projection}\nlimit ?`).all(sessionId, normalizedAfterId, normalizedLimit);
}

export function addSessionMessage(db, sessionId, {
  senderName,
  senderKind = 'user',
  content,
  mediaTimeMs
}) {
  const session = getSession(db, sessionId);
  if (!session) throw new Error('Room not found.');
  if (session.status !== 'active') throw new Error('Archived rooms are read-only.');

  const cleanName = String(senderName || '').trim().slice(0, 60);
  const cleanContent = String(content || '').trim().slice(0, 800);
  const cleanKind = ['user', 'ai', 'system'].includes(senderKind) ? senderKind : 'user';
  if (!cleanName) throw new Error('A sender name is required.');
  if (!cleanContent) throw new Error('Message content is required.');

  const now = new Date().toISOString();
  const result = db.prepare(`
    insert into watch_messages (
      session_id, media_id, sender_name, sender_kind, content, media_time_ms, created_at
    ) values (?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    session.mediaId,
    cleanName,
    cleanKind,
    cleanContent,
    Math.max(0, Math.round(mediaTimeMs)),
    now
  );

  return db.prepare(`
    select
      id,
      session_id as sessionId,
      media_id as mediaId,
      sender_name as senderName,
      sender_kind as senderKind,
      content,
      media_time_ms as mediaTimeMs,
      created_at as createdAt
    from watch_messages
    where id = ?
  `).get(result.lastInsertRowid);
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

export function deleteMediaCascadeRecords(db, mediaId, {
  deleteSessions = true,
  deleteMediaIndex = true
} = {}) {
  const before = getMediaCascadeSummary(db, mediaId);
  if (before.activeSessionCount > 0) {
    throw new Error('End the active room before deleting this film.');
  }

  db.exec('begin immediate');
  try {
    if (deleteSessions) {
      db.prepare('delete from watch_sessions where media_id = ?').run(mediaId);
    }
    if (deleteMediaIndex) {
      db.prepare('delete from media where id = ?').run(mediaId);
    }
    db.exec('commit');
  } catch (error) {
    db.exec('rollback');
    throw error;
  }

  return {
    ...before,
    deletedSessions: deleteSessions ? before.sessionCount : 0,
    deletedMessages: deleteSessions ? before.messageCount : 0,
    deletedObservations: deleteSessions ? before.observationCount : 0,
    deletedFrames: deleteSessions ? before.frameCount : 0
  };
}
