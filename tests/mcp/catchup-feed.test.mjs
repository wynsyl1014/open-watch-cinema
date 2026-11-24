import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { collectViewingCatchup, collectPendingAudio } from '../../mcp/viewing/catchup-feed.mjs';

const cue = (ms, text = 'dialogue-' + ms) => ({ fromMs: ms, toMs: ms + 1200, text });
const sound = (ms) => ({ id: 'a-' + ms, fromMs: ms - 10000, toMs: ms,
  availableAtMs: ms, text: 'audio-' + ms });
const pic = (ms, group = 0) => ({ mediaTimeMs: ms, fromMs: ms, toMs: ms + 500,
  storyboardRef: 's-' + ms + '.jpg', visualGroup: group, kind: 'scene_change' });
const msg = (ms, text) => ({ mediaTimeMs: ms, content: text });
function page({ from = 0, to = 20000, more = false, seekVersion = 3, seeked = false,
  roomId = 'room-1', messages = [], cues = [], sounds = [], images = [], motions = [],
  messageId = 0, observationSequence = 0 } = {}) {
  return {
    tick: {
      playback: { timeMs: 60000, state: 'playing', seekVersion, ...(seeked ? { seeked: true } : {}) },
      range: { fromMs: from, toMs: to, bootstrap: from === 0, seekDetected: seeked },
      newMessages: messages, dialogueDelta: cues, audioDescriptions: sounds, audioStatus: 'ready',
      storyboards: images, motionEvents: motions, ...(more ? { more: true } : {})
    },
    state: { roomId, cursors: { mediaMs: to, seekVersion, messageId, observationSequence } },
    recommendedNextPollMs: 2000
  };
}

test('one tool call drains a 60-second backlog, retaining all unique subtitle/audio content', async () => {
  const initial = { mediaMs: 0, seekVersion: 3, messageId: 0, observationSequence: 0 };
  const packets = [
    page({ to: 20000, more: true, messages: [msg(1000, 'again'), msg(1200, 'again')],
      cues: [cue(0, '你好'), cue(19500, '跨边界对白')], sounds: [sound(10000), sound(20000)],
      images: [pic(2000), pic(13000)], messageId: 2, observationSequence: 1 }),
    page({ from: 20000, to: 40000, more: true, messages: [msg(22000, '你看这里')],
      cues: [cue(19500, '跨边界对白'), cue(30000, '故事继续')], sounds: [sound(20000), sound(30000), sound(40000)],
      images: [pic(23000), pic(39000)], messageId: 3, observationSequence: 2 }),
    page({ from: 40000, to: 60000, cues: [cue(42000, '最终一句')],
      sounds: [sound(50000), sound(60000)], images: [pic(47000), pic(58000)],
      messageId: 3, observationSequence: 3 })
  ];
  const cursorsSeen = [];
  let reads = 0;
  const got = await collectViewingCatchup({
    requestTick: async ({ cursors, roomId }) => {
      cursorsSeen.push({ ...cursors, roomId });
      return packets[reads++];
    },
    roomId: 'room-1', cursors: initial, identity: 'private-identity'
  });
  assert.equal(reads, 3);
  assert.deepEqual(initial, { mediaMs: 0, seekVersion: 3, messageId: 0, observationSequence: 0 });
  assert.deepEqual(cursorsSeen.map(x => x.mediaMs), [0, 20000, 40000]);
  assert.equal(got.state.cursors.mediaMs, 60000);
  assert.equal(got.state.cursors.messageId, 3);
  assert.equal(got.tick.catchup.windowsRead, 3);
  assert.equal(got.tick.catchup.deliveredThroughMs, 60000);
  assert.equal(got.tick.catchup.pending, false);
  assert.equal(got.tick.more, undefined);
  assert.deepEqual(got.tick.newMessages.map(x => x.content), ['again', 'again', '你看这里']);
  assert.deepEqual(got.tick.dialogueDelta.map(x => x.text), ['你好', '跨边界对白', '故事继续', '最终一句']);
  assert.deepEqual(got.tick.audioDescriptions.map(x => x.id),
    ['a-10000', 'a-20000', 'a-30000', 'a-40000', 'a-50000', 'a-60000']);
  assert.deepEqual(got.tick.storyboards.map(x => x.mediaTimeMs), [2000, 13000, 23000, 39000, 47000, 58000]);
  assert.equal(got.recommendedNextPollMs, 2000);
  assert.ok(!JSON.stringify(got.tick).includes('private-identity'));
  assert.ok(!JSON.stringify(got.tick).includes('observationSequence'));
});

