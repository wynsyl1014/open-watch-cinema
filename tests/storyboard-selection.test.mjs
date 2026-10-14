import assert from 'node:assert/strict';
import test from 'node:test';
import { selectVisualArc, similarComposition } from '../src/storyboard-selection.mjs';
import { buildCinemaTick } from '../src/cinema-tick.mjs';
import { selectInlineStoryboards } from '../mcp/viewing-feed.mjs';

const frame = (mediaTimeMs, visualGroup, kind = 'motion_peak') => ({
  mediaTimeMs, visualGroup, kind, storyboardRef: `${mediaTimeMs}.jpg`
});

test('arc uses a distinct middle scene when the opening and final views look alike', () => {
  const result = selectVisualArc([
    frame(1000, 0, 'scene_change'), frame(8000, 1, 'scene_change'), frame(15000, 0)
  ]);
  assert.deepEqual(result.map((item) => item.mediaTimeMs), [8000, 15000]);
});

test('arc spreads distinct views across time and favours a cut over nearby motion', () => {
  const candidates = [frame(1000, 0), frame(1500, 1, 'scene_change'), frame(13000, 2), frame(15000, 3)];
  assert.deepEqual(selectVisualArc(candidates).map((item) => item.mediaTimeMs), [1500, 15000]);
  assert.deepEqual(selectVisualArc(candidates, 1).map((item) => item.mediaTimeMs), [15000]);
});

test('a static window contributes one current image even with many candidates', () => {
  assert.deepEqual(selectVisualArc([frame(0, 0), frame(12000, 0), frame(24000, 0)])
    .map((item) => item.mediaTimeMs), [24000]);
});

test('composition comparison groups small image changes but preserves different flat colours', () => {
  const original = { hash: 'f0f0f0f0f0f0f0f0', rgb: [0.4, 0.4, 0.4] };
  assert.equal(similarComposition(original, { ...original, hash: 'f0f0f0f0f0f0f0f1' }), true);
  assert.equal(similarComposition({ hash: '8000000000000000', rgb: [1, 0, 0] },
    { hash: '8000000000000000', rgb: [0, 0, 1] }), false);
  assert.equal(similarComposition({ hash: '8000000000000000' }, { hash: '8000000000000000' }), false);
  assert.equal(similarComposition({ hash: 'old-format' }, original), false);
});

test('HTTP shortlist and inline image limit preserve the same visual arc without exposing metrics', () => {
  const observations = Array.from({ length: 8 }, (_, index) => ({
    fromMs: (index + 1) * 2000, kind: index === 2 ? 'scene_change' : 'motion_peak',
    storyboard: { mediaTimeMs: (index + 1) * 2000, storyboardRef: `${index}.jpg`,
      perceptualHash: index === 2 ? '0f0f0f0f0f0f0f0f' : 'f0f0f0f0f0f0f0f0', averageRgb: [0.4, 0.4, 0.4] }
  }));
  const tick = buildCinemaTick({ room: { status: 'active' }, window: { observations },
    targetRange: { fromMs: 0, toMs: 20000, playheadMs: 20000 } });
  assert.deepEqual(selectInlineStoryboards(tick).map((item) => item.mediaTimeMs), [6000, 16000]);
  assert.equal(JSON.stringify(tick).includes('perceptualHash'), false);
  assert.equal(JSON.stringify(tick).includes('averageRgb'), false);
});
