import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const maxContentBytes = 16 * 1024 * 1024;
const maxBlocks = 1024;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function requireValue(condition, field) {
  if (!condition) throw new TypeError(`活动报告的 ${field} 无效。`);
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function label(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function inspectContent(body) {
  if (body.contentOmitted === true) {
    requireValue(integer(body.blockCount) && integer(body.imageCount) && body.imageCount <= body.blockCount, 'blockCount/imageCount');
    return { count: body.blockCount, images: body.imageCount, available: false };
  }
  requireValue(Array.isArray(body.content), 'content');
  let bytes = 0;
  let images = 0;
  for (const block of body.content) {
    if (block?.type === 'text') {
      requireValue(typeof block.text === 'string', 'content.text');
      bytes += Buffer.byteLength(block.text);
    } else {
      requireValue(block?.type === 'image' && imageTypes.has(block.mimeType), 'content.type/mimeType');
      requireValue(typeof block.data === 'string' && block.data.length > 0 && block.data.length % 4 === 0, 'content.data');
      const padding = block.data.endsWith('==') ? 2 : Number(block.data.endsWith('='));
      bytes += block.data.length / 4 * 3 - padding;
      images++;
    }
  }
  return { count: body.content.length, images, available: body.content.length <= maxBlocks && bytes <= maxContentBytes };
}

const callProjection = `call_id as callId, tool, action, started_at as startedAt,
  finished_at as finishedAt, is_error as isError, block_count as blockCount,
  image_count as imageCount, available as resultAvailable`;

function summary(row) {
  return row ? { ...row, isError: Boolean(row.isError), resultAvailable: Boolean(row.resultAvailable) } : null;
}

export function createAiActivity({
  resolveName = () => 'AI', getActiveRoomId = () => null, onlineTimeoutSeconds = 30,
  onChange = () => {}, now = Date.now
} = {}) {
  // An empty filename asks SQLite for an automatically deleted temporary database.
  // Page caching bounds the hot working set; large histories can spill to system temp.
  const db = new DatabaseSync('');
  db.exec(`
    pragma cache_size=-4096;
    create table connections (
      id text primary key, profile_id text, seq integer not null, connected_at integer not null,
      last_seen integer not null, online integer not null, closed_at integer, call_count integer not null default 0,
      dropped_calls integer not null default 0, progress_seq integer, room_id text, media_ms integer, seek_version integer
    );
    create table calls (
      id integer primary key, connection_id text not null, call_id text not null, tool text not null,
      action text, started_at integer not null, finished_at integer not null, is_error integer not null,
      block_count integer not null, image_count integer not null, available integer not null,
      unique(connection_id,call_id)
    );
    create index call_timeline on calls(connection_id,finished_at desc,id desc);
    create table images (hash text primary key, data blob not null);
    create table blocks (
      call_row integer not null, pos integer not null, text_value text, mime text, image_hash text,
      size integer, primary key(call_row,pos)
    ) without rowid;
  `);
  const statements = new Map();
  function query(sql) {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql);
  }

  let notifyTimer;
  let expiryTimer;
  let stopped = false;
  let onlineTimeoutMs = onlineTimeoutSeconds * 1000;
  const viewing = new Map();
  const setOnline = query('update connections set online=? where id=?');
  function changed() {
    if (notifyTimer || stopped) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = undefined;
      onChange();
    }, 80);
    notifyTimer.unref();
  }
  function refreshOnlineStatus() {
    clearTimeout(expiryTimer);
    if (!viewing.size) return;
    const time = now();
    const roomId = getActiveRoomId();
    let nextExpiry = Infinity;
    for (const [id, view] of viewing) {
      const deadline = view.finishedAt + onlineTimeoutMs;
      if (view.roomId !== roomId || deadline <= time) {
        viewing.delete(id);
        setOnline.run(0, id);
        changed();
      } else {
        nextExpiry = Math.min(nextExpiry, deadline);
      }
    }
    if (Number.isFinite(nextExpiry)) {
      expiryTimer = setTimeout(refreshOnlineStatus, nextExpiry - time);
      expiryTimer.unref();
    }
  }

  function setOnlineTimeout(seconds) {
    if (onlineTimeoutMs === seconds * 1000) return;
    onlineTimeoutMs = seconds * 1000;
    refreshOnlineStatus();
  }

  const getConnection = (id) => query('select * from connections where id=?').get(id);
  const findCall = (id, call) => query('select id,available from calls where connection_id=? and call_id=?').get(id, call);

  function addCall(body, connection) {
    if (findCall(connection.id, body.callId)) return false;
    const { count, images, available } = inspectContent(body);
    const row = query(`insert into calls(connection_id,call_id,tool,action,started_at,finished_at,
      is_error,block_count,image_count,available) values(?,?,?,?,?,?,?,?,?,?)`)
      .run(connection.id, body.callId, body.tool, body.action ?? null, body.startedAt, body.finishedAt,
        Number(body.isError), count, images, Number(available)).lastInsertRowid;
    if (available) {
      for (const [index, block] of body.content.entries()) {
        if (block.type === 'text') {
          query('insert into blocks(call_row,pos,text_value) values(?,?,?)').run(row, index, block.text);
        } else {
          const data = Buffer.from(block.data, 'base64');
          const padding = block.data.endsWith('==') ? 2 : Number(block.data.endsWith('='));
          requireValue(data.length === block.data.length / 4 * 3 - padding, 'content.data');
          const hash = createHash('sha256').update(data).digest('hex');
          query('insert or ignore into images(hash,data) values(?,?)').run(hash, data);
          query('insert into blocks(call_row,pos,mime,image_hash,size) values(?,?,?,?,?)')
            .run(row, index, block.mimeType, hash, data.length);
        }
      }
    }
    query('update connections set call_count=call_count+1 where id=?').run(connection.id);
    if (body.progress && (connection.progress_seq === null || body.seq > connection.progress_seq)) {
      const { roomId, mediaMs, seekVersion } = body.progress;
      query('update connections set progress_seq=?,room_id=?,media_ms=?,seek_version=? where id=?')
        .run(body.seq, roomId, mediaMs, seekVersion ?? null, connection.id);
    }
    return true;
  }

  function report(body) {
    requireValue(body && ['heartbeat', 'close', 'call'].includes(body.op), 'op');
    requireValue(typeof body.connectionId === 'string' && uuid.test(body.connectionId), 'connectionId');
    requireValue(body.profileId == null || label(body.profileId), 'profileId');
    requireValue(integer(body.seq), 'seq');
    const droppedCalls = body.op === 'call' ? 0 : body.droppedCalls ?? 0;
    requireValue(integer(droppedCalls), 'droppedCalls');
    if (body.op === 'call') {
      requireValue(typeof body.callId === 'string' && uuid.test(body.callId), 'callId');
      requireValue(label(body.tool) && (body.action == null || label(body.action)), 'tool/action');
      requireValue(integer(body.startedAt) && integer(body.finishedAt) && body.finishedAt >= body.startedAt, 'startedAt/finishedAt');
      requireValue(typeof body.isError === 'boolean', 'isError');
      if (body.viewingRoomId != null) {
        requireValue(!body.isError && body.tool === 'open_watch_cinema_tick' && label(body.viewingRoomId), 'viewingRoomId');
      }
      if (body.progress != null) {
        const p = body.progress;
        requireValue(!body.isError && body.tool === 'open_watch_cinema_tick' &&
          label(p.roomId) && integer(p.mediaMs) && (p.seekVersion == null || integer(p.seekVersion)), 'progress');
      }
    }
    const time = now();
    let notify = false;
    let added = false;
    let disconnected = false;
    let connection;
    db.exec('begin');
    try {
      connection = getConnection(body.connectionId);
      if (!connection) {
        query('insert into connections(id,profile_id,seq,connected_at,last_seen,online) values(?,?,-1,?,?,0)')
          .run(body.connectionId, null, time, time);
        connection = getConnection(body.connectionId);
      }
      requireValue(!connection.profile_id || !body.profileId || connection.profile_id === body.profileId, 'profileId');
      if (droppedCalls > connection.dropped_calls) {
        query('update connections set dropped_calls=? where id=?').run(droppedCalls, connection.id);
        notify = true;
      }
      if (!connection.profile_id && body.profileId) {
        query('update connections set profile_id=? where id=?').run(body.profileId, connection.id);
        notify ||= connection.call_count > 0 || connection.dropped_calls > 0;
      }
      if (body.seq > connection.seq && connection.closed_at === null) {
        disconnected = body.op === 'close';
        query('update connections set seq=?,last_seen=?,closed_at=? where id=?')
          .run(body.seq, time, disconnected ? time : null, connection.id);
        notify ||= disconnected && (connection.call_count > 0 || connection.dropped_calls > 0);
      }
      if (body.op === 'call') added = addCall(body, connection);
      db.exec('commit');
    } catch (error) {
      db.exec('rollback');
      throw error;
    }
    if (disconnected && viewing.delete(connection.id)) {
      setOnline.run(0, connection.id);
      refreshOnlineStatus();
    }
    const roomId = body.viewingRoomId ?? body.progress?.roomId;
    if (added && connection.closed_at === null && roomId && roomId === getActiveRoomId()) {
      const finishedAt = Math.min(time, body.finishedAt);
      if (finishedAt + onlineTimeoutMs > time && finishedAt >= (viewing.get(connection.id)?.finishedAt ?? 0)) {
        viewing.set(connection.id, { roomId, finishedAt });
        setOnline.run(1, connection.id);
        refreshOnlineStatus();
      }
    }
    if (notify || added) changed();
    return { ok: true };
  }

  function list() {
    refreshOnlineStatus();
    const rows = query('select * from connections where call_count > 0 or dropped_calls > 0 order by online desc, connected_at desc, id').all();
    const latest = query(`select ${callProjection} from calls where connection_id=? order by finished_at desc,id desc limit 1`);
    const connections = rows.map((row) => ({
      connectionId: row.id, profileId: row.profile_id, name: resolveName(row.profile_id),
      online: Boolean(row.online), connectedAt: row.connected_at, lastSeenAt: row.last_seen, closedAt: row.closed_at,
      callCount: row.call_count, droppedCalls: row.dropped_calls, retainedCalls: row.call_count, evictedCalls: 0, lastCall: summary(latest.get(row.id)),
      progress: row.room_id === null ? null : { roomId: row.room_id, mediaMs: row.media_ms,
        ...(row.seek_version === null ? {} : { seekVersion: row.seek_version }) }
    }));
    return { connections, evictedConnections: 0, totalCalls: connections.reduce((sum, c) => sum + c.callCount, 0) };
  }

  function calls(id, { offset = 0, limit = 100 } = {}) {
    const conn = getConnection(id);
    if (!conn) return null;
    requireValue(integer(offset) && integer(limit) && limit > 0 && limit <= 500, 'offset/limit');
    const rows = query(`select ${callProjection} from calls where connection_id=? order by finished_at desc,id desc limit ? offset ?`)
      .all(id, limit, offset);
    const next = offset + rows.length;
    return { connectionId: id, totalCalls: conn.call_count, evictedCalls: 0, offset,
      nextOffset: next < conn.call_count ? next : null, calls: rows.map(summary) };
  }

  function result(id, callId) {
    const call = findCall(id, callId);
    if (!call) return null;
    const content = query('select pos,text_value,mime,size from blocks where call_row=? order by pos').all(call.id)
      .map((b) => b.mime === null ? { type: 'text', text: b.text_value } :
        { type: 'image', index: b.pos, mimeType: b.mime, byteLength: b.size });
    return { callId, available: Boolean(call.available), content };
  }

  function image(id, callId, index) {
    if (!integer(index)) return null;
    const row = query(`select b.mime,i.data from calls c join blocks b on b.call_row=c.id
      join images i on i.hash=b.image_hash where c.connection_id=? and c.call_id=? and b.pos=?`).get(id, callId, index);
    return row ? { mimeType: row.mime, data: Buffer.from(row.data.buffer, row.data.byteOffset, row.data.byteLength) } : null;
  }

  function close() {
    if (stopped) return;
    stopped = true;
    clearTimeout(notifyTimer);
    clearTimeout(expiryTimer);
    db.close();
  }
  return { report, list, calls, result, image, refreshOnlineStatus, setOnlineTimeout, close };
}
