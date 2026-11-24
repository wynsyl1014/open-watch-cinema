import { resolve } from 'node:path';
import {
  assessDialogueSource
} from '../../src/media/index.mjs';

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/media/probe-subtitles.mjs <video>');
  process.exit(2);
}

try {
  const result = await assessDialogueSource(resolve(input));
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message || String(error) }));
  process.exit(1);
}
