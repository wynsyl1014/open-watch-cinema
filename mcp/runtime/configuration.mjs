import { requireInteger } from './validation.mjs';

export const MAX_REMEMBERED_FRAMES = 64;

export const DEFAULT_TICK_LIMITS = Object.freeze({
  initialWindowMs: 15_000,
  maxAdvanceMs: 20_000,
  maxMessages: 20,
  maxLiveObservations: 40,
  maxStoryboards: 5,
  maxMotionEvents: 8
});

function flagEnabled(value) {
  return value === '1' || value === 'true';
}

export function readRuntimeConfig(env = process.env, argv = process.argv.slice(2)) {
  const explicitUrl = env.OPEN_WATCH_CINEMA_URL;
  const requireUrl = env.OPEN_WATCH_CINEMA_REQUIRE_URL === '1';
  if (requireUrl && !explicitUrl?.trim()) {
    throw new TypeError('OPEN_WATCH_CINEMA_URL is required when OPEN_WATCH_CINEMA_REQUIRE_URL=1.');
  }
  const urls = requireUrl ? [explicitUrl.trim()] : [
    explicitUrl,
    'http://127.0.0.1:4182',
    'http://127.0.0.1:4183',
    'http://127.0.0.1:4184',
    'http://127.0.0.1:4185',
    'http://127.0.0.1:4186',
    'http://127.0.0.1:4187'
  ].filter((value, index, values) => value && values.indexOf(value) === index);
  // No new default is chosen here. The viewing settings work can supply this later.
  const CATCHUP_TIME_BUDGET_MS = env.OPEN_WATCH_CINEMA_CATCHUP_BUDGET_MS
    ? requireInteger(Number(env.OPEN_WATCH_CINEMA_CATCHUP_BUDGET_MS), 'OPEN_WATCH_CINEMA_CATCHUP_BUDGET_MS', { min: 1, max: 2_147_483_647 })
    : Infinity;
  const IMAGE_BUDGET_BYTES = env.OPEN_WATCH_CINEMA_IMAGE_BUDGET_BYTES
    ? requireInteger(Number(env.OPEN_WATCH_CINEMA_IMAGE_BUDGET_BYTES), 'OPEN_WATCH_CINEMA_IMAGE_BUDGET_BYTES', { min: 1, max: 2_147_483_647 })
    : Infinity;
  const enableHistory = argv.includes('--with-history') || flagEnabled(env.OPEN_WATCH_CINEMA_ENABLE_HISTORY);
  const enableControl = argv.includes('--with-control') || flagEnabled(env.OPEN_WATCH_CINEMA_ENABLE_CONTROL);
  return { urls, CATCHUP_TIME_BUDGET_MS, IMAGE_BUDGET_BYTES, enableHistory, enableControl };
}
