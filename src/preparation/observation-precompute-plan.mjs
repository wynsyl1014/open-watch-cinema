import { createHash } from 'node:crypto';
import { normalizeSkipRanges } from '../media/skip-ranges.mjs';

export const OBSERVATION_PRECOMPUTE_PLAN_VERSION = 1;
export const OBSERVER_PROTOCOL_VERSION = 2;
export const MAX_ANALYSIS_DURATION_MS = 300_000;
export const DEFAULT_BOUNDARY_CONTEXT_MS = 2_000;
export const DEFAULT_SAMPLE_FPS = 2;

const CHUNK_STATUSES = new Set(['pending', 'running', 'complete', 'failed']);

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function normalizeSampleFps(value) {
  const sampleFps = Number(value);
  if (!Number.isFinite(sampleFps) || sampleFps < 0.5 || sampleFps > 4) {
    throw new TypeError('sampleFps must be between 0.5 and 4.');
  }
  return sampleFps;
}

function normalizeMediaIdentity(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('mediaIdentity must be a non-empty string.');
  }
  return value.trim();
}

function cloneManifest(manifest) {
  return {
    ...manifest,
    progress: { ...manifest.progress },
    chunks: manifest.chunks.map((chunk) => ({ ...chunk }))
  };
}

function stablePlanIdentity({
  mediaIdentity,
  durationMs,
  observerProtocolVersion,
  sampleFps,
  maxAnalysisDurationMs,
  boundaryContextMs,
  viewingIntervalMs,
  imageSettings,
  skipRanges
}) {
  return createHash('sha256')
    .update(JSON.stringify({
      planVersion: OBSERVATION_PRECOMPUTE_PLAN_VERSION,
      mediaIdentity,
      durationMs,
      observerProtocolVersion,
      sampleFps,
      maxAnalysisDurationMs,
      boundaryContextMs,
      ...(viewingIntervalMs === null ? {} : { viewingIntervalMs }),
      ...(imageSettings === null ? {} : { imageSettings }),
      ...(skipRanges.length ? { skipRanges } : {})
    }))
    .digest('hex');
}

export function planObservationChunks(durationMs, {
  maxAnalysisDurationMs = MAX_ANALYSIS_DURATION_MS,
  boundaryContextMs = DEFAULT_BOUNDARY_CONTEXT_MS,
  viewingIntervalMs = null
} = {}) {
  durationMs = requirePositiveInteger(durationMs, 'durationMs');
  maxAnalysisDurationMs = requirePositiveInteger(
    maxAnalysisDurationMs,
    'maxAnalysisDurationMs'
  );
  boundaryContextMs = requireNonNegativeInteger(boundaryContextMs, 'boundaryContextMs');

  if (boundaryContextMs >= maxAnalysisDurationMs) {
    throw new RangeError('boundaryContextMs must be smaller than maxAnalysisDurationMs.');
  }

  const availableDurationMs = maxAnalysisDurationMs - boundaryContextMs;
  if (viewingIntervalMs !== null) {
    requirePositiveInteger(viewingIntervalMs, 'viewingIntervalMs');
    if (viewingIntervalMs > availableDurationMs) {
      throw new RangeError('viewingIntervalMs must fit within one bounded analysis batch.');
    }
  }
  // Fixed viewing sections and bounded decoding batches have different jobs.
  // Align ownership so one section is never split across two batch files.
  const logicalChunkDurationMs = viewingIntervalMs === null
    ? availableDurationMs
    : Math.floor(availableDurationMs / viewingIntervalMs) * viewingIntervalMs;
  const chunks = [];

  for (
    let logicalStartMs = 0, index = 0;
    logicalStartMs < durationMs;
    logicalStartMs += logicalChunkDurationMs, index += 1
  ) {
    const logicalEndMs = Math.min(durationMs, logicalStartMs + logicalChunkDurationMs);
    const analysisStartMs = index === 0
      ? logicalStartMs
      : logicalStartMs - boundaryContextMs;
    const analysisEndMs = logicalEndMs;

    chunks.push({
      chunkId: `chunk-${String(index).padStart(4, '0')}`,
      index,
      status: 'pending',
      logicalStartMs,
      logicalEndMs,
      analysisStartMs,
      analysisDurationMs: analysisEndMs - analysisStartMs,
      acceptFromMs: logicalStartMs,
      acceptToMs: logicalEndMs,
      attempts: 0,
      observationCount: null,
      storyboardCount: null,
      resultRef: null,
      error: null
    });
  }

  return chunks;
}

