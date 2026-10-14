import assert from 'node:assert/strict';
import test from 'node:test';
import { cinemaTickRange } from '../src/cinema-tick.mjs';
import { openDatabase, openSession, updateSessionPlayback } from '../src/database.mjs';

function range(overrides = {}) {
  return cinemaTickRange({
    mediaCursorMs: 573_180,
    playheadMs: 956_735,
    seekVersion: 1,
    cursorSeekVersion: 0,
    initialWindowMs: 15_000,
    maxAdvanceMs: 20_000,
    ...overrides
  });
}

test('Her forward seek rebases to destination context instead of skipped material', () => {
  assert.deepEqual(range(), {
    fromMs: 941_735, toMs: 956_735, playheadMs: 956_735,
    seekDetected: true, bootstrap: false
  });
});

test('backward and repeated seeks are detected even while the AI is behind', () => {
  assert.equal(range({ playheadMs: 400_000 }).fromMs, 385_000);
  assert.equal(range({ mediaCursorMs: 100_000, playheadMs: 400_000 }).seekDetected, true);
  assert.equal(range({ seekVersion: 3 }).fromMs, 941_735);
  assert.equal(range({ playheadMs: 5_000 }).fromMs, 0);
});

test('ordinary backlog is preserved and an acknowledged seek does not replay context', () => {
  assert.equal(range({ seekVersion: 0 }).toMs, 593_180);
  assert.equal(range({ seekVersion: 0 }).seekDetected, false);
  const caughtUp = range({ mediaCursorMs: 956_735, cursorSeekVersion: 1 });
  assert.equal(caughtUp.fromMs, 956_735);
  assert.equal(caughtUp.toMs, 956_735);
  assert.equal(caughtUp.seekDetected, false);
  const bootstrap = range({ mediaCursorMs: undefined });
  assert.equal(bootstrap.bootstrap, true);
  assert.equal(bootstrap.seekDetected, false);
  assert.equal(bootstrap.fromMs, 941_735);
});

test('legacy backward detection remains available without a seek notification', () => {
  assert.equal(range({ seekVersion: 0, playheadMs: 400_000 }).seekDetected, true);
});

test('seek version changes only on explicit seeks, including while paused', () => {
  const db = openDatabase(':memory:');
  try {
    const room = openSession(db, { mediaId: 'film', mediaTitle: 'Film' });
    assert.equal(room.seekVersion, 0);
    for (const playbackState of ['playing', 'paused', 'playing']) {
      assert.equal(updateSessionPlayback(db, room.id, {
        mediaTimeMs: 573_180, playbackState
      }).seekVersion, 0);
    }
    assert.equal(updateSessionPlayback(db, room.id, {
      mediaTimeMs: 956_735, playbackState: 'paused', seeked: true
    }).seekVersion, 1);
    assert.equal(updateSessionPlayback(db, room.id, {
      mediaTimeMs: 400_000, playbackState: 'paused', seeked: true
    }).seekVersion, 2);
    assert.equal(updateSessionPlayback(db, room.id, {
      mediaTimeMs: 401_000, playbackState: 'playing'
    }).seekVersion, 2);
  } finally {
    db.close();
  }
});
