import { createHash, randomUUID } from 'node:crypto';

import { resolveActor } from './participants.mjs';
import { parseNotebookText } from './notebook-text.mjs';

const KINDS = new Set(['note', 'character', 'relation']);
const ID = /^[a-f0-9-]{36}$/;

function invalid(message, code = 'INVALID_ARGUMENT') {
  return Object.assign(new Error(message), { code });
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid(`${label} must be an object.`);
  return value;
}
function integer(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max)
    throw invalid(`${label} must be an integer between 0 and ${max}.`);
  return value;
}
function string(value, label, max, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) {
    throw invalid(`${label} must be ${empty ? 'at most' : 'between 1 and'} ${max} characters.`);
  }
  return value;
}

export function initializeNotebook(db) {
  // Additive, append-only storage. Existing films, rooms and messages are untouched.
  db.exec(`
    create table if not exists notebook_revisions (
      version integer primary key autoincrement,
      media_id text not null,
      entry_id text not null,
      source_room_id text not null,
      known_at_ms integer not null check (known_at_ms >= 0),
      deleted integer not null default 0 check (deleted in (0, 1)),
      payload_json text not null,
      created_at text not null
    );
    create table if not exists notebook_change_events (
      id integer primary key autoincrement,
      room_id text not null, media_id text not null, media_time_ms integer not null,
      entry_id text not null, version integer not null,
      editor_ref text not null, author_ref text, fields_json text not null
    );
    create index if not exists notebook_events_room on notebook_change_events(room_id, id);
    create index if not exists notebook_batch_receipt on notebook_revisions(media_id, json_extract(payload_json, '$._batch.key'))
      where json_extract(payload_json, '$._batch.key') is not null;
    create index if not exists notebook_revisions_projection
      on notebook_revisions(media_id, entry_id, known_at_ms, version);
  `);
}

// Compute heads using the film/entry index. Only the latest payload for each
// entry reaches the projection; previous revisions may contain long passages.
const HEADS = 'select max(version) as version from notebook_revisions where media_id=? group by entry_id';
function projectedRows(db, mediaId) {
  return db
    .prepare(
      `select r.* from (${HEADS}) h join notebook_revisions r using(version)
    where r.deleted=0 order by r.known_at_ms, r.version`
    )
    .all(mediaId);
}
function entryFromRow(row) {
  const { _batch, ...entry } = JSON.parse(row.payload_json);
  return {
    ...entry,
    id: row.entry_id,
    version: row.version,
    knownAtMs: row.known_at_ms,
    sourceRoomId: row.source_room_id,
    updatedAt: row.created_at,
    ...(entry.kind === 'note' ? { section: entry.section || 'timeline' } : {}),
    ...(entry.kind === 'relation'
      ? {
          label: entry.label ?? entry.text,
          direction: entry.direction || 'mutual',
          uncertain: Boolean(entry.uncertain)
        }
      : {})
  };
}
function participantReader(db) {
  const cached = new Map();
  return (ref) => {
    if (!ref?.id || !ref?.kind) return null;
    const key = ref.kind + ':' + ref.id;
    if (!cached.has(key)) cached.set(key, resolveActor(db, { kind: ref.kind, id: ref.id }));
    return cached.get(key);
  };
}

function reader(db) {
  const actor = participantReader(db);
  return (entry) => ({
    ...entry,
    author: actor(entry.author),
    lastEditor: actor(entry.lastEditor),
    fieldAuthors: Object.fromEntries(
      Object.entries(entry.fieldAuthors || {}).map(([key, ref]) => [key, actor(ref)])
    )
  });
}

export function readNotebook(db, mediaId, playheadMs) {
  string(mediaId, 'mediaId', 200);
  integer(playheadMs, 'playheadMs');
  const projected = projectedRows(db, mediaId).map(entryFromRow);
  const characters = new Set(projected.filter((e) => e.kind === 'character').map((e) => e.id));
  const hydrate = reader(db);
  const entries = projected
    .filter((e) => e.kind !== 'relation' || e.characterIds.every((id) => characters.has(id)))
    .map((e) =>
      hydrate(e.characterIds ? { ...e, characterIds: e.characterIds.filter((id) => characters.has(id)) } : e)
    );
  return { mediaId, playheadMs, entries };
}