export function getObservationPrecomputeProgress(manifest) {
  const totalChunks = manifest.chunks.length;
  const completeChunks = manifest.chunks.filter((chunk) => chunk.status === 'complete').length;
  const failedChunks = manifest.chunks.filter((chunk) => chunk.status === 'failed').length;
  const runningChunks = manifest.chunks.filter((chunk) => chunk.status === 'running').length;
  const pendingChunks = totalChunks - completeChunks - failedChunks - runningChunks;
  const completedThroughMs = manifest.chunks.reduce((throughMs, chunk) => {
    if (chunk.logicalStartMs !== throughMs || chunk.status !== 'complete') return throughMs;
    return chunk.logicalEndMs;
  }, 0);

  return {
    totalChunks,
    pendingChunks,
    runningChunks,
    completeChunks,
    failedChunks,
    completedThroughMs,
    percent: totalChunks === 0 ? 0 : Number(((completeChunks / totalChunks) * 100).toFixed(2))
  };
}

function deriveManifestStatus(progress) {
  if (progress.completeChunks === progress.totalChunks && progress.totalChunks > 0) return 'ready';
  if (progress.runningChunks > 0 || progress.completeChunks > 0) return 'running';
  if (progress.failedChunks > 0) return 'failed';
  return 'pending';
}

function refreshManifestProgress(manifest) {
  const progress = getObservationPrecomputeProgress(manifest);
  return {
    ...manifest,
    status: deriveManifestStatus(progress),
    progress
  };
}

export function createObservationPrecomputeManifest({
  mediaIdentity,
  durationMs,
  observerProtocolVersion = OBSERVER_PROTOCOL_VERSION,
  sampleFps = DEFAULT_SAMPLE_FPS,
  maxAnalysisDurationMs = MAX_ANALYSIS_DURATION_MS,
  boundaryContextMs = DEFAULT_BOUNDARY_CONTEXT_MS,
  viewingIntervalMs = null,
  imageSettings = null,
  skipRanges = []
}) {
  mediaIdentity = normalizeMediaIdentity(mediaIdentity);
  durationMs = requirePositiveInteger(durationMs, 'durationMs');
  skipRanges = normalizeSkipRanges(skipRanges, durationMs);
  observerProtocolVersion = requirePositiveInteger(
    observerProtocolVersion,
    'observerProtocolVersion'
  );
  sampleFps = normalizeSampleFps(sampleFps);
  if (imageSettings !== null) {
    if (typeof imageSettings !== 'object' || Array.isArray(imageSettings)) {
      throw new TypeError('imageSettings must be an object.');
    }
    imageSettings = Object.fromEntries(Object.keys(imageSettings).sort().map((key) => [key, imageSettings[key]]));
  }

  const chunks = planObservationChunks(durationMs, {
    maxAnalysisDurationMs,
    boundaryContextMs,
    viewingIntervalMs
  });
  const planHash = stablePlanIdentity({
    mediaIdentity,
    durationMs,
    observerProtocolVersion,
    sampleFps,
    maxAnalysisDurationMs,
    boundaryContextMs,
    viewingIntervalMs,
    imageSettings,
    skipRanges
  });

  return refreshManifestProgress({
    planVersion: OBSERVATION_PRECOMPUTE_PLAN_VERSION,
    planId: planHash.slice(0, 24),
    planHash,
    mediaIdentity,
    durationMs,
    observerProtocolVersion,
    sampleFps,
    maxAnalysisDurationMs,
    boundaryContextMs,
    logicalChunkDurationMs: viewingIntervalMs === null
      ? maxAnalysisDurationMs - boundaryContextMs
      : Math.floor((maxAnalysisDurationMs - boundaryContextMs) / viewingIntervalMs) * viewingIntervalMs,
    ...(viewingIntervalMs === null ? {} : { viewingIntervalMs }),
    ...(imageSettings === null ? {} : { imageSettings }),
    ...(skipRanges.length ? { skipRanges } : {}),
    status: 'pending',
    progress: null,
    chunks
  });
}

export function getNextObservationChunk(manifest) {
  validateObservationPrecomputeManifest(manifest);
  return manifest.chunks.find((chunk) => chunk.status !== 'complete') ?? null;
}

export function markObservationChunkRunning(manifest, chunkIndex) {
  const next = cloneManifest(manifest);
  const chunk = next.chunks[chunkIndex];
  if (!chunk) throw new RangeError(`Unknown chunk index ${chunkIndex}.`);
  if (chunk.status === 'complete') {
    throw new Error(`Chunk ${chunk.chunkId} is already complete.`);
  }
  chunk.status = 'running';
  chunk.attempts += 1;
  chunk.error = null;
  return refreshManifestProgress(next);
}

