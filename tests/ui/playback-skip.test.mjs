import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaybackSkip, playbackSkipRanges } from '../../public/playback-skip.js';

const intro = { kind: 'intro', fromMs: 1_000, toMs: 3_000 };
const outro = { kind: 'outro', fromMs: 8_000, toMs: 10_000 };
const controller = () => createPlaybackSkip(() => [intro, outro]);

test('natural playback skips each whole range including the film tail', () => {
  const skip = controller();
  assert.equal(skip.nextTarget(999.9), null);
  assert.equal(skip.nextTarget(1_000), 3_000);
  skip.programmaticSeek(3_000);
  assert.equal(skip.nextTarget(2_000), null);
  skip.finishSeek(3_000);
  assert.equal(skip.nextTarget(3_000), null);
  assert.equal(skip.nextTarget(8_100), 10_000);
});

test('manual seeks inside and at the first millisecond play normally even if timeupdate precedes seeked', () => {
  const skip = controller();
  for (const atMs of [1_000, 1_500]) {
    skip.beginSeek();
    assert.equal(skip.nextTarget(atMs), null);
    skip.finishSeek(atMs);
    assert.equal(skip.nextTarget(atMs), null);
    assert.equal(skip.nextTarget(2_999), null);
  }
});

test('seeking just before the start and playing into it clears manual viewing', () => {
  const skip = controller();
  skip.finishSeek(1_000);
  assert.equal(skip.nextTarget(2_000), null);
  skip.beginSeek();
  skip.finishSeek(999);
  assert.equal(skip.nextTarget(999), null);
  assert.equal(skip.nextTarget(1_000), 3_000);
});

test('leaving the selected range restores automatic skipping for later visits and other ranges', () => {
  const skip = controller();
  skip.finishSeek(1_500);
  assert.equal(skip.nextTarget(2_999), null);
  assert.equal(skip.nextTarget(3_000), null);
  assert.equal(skip.nextTarget(8_000), 10_000);
  assert.equal(skip.nextTarget(1_000), 3_000);
});

test('restoring a saved position does not create an exemption for manual viewing', () => {
  const skip = controller();
  skip.programmaticSeek(1_000);
  skip.beginSeek();
  skip.finishSeek(1_000);
  assert.equal(skip.nextTarget(1_500), 3_000);
  skip.finishSeek(2_000);
  assert.equal(skip.nextTarget(2_000), null);
  skip.reset();
  assert.equal(skip.nextTarget(2_000), 3_000);
});

test('playback uses the package snapshot, including an empty range list for old packages', () => {
  assert.deepEqual(playbackSkipRanges({ skipRanges: [intro] }), [intro]);
  assert.deepEqual(playbackSkipRanges({ skipRanges: [intro], aiPackage: { status: 'running' } }), [intro]);
  assert.deepEqual(playbackSkipRanges({ skipRanges: [intro], aiPackage: { skipRanges: [outro] } }), [outro]);
  assert.deepEqual(playbackSkipRanges({ skipRanges: [intro], aiPackage: { packageVersion: 3 } }), []);
  assert.deepEqual(playbackSkipRanges(null), []);
});