test('text budget holds the unread page for the next invocation', async () => {
  const big = '保持字幕原样'.repeat(150);
  const packets = [
    page({ to: 20000, more: true, cues: [cue(1000, big)] }),
    page({ from: 20000, to: 40000, more: true, cues: [cue(22000, big)] })
  ];
  let n = 0;
  const first = await collectViewingCatchup({
    requestTick: async () => packets[n++], roomId: 'room-1',
    cursors: { mediaMs: 0, seekVersion: 3 },
    maxTextCharacters: 1400
  });
  assert.equal(first.tick.catchup.pendingReason, 'text_budget');
  assert.equal(first.tick.more, true);
  assert.equal(first.tick.catchup.windowsRead, 1);
  assert.equal(first.state.cursors.mediaMs, 20000);
  assert.equal(first.tick.dialogueDelta[0].text, big);
  const next = await collectViewingCatchup({
    requestTick: async () => packets[1], roomId: 'room-1',
    cursors: first.state.cursors, maxWindows: 1
  });
  assert.equal(next.tick.dialogueDelta[0].text, big);
});

test('hard page cap preserves the unconsumed tail', async () => {
  const got = await collectViewingCatchup({
    requestTick: async () => page({ from: 20000, to: 40000, more: true }),
    roomId: 'room-1', cursors: { mediaMs: 20000 }, maxWindows: 1
  });
  assert.equal(got.tick.catchup.pendingReason, 'page_limit');
  assert.equal(got.tick.more, true);
  assert.equal(got.state.cursors.mediaMs, 40000);
});

test('seek rebase is surfaced; mid-drain seek or room transition rejects without a state commit', async () => {
  const packets = [
    page({ from: 30000, to: 45000, seeked: true, seekVersion: 7, more: true, cues: [cue(31000)] }),
    page({ from: 45000, to: 60000, seekVersion: 7, cues: [cue(49000)] })
  ];
  let n = 0;
  const rebased = await collectViewingCatchup({
    requestTick: async () => packets[n++],
    roomId: 'room-1', cursors: { mediaMs: 20000, seekVersion: 6 }
  });
  assert.equal(rebased.tick.playback.seeked, true);
  assert.equal(rebased.tick.dialogueDelta.length, 2);

  n = 0;
  packets[1] = page({ from: 45000, to: 60000, seekVersion: 8 });
  await assert.rejects(collectViewingCatchup({
    requestTick: async () => packets[n++],
    roomId: 'room-1', cursors: { mediaMs: 20000, seekVersion: 6 }
  }), /seek changed/);
  n = 0;
  packets[1] = page({ from: 45000, to: 60000, seekVersion: 7, roomId: 'room-2' });
  await assert.rejects(collectViewingCatchup({
    requestTick: async () => packets[n++],
    roomId: 'room-1', cursors: { mediaMs: 20000, seekVersion: 6 }
  }), /room changed/);
});

test('no progress cannot loop, malformed responses fail, quiet room retains an empty packet', async () => {
  const stagnant = await collectViewingCatchup({
    requestTick: async () => page({ from: 0, to: 0, more: true }),
    roomId: 'room-1', cursors: { mediaMs: 0, seekVersion: 3, messageId: 0, observationSequence: 0 }
  });
  assert.equal(stagnant.tick.catchup.pendingReason, 'no_cursor_progress');
  assert.equal(stagnant.tick.more, true);
  assert.equal(stagnant.tick.dialogueDelta.length, 0);
  await assert.rejects(collectViewingCatchup({ requestTick: async () => ({ tick: {}, state: {} }) }),
    /valid managed tick/);
});

