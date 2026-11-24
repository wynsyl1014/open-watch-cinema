import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recoverSubtitleExtraction, subtitleBundleDirectory } from '../../src/media/media-subtitles.mjs';

test('a second process cannot recover a live subtitle batch and can recover it after a crash', {timeout:10000}, async t => {
  const root = await mkdtemp(join(tmpdir(),'owc-subtitle-owner-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const video = join(root,'film.mkv');
  const bundle = subtitleBundleDirectory(video);
  await mkdir(bundle);
  const lockModule = new URL('../../src/media/subtitle-write-lock.mjs',import.meta.url).href;
  const script = `
    import {withSubtitleWriteLock} from ${JSON.stringify(lockModule)};
    import {mkdir} from 'node:fs/promises';
    import {join} from 'node:path';
    await withSubtitleWriteLock(process.argv[1],async () => {
      await mkdir(join(process.argv[1],'.owc-subtitle-batch'));
      process.send('ready');
      await new Promise(() => setInterval(() => {},60000));
    });
  `;
  const child = spawn(process.execPath,['--input-type=module','-e',script,bundle],{stdio:['ignore','ignore','pipe','ipc']});
  const stopped = once(child,'exit');
  t.after(async () => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); await stopped; });
  const [ready] = await once(child,'message');
  assert.equal(ready,'ready');
  await assert.rejects(recoverSubtitleExtraction(video), /另一个影院进程/);
  assert.deepEqual(await readdir(bundle),['.owc-subtitle-batch']);
  child.kill('SIGKILL');
  await stopped;
  assert.equal(await recoverSubtitleExtraction(video),true);
  assert.deepEqual(await readdir(bundle),[]);
  assert.deepEqual(await readdir(root),['film.owc-subtitles']);
});
