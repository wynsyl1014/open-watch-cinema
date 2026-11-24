import { readFile } from 'node:fs/promises';
import { validateViewingChunk } from '../../src/delivery/viewing-package.mjs';
import { join, resolve } from 'node:path';

async function main() {
  const packageDir = resolve(process.argv[2] || '');
  if (!process.argv[2]) throw new Error('Observation package directory is required.');

  const manifest = JSON.parse(await readFile(join(packageDir, 'manifest.json'), 'utf8'));
  let observationCount = 0;
  let storyboardCount = 0;
  let ownershipValid = true;
  let resultCount = 0;

  for (const chunk of manifest.chunks.filter((item) => item.status === 'complete')) {
    if (!chunk.resultRef) throw new Error(`${chunk.chunkId} is complete without a resultRef.`);
    const result = JSON.parse(await readFile(join(packageDir, chunk.resultRef), 'utf8'));
    resultCount += 1;
    if (manifest.packageVersion === 3) {
      validateViewingChunk(result, manifest, chunk);
      observationCount += result.tracks.visual.observationCount;
      storyboardCount += result.tracks.visual.storyboardCount;
      continue;
    }
    observationCount += result.observations.length;
    storyboardCount += result.frames.length;
    ownershipValid &&= result.observations.every((item) => (
      item.fromMs >= chunk.acceptFromMs && item.fromMs < chunk.acceptToMs
    ));
  }

  if (!ownershipValid) throw new Error('At least one observation falls outside its ownership range.');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    planId: manifest.planId,
    status: manifest.status,
    completedChunks: manifest.progress.completeChunks,
    resultCount,
    observationCount,
    storyboardCount,
    completedThroughMs: manifest.progress.completedThroughMs,
    ownershipValid
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exitCode = 1;
});
