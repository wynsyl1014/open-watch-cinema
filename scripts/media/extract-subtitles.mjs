import { resolve } from 'node:path';

import {
  extractSubtitleStreams
} from '../../src/media/index.mjs';

const input = process.argv[2];
const target = process.argv[3] || input;

if (!input) {
  console.error('Usage: node scripts/media/extract-subtitles.mjs <source-media> [target-media]');
  process.exit(2);
}

try {
  const result = await extractSubtitleStreams(resolve(input), {
    outputMediaPath: resolve(target)
  });
  console.log(JSON.stringify({
    ok: result.status === 'ready' || result.status === 'no_subtitles',
    status: result.status,
    trackCount: result.tracks.length,
    tracks: result.tracks.map((track) => ({
      id: track.id,
      streamIndex: track.streamIndex,
      language: track.language,
      title: track.title,
      label: track.label,
      default: track.default,
      format: track.format,
      fileName: track.fileName
    }))
  }, null, 2));
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
