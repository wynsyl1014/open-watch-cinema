import test from 'node:test';
import assert from 'node:assert/strict';
import { nextOlderOffset } from '../../public/ai-activity.js';

test('new calls shift the reader’s existing page without invalidating the loaded history', () => {
  const head = { calls: [{ callId: 'new' }, { callId: 'old' }], totalCalls: 81, nextOffset: 2 };
  assert.equal(nextOlderOffset(head, 'old', 80, 40), 41);
  assert.equal(nextOlderOffset(head, 'old', 80, null), null);
});

test('a late call or a nonoverlapping head exposes the missing range', () => {
  const head = { calls: [{ callId: 'new' }, { callId: 'old' }], totalCalls: 82, nextOffset: 2 };
  assert.equal(nextOlderOffset(head, 'old', 80, null), 2);
  assert.equal(nextOlderOffset(head, 'another', 78, 40), 2);
  assert.equal(nextOlderOffset({ ...head, nextOffset: null }, null, 0, 0), null);
});
