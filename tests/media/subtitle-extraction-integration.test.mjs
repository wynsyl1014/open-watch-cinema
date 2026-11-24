import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createObservationPrecomputeManifest, markObservationChunkComplete } from '../../src/preparation/observation-precompute-plan.mjs';
import { prepareDialogueSource } from '../../src/preparation/dialogue-track.mjs';
import { readObservationTrackWindow } from '../../src/delivery/observation-track-reader.mjs';
import { createFilmLibrary } from '../../src/media/film-library.mjs';
import { prepareMediaForChrome } from '../../src/media/media-compatibility.mjs';
import { deleteFilmSubtitles, extractSubtitleStreams, inspectFilmSubtitles, recoverSubtitleExtraction, readSubtitleBundle } from '../../src/media/media-subtitles.mjs';

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test('selected tracks publish together, survive repair, and can be deleted independently', async (context) => {
  const versionCheck = spawnSync('ffmpeg', ['-version'], { windowsHide: true });
  if (versionCheck.status !== 0) {
    context.skip('FFmpeg is unavailable in this environment.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'open-watch-cinema-subtitles-'));
  const inputPath = join(root, 'sample.mkv');
  const outputPath = join(root, 'sample.mp4');
  const subtitlePath = join(root, 'sample.srt');

  try {
    await writeFile(subtitlePath, [
      '1',
      '00:00:00,100 --> 00:00:00,900',
      'Hello from the subtitle track.',
      ''
    ].join('\n'), 'utf8');

    const generated = spawnSync('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', 'color=c=black:s=320x180:r=24:d=1',
      '-f', 'lavfi',
      '-i', 'sine=frequency=440:duration=1',
      '-f', 'srt',
      '-i', subtitlePath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-map', '2:s:0',
      '-map', '2:s:0',
      '-map', '2:s:0',
      '-shortest',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-c:s', 'subrip',
      '-metadata:s:s:0', 'language=eng',
      '-metadata:s:s:0', 'title=English',
      '-disposition:s:0', 'default',
      '-metadata:s:s:1', 'language=chi',
      '-metadata:s:s:1', 'title=Hong Kong',
      '-metadata:s:s:2', 'language=chi',
      inputPath
    ], { windowsHide: true, encoding: 'utf8' });

    assert.equal(generated.status, 0, generated.stderr || 'Could not generate subtitle fixture.');

    const managedRoot = join(root,'managed');
    await mkdir(managedRoot);
    await copyFile(inputPath,join(managedRoot,'同看.mkv'));
    await copyFile(subtitlePath,join(managedRoot,'同看.zh.srt'));
    const library = createFilmLibrary(managedRoot,{settleMs:0});
    const { items:[film] } = await library.snapshot();
    assert.equal(film.subtitleTracks.length,1);
    const manualId = film.subtitleTracks[0].id;
    const original = await readFile(join(film.subtitlesPath,'同看.zh.srt'));
    const languages = ['en','zh-Hant'];
    const progress = [];
    const extracted = await extractSubtitleStreams(film.absolutePath,{languages,onProgress:({percent})=>progress.push(percent)});
    assert.deepEqual(extracted.tracks.map(row=>row.id),['stream-2','stream-3']);
    assert.equal(progress.at(-1),100);
    const beforeRepair = await inspectFilmSubtitles(film.absolutePath);
    assert.deepEqual(beforeRepair.embedded.map(row=>[row.languageGroup,row.saved]),[['en',true],['zh-Hant',true],['zh',false]]);
    const extra = await extractSubtitleStreams(film.absolutePath,{trackIds:['stream-4']});
    assert.equal(extra.tracks.length,3);
    const sidecar = (await readSubtitleBundle(film.absolutePath)).find(row=>row.id===manualId);
    const linkedFile = extracted.tracks[0].fileName;
    const batch = join(extracted.bundleDirectory,'.owc-subtitle-batch');
    await mkdir(batch);
    async function journal(path,fileName) {
      const identity = await lstat(path,{bigint:true});
      await writeFile(join(batch,'install.json'), JSON.stringify([{fileName,dev:String(identity.dev),ino:String(identity.ino)}]));
    }
    await journal(extracted.tracks[0].absolutePath,linkedFile);
    assert.equal(await recoverSubtitleExtraction(film.absolutePath),false);
    assert.ok(await exists(extracted.tracks[0].absolutePath));
    const unfinished = 'track-00000000-0000-4000-8000-000000000000.vtt';
    await mkdir(batch);
    await writeFile(join(extracted.bundleDirectory,unfinished),'partial');
    await journal(join(extracted.bundleDirectory,unfinished),unfinished);
    assert.equal(await recoverSubtitleExtraction(film.absolutePath),true);
    assert.equal(await exists(join(extracted.bundleDirectory,unfinished)),false);
    await deleteFilmSubtitles(film.absolutePath,['stream-3','stream-4']);
    await prepareMediaForChrome(film.absolutePath);
    const { items:[updated] } = await library.snapshot();
    assert.equal(updated.id,film.id);
    assert.equal(updated.extension,'.mp4');
    assert.equal(updated.subtitleTracks.length,2);
    assert.ok(updated.subtitleTracks.some(track=>track.id===manualId));
    assert.ok(updated.subtitleTracks.some(track=>track.id.startsWith('stream-')));
    assert.deepEqual(await readFile(join(updated.subtitlesPath,'同看.zh.srt')),original);

    const dialogue = await prepareDialogueSource(updated.absolutePath,{preferredTrackId:'stream-2'});
    const chunkDir = join(updated.packagePath,'chunks','chunk-0000');
    await mkdir(chunkDir,{recursive:true});
    let manifest = createObservationPrecomputeManifest({mediaIdentity:'sha256:test',durationMs:1000});
    manifest = markObservationChunkComplete(manifest,0,{observationCount:0,storyboardCount:0,resultRef:'chunks/chunk-0000/visual.json'});
    manifest.chunks[0].dialogueRef = 'chunks/chunk-0000/dialogue.json';
    manifest.dialogueTrack = {status:'ready',cueCount:dialogue.cues.length};
    await writeFile(join(chunkDir,'visual.json'),JSON.stringify({observations:[]}));
    await writeFile(join(chunkDir,'dialogue.json'),JSON.stringify({status:'ready',cues:dialogue.cues}));
    await writeFile(join(updated.packagePath,'manifest.json'),JSON.stringify(manifest));
    const afterRepair = await inspectFilmSubtitles(updated.absolutePath);
    assert.deepEqual(afterRepair.embedded.map(row => [row.id,row.saved,row.extractable]),[['stream-2',true,false]]);
    await writeFile(updated.absolutePath,'unreadable synthetic file');
    const unavailable = await inspectFilmSubtitles(updated.absolutePath);
    assert.match(unavailable.probeError,/无法读取片源/);
    assert.equal(unavailable.embedded[0].saved,true);
    assert.equal(unavailable.external[0].id,manualId);
    await deleteFilmSubtitles(updated.absolutePath,[manualId,'stream-2']);
    assert.equal(await exists(sidecar.absolutePath),false);
    assert.equal(await exists(join(updated.subtitlesPath,'同看.zh.srt')),false);
    assert.deepEqual(await readSubtitleBundle(updated.absolutePath),[]);
    const packaged = await readObservationTrackWindow(updated.packagePath,{fromMs:0,toMs:1000,playheadMs:1000});
    assert.deepEqual(packaged.dialogue.map(row=>row.text),['Hello from the subtitle track.']);
    const result = await prepareMediaForChrome(inputPath);
    assert.equal(result.changed, true);
    assert.equal(result.subtitleStatus,'no_saved_subtitles');
    assert.equal(await exists(inputPath), false);
    assert.equal(await exists(outputPath), true);
    assert.deepEqual(await readSubtitleBundle(outputPath),[]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
