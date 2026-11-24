import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCinemaTick, cinemaTickRange } from '../../src/delivery/cinema-tick.mjs';

function fixtureRoom() {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    mediaId: 'a'.repeat(24),
    mediaTitle: 'Test Film',
    status: 'active',
    lastPositionMs: 20_000,
    playbackState: 'playing',
    playbackVersion: 7,
    updatedAt: '2026-08-06T02:15:00.000Z'
  };
}

test('cinema tick combines exact messages with compact spoiler-gated viewing material', () => {
  const tick = buildCinemaTick({
    room: fixtureRoom(),
    inputCursors: { messageId: 4, observationSequence: 8 },
    targetRange: {
      fromMs: 10_000,
      toMs: 20_000,
      playheadMs: 20_000,
      bootstrap: false,
      seekDetected: false
    },
    messages: [
      {
        id: 5,
        senderName: 'Sylvie',
        senderKind: 'user',
        content: 'Did you notice the stone?',
        mediaTimeMs: 12_345,
        createdAt: '2026-08-06T02:15:01.000Z'
      }
    ],
    liveObservations: [
      {
        sequenceNo: 9,
        fromMs: 18_000,
        toMs: 18_500,
        kind: 'motion_peak',
        sceneScore: 0.1,
        motionScore: 0.8,
        metrics: { brightness: 0.9, motionDirection: 'left' }
      }
    ],
    window: {
      visualStatus: 'ready',
      dialogueTrack: { status: 'ready' },
      aiReadiness: { ready: true, experienceMode: 'complete' },
      revealThroughMs: 20_000,
      hasMore: false,
      dialogueHasMore: false,
      dialogue: [
        { cueId: 'cue-1', fromMs: 11_000, toMs: 12_000, text: 'Look over there.' }
      ],
      observations: [
        {
          fromMs: 11_500,
          toMs: 12_000,
          kind: 'scene_change',
          sceneScore: 0.9,
          motionScore: 0.7,
          metrics: { brightness: 0.4, histogramDistance: 0.8, motionDirection: 'right' },
          storyboard: {
            mediaTimeMs: 11_500,
            frameReason: 'scene_change',
            perceptualHash: '0123456789abcdef',
            storyboardRef: 'chunks/a/storyboards/one.jpg'
          }
        },
        {
          fromMs: 12_000,
          toMs: 12_500,
          kind: 'motion_peak',
          sceneScore: 0.2,
          motionScore: 0.9,
          metrics: { brightness: 0.5, motionDirection: 'right' },
          storyboard: {
            mediaTimeMs: 12_000,
            frameReason: 'motion_peak',
            perceptualHash: '0123456789abcdef',
            storyboardRef: 'chunks/a/storyboards/duplicate.jpg'
          }
        }
      ]
    }
  });

  assert.equal(tick.newMessages.length, 1);
  assert.equal(tick.newMessages[0].content, 'Did you notice the stone?');
  assert.equal(tick.dialogueDelta[0].text, 'Look over there.');
  assert.equal(tick.storyboards.length, 1);
  assert.equal(tick.storyboards[0].storyboardRef, 'chunks/a/storyboards/duplicate.jpg');
  assert.equal(tick.motionEvents.length, 3);
  assert.deepEqual(tick.internalCursors, { mediaMs: 20_000, seekVersion: 0, messageId: 5, observationSequence: 9 });
  assert.equal(tick.playback.timeMs, 20_000);
  assert.equal(JSON.stringify(tick).includes('brightness'), false);
  assert.equal(JSON.stringify(tick).includes('histogramDistance'), false);
  assert.equal(JSON.stringify(tick).includes('perceptualHash'), false);
  assert.equal(JSON.stringify(tick).includes('sceneScore'), false);
  assert.equal(tick.newMessages[0].senderName, 'Sylvie');
});

test('cinema tick reports a light backlog signal while retaining internal independent cursors', () => {
  const tick = buildCinemaTick({
    room: fixtureRoom(),
    inputCursors: { messageId: 10, observationSequence: 20 },
    targetRange: {
      fromMs: 5_000,
      toMs: 15_000,
      playheadMs: 25_000,
      bootstrap: false,
      seekDetected: false
    },
    messages: [],
    liveObservations: [],
    messageHasMore: true,
    observationHasMore: true,
    window: {
      revealThroughMs: 15_000,
      observations: [],
      dialogue: [],
      hasMore: false,
      dialogueHasMore: false
    }
  });

  assert.deepEqual(tick.internalCursors, {
    mediaMs: 15_000,
    seekVersion: 0,
    messageId: 10,
    observationSequence: 20
  });
  assert.equal(tick.more, true);
});