const WRITABLE_FIELDS = [
  'name',
  'text',
  'appearance',
  'section',
  'detail',
  'answer',
  'answerAtMs',
  'eventAtMs',
  'characterIds',
  'label',
  'direction',
  'uncertain'
];
const FIELD_LABELS = {
  name: '人物称呼',
  text: '正文',
  appearance: '外貌',
  section: '分区',
  detail: '说明',
  answer: '解答',
  eventAtMs: '影片时间',
  answerAtMs: '解答时间',
  characterIds: '关联人物',
  label: '关系标签',
  direction: '关系方向',
  uncertain: '推测标记',
  deleted: '删除'
};
const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
function transaction(db, work) {
  db.exec('begin immediate');
  try {
    const result = work();
    db.exec('commit');
    return result;
  } catch (error) {
    db.exec('rollback');
    throw error;
  }
}
function context(db, room, actor) {
  object(room, 'room');
  if (room.status !== 'active')
    throw invalid('The notebook can only be edited in an active room.', 'ROOM_UNAVAILABLE');
  const mediaId = string(room.mediaId, 'room.mediaId', 200);
  const roomId = string(room.id, 'room.id', 200);
  const time = integer(room.lastPositionMs, 'room.lastPositionMs');
  const resolved = actor ? resolveActor(db, actor) : null;
  const ref = resolved ? { kind: resolved.kind, id: resolved.id } : null;
  return { db, roomId, mediaId, time, entries: new Map(), people: null, count: null, actor: ref };
}

// A single field edit only needs the current entry, its base revision and any
// explicitly linked characters. Keep this cache inside the write transaction.
function currentEntry(ctx, id) {
  if (!ctx.entries.has(id)) {
    const row = ctx.db
      .prepare(
        `select * from notebook_revisions where media_id=? and entry_id=?
      order by version desc limit 1`
      )
      .get(ctx.mediaId, id);
    ctx.entries.set(id, row && !row.deleted ? entryFromRow(row) : null);
  }
  return ctx.entries.get(id);
}

function characterNames(ctx) {
  if (!ctx.people) {
    const rows = ctx.db
      .prepare(
        `select r.entry_id as id, json_extract(r.payload_json,'$.name') as name
      from (${HEADS}) h join notebook_revisions r using(version)
      where r.deleted=0 and json_extract(r.payload_json,'$.kind')='character'`
      )
      .all(ctx.mediaId);
    ctx.people = new Map(rows.map((row) => [row.id, row.name]));
  }
  return ctx.people;
}

function conflict(ctx, current, fields) {
  const error = invalid(
    'This notebook field changed. Read the current value before saving.',
    'NOTEBOOK_VERSION_CONFLICT'
  );
  error.current = reader(ctx.db)(current);
  error.fields = fields;
  throw error;
}

function mergePatch(ctx, current, raw) {
  if (!current) return raw;
  if (raw.expectedVersion === current.version) return raw;
  const fields = WRITABLE_FIELDS.filter((field) => Object.hasOwn(raw, field));
  if (raw.action === 'delete') conflict(ctx, current, ['deleted']);
  if (!Number.isSafeInteger(raw.expectedVersion)) conflict(ctx, current, fields);
  const row = ctx.db
    .prepare('select * from notebook_revisions where media_id=? and entry_id=? and version=? and deleted=0')
    .get(ctx.mediaId, current.id, raw.expectedVersion);
  if (!row) conflict(ctx, current, fields);
  const base = entryFromRow(row);
  const patch = { ...raw };
  const conflicting = [];
  for (const field of fields) {
    // Legacy form submissions also contain unchanged inputs. Never restore a stale field accidentally.
    if (equal(raw[field], base[field])) delete patch[field];
    else if (!equal(base[field], current[field]) && !equal(raw[field], current[field]))
      conflicting.push(field);
  }
  if (conflicting.length) conflict(ctx, current, conflicting);
  return patch;
}

