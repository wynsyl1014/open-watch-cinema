import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { initializeNotebook, writeNotebook, readNotebook, readNotebookChanges } from '../../src/storage/notebook.mjs';

import {
  addSessionMessage,
  addSessionObservations,
  deleteArchivedRoom,
  listSessionMessages,
  endSession,
  getMediaCascadeSummary,
  listIndexedMedia,
  listSessions,
  openDatabase,
  openSession,
  syncMediaIndex
} from '../../src/storage/database.mjs';

test('releasing a film retains its room, conversation, observations and shared notebook until archive deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owc-delete-policy-'));
  const db = openDatabase(join(root, 'cinema.sqlite'));
  const mediaId = 'd'.repeat(24);

  try {
    syncMediaIndex(db, [{
      id: mediaId,
      title: 'Fixture Film',
      relativePath: 'Fixture Film.mp4',
      extension: '.mp4',
      size: 100,
      modifiedAt: '2026-08-05T00:00:00.000Z'
    }]);
    const room = openSession(db, { mediaId, mediaTitle: 'Fixture Film' });
    initializeNotebook(db);
    const saved = writeNotebook(db, room, { kind: 'note', text: 'Old note' }, { kind: 'ai', id: 'test' });
    writeNotebook(db, room, { id: saved.id, expectedVersion: saved.version, text: 'Edited note' }, { kind: 'user', id: 'viewer' });
    assert.equal(readNotebookChanges(db, room.id).events.length, 1);
    addSessionMessage(db, room.id, {
      senderName: 'Viewer',
      content: 'A retained thought.',
      mediaTimeMs: 1_000
    });
    addSessionObservations(db, room.id, {
      engine: 'fixture',
      observations: [{
        fromMs: 900,
        toMs: 1_100,
        kind: 'heartbeat',
        metrics: {}
      }]
    });
    endSession(db, room.id, { lastPositionMs: 2_000 });

    assert.deepEqual(getMediaCascadeSummary(db, mediaId), {
      sessionCount: 1,
      activeSessionCount: 0,
      messageCount: 1,
      observationCount: 1,
      frameCount: 0
    });

    syncMediaIndex(db, []);
    assert.deepEqual(listIndexedMedia(db), []);
    assert.equal(listSessions(db)[0].id, room.id);
    assert.equal(listSessionMessages(db, room.id)[0].content, 'A retained thought.');
    assert.equal(getMediaCascadeSummary(db, mediaId).observationCount, 1);
    assert.equal(readNotebookChanges(db, room.id).events.length, 1);

    assert.equal(deleteArchivedRoom(db, room.id).deleted, true);
    assert.deepEqual(listSessions(db), []);
    assert.deepEqual(readNotebookChanges(db, room.id).events, []);
    assert.equal(readNotebook(db, mediaId, 0).entries[0].text, 'Edited note');
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

