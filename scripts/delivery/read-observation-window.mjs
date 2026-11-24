import { resolve } from 'node:path';
import {
  readObservationTrackWindow
} from '../../src/delivery/index.mjs';

const [packageDir, fromValue, toValue, playheadValue] = process.argv.slice(2);
if (!packageDir || !fromValue || !toValue || !playheadValue) {
  console.error('Usage: node scripts/delivery/read-observation-window.mjs <package-dir> <from-ms> <to-ms> <playhead-ms>');
  process.exit(2);
}

try {
  const result = await readObservationTrackWindow(resolve(packageDir), {
    fromMs: Number(fromValue),
    toMs: Number(toValue),
    playheadMs: Number(playheadValue),
    lookaheadMs: 1_000,
    maxItems: 24
  });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message || String(error) }));
  process.exit(1);
}
