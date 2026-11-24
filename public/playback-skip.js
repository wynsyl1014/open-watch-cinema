export function playbackSkipRanges(item) {
  const prepared = item?.aiPackage;
  if (prepared?.skipRanges) return prepared.skipRanges;
  return prepared?.packageVersion ? [] : item?.skipRanges ?? [];
}

const contains = (range, timeMs) => range.fromMs <= timeMs && timeMs < range.toMs;

export function createPlaybackSkip(getRanges) {
  let watching = [];
  let seeking = false;
  let programmaticTarget = null;
  return {
    reset() {
      watching = [];
      seeking = false;
      programmaticTarget = null;
    },
    beginSeek() {
      seeking = true;
    },
    programmaticSeek(toMs) {
      seeking = true;
      programmaticTarget = toMs;
    },
    finishSeek(timeMs) {
      // The media duration and package duration can differ by a fraction of a millisecond.
      const programmatic = programmaticTarget !== null && Math.abs(timeMs - programmaticTarget) < 1;
      watching = programmatic ? [] : getRanges().filter(range => contains(range, timeMs));
      seeking = false;
      programmaticTarget = null;
    },
    nextTarget(timeMs) {
      if (seeking) return null;
      const ranges = getRanges();
      watching = watching.filter(watched => contains(watched, timeMs)
        && ranges.some(range => range.fromMs === watched.fromMs && range.toMs === watched.toMs));
      if (watching.length) return null;
      return ranges.find(range => contains(range, timeMs))?.toMs ?? null;
    }
  };
}
