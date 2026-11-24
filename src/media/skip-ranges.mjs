const kinds = ['intro', 'outro', 'middle'];

function normalizeRange(value, durationMs, openEnd = false) {
  if (!Number.isSafeInteger(value?.fromMs) || value.fromMs < 0) return null;
  const toMs = openEnd && value.toMs === null ? null : value.toMs;
  if (toMs !== null && !Number.isSafeInteger(toMs)) return null;
  if (toMs === null && !openEnd) return null;
  if (value.fromMs >= Math.min(toMs ?? Infinity, durationMs)) return null;
  return { fromMs: value.fromMs, toMs: toMs === null ? null : Math.min(toMs, durationMs) };
}

export function normalizeSkipConfig(config, durationMs = Infinity) {
  const intro = normalizeRange(config?.intro, durationMs);
  const outro = normalizeRange(config?.outro, durationMs, true);
  const middle = (Array.isArray(config?.middle) ? config.middle : [])
    .map(range => normalizeRange(range, durationMs)).filter(Boolean).sort(byTime);
  return { ...(intro && { intro }), ...(outro && { outro }), middle };
}

function byTime(left, right) {
  return left.fromMs - right.fromMs || left.toMs - right.toMs;
}

export function resolveSkipRanges(config, durationMs) {
  const { intro, outro, middle } = normalizeSkipConfig(config, durationMs);
  return normalizeSkipRanges([
    ...(intro ? [{ kind: 'intro', ...intro }] : []),
    ...(outro ? [{ kind: 'outro', ...outro, toMs: outro.toMs ?? durationMs }] : []),
    ...middle.map(range => ({ kind: 'middle', ...range }))
  ], durationMs);
}

export function normalizeSkipRanges(ranges, durationMs) {
  return ranges.flatMap(range => {
    const bounds = normalizeRange(range, durationMs);
    return bounds && kinds.includes(range.kind) ? [{ kind: range.kind, ...bounds }] : [];
  }).sort((left, right) => byTime(left, right) || kinds.indexOf(left.kind) - kinds.indexOf(right.kind));
}

export function skipRangeAt(ranges, timeMs) {
  return ranges.find(range => range.fromMs <= timeMs && timeMs < range.toMs);
}

// Subtract the union of skipped intervals from a half-open time range.
export function includedRanges(fromMs, toMs, skipRanges) {
  const ranges = [];
  for (const skip of skipRanges) {
    if (skip.toMs <= fromMs) continue;
    if (skip.fromMs >= toMs) break;
    if (skip.fromMs > fromMs) ranges.push({ fromMs, toMs: skip.fromMs });
    fromMs = Math.max(fromMs, skip.toMs);
  }
  if (fromMs < toMs) ranges.push({ fromMs, toMs });
  return ranges;
}
