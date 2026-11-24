// Prepared image choices recorded in the film package.
export const DEFAULT_STORYBOARD_HEIGHT = 480;
export const STORYBOARD_MAX_BYTES = 1_572_864;
export const CURRENT_STORYBOARD_VERSION = 4;

const STORYBOARD_MODES = new Set(['economy', 'balanced', 'full']);
const STORYBOARD_HEIGHTS = [480, 720, 1080];

function storyboardVersionForMode(mode) {
  return mode === 'economy' ? 3 : CURRENT_STORYBOARD_VERSION;
}

export function validateStoryboardHeight(value) {
  if (!STORYBOARD_HEIGHTS.includes(value)) {
    throw new RangeError('Storyboard height must be 480, 720 or 1080.');
  }
  return value;
}

export function imageSettingsForMode(mode = 'balanced', fullHeight = DEFAULT_STORYBOARD_HEIGHT) {
  if (!STORYBOARD_MODES.has(mode)) throw new RangeError('Invalid storyboard mode.');
  return {
    mode,
    assetVersion: storyboardVersionForMode(mode),
    storyboardHeight: mode === 'full' ? validateStoryboardHeight(fullHeight) : mode === 'balanced' ? 268 : 124,
    storyboardJpegQuality: 86,
    minStoryboardJpegQuality: 60,
    storyboardMaxBytes: STORYBOARD_MAX_BYTES
  };
}

export function needsStoryboardUpgrade(packageVersion) {
  return packageVersion === 1 || packageVersion === 2;
}

export function hasStoryboardCornerMarks(imageSettings) {
  return (imageSettings?.mode === 'balanced' || imageSettings?.mode === 'full')
    && imageSettings.assetVersion === CURRENT_STORYBOARD_VERSION;
}

export function normalizeImageSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Image settings must be an object.');
  }
  const allowed = new Set(['mode', 'assetVersion', 'storyboardHeight',
    'storyboardJpegQuality', 'minStoryboardJpegQuality', 'storyboardMaxBytes']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new TypeError('Unknown image setting.');
  if (!STORYBOARD_MODES.has(value.mode)) throw new RangeError('Invalid storyboard mode.');
  if (value.assetVersion !== storyboardVersionForMode(value.mode)) {
    throw new RangeError('Unsupported image asset version.');
  }
  const expectedHeight = imageSettingsForMode(value.mode, value.storyboardHeight).storyboardHeight;
  if (expectedHeight !== value.storyboardHeight) {
    throw new RangeError('Invalid storyboard height for mode.');
  }
  const result = {
    mode: value.mode,
    assetVersion: value.assetVersion,
    storyboardHeight: value.storyboardHeight,
    storyboardJpegQuality: value.storyboardJpegQuality
  };
  if (!Number.isSafeInteger(result.storyboardJpegQuality) || result.storyboardJpegQuality < 1
      || result.storyboardJpegQuality > 100) {
    throw new RangeError('JPEG quality must be between 1 and 100.');
  }
  if (value.storyboardMaxBytes !== undefined) {
    if (!Number.isSafeInteger(value.storyboardMaxBytes) || value.storyboardMaxBytes < 1) {
      throw new TypeError('Image budget must be a positive integer.');
    }
    result.storyboardMaxBytes = value.storyboardMaxBytes;
  }
  if (value.minStoryboardJpegQuality !== undefined || value.storyboardMaxBytes !== undefined) {
    if (!Number.isSafeInteger(value.minStoryboardJpegQuality) || value.minStoryboardJpegQuality < 1
        || value.minStoryboardJpegQuality > result.storyboardJpegQuality) {
      throw new RangeError('Invalid minimum JPEG quality.');
    }
    result.minStoryboardJpegQuality = value.minStoryboardJpegQuality;
  }
  return result;
}
