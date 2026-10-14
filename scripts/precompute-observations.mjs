import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runObservationPrecompute } from '../src/observation-precompute-runner.mjs';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--audio') { options.includeAudio = true; continue; }
    if (argument === '--input') options.inputPath = value;
    else if (argument === '--output-root') options.outputRoot = value;
    else if (argument === '--max-chunks') options.maxChunks = Number(value);
    else if (argument === '--sample-fps') options.sampleFps = Number(value);
    else throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }
  if (!options.inputPath) throw new Error('--input is required.');
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const startedAt = Date.now();
  const result = await runObservationPrecompute(PROJECT_ROOT, {
    ...options,
    inputPath: resolve(options.inputPath),
    outputRoot: options.outputRoot ? resolve(options.outputRoot) : undefined,
    onChunkComplete({ chunk, elapsedMs, progress }) {
      process.stderr.write(
        `${chunk.chunkId} complete in ${elapsedMs}ms (${progress.completeChunks}/${progress.totalChunks})\n`
      );
    }
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    planId: result.manifest.planId,
    status: result.manifest.status,
    ready: result.ready,
    chunksRun: result.chunksRun,
    progress: result.manifest.progress,
    elapsedMs: Date.now() - startedAt,
    manifestPath: result.manifestPath
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exitCode = 1;
});
