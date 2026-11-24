export function parseSingleRange(header, size) {
  if (!Number.isSafeInteger(size) || size < 1) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match) return null;

  let start = match[1] === '' ? undefined : Number(match[1]);
  let end = match[2] === '' ? undefined : Number(match[2]);

  if (start !== undefined && !Number.isSafeInteger(start)) return null;
  if (end !== undefined && !Number.isSafeInteger(end)) return null;

  if (start === undefined) {
    const suffixLength = end;
    if (!suffixLength || suffixLength < 1) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else if (end === undefined) {
    end = size - 1;
  }

  if (start < 0 || end < 0 || start > end || start >= size) return null;

  const boundedEnd = Math.min(end, size - 1);
  return {
    start,
    end: boundedEnd,
    length: boundedEnd - start + 1
  };
}