test('prepared images and motion entries are retained without another visual selection', async () => {
  const frames = Array.from({ length: 30 }, (_, i) => pic(i * 700, i));
  const motion = Array.from({ length: 100 }, (_, i) =>
    ({ fromMs: i * 200, toMs: i * 200 + 100, kind: 'motion_peak', direction: 'left' }));
  const allCues = Array.from({ length: 80 }, (_, i) => cue(i * 200, 'Line ' + i));
  const got = await collectViewingCatchup({
    requestTick: async () => page({ to: 20000, cues: allCues, sounds: [sound(10000), sound(20000)],
      images: frames, motions: motion })
  });
  assert.equal(got.tick.dialogueDelta.length, 80);
  assert.equal(got.tick.audioDescriptions.length, 2);
  assert.equal(got.tick.storyboards.length, 30);
  assert.equal(got.tick.motionEvents.length, 100);
  assert.equal(got.tick.catchup.motionEventsSummarized, 0);
});

test('host cancellation stops the next page and leaves input cursors untouched', async () => {
  const controller = new AbortController();
  const cursors = { mediaMs: 0, seekVersion: 3 };
  let reads = 0;
  await assert.rejects(collectViewingCatchup({
    cursors, signal: controller.signal,
    requestTick: async ({ signal }) => {
      assert.equal(signal, controller.signal);
      reads += 1;
      if (reads === 2) {
        controller.abort(new DOMException('Viewer stopped', 'AbortError'));
        signal.throwIfAborted();
      }
      return page({ more: true });
    }
  }), { name: 'AbortError' });
  assert.equal(reads, 2);
  assert.deepEqual(cursors, { mediaMs: 0, seekVersion: 3 });
});

test('a cancelled call never starts catch-up', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(collectViewingCatchup({
    signal: controller.signal,
    requestTick: () => assert.fail('No page should be requested')
  }), { name: 'AbortError' });
});

test('time budget returns completed pages while retaining the timed-out page for the next call', async () => {
  const cursors = { mediaMs: 0, seekVersion: 3 };
  let reads = 0;
  const got = await collectViewingCatchup({
    cursors, timeBudgetMs: 20,
    requestTick: async ({ signal }) => {
      reads += 1;
      if (reads === 1) return page({ more: true, cues: [cue(1000)] });
      await delay(10_000, null, { signal });
      assert.fail('The unfinished second page must be cancelled');
    }
  });
  assert.equal(reads, 2);
  assert.equal(got.state.cursors.mediaMs, 20000);
  assert.equal(got.tick.catchup.pendingReason, 'time_budget');
  assert.equal(got.tick.catchup.deliveredThroughMs, 20000);
  assert.equal(got.tick.dialogueDelta.length, 1);
  assert.deepEqual(cursors, { mediaMs: 0, seekVersion: 3 });
});

test('time budget before the first page reports waiting without a cursor to commit', async () => {
  await assert.rejects(collectViewingCatchup({
    timeBudgetMs: 10,
    requestTick: ({ signal }) => delay(10_000, page(), { signal })
  }), { code: 'CATCHUP_BUDGET_EXHAUSTED' });
});

test('unified sections merge across pages and preserve pending audio ranges and settings', async () => {
  const first = page({ to: 1000, more: true });
  const second = page({ from: 1000, to: 2000 });
  for (const [index, packet] of [first, second].entries()) {
    Object.assign(packet.tick, {
      packageVersion: 3, viewingIntervalMs: 2000,
      segments: [{ id: 'section-0', fromMs: 0, toMs: 2000,
        entries: [{ id: 'line-' + index, type: 'dialogue', fromMs: 500 + index * 1000,
          toMs: 3000, availableAtMs: 500 + index * 1000, text: 'line-' + index }] }],
      pendingAudioRanges: [{ chunkId: 'chunk-0000', fromMs: index * 1000, toMs: (index + 1) * 1000 }]
    });
    packet.viewingSettings = { revision: 'settings-' + index, intervalMs: 2000 };
  }
  let calls = 0;
  const got = await collectViewingCatchup({ requestTick: async () => [first, second][calls++] });
  assert.equal(got.tick.segments.length, 1);
  assert.equal(got.tick.segments[0].entries.length, 2);
  assert.deepEqual(got.tick.pendingAudioRanges, [{ chunkId: 'chunk-0000', fromMs: 0, toMs: 2000 }]);
  assert.equal(got.viewingSettings.revision, 'settings-0');
});

