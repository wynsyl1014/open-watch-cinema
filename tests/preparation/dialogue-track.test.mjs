import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chooseDialogueSubtitleTrack,
  dialogueChunkPayload,
  parseWebVttDialogue
} from '../../src/preparation/dialogue-track.mjs';

test('WebVTT dialogue parser produces stable timed plain-text cues', () => {
  const cues = parseWebVttDialogue(`WEBVTT

00:00:01.000 --> 00:00:03.250 line:96%
<c.zh>你好</c>

00:00:03.250 --> 00:00:04.000
Second   line.
`);

  assert.equal(cues.length, 2);
  assert.deepEqual(cues.map(({ fromMs, toMs, text }) => ({ fromMs, toMs, text })), [
    { fromMs: 1_000, toMs: 3_250, text: '你好' },
    { fromMs: 3_250, toMs: 4_000, text: 'Second line.' }
  ]);
  assert.match(cues[0].cueId, /^[a-f0-9]{20}$/);
});

test('dialogue source selection prefers explicit choice, then English, then default', () => {
  const tracks = [
    { id: 'zh', language: 'zho', default: true },
    { id: 'en', language: 'eng', default: false }
  ];
  assert.equal(chooseDialogueSubtitleTrack(tracks).id, 'en');
  assert.equal(chooseDialogueSubtitleTrack(tracks, 'zh').id, 'zh');
  assert.equal(chooseDialogueSubtitleTrack([{ id: 'fr', language: 'fra', default: true }]).id, 'fr');
});

test('dialogue chunk keeps boundary-overlapping cues beside the visual chunk', () => {
  const source = {
    status: 'source_detected',
    sourceMode: 'test',
    track: { id: 'en', language: 'eng', format: 'webvtt' },
    cues: [
      { cueId: 'before', fromMs: 9_000, toMs: 10_500, text: 'Carries in.' },
      { cueId: 'owned', fromMs: 11_000, toMs: 12_000, text: 'Owned here.' },
      { cueId: 'after', fromMs: 20_000, toMs: 21_000, text: 'Next chunk.' }
    ]
  };
  const chunk = {
    chunkId: 'chunk-0001',
    index: 1,
    acceptFromMs: 10_000,
    acceptToMs: 20_000
  };
  const payload = dialogueChunkPayload(source, chunk, { planId: 'plan' });

  assert.deepEqual(payload.cues.map(({ cueId, owned }) => ({ cueId, owned })), [
    { cueId: 'before', owned: false },
    { cueId: 'owned', owned: true }
  ]);
});
