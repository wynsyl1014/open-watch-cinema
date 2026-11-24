import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createFilmLibrary } from '../../src/media/film-library.mjs';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'owc-cleanup-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const library=createFilmLibrary(root,{settleMs:0});
  await library.createCollection('系列');
  await library.createCollection('系列/第1季');
  const {items:[film]}=await library.importFile('第一集.mp4',Readable.from(['first']),{collection:'系列/第1季'});
  await writeFile(join(film.subtitlesPath,'en.vtt'),'WEBVTT\n');
  await mkdir(film.packagePath);
  await writeFile(join(film.packagePath,'manifest.json'),JSON.stringify({packageKind:'open-watch-cinema-ai-package',status:'ready',sourceFileName:'第一集.mp4',sourceRelativePath:film.relativePath}));
  return {root,library,film};
}

test('batch can drop videos, then clean retained subtitles and prepared packages, and explicitly remove folders',async t=>{
  const {root,library,film}=await fixture(t);
  const target={collectionPath:'系列'};
  let preview=await library.previewCleanup(target);
  assert.equal(preview.busy,false);
  assert.deepEqual([preview.filmCount,preview.collectionCount,preview.folderCount,preview.videoCount,preview.subtitleCount,preview.packageCount],[1,2,3,1,1,1]);
  const op=randomUUID();
  const result=await library.applyCleanup(target,{video:true},preview.revision,op);
  assert.deepEqual(result.issues,[]);assert.equal(result.items.length,0);assert.equal(result.retainedFilms[0].id,film.id);
  assert.deepEqual(await library.listCleanupOperations(),[{id:op,complete:true}]);
  const restarted=createFilmLibrary(root);
  const replay=await restarted.applyCleanup(target,{video:true},preview.revision,op);
  assert.equal(replay.retainedFilms[0].id,film.id);
  await assert.rejects(restarted.applyCleanup(target,{package:true},preview.revision,op),/不一致/);
  await restarted.ackCleanup(op);
  preview=await restarted.previewCleanup(target);
  assert.equal(preview.videoCount,0);assert.deepEqual(preview.mediaIds,[film.id]);
  await assert.rejects(restarted.applyCleanup(target,{folder:true},preview.revision),/保留/);
  await restarted.applyCleanup({mediaId:film.id},{subtitles:true},(await restarted.previewCleanup({mediaId:film.id})).revision);
  assert.equal(await readFile(join(film.packagePath,'manifest.json'),'utf8').then(Boolean),true);
  assert.equal((await restarted.previewCleanup(target)).subtitleCount,0);
  await restarted.applyCleanup(target,{package:true,folder:true},(await restarted.previewCleanup(target)).revision);
  assert.deepEqual(await readdir(root),[]);
});
test('unknown files and symlinks stay protected even inside a managed asset directory',async t=>{
  const {root,library,film}=await fixture(t);
  await writeFile(join(film.packagePath,'poster.jpg'),'unrelated');
  await writeFile(join(film.subtitlesPath,'notes.pdf'),'my notes');
  await symlink(join(film.episodePath,'.cinema.json'),join(film.subtitlesPath,'redirect.vtt'));
  const target={collectionPath:'系列'};let preview=await library.previewCleanup(target);
  assert.equal(preview.unknownPaths.length,3);
  assert.equal(preview.canDissolve,false);
  await assert.rejects(library.applyCleanup(target,{folder:true,package:true,video:true,subtitles:true},preview.revision),/未识别/);
  await library.applyCleanup(target,{package:true,subtitles:true},preview.revision);
  assert.equal(await readFile(join(film.packagePath,'poster.jpg'),'utf8'),'unrelated');
  assert.equal(await readFile(join(film.subtitlesPath,'notes.pdf'),'utf8'),'my notes');
  assert.ok((await lstat(join(film.subtitlesPath,'redirect.vtt'))).isSymbolicLink());
  assert.equal(await readFile(film.absolutePath,'utf8'),'first');
});
test('dissolve preflights direct name conflicts and moves only direct members, preserving their hierarchy',async t=>{
  const {root,library,film}=await fixture(t);
  await mkdir(join(root,'第1季'));
  const target={collectionPath:'系列'};
  let p=await library.previewCleanup(target);assert.deepEqual(p.moveConflicts,['第1季']);
  await assert.rejects(library.dissolveCollection('系列',p.revision),/同名/);
  await rm(join(root,'第1季'),{recursive:true});
  await writeFile(join(root,'系列','.DS_Store'),'benign');
  p=await library.previewCleanup(target);assert.equal(p.canDissolve,true);
  const op=randomUUID();
  const result=await library.dissolveCollection('系列',p.revision,op);
  assert.equal(result.items[0].id,film.id);
  assert.equal(result.items[0].collection,'第1季');
  await library.dissolveCollection('系列',p.revision,op);
  await library.ackCleanup(op);
  assert.deepEqual(await readdir(root),['第1季']);
  for (const path of ['','../','/','第1季/../第1季']) await assert.rejects(library.previewCleanup({collectionPath:path}));
});
test('active loose writers, download sidecars, and outdated previews stop cleanup',async t=>{
  const {root,library,film}=await fixture(t);
  const path=join(root,'系列','pending.mp4');
  const handle=await open(path,'w');
  const target={collectionPath:'系列'};
  try {
    await handle.writeFile('pending');
    const p=await library.previewCleanup(target);
    if (process.platform==='darwin' || process.platform==='win32') assert.equal(p.busy,true);
  } finally {await handle.close();}
  await writeFile(path+'.aria2','downloading');
  assert.equal((await library.previewCleanup(target)).busy,true);
  await rm(path);await rm(path+'.aria2');
  const p=await library.previewCleanup(target);
  await writeFile(join(film.episodePath,'poster.pdf'),'new');
  await assert.rejects(library.applyCleanup(target,{video:true},p.revision),/预览/);
  assert.equal(await readFile(film.absolutePath,'utf8'),'first');
});