function buildPayload(ctx, previous, patch) {
  const kind = patch.kind ?? previous?.kind ?? 'note';
  if (!KINDS.has(kind) || (previous && previous.kind !== kind))
    throw invalid('Invalid change of entry kind.');
  const section = kind === 'note' ? (patch.section ?? previous?.section ?? 'timeline') : null;
  if (kind === 'note' && !['timeline', 'question', 'jot'].includes(section))
    throw invalid('Unknown note section.');
  const isQuestion = section === 'question';
  const allowed = new Set(['text', 'eventAtMs', 'characterIds']);
  if (kind === 'character') {
    allowed.add('name');
    allowed.add('appearance');
  }
  if (kind === 'relation') for (const field of ['label', 'direction', 'uncertain']) allowed.add(field);
  if (kind === 'note') allowed.add('section');
  if (isQuestion) for (const field of ['answer', 'answerAtMs', 'detail']) allowed.add(field);
  for (const field of WRITABLE_FIELDS)
    if (Object.hasOwn(patch, field) && !allowed.has(field))
      throw invalid('Invalid field for this entry: ' + field);
  if (previous?.section === 'question' && section !== 'question' && (previous.answer || previous.detail))
    throw invalid('A question with details or an answer must remain a question.');

  const text = string(
    patch.text ?? previous?.text ?? '',
    'text',
    4000,
    kind === 'character' || kind === 'relation'
  );
  const eventAtMs = integer(
    patch.eventAtMs ?? previous?.eventAtMs ?? ctx.time,
    'eventAtMs',
    patch.eventAtMs === undefined || patch.eventAtMs === previous?.eventAtMs
      ? Number.MAX_SAFE_INTEGER
      : ctx.time
  );
  const payload = { kind, text, eventAtMs };
  if (section) payload.section = section;
  const ids = patch.characterIds ?? previous?.characterIds ?? [];
  if (
    !Array.isArray(ids) ||
    ids.length > 20 ||
    new Set(ids).size !== ids.length ||
    ids.some(
      (id) =>
        typeof id !== 'string' ||
        !ID.test(id) ||
        (Object.hasOwn(patch, 'characterIds') && currentEntry(ctx, id)?.kind !== 'character')
    )
  ) {
    throw invalid('Linked characters must be distinct, existing entries in this film.');
  }
  if (ids.length) payload.characterIds = [...ids];
  if (kind === 'character') {
    if (ids.length) throw invalid('A character cannot link to other characters.');
    payload.name = string(patch.name ?? previous?.name, 'name', 80);
    const appearance = string(patch.appearance ?? previous?.appearance ?? '', 'appearance', 2000, true);
    if (appearance) payload.appearance = appearance;
  }
  if (kind === 'relation') {
    if (ids.length !== 2) throw invalid('A relation requires exactly two characters.');
    const label = patch.label ?? previous?.label;
    // Legacy clients used a single text field for both the label and explanation.
    payload.label =
      label === undefined
        ? string(text, 'label', 4000)
        : string(label, 'label', Math.max(120, previous?.label?.length || 0));
    payload.direction = patch.direction ?? previous?.direction ?? 'mutual';
    payload.uncertain = patch.uncertain ?? previous?.uncertain ?? false;
    if (!['forward', 'mutual'].includes(payload.direction) || typeof payload.uncertain !== 'boolean')
      throw invalid('Invalid relation direction or certainty.');
  }
  if (isQuestion) {
    payload.detail = string(patch.detail ?? previous?.detail ?? '', 'detail', 4000, true);
    payload.answer = string(patch.answer ?? previous?.answer ?? '', 'answer', 4000, true);
    if (payload.answer) {
      const updating = payload.answer !== previous?.answer;
      const at = patch.answerAtMs ?? (updating ? ctx.time : (previous?.answerAtMs ?? ctx.time));
      payload.answerAtMs = integer(
        at,
        'answerAtMs',
        at === previous?.answerAtMs ? Number.MAX_SAFE_INTEGER : ctx.time
      );
    }
  }
  return payload;
}

