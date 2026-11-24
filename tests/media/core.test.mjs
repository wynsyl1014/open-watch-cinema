import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseSingleRange } from '../../src/media/http-range.mjs';
import { scanMediaDirectory } from '../../src/media/media-library.mjs';

test('single HTTP ranges support normal, open-ended, and suffix requests', () => {
  assert.deepEqual(parseSingleRange('bytes=0-99', 1000), { start: 0, end: 99, length: 100 });
  assert.deepEqual(parseSingleRange('bytes=900-', 1000), { start: 900, end: 999, length: 100 });
  assert.deepEqual(parseSingleRange('bytes=-50', 1000), { start: 950, end: 999, length: 50 });
  assert.equal(parseSingleRange('bytes=1000-1100', 1000), null);
  assert.equal(parseSingleRange('bytes=0-1,4-5', 1000), null);
});

test('media scan finds supported videos recursively and ignores other files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-watch-cinema-'));
  try {
    await mkdir(join(root, 'Season 1'));
    await writeFile(join(root, 'Film One.mp4'), 'first');
    await writeFile(join(root, 'Season 1', 'Episode-02.webm'), 'second');
    await writeFile(join(root, 'README.md'), 'not media');

    const firstScan = await scanMediaDirectory(root);
    const secondScan = await scanMediaDirectory(root);

    assert.equal(firstScan.length, 2);
    assert.deepEqual(firstScan.map((item) => item.relativePath), ['Season 1/Episode-02.webm', 'Film One.mp4']);
    assert.deepEqual(firstScan.map((item) => item.id), secondScan.map((item) => item.id));
    assert.ok(firstScan.every((item) => !item.absolutePath.includes('README.md')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