test('empty collections can be removed and receipts for completed operations remain until acknowledged',async t=>{
  const {root,library}=await fixture(t);
  await library.createCollection('空');
  const target={collectionPath:'空'},p=await library.previewCleanup(target),id=randomUUID();
  assert.equal(p.folderCount,1);
  await library.applyCleanup(target,{folder:true},p.revision,id);
  await assert.rejects(lstat(join(root,'空')),{code:'ENOENT'});
  const result=await library.applyCleanup(target,{folder:true},p.revision,id);
  assert.ok(!result.collections.includes('空'));
  await library.ackCleanup(id);
  assert.deepEqual(await library.listCleanupOperations(),[]);
});

test('an interrupted dissolution resumes its outstanding moves and keeps the receipt until the DB acknowledges',async t=>{
  const {root,library}=await fixture(t);
  const {createCleanup}=await import('../../src/media/collection-cleanup.mjs');
  const {realpath,rename}=await import('node:fs/promises');
  const physical=await realpath(root);
  await library.createCollection('系列/第2季');
  const collectionPath='系列',target={collectionPath},id=randomUUID();
  // Use two empty direct members and a projection identical to the on-disk discovery input.
  const shelves=['系列','系列/第1季','系列/第2季'];
  const path=join(physical,'系列/第1季/第一集');
  const episode={dir:path,meta:JSON.parse(await readFile(join(path,'.cinema.json'),'utf8'))};
  const cleanup=createCleanup(()=>physical,{
    discover:async()=>({collections:shelves,episodes:[episode]}),isBusy:()=>false,writersInDirectory:()=>false,
    isVideo:name=>name.endsWith('.mp4'),snapshot:()=>null,
    move:async pairs=>{await rename(...pairs[0]);throw Error('process lost');}
  });
  const p=await library.previewCleanup(target);
  await assert.rejects(cleanup.apply(target,{},p.revision,id,'dissolve'),/process lost/);
  assert.deepEqual(await library.listCleanupOperations(),[{id,complete:false}]);
  await assert.rejects(library.ackCleanup(id),/未完成/);
  const restart=createFilmLibrary(root,{settleMs:0});
  const result=await restart.dissolveCollection(collectionPath,p.revision,id);
  assert.equal(result.items[0].collection,'第1季');
  assert.ok(result.collections.includes('第2季'));
  await restart.ackCleanup(id);
  assert.deepEqual((await readdir(root)).sort(),['第1季','第2季']);
});

test('multi-part storyboards and leftover upgrade shells clean up with the package while unknown files stay protected',async t=>{
  const {library,film}=await fixture(t);
  const chunkDir=join(film.packagePath,'chunks','chunk-0000');
  const sbDir=join(chunkDir,'storyboards');
  await mkdir(sbDir,{recursive:true});
  await writeFile(join(sbDir,'chunk-0000-0001-5000.jpg'),'main');
  await writeFile(join(sbDir,'chunk-0000-0001-5000-part-2.jpg'),'crop');
  await writeFile(join(chunkDir,'viewing.json'),JSON.stringify({
    segments:[{entries:[{type:'image',storyboardRef:'chunks/chunk-0000/storyboards/chunk-0000-0001-5000.jpg',
      parts:[{ref:'chunks/chunk-0000/storyboards/chunk-0000-0001-5000.jpg'},{ref:'chunks/chunk-0000/storyboards/chunk-0000-0001-5000-part-2.jpg'}]}]}]
  }));
  const tx=join(film.episodePath,'.upgrades',randomUUID());
  await mkdir(join(tx,'new'),{recursive:true});
  await writeFile(join(tx,'upgrade.json'),JSON.stringify({status:'complete',oldPackageDisposition:'recycled'}));

  const target={mediaId:film.id};
  let preview=await library.previewCleanup(target);
  assert.deepEqual(preview.unknownPaths,[]);
  assert.equal(preview.packageCount,1);
  await library.applyCleanup(target,{package:true},preview.revision);
  await assert.rejects(lstat(film.packagePath),{code:'ENOENT'});
  await assert.rejects(lstat(join(film.episodePath,'.upgrades')),{code:'ENOENT'});
});

test('single-film full cleanup removes the empty episode directory and retained card while protecting unknown files',async t=>{
  const {library,film}=await fixture(t);
  await writeFile(join(film.episodePath,'.DS_Store'),'benign');
  const target={mediaId:film.id};

  // Partial cleanup leaves the folder when assets remain.
  let preview=await library.previewCleanup(target);
  await assert.rejects(library.applyCleanup(target,{video:true,folder:true},preview.revision),/保留/);

  // Removing all assets + folder deletes the entire episode directory and leaves no retained card.
  await writeFile(join(film.episodePath,'poster.jpg'),'keep-me');
  preview=await library.previewCleanup(target);
  await assert.rejects(library.applyCleanup(target,{video:true,subtitles:true,package:true,folder:true},preview.revision),/未识别/);
  await rm(join(film.episodePath,'poster.jpg'));

  // First remove only the files, then remove the leftover empty shell folder cleanly.
  preview=await library.previewCleanup(target);
  await library.applyCleanup(target,{video:true,subtitles:true,package:true},preview.revision);
  preview=await library.previewCleanup(target);
  assert.equal(preview.folderCount,1);
  assert.equal(preview.videoCount,0);
  const after=await library.applyCleanup(target,{folder:true},preview.revision);
  assert.deepEqual(after.retainedFilms,[]);
  await assert.rejects(lstat(film.episodePath),{code:'ENOENT'});
});