function save(ctx, input, batch) {
  const raw = object(input, 'body');
  const action = raw.action || 'save';
  if (!['save', 'delete'].includes(action)) throw invalid('Unknown notebook action.');
  const id = raw.id === undefined ? randomUUID() : string(raw.id, 'id', 36);
  if (!ID.test(id) || (action === 'delete' && !raw.id)) throw invalid('Invalid notebook entry id.');
  const previous = raw.id ? currentEntry(ctx, id) : null;
  if (
    raw.id &&
    (!previous ||
      (previous.kind === 'relation' &&
        previous.characterIds.some((target) => currentEntry(ctx, target)?.kind !== 'character')))
  ) {
    throw invalid('Notebook entry unavailable.', 'NOTEBOOK_ENTRY_UNAVAILABLE');
  }
  if (!previous) {
    ctx.count ??= ctx.db
      .prepare('select count(distinct entry_id) as n from notebook_revisions where media_id=?')
      .get(ctx.mediaId).n;
    if (ctx.count >= 2000) throw invalid('Notebook limit reached.', 'NOTEBOOK_LIMIT');
  }
  const patch = mergePatch(ctx, previous, raw);
  const deleting = action === 'delete';
  const payload = deleting ? {} : buildPayload(ctx, previous, patch);
  const changed = deleting
    ? ['deleted']
    : WRITABLE_FIELDS.filter((field) => !equal(payload[field], previous?.[field]));
  if (!changed.length && !batch) return previous;
  payload.author = previous ? (previous.author ?? null) : ctx.actor;
  payload.lastEditor = ctx.actor;
  payload.fieldAuthors = { ...previous?.fieldAuthors };
  for (const field of changed) payload.fieldAuthors[field] = ctx.actor;
  if (batch) payload._batch = batch;

  const updatedAt = new Date().toISOString();
  const result = ctx.db
    .prepare(
      `insert into notebook_revisions
    (media_id,entry_id,source_room_id,known_at_ms,deleted,payload_json,created_at) values(?,?,?,?,?,?,?)`
    )
    .run(ctx.mediaId, id, ctx.roomId, ctx.time, Number(deleting), JSON.stringify(payload), updatedAt);
  const version = Number(result.lastInsertRowid);
  if (previous && ctx.actor?.kind === 'user' && changed.length) {
    ctx.db
      .prepare(
        `insert into notebook_change_events
      (room_id,media_id,media_time_ms,entry_id,version,editor_ref,author_ref,fields_json) values (?,?,?,?,?,?,?,?)`
      )
      .run(
        ctx.roomId,
        ctx.mediaId,
        ctx.time,
        id,
        version,
        JSON.stringify(ctx.actor),
        previous.author ? JSON.stringify(previous.author) : null,
        JSON.stringify(changed)
      );
  }
  if (!previous) ctx.count++;
  if (deleting) {
    ctx.entries.set(id, null);
    ctx.people?.delete(id);
    return { id, version, deleted: true, knownAtMs: ctx.time };
  }
  delete payload._batch;
  const entry = { ...payload, id, version, knownAtMs: ctx.time, sourceRoomId: ctx.roomId, updatedAt };
  ctx.entries.set(id, entry);
  if (entry.kind === 'character') ctx.people?.set(id, entry.name);
  return entry;
}

export function writeNotebook(db, room, body, actor = null) {
  return transaction(db, () => {
    const entry = save(context(db, room, actor), body);
    return entry.deleted ? entry : reader(db)(entry);
  });
}

function uniqueMatch(matches, description) {
  if (matches.length !== 1)
    throw invalid(matches.length ? '引用有歧义：' + description : '找不到引用：' + description);
  return matches[0];
}
function entryByRef(ctx, ref) {
  if (!/^[0-9a-f-]{8,36}$/.test(ref)) throw invalid('请复制至少 8 位的条目短引用。');
  const matches = ctx.db
    .prepare(
      `select r.entry_id as id from (
      select max(version) as version from notebook_revisions
      where media_id=? and entry_id glob ? group by entry_id
    ) h join notebook_revisions r using(version) where r.deleted=0 limit 2`
    )
    .all(ctx.mediaId, ref + '*');
  const found = uniqueMatch(matches, '#' + ref);
  return currentEntry(ctx, found.id);
}
function findPerson(ctx, name) {
  if (name.startsWith('#')) {
    const entry = entryByRef(ctx, name.slice(1));
    if (entry.kind !== 'character') throw invalid('该引用不是人物：' + name);
    return entry.id;
  }
  const matches = [];
  for (const [id, candidateName] of characterNames(ctx)) {
    if (name === candidateName) matches.push(id);
  }
  return uniqueMatch(matches, '@' + name);
}
function rowPatch(ctx, row) {
  const at = row.eventAtMs === undefined ? {} : { eventAtMs: row.eventAtMs };
  if (row.ref) {
    const target = entryByRef(ctx, row.ref);
    const when = row.field === 'answer' && row.eventAtMs !== undefined ? { answerAtMs: row.eventAtMs } : at;
    return { id: target.id, expectedVersion: row.expectedVersion, [row.field]: row.value, ...when };
  }
  if (row.section === 'character')
    return {
      kind: 'character',
      name: row.name,
      text: row.text,
      ...(row.appearance !== undefined ? { appearance: row.appearance } : {}),
      ...at
    };
  if (row.section === 'relation')
    return {
      kind: 'relation',
      characterIds: row.names.map((name) => findPerson(ctx, name)),
      label: row.label,
      direction: row.direction,
      uncertain: row.uncertain,
      text: row.text,
      ...at
    };
  return {
    kind: 'note',
    section: row.section,
    text: row.text,
    ...(row.detail !== undefined ? { detail: row.detail } : {}),
    characterIds: (row.names || []).map((name) => findPerson(ctx, name)),
    ...at
  };
}

