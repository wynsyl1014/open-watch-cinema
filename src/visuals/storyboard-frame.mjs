import { access, constants, readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { readObservationTrackWindow } from '../delivery/observation-track-reader.mjs';

const MIME_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp']
]);
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const runFile = promisify(execFile);

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

export function normalizeStoryboardRef(value) {
  if (typeof value !== 'string') throw new TypeError('storyboardRef must be a string.');
  const ref = value.trim();
  if (!ref || ref.includes('\0') || ref.includes('\\')) {
    throw new Error('storyboardRef must be one normalized package-relative reference.');
  }
  if (!/^chunks\/chunk-\d{4}\/storyboards\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpe?g|png|webp)$/i.test(ref)) {
    throw new Error('storyboardRef is outside the allowlisted storyboard namespace.');
  }
  if (ref.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('storyboardRef contains a traversal segment.');
  }
  return ref;
}

async function packageImagePath(root, ref) {
  const path = await realpath(resolve(root, ref));
  if (!path.startsWith(root + sep)) throw new Error('The storyboard resolved outside its AI package.');
  const info = await stat(path);
  if (!info.isFile()) throw new Error('The storyboard reference is not a file.');
  if (!info.size) throw new Error('The prepared image is empty.');
  if (info.size > MAX_FRAME_BYTES) throw new Error('The storyboard exceeds the image bridge size limit.');
  return path;
}

