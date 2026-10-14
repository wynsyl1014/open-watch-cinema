import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaybackSync } from '../public/playback-sync.js';

test('pause or resume during debounce retains the seek and latest destination', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  const schedule = createPlaybackSync({ send: (item) => sent.push(item), onError: assert.fail });
  schedule({ roomId: 'a', mediaTimeMs: 500, seeked: true });
  schedule({ roomId: 'a', mediaTimeMs: 900, seeked: true });
  schedule({ roomId: 'a', mediaTimeMs: 900, playbackState: 'paused' });
  t.mock.timers.tick(250);
  await Promise.resolve();
  assert.deepEqual(sent, [{ roomId: 'a', mediaTimeMs: 900, playbackState: 'paused', seeked: true }]);
});

test('slow playback requests cannot overtake a newer seek', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  let release;
  const first = new Promise((resolve) => { release = resolve; });
  const schedule = createPlaybackSync({
    send: (item) => { sent.push(item); return sent.length === 1 ? first : undefined; },
    onError: assert.fail
  });
  schedule({ roomId: 'a', mediaTimeMs: 500 });
  t.mock.timers.tick(250);
  await Promise.resolve();
  schedule({ roomId: 'a', mediaTimeMs: 900, seeked: true });
  t.mock.timers.tick(250);
  await Promise.resolve();
  assert.equal(sent.length, 1);
  release();
  await first;
  // Drain the promise chain after the first request completes.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.map((item) => item.mediaTimeMs), [500, 900]);
});

test('pending seek flags do not transfer to another room', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  const schedule = createPlaybackSync({ send: (item) => sent.push(item), onError: assert.fail });
  schedule({ roomId: 'a', mediaTimeMs: 500, seeked: true });
  schedule({ roomId: 'b', mediaTimeMs: 0 });
  t.mock.timers.tick(250);
  await Promise.resolve();
  assert.deepEqual(sent, [{ roomId: 'b', mediaTimeMs: 0, seeked: false }]);
});