export function writeNotebookBatch(db, room, body, actor) {
  object(body, 'body');
  const rows = parseNotebookText(body.text);
  const requestId = string(body.requestId, 'requestId', 200);
  const digest = createHash('sha256').update(body.text).digest('hex');
  return transaction(db, () => {
    const ctx = context(db, room, actor);
    if (!ctx.actor) throw invalid('A batch needs an actor.');
    const key = createHash('sha256')
      .update(JSON.stringify([ctx.roomId, ctx.actor.kind, ctx.actor.id, requestId]))
      .digest('hex');
    const original = db
      .prepare(
        `select * from notebook_revisions where media_id=? and
      json_extract(payload_json,'$._batch.key')=? order by json_extract(payload_json,'$._batch.line')`
      )
      .all(ctx.mediaId, key);
    const hydrate = reader(db);
    if (original.length) {
      if (JSON.parse(original[0].payload_json)._batch.digest !== digest)
        throw invalid('This requestId was already used for different text.');
      return { replayed: true, entries: original.map((row) => hydrate(entryFromRow(row))) };
    }
    // Resolve names declared anywhere in the same call, even in a later section.
    const ordered = [
      ...rows.filter((r) => r.section === 'character'),
      ...rows.filter((r) => r.section !== 'character')
    ];
    const results = new Map();
    for (const row of ordered) {
      try {
        results.set(row.line, save(ctx, rowPatch(ctx, row), { key, digest, line: row.line }));
      } catch (error) {
        error.message = `第 ${row.line} 行：${error.message}`;
        error.line = row.line;
        throw error;
      }
    }
    return { replayed: false, entries: rows.map((row) => hydrate(results.get(row.line))) };
  });
}

export function readNotebookChanges(db, roomId, afterId = 0, limit = 100) {
  string(roomId, 'roomId', 200);
  integer(afterId, 'afterId');
  integer(limit, 'limit', 200);
  if (!limit) throw invalid('limit must be positive.');
  const rows = db
    .prepare('select * from notebook_change_events where room_id=? and id>? order by id limit ?')
    .all(roomId, afterId, limit + 1);
  const participant = participantReader(db);
  return {
    hasMore: rows.length > limit,
    events: rows.slice(0, limit).map((row) => {
      const user = participant(JSON.parse(row.editor_ref));
      const author = row.author_ref ? participant(JSON.parse(row.author_ref)) : null;
      const fields = JSON.parse(row.fields_json);
      const title = fields.map((field) => FIELD_LABELS[field] || field).join('、');
      const reference = '#' + row.entry_id.slice(0, 8) + '/v' + row.version;
      const notebook = author ? author.name + ' 的观影小本本' : '观影小本本';
      const content = `${user.name} 修改了 ${notebook}（${reference}，${title}）。`;
      return {
        id: row.id,
        roomId: row.room_id,
        mediaId: row.media_id,
        atMs: row.media_time_ms,
        entryId: row.entry_id,
        version: row.version,
        userName: user.name,
        authorName: author?.name ?? null,
        fields,
        content
      };
    })
  };
}
