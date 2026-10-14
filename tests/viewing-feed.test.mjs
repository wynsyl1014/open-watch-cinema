import assert from 'node:assert/strict';
import test from 'node:test';
import { buildViewingFeed, selectInlineStoryboards } from '../mcp/viewing-feed.mjs';

const frame = (time, kind = 'motion_peak') => ({
  mediaTimeMs: time, kind, storyboardRef: `frame-${time}.jpg`
});
function fixture() {
  return { tick: {
    playback: { playheadMs: 20_000, seekVersion: 3 },
    range: { fromMs: 10_000, toMs: 20_000, bootstrap: false, seekDetected: false },
    cursors: { mediaMs: 20_000, seekVersion: 3, messageId: 7, observationSequence: 0 },
    storyboards: [frame(10_000), frame(12_000, 'scene_change'), frame(16_000), frame(19_000), frame(21_000)]
  } };
}
const readRoom = async () => ({ status: 'active', seekVersion: 3, lastPositionMs: 21_000 });
const fetchFrame = async (selection) => ({ mcpContent: [
  { type: 'image', mimeType: 'image/jpeg', data: 'dGVzdA==' },
  { type: 'text', text: JSON.stringify({ panelTimesMs: [selection.mediaTimeMs - 1000, selection.mediaTimeMs - 500, selection.mediaTimeMs] }) }
] });

test('inline images include a scene transition and latest eligible view, in time order', () => {
  assert.deepEqual(selectInlineStoryboards(fixture().tick).map((x) => x.mediaTimeMs), [12_000, 19_000]);
});

test('paused polling does not reattach images; seeking can replay destination context', () => {
  const { tick } = fixture();
  tick.range.fromMs = tick.range.toMs;
  assert.deepEqual(selectInlineStoryboards(tick), []);
  tick.range.seekDetected = true;
  assert.deepEqual(selectInlineStoryboards(tick).map((x) => x.mediaTimeMs), [12_000, 19_000]);
});

test('image exactly at the new range start is delivered once, including a heartbeat', () => {
  const { tick } = fixture();
  tick.storyboards = [frame(10000, 'visual_heartbeat')];
  assert.deepEqual(selectInlineStoryboards(tick).map((x) => x.mediaTimeMs), [10000]);
  tick.range.fromMs = 10500;
  assert.deepEqual(selectInlineStoryboards(tick), []);
  tick.range.fromMs = tick.range.toMs = 10000;
  assert.deepEqual(selectInlineStoryboards(tick), []);
});

test('tick retains complete cursors and attaches labelled images', async () => {
  const payload = fixture();
  const result = await buildViewingFeed(payload, { fetchFrame, readRoom });
  const enriched = JSON.parse(result.mcpContent[0].text).tick;
  assert.deepEqual(enriched.cursors, payload.tick.cursors);
  assert.equal(result.mcpContent.filter((x) => x.type === 'image').length, 2);
  assert.deepEqual(enriched.visualEvidence.images.map((x) => x.status), ['attached', 'attached']);
});

test('missing images are explicit and do not discard dialogue or cursors', async () => {
  const payload = fixture();
  payload.tick.dialogueDelta = [{ text: 'A line worth keeping.' }];
  const result = await buildViewingFeed(payload, {
    fetchFrame: async () => { throw new Error('Missing image'); }, readRoom
  });
  const tick = JSON.parse(result.mcpContent[0].text).tick;
  assert.deepEqual(tick.dialogueDelta, payload.tick.dialogueDelta);
  assert.equal(tick.visualEvidence.images[0].status, 'unavailable');
  assert.equal(result.mcpContent.length, 1);
});

test('seek during image fetch rejects the entire stale packet', async () => {
  await assert.rejects(buildViewingFeed(fixture(), {
    fetchFrame, readRoom: async () => ({ status: 'active', seekVersion: 4, lastPositionMs: 40_000 })
  }), /same input cursors/);
});

test('oversized inline images remain explicit gaps without losing cursors', async () => {
  const payload = fixture();
  const result = await buildViewingFeed(payload, {
    fetchFrame: async () => ({ mcpContent: [
      { type: 'image', mimeType: 'image/jpeg', data: 'A'.repeat(2 * 1024 * 1024 + 1) }
    ] }), readRoom
  });
  const tick = JSON.parse(result.mcpContent[0].text).tick;
  assert.equal(result.mcpContent.filter((item) => item.type === 'image').length, 0);
  assert.ok(tick.visualEvidence.images.every((item) => item.status === 'unavailable'));
  assert.deepEqual(tick.cursors, payload.tick.cursors);
});
