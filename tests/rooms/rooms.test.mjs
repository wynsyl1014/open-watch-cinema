import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  addSessionMessage,
  deleteArchivedRoom,
  endSession,
  getActiveSession,
  getSession,
  latestRoomResume,
  listSessionMessages,
  listSessions,
  openDatabase,
  openSession,
  updateSessionPlayback
} from '../../src/storage/database.mjs';
import { getWatchBridgeState } from '../../src/storage/watch-bridge-settings.mjs';

test('room messages bind to film time and archived rooms reject new writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-watch-cinema-room-'));
  const databasePath = join(root, 'cinema.sqlite');
  const db = openDatabase(databasePath);

  try {
    const room = openSession(db, {
      mediaId: 'a'.repeat(24),
      mediaTitle: 'Test Film'
    });
    assert.equal(room.status, 'active');
    assert.equal(getActiveSession(db).id, room.id);

    const message = addSessionMessage(db, room.id, {
      senderName: 'Viewer',
      senderKind: 'user',
      content: 'This belongs at twelve seconds.',
      mediaTimeMs: 12_345
    });
    assert.equal(message.mediaTimeMs, 12_345);
    const secondMessage = addSessionMessage(db, room.id, {
      senderName: 'Elias',
      senderKind: 'ai',
      content: 'I saw it too.',
      mediaTimeMs: 13_000
    });
    assert.equal(listSessionMessages(db, room.id).length, 2);
    assert.deepEqual(
      listSessionMessages(db, room.id, { afterId: message.id, limit: 1 }).map((item) => item.id),
      [secondMessage.id]
    );

    const ended = endSession(db, room.id, { lastPositionMs: 22_000 });
    assert.equal(ended.status, 'ended');
    assert.equal(getActiveSession(db), null);
    assert.equal(listSessions(db)[0].messageCount, 2);

    assert.throws(
      () => addSessionMessage(db, room.id, {
        senderName: 'Viewer',
        content: 'This must not be accepted.',
        mediaTimeMs: 23_000
      }),
      /read-only/i
    );
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('only the latest ended screening supplies a film resume and an open room freezes that position', async t => {
  const root = await mkdtemp(join(tmpdir(), 'open-watch-cinema-room-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, 'cinema.sqlite');
  const film = { mediaId: 'same-film', mediaTitle: 'Same Film' };
  let db = openDatabase(databasePath);
  t.after(() => db.close());

  assert.equal(latestRoomResume(db, film.mediaId), null);
  const older = openSession(db, film);
  endSession(db, older.id, { lastPositionMs: 130_000 });
  const other = openSession(db, { mediaId: 'other-film', mediaTitle: 'Other Film' });
  endSession(db, other.id, { lastPositionMs: 500_000 });
  const latest = openSession(db, film);
  updateSessionPlayback(db, latest.id, { mediaTimeMs: 110_000, playbackState: 'playing' });
  endSession(db, latest.id, { lastPositionMs: 86_500 });
  const resume = latestRoomResume(db, film.mediaId);
  assert.deepEqual({ ...resume }, { mediaId: film.mediaId, roomId: latest.id, lastPositionMs: 86_500 });
  for (const invalid of [{ ...resume, roomId: older.id }, { ...resume, roomId: other.id }, { ...resume, lastPositionMs: 86_501 }]) {
    assert.throws(() => openSession(db, { ...film, resume: invalid }), { code: 'ROOM_RESUME_STALE' });
    assert.equal(getActiveSession(db), null);
  }

  const next = openSession(db, { ...film, resume, openingMessage: 'Welcome back' });
  assert.equal(next.playbackState, 'paused');
  assert.equal(next.lastPositionMs, 86_500);
  assert.equal(next.seekVersion, 0);
  assert.equal(getSession(db, latest.id).lastPositionMs, 86_500);
  updateSessionPlayback(db, next.id, { mediaTimeMs: 100_000, playbackState: 'playing' });
  db.close();
  db = openDatabase(databasePath);
  assert.equal(getActiveSession(db).resumeFromMs, 86_500);
  assert.equal(getWatchBridgeState(db).resumeFromMs, 86_500);
  assert.equal(getWatchBridgeState(db).playheadMs, 100_000);
  const ended = endSession(db, next.id);
  assert.equal(ended.lastPositionMs, 100_000);
  assert.equal(getSession(db, next.id).resumeFromMs, null);
  assert.equal(getWatchBridgeState(db).resumeFromMs, null);

  const secondOffer = latestRoomResume(db, film.mediaId);
  deleteArchivedRoom(db, next.id);
  assert.throws(() => openSession(db, { ...film, resume: secondOffer }), { code: 'ROOM_RESUME_STALE' });
  const restarted = openSession(db, film);
  assert.equal(restarted.resumeFromMs, null);
  assert.equal(restarted.lastPositionMs, 0);
  endSession(db, restarted.id, { lastPositionMs: 0 });
  assert.equal(latestRoomResume(db, film.mediaId), null);
});
