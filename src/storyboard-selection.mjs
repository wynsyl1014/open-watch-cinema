// Composition groups stay local to a tick. Hashes and RGB values remain server-side.
export function similarComposition(left, right) {
  if (!/^[a-f0-9]{16}$/i.test(left.hash || '') || !/^[a-f0-9]{16}$/i.test(right.hash || '')) return false;
  let bits = BigInt(`0x${left.hash}`) ^ BigInt(`0x${right.hash}`);
  let distance = 0;
  while (bits) { distance += 1; bits &= bits - 1n; }
  if (distance > 4) return false;
  if (left.rgb?.length === 3 && right.rgb?.length === 3) {
    return left.rgb.every((value, index) => Math.abs(value - right.rgb[index]) < 0.08);
  }
  // A flat image's hash cannot distinguish colours without the RGB measurements.
  const ones = BigInt(`0x${left.hash}`).toString(2).replaceAll('0', '').length;
  return ones > 1 && ones < 63;
}

export function selectVisualArc(candidates, maximum = 2) {
  if (!candidates.length || maximum < 1) return [];
  const ordered = [...candidates].sort((a, b) => a.mediaTimeMs - b.mediaTimeMs);
  const latest = ordered.at(-1);
  const selected = [latest];
  const span = Math.max(1, latest.mediaTimeMs - ordered[0].mediaTimeMs);
  const remaining = ordered.slice(0, -1);
  while (selected.length < maximum && remaining.length) {
    // Prefer distinct compositions; among them, spread coverage across the window
    // and favour cuts over nearby motion peaks. Always retain the final view.
    const distinct = remaining.filter((frame) => selected.every((other) => (
      frame.storyboardRef !== other.storyboardRef
      && (frame.visualGroup === undefined || other.visualGroup === undefined || frame.visualGroup !== other.visualGroup)
    )));
    if (!distinct.length) break;
    const score = (frame) => Math.min(...selected.map((other) => Math.abs(frame.mediaTimeMs - other.mediaTimeMs))) / span * 2
      + (frame.kind === 'scene_change' ? 1 : 0);
    distinct.sort((a, b) => score(b) - score(a) || a.mediaTimeMs - b.mediaTimeMs);
    selected.push(distinct[0]);
    remaining.splice(remaining.indexOf(distinct[0]), 1);
  }
  return selected.sort((a, b) => a.mediaTimeMs - b.mediaTimeMs);
}