export function markObservationChunkComplete(manifest, chunkIndex, {
  observationCount = 0,
  storyboardCount = 0,
  resultRef = null
} = {}) {
  observationCount = requireNonNegativeInteger(observationCount, 'observationCount');
  storyboardCount = requireNonNegativeInteger(storyboardCount, 'storyboardCount');
  if (resultRef !== null && (typeof resultRef !== 'string' || !resultRef.trim())) {
    throw new TypeError('resultRef must be null or a non-empty string.');
  }

  const next = cloneManifest(manifest);
  const chunk = next.chunks[chunkIndex];
  if (!chunk) throw new RangeError(`Unknown chunk index ${chunkIndex}.`);
  chunk.status = 'complete';
  chunk.observationCount = observationCount;
  chunk.storyboardCount = storyboardCount;
  chunk.resultRef = resultRef?.trim() ?? null;
  chunk.error = null;
  return refreshManifestProgress(next);
}

export function markObservationChunkFailed(manifest, chunkIndex, error) {
  if (typeof error !== 'string' || !error.trim()) {
    throw new TypeError('error must be a non-empty string.');
  }
  const next = cloneManifest(manifest);
  const chunk = next.chunks[chunkIndex];
  if (!chunk) throw new RangeError(`Unknown chunk index ${chunkIndex}.`);
  if (chunk.status === 'complete') {
    throw new Error(`Chunk ${chunk.chunkId} is already complete.`);
  }
  chunk.status = 'failed';
  chunk.error = error.trim();
  return refreshManifestProgress(next);
}

export function validateObservationPrecomputeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new TypeError('manifest must be an object.');
  }
  requirePositiveInteger(manifest.durationMs, 'manifest.durationMs');
  requirePositiveInteger(
    manifest.maxAnalysisDurationMs,
    'manifest.maxAnalysisDurationMs'
  );
  requireNonNegativeInteger(
    manifest.boundaryContextMs,
    'manifest.boundaryContextMs'
  );
  if (!Array.isArray(manifest.chunks) || manifest.chunks.length === 0) {
    throw new TypeError('manifest.chunks must be a non-empty array.');
  }
  if (manifest.viewingIntervalMs !== undefined) {
    requirePositiveInteger(manifest.viewingIntervalMs, 'manifest.viewingIntervalMs');
  }

  let expectedLogicalStartMs = 0;
  for (const [index, chunk] of manifest.chunks.entries()) {
    if (chunk.index !== index || chunk.chunkId !== `chunk-${String(index).padStart(4, '0')}`) {
      throw new Error(`Chunk identity mismatch at index ${index}.`);
    }
    if (!CHUNK_STATUSES.has(chunk.status)) {
      throw new Error(`Invalid status for ${chunk.chunkId}.`);
    }
    if (chunk.logicalStartMs !== expectedLogicalStartMs) {
      throw new Error(`Logical coverage gap or overlap before ${chunk.chunkId}.`);
    }
    if (manifest.viewingIntervalMs !== undefined && (
      chunk.logicalStartMs % manifest.viewingIntervalMs !== 0
      || (chunk.logicalEndMs !== manifest.durationMs && chunk.logicalEndMs % manifest.viewingIntervalMs !== 0)
    )) {
      throw new Error(`Viewing section boundary mismatch for ${chunk.chunkId}.`);
    }
    if (chunk.logicalEndMs <= chunk.logicalStartMs) {
      throw new Error(`Invalid logical range for ${chunk.chunkId}.`);
    }
    if (chunk.acceptFromMs !== chunk.logicalStartMs || chunk.acceptToMs !== chunk.logicalEndMs) {
      throw new Error(`Ownership range mismatch for ${chunk.chunkId}.`);
    }
    if (chunk.analysisStartMs < 0 || chunk.analysisStartMs > chunk.logicalStartMs) {
      throw new Error(`Invalid analysis start for ${chunk.chunkId}.`);
    }
    if (chunk.analysisDurationMs <= 0 || chunk.analysisDurationMs > manifest.maxAnalysisDurationMs) {
      throw new Error(`Analysis duration exceeds worker bounds for ${chunk.chunkId}.`);
    }
    if (chunk.analysisStartMs + chunk.analysisDurationMs !== chunk.logicalEndMs) {
      throw new Error(`Analysis range mismatch for ${chunk.chunkId}.`);
    }
    expectedLogicalStartMs = chunk.logicalEndMs;
  }

  if (expectedLogicalStartMs !== manifest.durationMs) {
    throw new Error('Chunk plan does not cover the complete media duration.');
  }

  const expectedProgress = getObservationPrecomputeProgress(manifest);
  if (JSON.stringify(manifest.progress) !== JSON.stringify(expectedProgress)) {
    throw new Error('Manifest progress does not match chunk states.');
  }
  if (manifest.status !== deriveManifestStatus(expectedProgress)) {
    throw new Error('Manifest status does not match chunk states.');
  }

  return true;
}
