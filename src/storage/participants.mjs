import { randomUUID } from 'node:crypto';

const selectedProfileKey = 'cinema_selected_ai_profile';

// Participant references are independent of film, room, browser and display name.
export function initializeParticipants(db) {
  db.exec(`create table if not exists cinema_participants (
    kind text not null check(kind in ('user','ai')),
    id text not null,
    display_name text not null,
    primary key(kind, id)
  )`);
}

function participantKey({ kind, id }) {
  if (kind === 'user') return 'viewer';
  if (kind === 'ai' && typeof id === 'string' && id.trim() && id.length <= 120) return id;
  throw new TypeError('请提供有效的影院档案 ID。');
}

export function participantProfile(db, actor) {
  const id = participantKey(actor);
  const row = db
    .prepare('select display_name from cinema_participants where kind=? and id=?')
    .get(actor.kind, id);
  const displayName = row?.display_name ?? '';
  return {
    kind: actor.kind,
    id,
    displayName,
    configured: Boolean(row),
    name: displayName || (actor.kind === 'user' ? 'user' : 'AI')
  };
}

export function resolveActor(db, actor) {
  const { kind, id, name } = participantProfile(db, actor);
  return { kind, id, name };
}

function normalizeName(value, required = false) {
  if (typeof value !== 'string' || value.trim().length > 60 || /[\x00-\x1F\x7F]/u.test(value)) {
    throw new TypeError('名字须为单行，最多 60 个字符。');
  }
  const name = value.trim();
  if (required && !name) throw new TypeError('请填写 AI 的名字。');
  return name;
}

function writeTransaction(db, write) {
  if (db.isTransaction) return write();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = write();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function writeName(db, actor, name, initializeOnly = false) {
  const current = participantProfile(db, actor);
  if (current.configured && (initializeOnly || current.displayName === name)) return current;
  if (actor.kind === 'ai' && name) {
    const occupied = db.prepare(
      "select 1 from cinema_participants where kind='ai' and display_name=? and id<>? limit 1"
    ).get(name, current.id);
    if (occupied) {
      throw Object.assign(new Error('已有 AI 档案使用这个名字，请选择该档案或换一个名字。'), {
        code: 'AI_NAME_TAKEN'
      });
    }
  }
  db.prepare(
    'insert into cinema_participants(kind,id,display_name) values(?,?,?) ' +
    'on conflict(kind,id) do update set display_name=excluded.display_name'
  ).run(actor.kind, current.id, name);
  return participantProfile(db, actor);
}

export function setParticipantName(db, actor, name, { initializeOnly = false } = {}) {
  const cleanName = normalizeName(name);
  return writeTransaction(db, () => writeName(db, actor, cleanName, initializeOnly));
}

export function aiProfileSettings(db) {
  const rows = db.prepare(`
    select id, display_name as name, (select value from settings where key=?) as selection
    from cinema_participants where kind='ai' and trim(display_name)<>''
    order by display_name, id
  `).all(selectedProfileKey);
  const profiles = rows.map(({ id, name }) => ({ id, name }));
  const saved = rows[0]?.selection;
  const selectedId = profiles.some(({ id }) => id === saved)
    ? saved
    : profiles.length === 1 ? profiles[0].id : null;
  return { profiles, selectedId };
}

export function updateAiProfileSettings(db, body) {
  const { action, id, name } = body || {};
  if (!['create', 'select', 'rename'].includes(action)) {
    throw new TypeError('请选择创建、切换或改名操作。');
  }
  return writeTransaction(db, () => {
    const actor = { kind: 'ai', id: action === 'create' ? `ai-${randomUUID()}` : id };
    if (action !== 'create' && !participantProfile(db, actor).displayName.trim()) {
      throw Object.assign(new Error('找不到这个 AI 档案，请重新选择。'), { code: 'AI_PROFILE_NOT_FOUND' });
    }
    if (action !== 'select') writeName(db, actor, normalizeName(name, true));
    if (action !== 'rename') {
      db.prepare(
        'insert into settings(key,value,updated_at) values(?,?,?) ' +
        'on conflict(key) do update set value=excluded.value, updated_at=excluded.updated_at'
      ).run(selectedProfileKey, actor.id, new Date().toISOString());
    }
    return aiProfileSettings(db);
  });
}
