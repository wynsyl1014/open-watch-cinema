import assert from 'node:assert/strict';
import test from 'node:test';

import { assessChromeCompatibility } from '../../src/media/media-compatibility.mjs';

test('Chrome profile accepts MP4 H.264 yuv420p with AAC audio', () => {
  const result = assessChromeCompatibility({
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    video: { codec_name: 'h264', pix_fmt: 'yuv420p' },
    audio: { codec_name: 'aac', channels: 2 }
  });

  assert.equal(result.ready, true);
});

test('Chrome profile requests only audio conversion for MP4 H.264 with AC3', () => {
  const result = assessChromeCompatibility({
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    video: { codec_name: 'h264', pix_fmt: 'yuv420p' },
    audio: { codec_name: 'ac3', channels: 2 }
  });

  assert.equal(result.ready, false);
  assert.equal(result.videoReady, true);
  assert.equal(result.audioReady, false);
  assert.match(result.note, /AC3/i);
});

test('Chrome profile sends Matroska H.264 AAC through the MP4 preparation path', () => {
  const result = assessChromeCompatibility({
    formatName: 'matroska,webm',
    video: { codec_name: 'h264', pix_fmt: 'yuv420p' },
    audio: { codec_name: 'aac', channels: 2 }
  });

  assert.equal(result.ready, false);
  assert.equal(result.videoReady, true);
  assert.equal(result.audioReady, true);
  assert.match(result.note, /remuxed to MP4/i);
});