test('waiting for preparation ends catchup at the actual cursor without a busy loop', async () => {
  const packet = page({ from: 1000, to: 1000, more: true });
  Object.assign(packet.tick, { packageVersion: 3, segments: [], awaitingPreparation: true });
  let calls = 0;
  const got = await collectViewingCatchup({ requestTick: async () => { calls += 1; return packet; } });
  assert.equal(calls, 1);
  assert.equal(got.state.cursors.mediaMs, 1000);
  assert.equal(got.tick.awaitingPreparation, true);
  assert.equal(got.tick.catchup.pendingReason, 'preparing');
});

function audioWindow({ entries = [], pending = [], through = 20000, seekVersion = 3 } = {}) {
  return {
    room: { id: 'room-1', status: 'active', seekVersion },
    window: {
      nextCursorMs: through, pendingAudioRanges: pending,
      segments: [{ id: 'section-0', fromMs: 0, toMs: 10000, entries }]
    }
  };
}
const pendingRange = { chunkId: 'chunk-0000', fromMs: 0, toMs: 20000 };
const audioEntry = (id = 'sound-1') => ({
  id, type: 'sound', fromMs: 5000, toMs: 15000, availableAtMs: 15000, text: 'footsteps'
});
const audioOptions = { ranges: [pendingRange], roomId: 'room-1', seekVersion: 3, playheadMs: 20000 };

test('ready late sound is returned in its original section and already delivered IDs are skipped', async () => {
  const got = await collectPendingAudio({
    ...audioOptions,
    deliveredIds: new Set(['sound-old']),
    requestWindow: async () => audioWindow({ entries: [audioEntry('sound-old'), audioEntry()] })
  });
  assert.deepEqual(got.pendingAudioRanges, []);
  assert.equal(got.segments[0].fromMs, 0);
  assert.deepEqual(got.segments[0].entries.map((entry) => entry.id), ['sound-1']);
});

test('unready sound remains pending and capped audio windows preserve their tail', async () => {
  const unready = await collectPendingAudio({
    ...audioOptions,
    requestWindow: async () => audioWindow({ pending: [pendingRange] })
  });
  assert.deepEqual(unready.pendingAudioRanges, [pendingRange]);
  assert.deepEqual(unready.segments, []);
  const limited = await collectPendingAudio({
    ...audioOptions,
    requestWindow: async () => audioWindow({ entries: [audioEntry()], through: 15000 })
  });
  assert.deepEqual(limited.pendingAudioRanges, [{ ...pendingRange, fromMs: 15000 }]);
});

test('late sound reads reject seeks and propagate caller cancellation', async () => {
  await assert.rejects(collectPendingAudio({
    ...audioOptions, requestWindow: async () => audioWindow({ seekVersion: 4 })
  }), { code: 'PLAYBACK_CHANGED' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(collectPendingAudio({
    ...audioOptions, signal: controller.signal,
    requestWindow: async () => assert.fail('No read expected')
  }), { name: 'AbortError' });
});


test('late sound keeps its full range and releases from its start even for an old end-gated record', async () => {
  const got = await collectPendingAudio({
    ...audioOptions, playheadMs: 5000,
    requestWindow: async () => audioWindow({ entries: [audioEntry()], through: 5000 })
  });
  assert.equal(got.segments[0].entries[0].availableAtMs, 5000);
  assert.equal(got.segments[0].entries[0].toMs, 15000);
  assert.deepEqual(got.pendingAudioRanges, [{ ...pendingRange, fromMs: 5000 }]);
});
