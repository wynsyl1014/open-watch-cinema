import { readFile } from 'node:fs/promises';
import { validateViewingChunk } from '../../src/delivery/viewing-package.mjs';
import { join, resolve } from 'node:path';

const packageDir = resolve(process.argv[2] || '');
if (!process.argv[2]) {
  console.error('Usage: node scripts/delivery/inspect-observation-package.mjs <package-dir>');
  process.exit(2);
}

const manifest = JSON.parse(await readFile(join(packageDir, 'manifest.json'), 'utf8'));
const observations = [];
for (const chunk of manifest.chunks.filter((item) => item.status === 'complete')) {
  const payload = JSON.parse(await readFile(join(packageDir, chunk.resultRef), 'utf8'));
  if (manifest.packageVersion === 3) {
    validateViewingChunk(payload, manifest, chunk);
    for (const entry of payload.segments.flatMap(section => section.entries)) {
      if (entry.type === 'motion') observations.push({ chunkId: chunk.chunkId, ...entry });
      if (entry.type === 'image') observations.push({ chunkId: chunk.chunkId, fromMs: entry.fromMs,
        storyboard: { ...entry, mediaTimeMs: entry.fromMs } });
    }
    continue;
  }
  for (const observation of payload.observations) {
    observations.push({
      chunkId: chunk.chunkId,
      ...observation
    });
  }
}

const withStoryboard = observations.filter((item) => item.storyboard);
const targets = [
  Math.round(manifest.durationMs * 0.08),
  Math.round(manifest.durationMs * 0.5),
  Math.round(manifest.durationMs * 0.9)
];
const samples = targets.map((targetMs) => withStoryboard.reduce((best, item) => {
  const distance = Math.abs(item.storyboard.mediaTimeMs - targetMs);
  if (!best || distance < best.distance) return { distance, item };
  return best;
}, null)?.item).filter(Boolean);

console.log(JSON.stringify({
  planId: manifest.planId,
  durationMs: manifest.durationMs,
  observationCount: observations.length,
  storyboardObservationCount: withStoryboard.length,
  firstObservation: observations[0] || null,
  samples
}, null, 2));