test('cinema tick defers live observations beyond the spoiler gate without advancing their cursor', () => {
  const tick = buildCinemaTick({
    room: fixtureRoom(),
    inputCursors: { messageId: 0, observationSequence: 30 },
    targetRange: {
      fromMs: 10_000,
      toMs: 20_000,
      playheadMs: 20_000,
      bootstrap: false,
      seekDetected: false
    },
    liveObservations: [
      {
        sequenceNo: 31,
        fromMs: 19_000,
        toMs: 19_500,
        kind: 'motion_peak',
        motionScore: 0.8,
        metrics: { motionDirection: 'right' }
      },
      {
        sequenceNo: 32,
        fromMs: 21_000,
        toMs: 21_500,
        kind: 'scene_change',
        sceneScore: 0.9,
        motionScore: 0.6,
        metrics: { motionDirection: 'left' }
      }
    ],
    window: {
      revealThroughMs: 20_000,
      observations: [],
      dialogue: [],
      hasMore: false,
      dialogueHasMore: false
    }
  });

  assert.equal(tick.motionEvents.length, 1);
  assert.equal(tick.internalCursors.observationSequence, 31);
  assert.equal(tick.more, true);
});

test('cinema tick omits only the matching private AI identity while advancing past it', () => {
  const tick = buildCinemaTick({
    room: fixtureRoom(),
    consumerIdentity: 'mcp-one',
    inputCursors: { messageId: 4, observationSequence: 0 },
    targetRange: {
      fromMs: 20_000,
      toMs: 20_000,
      playheadMs: 20_000,
      bootstrap: false,
      seekDetected: false
    },
    messages: [
      {
        id: 5,
        senderName: 'Sylvie',
        senderKind: 'user',
        content: 'Viewer message.',
        mediaTimeMs: 19_000,
        createdAt: '2026-08-06T02:15:01.000Z'
      },
      {
        id: 6,
        senderName: 'Elias',
        senderKind: 'ai',
        senderIdentity: 'mcp-one',
        content: 'Earlier AI reply.',
        mediaTimeMs: 19_500,
        createdAt: '2026-08-06T02:15:02.000Z'
      },
      {
        id: 7,
        senderName: 'Elias',
        senderKind: 'ai',
        senderIdentity: 'mcp-two',
        content: 'Another Elias process.',
        mediaTimeMs: 19_700,
        createdAt: '2026-08-06T02:15:03.000Z'
      }
    ],
    window: {
      revealThroughMs: 20_000,
      observations: [],
      dialogue: [],
      hasMore: false,
      dialogueHasMore: false
    }
  });

  assert.deepEqual(tick.newMessages.map((item) => item.content), ['Viewer message.', 'Another Elias process.']);
  assert.equal(tick.internalCursors.messageId, 7);
  assert.equal(JSON.stringify(tick).includes('Earlier AI reply.'), false);
});


test('unified tick retains prepared images and commits only the range actually read', () => {
  const entries = [1_000, 2_000, 3_000].map((fromMs) => ({
    id: 'image-' + fromMs, type: 'image', fromMs, toMs: fromMs, availableAtMs: fromMs,
    storyboardRef: 'chunks/chunk-0000/storyboards/' + fromMs + '.jpg',
    panelTimesMs: [fromMs, fromMs, fromMs],
    perceptualHash: '0123456789abcdef'
  }));
  const tick = buildCinemaTick({
    room: fixtureRoom(), targetRange: { fromMs: 0, toMs: 20_000, playheadMs: 20_000 },
    limits: { maxStoryboards: 1 },
    window: {
      packageVersion: 3, viewingIntervalMs: 6_000, nextCursorMs: 6_000,
      revealThroughMs: 20_000, awaitingPreparation: true,
      observations: [], dialogue: [], audioDescriptions: [],
      pendingAudioRanges: [{ chunkId: 'chunk-0000', fromMs: 0, toMs: 6_000 }],
      segments: [{ id: 'section-0', fromMs: 0, toMs: 6_000, entries }]
    }
  });
  assert.equal(tick.storyboards.length, 3);
  assert.deepEqual(tick.storyboards.map((entry) => entry.mediaTimeMs), [1_000, 2_000, 3_000]);
  assert.equal(tick.segments[0].entries.length, 3);
  assert.equal(tick.internalCursors.mediaMs, 6_000);
  assert.equal(tick.range.toMs, 6_000);
  assert.equal(tick.awaitingPreparation, true);
  assert.equal(tick.more, true);
  assert.equal(tick.pendingAudioRanges.length, 1);
  assert.equal(JSON.stringify(tick).includes('perceptualHash'), false);
});

test('unified tick preserves complete dialogue across its delivery window', () => {
  const tick = buildCinemaTick({
    room: fixtureRoom(), targetRange: { fromMs: 4_000, toMs: 5_000, playheadMs: 5_000 },
    window: {
      packageVersion: 3, viewingIntervalMs: 6_000, nextCursorMs: 5_000, revealThroughMs: 5_000,
      observations: [], audioDescriptions: [], pendingAudioRanges: [],
      dialogue: [{ fromMs: 4_500, toMs: 8_000, text: 'A complete line.' }],
      segments: [{ id: 'section-0', fromMs: 0, toMs: 6_000, entries: [
        { id: 'line', type: 'dialogue', fromMs: 4_500, toMs: 8_000, availableAtMs: 4_500, text: 'A complete line.' }
      ] }]
    }
  });
  assert.equal(tick.dialogueDelta[0].toMs, 8_000);
  assert.equal(tick.segments[0].entries[0].toMs, 8_000);
  assert.equal(tick.internalCursors.mediaMs, 5_000);
});

