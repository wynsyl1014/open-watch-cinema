import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addSessionMessage,
  listSessionMessages,
  openDatabase,
  openSession
} from '../../src/storage/database.mjs';
import {
  aiProfileSettings,
  participantProfile,
  setParticipantName,
  updateAiProfileSettings
} from '../../src/storage/participants.mjs';

test('a renamed viewer and AI update linked historical credits independently', () => {
  const db = openDatabase(':memory:');
  try {
    const room = openSession(db, { mediaId: 'film', mediaTitle: 'Sample' });
    const viewer = { kind: 'user' };
    const ai = { kind: 'ai', id: 'agent-one' };
    assert.equal(participantProfile(db, viewer).name, 'user');
    addSessionMessage(db, room.id, {
      senderKind: 'user',
      senderName: 'user',
      content: 'Before picking a name',
      mediaTimeMs: 0
    });
    assert.equal(listSessionMessages(db, room.id)[0].senderName, 'user');
    assert.equal(participantProfile(db, viewer).configured, false);
    for (const actor of [viewer, ai]) setParticipantName(db, actor, 'Same name');
    addSessionMessage(db, room.id, {
      senderKind: 'user',
      senderName: 'old browser snapshot',
      content: 'One',
      mediaTimeMs: 0
    });
    addSessionMessage(db, room.id, {
      senderKind: 'ai',
      senderIdentity: ai.id,
      senderName: 'stale client cache',
      content: 'Two',
      mediaTimeMs: 0
    });
    addSessionMessage(db, room.id, {
      senderKind: 'ai',
      senderName: 'Legacy credit',
      content: 'Three',
      mediaTimeMs: 0
    });
    setParticipantName(db, viewer, '鹿鹿');
    updateAiProfileSettings(db, { action: 'rename', id: ai.id, name: 'Elias' });
    const names = () => listSessionMessages(db, room.id).map((message) => message.senderName);
    assert.deepEqual(names(), ['鹿鹿', '鹿鹿', 'Elias', 'Legacy credit']);
    setParticipantName(db, viewer, '');
    setParticipantName(db, viewer, 'stale browser', { initializeOnly: true });
    assert.deepEqual(names(), ['user', 'user', 'Elias', 'Legacy credit']);
  } finally {
    db.close();
  }
});

test('new profiles select automatically, retain their IDs and reject name collisions atomically', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  assert.deepEqual(aiProfileSettings(db), { profiles: [], selectedId: null });
  setParticipantName(db, { kind: 'user' }, 'Elias');
  const update = (body) => updateAiProfileSettings(db, body);
  const first = update({ action: 'create', name: '  Elias  ' });
  const elias = first.selectedId;
  assert.ok(elias);
  assert.deepEqual(first.profiles, [{ id: elias, name: 'Elias' }]);
  const second = update({ action: 'create', name: 'Nova' });
  const nova = second.selectedId;
  assert.notEqual(nova, elias);
  assert.equal(update({ action: 'select', id: elias }).selectedId, elias);

  const before = aiProfileSettings(db);
  for (const body of [
    { action: 'create', name: ' Nova ' },
    { action: 'rename', id: elias, name: 'Nova' }
  ]) {
    assert.throws(() => update(body), { code: 'AI_NAME_TAKEN' });
  }
  for (const name of ['', '  ', 'two\nlines', 'a'.repeat(61)]) {
    assert.throws(() => update({ action: 'create', name }), TypeError);
  }
  for (const action of ['select', 'rename']) {
    assert.throws(() => update({ action, id: 'missing', name: 'Fresh' }), {
      code: 'AI_PROFILE_NOT_FOUND'
    });
  }
  assert.deepEqual(aiProfileSettings(db), before);
  const renamed = update({ action: 'rename', id: nova, name: 'Rose' });
  assert.deepEqual(renamed, {
    profiles: [{ id: elias, name: 'Elias' }, { id: nova, name: 'Rose' }],
    selectedId: elias
  });
});

test('older profiles stay distinct and an explicit selection survives restart', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'owc-profile-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'cinema.sqlite');
  let db = openDatabase(file);
  try {
    const legacy = db.prepare("insert into cinema_participants(kind,id,display_name) values('ai',?,?)");
    legacy.run('unnamed', '');
    assert.deepEqual(aiProfileSettings(db), { profiles: [], selectedId: null });
    legacy.run('old-a', '同名');
    assert.deepEqual(aiProfileSettings(db), { profiles: [{ id: 'old-a', name: '同名' }], selectedId: 'old-a' });
    legacy.run('old-b', '同名');
    assert.deepEqual(aiProfileSettings(db), {
      profiles: [{ id: 'old-a', name: '同名' }, { id: 'old-b', name: '同名' }], selectedId: null
    });
    updateAiProfileSettings(db, { action: 'select', id: 'old-b' });
    const room = openSession(db, { mediaId: 'legacy', mediaTitle: 'Film' });
    for (const id of ['old-a', 'old-b']) {
      addSessionMessage(db, room.id, { senderKind: 'ai', senderIdentity: id, senderName: '同名', content: id, mediaTimeMs: 0 });
    }
    updateAiProfileSettings(db, { action: 'rename', id: 'old-b', name: '旧朋友' });
    assert.deepEqual(listSessionMessages(db, room.id).map(({ senderName }) => senderName), ['同名', '旧朋友']);
  } finally {
    db.close();
  }
  db = openDatabase(file);
  try {
    assert.deepEqual(aiProfileSettings(db), {
      profiles: [{ id: 'old-a', name: '同名' }, { id: 'old-b', name: '旧朋友' }],
      selectedId: 'old-b'
    });
    assert.throws(() => updateAiProfileSettings(db, { action: 'select', id: 'unnamed' }), {
      code: 'AI_PROFILE_NOT_FOUND'
    });
  } finally {
    db.close();
  }
});
