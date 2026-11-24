import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/storage/database.mjs';
import {
  DEFAULT_VIEWING_INTERVAL_MS,
  getViewingCadence,
  setViewingCadence,
  getViewingSettings,
  setViewingSettings
} from '../../src/visuals/viewing-cadence.mjs';

test('cinema viewing cadence defaults to two seconds and stores a customized value', () => {
  const db = openDatabase(':memory:');
  try {
    assert.equal(getViewingCadence(db).intervalMs, DEFAULT_VIEWING_INTERVAL_MS);
    const value = setViewingCadence(db, 0.5);
    assert.equal(value.intervalMs, 500);
    assert.equal(value.dialoguePolicy, 'complete');
    assert.equal(value.visualPolicy, 'event_selected');
    assert.equal(getViewingCadence(db).intervalSeconds, 0.5);

    setViewingCadence(db, 1.75);
    assert.equal(getViewingCadence(db).intervalMs, 1750);
    assert.equal(getViewingCadence(db).intervalSeconds, 1.75);

    setViewingCadence(db, 30);
    assert.equal(getViewingCadence(db).intervalMs, 30000);
  } finally {
    db.close();
  }
});

test('invalid changes reject without overwriting a saved preference', () => {
  const db = openDatabase(':memory:');
  try {
    setViewingCadence(db, 2.5);
    for (const bad of [0, 0.49, 30.1, Infinity, NaN, null, '2', -5]) {
      assert.throws(() => setViewingCadence(db, bad), /Viewing interval/);
      assert.equal(getViewingCadence(db).intervalMs, 2500);
    }
  } finally {
    db.close();
  }
});

test('invalid persisted values fall back to the default without modifying other settings', () => {
  const db = openDatabase(':memory:');
  try {
    db.prepare('insert into settings (key, value, updated_at) values (?, ?, ?)').run(
      'ai_viewing_interval_ms', '-900', new Date().toISOString()
    );
    assert.equal(getViewingCadence(db).intervalMs, 2000);
  } finally {
    db.close();
  }
});

test('viewing settings save the selected preparation choices and keep a stable revision', () => {
  const db = openDatabase(':memory:');
  try {
    const initial = getViewingSettings(db);
    assert.equal(initial.initialBufferMinutes, 15);
    assert.equal(Object.hasOwn(initial, 'storyboardHeight'), false);
    assert.equal(initial.audioReleasePolicy, 'start');
    assert.equal(initial.configured, false);
    assert.equal(initial.aiOnlineTimeoutSeconds, 30);
    const timeout = setViewingSettings(db, { aiOnlineTimeoutSeconds: 45 });
    assert.equal(timeout.aiOnlineTimeoutSeconds, 45);
    assert.equal(timeout.revision, initial.revision);
    assert.equal(timeout.configured, false);
    assert.throws(() => setViewingSettings(db, { aiOnlineTimeoutSeconds: 0 }), /AI 在线保留时间/);
    assert.equal(getViewingSettings(db).aiOnlineTimeoutSeconds, 45);
    const saved = setViewingSettings(db, { intervalSeconds: 3, initialBufferMinutes: 30 });
    assert.equal(saved.configured, true);
    assert.equal(saved.initialBufferMs, 1_800_000);
    assert.equal(saved.aiOnlineTimeoutSeconds, 45);
    assert.notEqual(saved.revision, initial.revision);
    assert.equal(setViewingSettings(db, { intervalSeconds: 3, initialBufferMinutes: 30 }).revision, saved.revision);
    assert.throws(() => setViewingSettings(db, { intervalSeconds: 4, storyboardHeight: 1440 }), /Unknown viewing setting/);
    assert.equal(getViewingSettings(db).revision, saved.revision);
  } finally {
    db.close();
  }
});