test('prepared sound starts now while its full end remains ahead of the playhead', () => {
  const sound = { id: 'sound-now', type: 'sound', fromMs: 5_000, toMs: 15_000,
    availableAtMs: 15_000, text: 'Footsteps followed by a knock.' };
  const tick = buildCinemaTick({
    room: fixtureRoom(), targetRange: { fromMs: 4_000, toMs: 5_000, playheadMs: 5_000 },
    window: {
      packageVersion: 3, viewingIntervalMs: 6_000, nextCursorMs: 5_000, revealThroughMs: 5_000,
      observations: [], dialogue: [], audioDescriptions: [sound], pendingAudioRanges: [],
      segments: [{ id: 'section-0', fromMs: 0, toMs: 6_000, entries: [sound,
        { id: 'future-image', type: 'image', fromMs: 6_000, toMs: 6_000,
          availableAtMs: 6_000, storyboardRef: 'private.jpg', panelTimesMs: [6000, 6000, 6000] }
      ] }]
    }
  });
  assert.equal(tick.audioDescriptions[0].availableAtMs, 5_000);
  assert.equal(tick.audioDescriptions[0].toMs, 15_000);
  assert.equal(tick.segments[0].entries[0].availableAtMs, 5_000);
  assert.equal(tick.internalCursors.mediaMs, 5_000);
  assert.deepEqual(tick.storyboards, []);
});
test('resumed bootstrap and stale media cursors begin at the same room checkpoint', () => {
  const options = { playheadMs: 92_000, seekVersion: 0, cursorSeekVersion: 0,
    initialWindowMs: 15_000, maxAdvanceMs: 20_000, mediaFloorMs: 86_500 };
  assert.equal(cinemaTickRange(options).fromMs, 86_500);
  assert.equal(cinemaTickRange({ ...options, playheadMs: 120_000 }).fromMs, 105_000);
  assert.equal(cinemaTickRange({ ...options, mediaCursorMs: 0 }).fromMs, 86_500);
  assert.equal(cinemaTickRange({ ...options, mediaCursorMs: 90_000 }).fromMs, 90_000);
  assert.equal(cinemaTickRange({ ...options, playheadMs: 86_500 }).toMs, 86_500);
  assert.equal(cinemaTickRange({ ...options, mediaFloorMs: 0, seekVersion: 1, playheadMs: 43_000, mediaCursorMs: 92_000 }).fromMs, 28_000);
});

test('Chat media can advance ahead of the real playhead and retains that cursor when paused', () => {
  const options = { playheadMs: 30_000, mediaCursorMs: 30_000, seekVersion: 0, cursorSeekVersion: 0,
    initialWindowMs: 15_000, maxAdvanceMs: 60_000 };
  const future = cinemaTickRange({ ...options, deliveryHorizonMs: 50_000 });
  const sound = { id: 'sound', type: 'sound', fromMs: 34_000, toMs: 40_000, availableAtMs: 40_000,
    text: 'A noise.' };
  const expected = [sound, { id: 'line', type: 'dialogue', fromMs: 41_000, toMs: 43_000,
    availableAtMs: 41_000, text: 'A later line.' }];
  const tick = buildCinemaTick({ room: fixtureRoom(), targetRange: future, window: {
    packageVersion: 3, nextCursorMs: 50_000, revealThroughMs: 50_000,
    segments: [{ id: 'future', fromMs: 30_000, toMs: 60_000, entries: [...expected,
      { id: 'later', type: 'sound', fromMs: 49_000, toMs: 52_000, availableAtMs: 52_000, text: 'Too early.' }
    ] }]
  } });
  assert.equal(tick.playback.timeMs, 30_000);
  assert.equal(tick.playback.deliveryHorizonMs, 50_000);
  assert.deepEqual(tick.segments[0].entries.map(entry => [entry.id, entry.availableAtMs]), [['sound', 40_000], ['line', 41_000]]);
  assert.equal(tick.internalCursors.mediaMs, 50_000);
  const paused = cinemaTickRange({ ...options, playheadMs: 31_000, mediaCursorMs: 50_000, deliveryHorizonMs: 31_000 });
  assert.equal(paused.seekDetected, false);
  assert.equal(paused.fromMs, paused.toMs);
  assert.equal(buildCinemaTick({ room: fixtureRoom(), window: { packageVersion: 3 },
    targetRange: paused }).internalCursors.mediaMs, 50_000);
  const priority = cinemaTickRange({ ...options, playheadMs: 31_000, mediaCursorMs: 12_000, messagesOnly: true });
  assert.equal(buildCinemaTick({ room: fixtureRoom(), window: { packageVersion: 3 },
    targetRange: priority }).internalCursors.mediaMs, 12_000);
  assert.equal(cinemaTickRange({ ...options, mediaCursorMs: 50_000 }).seekDetected, true);
});
