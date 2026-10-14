import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCinemaTick } from '../src/cinema-tick.mjs';

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
            perceptualHash: 'f0f0f0f0f0f0f0f0',
            averageRgb: [0.4, 0.4, 0.4],
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
            perceptualHash: 'f0f0f0f0f0f0f0f1',
            averageRgb: [0.4, 0.4, 0.4],
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
  assert.equal(tick.cursors.mediaMs, 20_000);
  assert.equal(tick.cursors.messageId, 5);
  assert.equal(tick.cursors.observationSequence, 9);
  assert.equal(tick.compacted.rawVisualMetricsOmitted, true);
  assert.equal(JSON.stringify(tick).includes('brightness'), false);
  assert.equal(JSON.stringify(tick).includes('histogramDistance'), false);
  assert.equal(JSON.stringify(tick).includes('perceptualHash'), false);
});

test('storyboard limit retains the newest view even when earlier action scores higher', () => {
  const input = {
    room: fixtureRoom(),
    targetRange: { fromMs: 0, toMs: 20_000, playheadMs: 20_000 },
    window: {
      observations: [1_000, 5_000, 19_000].map((mediaTimeMs, index) => ({
        fromMs: mediaTimeMs,
        kind: index < 2 ? 'scene_change' : 'visual_event',
        sceneScore: index < 2 ? 0.9 : 0,
        storyboard: { mediaTimeMs, storyboardRef: `frame-${mediaTimeMs}.jpg` }
      }))
    }
  };
  const tick = buildCinemaTick({ ...input, limits: { maxStoryboards: 2 } });
  assert.deepEqual(tick.storyboards.map((frame) => frame.mediaTimeMs), [1_000, 19_000]);
  const single = buildCinemaTick({ ...input, limits: { maxStoryboards: 1 } });
  assert.deepEqual(single.storyboards.map((frame) => frame.mediaTimeMs), [19_000]);
});

test('cinema tick reports backlog without dropping independent message and observation cursors', () => {
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

  assert.deepEqual(tick.cursors, {
    mediaMs: 15_000,
    seekVersion: 0,
    messageId: 10,
    observationSequence: 20
  });
  assert.equal(tick.more.media, true);
  assert.equal(tick.more.messages, true);
  assert.equal(tick.more.observations, true);
  assert.equal(tick.more.any, true);
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

  assert.deepEqual(tick.motionEvents.map((item) => item.sequenceNo), [31]);
  assert.equal(tick.cursors.observationSequence, 31);
  assert.equal(tick.more.observations, true);
  assert.equal(tick.more.any, true);
});

test('cinema tick omits self-authored AI echoes while advancing past them', () => {
  const tick = buildCinemaTick({
    room: fixtureRoom(),
    consumerName: 'Elias',
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
        content: 'Earlier AI reply.',
        mediaTimeMs: 19_500,
        createdAt: '2026-08-06T02:15:02.000Z'
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

  assert.deepEqual(tick.newMessages.map((item) => item.id), [5]);
  assert.equal(tick.cursors.messageId, 6);
  assert.equal(tick.compacted.selfMessagesOmitted, 1);
});
