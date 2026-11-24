import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeBilingualWebVtt,
  parseWebVtt,
  styleWebVttForPlayback
} from '../../public/subtitle-utils.js';

const chinese = `WEBVTT

00:01.000 --> 00:03.000
你读过一位叫法兰柏利斯的人
被谋杀的案子吗？

00:03.000 --> 00:04.000
（前情提要）
`;

const english = `WEBVTT

00:01.000 --> 00:04.000
Did you ever read about the murder of
a man called Frank Parris?
`;

test('single-language playback styling flattens soft line breaks and widens the cue', () => {
  const styled = styleWebVttForPlayback(chinese);
  assert.match(styled, /line:-1 position:50% size:96% align:center/);
  assert.match(styled, /你读过一位叫法兰柏利斯的人 被谋杀的案子吗？/);
  assert.doesNotMatch(styled, /法兰柏利斯的人\n被谋杀/);
});

test('bilingual subtitles align mismatched cue boundaries without losing either language', () => {
  const merged = mergeBilingualWebVtt(chinese, english);
  const cues = parseWebVtt(merged);
  assert.equal(cues.length, 2);
  assert.match(cues[0].text, /<c\.zh>你读过一位叫法兰柏利斯的人 被谋杀的案子吗？<\/c>/);
  assert.match(cues[0].text, /<c\.en>Did you ever read about the murder of a man called Frank Parris\?<\/c>/);
  assert.match(cues[1].text, /<c\.zh>（前情提要）<\/c>/);
  assert.match(cues[1].text, /<c\.en>Did you ever read about the murder of a man called Frank Parris\?<\/c>/);
});