async function hasHdFrame(version, inputPath) {
  try {
    if (version >= 3 || !inputPath) return false;
    // Earlier v1/v2 packages inspect directly from the local film when requested.
    const info = await stat(inputPath);
    if (!info.isFile() || !info.size) return false;
    await access(inputPath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function savedImageMetadata(image, gateMs) {
  const metadata = {};
  for (const key of ['width', 'height', 'jpegQuality', 'requestedHeight']) {
    if (Number.isSafeInteger(image?.[key]) && image[key] > 0) metadata[key] = image[key];
  }
  if (typeof image?.budgetLimited === 'boolean') metadata.budgetLimited = image.budgetLimited;
  if (Array.isArray(image?.views) && image.views.length >= 1
      && image.views.every(view => view && [0, 1, 2].includes(view.sourceIndex)
        && (view.mediaTimeMs === undefined || (Number.isSafeInteger(view.mediaTimeMs) && view.mediaTimeMs >= 0 && view.mediaTimeMs <= gateMs))
        && ['full', 'crop'].includes(view.type) && Array.isArray(view.box) && view.box.length === 4
        && view.box.every(value => Number.isSafeInteger(value) && value >= 0))) {
    metadata.views = image.views.map(({ sourceIndex, type, box, mediaTimeMs, anchorTimeMs, sourceBox }) => ({
      sourceIndex, type, box,
      ...(mediaTimeMs !== undefined ? { mediaTimeMs } : {}),
      ...(type === 'crop' && Number.isSafeInteger(anchorTimeMs) && anchorTimeMs >= 0 && anchorTimeMs <= mediaTimeMs
        && Array.isArray(sourceBox) && sourceBox.length === 4
        && sourceBox.every(value => Number.isFinite(value) && value >= 0 && value <= 1)
        && sourceBox[0] < sourceBox[2] && sourceBox[1] < sourceBox[3]
        ? { anchorTimeMs, sourceBox } : {})
    }));
  }
  return metadata;
}

// The film path comes from the local catalog. Use the same square-pixel geometry as the preparation worker.
async function sourceFrame(inputPath, mediaTimeMs, signal, metadata) {
  if (!inputPath) throw new Error('The room source video is unavailable.');
  signal?.throwIfAborted();
  const { stdout: content } = await runFile('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-ss', (mediaTimeMs / 1000).toFixed(3), '-i', inputPath,
    '-map', '0:v:0', '-an', '-frames:v', '1', '-vf',
    "scale=w='trunc(iw*if(gt(sar,0),sar,1)+0.5)':h=ih,setsar=1,scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:flags=lanczos",
    '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '2', 'pipe:1'
  ], {
    encoding: 'buffer', maxBuffer: MAX_FRAME_BYTES, timeout: 12_000,
    windowsHide: true, signal
  });
  signal?.throwIfAborted();
  if (!content.length) throw new Error('No source frame exists at this timestamp.');
  return { content, mimeType: 'image/jpeg', metadata: { ...metadata, bytes: content.byteLength } };
}

export async function readSpoilerGatedStoryboardFrame(packageDir, {
  storyboardRef,
  mediaTimeMs,
  playheadMs,
  quality = 'storyboard',
  inputPath,
  signal
}) {
  signal?.throwIfAborted();
  if (!['storyboard', 'hd'].includes(quality)) {
    throw new TypeError('quality must be storyboard or hd.');
  }
  mediaTimeMs = requireNonNegativeInteger(mediaTimeMs, 'mediaTimeMs');
  playheadMs = requireNonNegativeInteger(playheadMs, 'playheadMs');
  if (mediaTimeMs > playheadMs) {
    throw new Error('This storyboard has not reached the current playhead yet.');
  }

  const ref = normalizeStoryboardRef(storyboardRef);
  const packageRoot = await realpath(resolve(packageDir));
  signal?.throwIfAborted();
  const fromMs = Math.max(0, mediaTimeMs - 2_000);
  const toMs = Math.min(playheadMs + 1, mediaTimeMs + 2_001);
  const window = await readObservationTrackWindow(packageRoot, {
    fromMs,
    toMs,
    playheadMs,
    lookaheadMs: 0,
    maxItems: 100,
    tracks: ['visual'],
    signal
  });
  signal?.throwIfAborted();
  const observation = window.observations.find((candidate) => (
    (candidate?.storyboard?.storyboardRef === ref || candidate?.storyboard?.parts?.some(part => part.ref === ref))
    && candidate.storyboard.mediaTimeMs === mediaTimeMs
  ));
  if (!observation) {
    throw new Error('The requested storyboard is not revealed for this room playhead.');
  }
  const storyboard = observation.storyboard;
  const panelTimesMs = storyboard.panelTimesMs;
  if (panelTimesMs && (!Array.isArray(panelTimesMs) || panelTimesMs.length < 1 || panelTimesMs.length > 3
      || panelTimesMs.some((time) => !Number.isSafeInteger(time) || time < 0
        || time > mediaTimeMs || time > playheadMs))) {
    throw new Error('The storyboard panels have not reached the current playhead or inspection time yet.');
  }

  const metadata = {
    storyboardRef: ref,
    quality,
    ...(panelTimesMs ? { panelTimesMs } : {}),
    mediaTimeMs,
    playheadMs,
    revealThroughMs: window.revealThroughMs,
    fromMs: observation.fromMs,
    toMs: observation.toMs,
    kind: observation.kind,
    frameReason: storyboard.frameReason || observation.kind
  };
  const image = storyboard.parts?.find(part => part.ref === ref)?.image ?? storyboard.image;
  if (quality === 'hd') {
    if (window.packageVersion >= 3) {
      throw new Error('本片仅保存成品分镜。请直接查看已收到的画面。');
    }
    // Legacy v1/v2 packages sample the local film directly.
    return sourceFrame(inputPath, mediaTimeMs, signal, metadata);
  }

  signal?.throwIfAborted();
  const framePath = await packageImagePath(packageRoot, ref);
  signal?.throwIfAborted();
  const mimeType = MIME_TYPES.get(extname(framePath).toLowerCase());
  if (!mimeType) throw new Error('The storyboard image type is not supported.');
  const content = await readFile(framePath, { signal });
  signal?.throwIfAborted();
  if (!content.length) throw new Error('The prepared image is empty.');
  if (content.byteLength > MAX_FRAME_BYTES) {
    throw new Error('The storyboard exceeds the image bridge size limit.');
  }
  if (quality === 'storyboard' && await hasHdFrame(window.packageVersion, inputPath)) {
    metadata.hdAvailable = true;
  }
  signal?.throwIfAborted();
  return {
    content,
    mimeType,
    metadata: { ...metadata, ...savedImageMetadata(image, mediaTimeMs), bytes: content.byteLength }
  };
}
