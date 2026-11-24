import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createFilmLibrary } from '../../src/media/film-library.mjs';

async function fixture(t,options={}) {
  const data=await realpath(await mkdtemp(join(tmpdir(),'cinema-release-')));
  t.after(()=>rm(data,{recursive:true,force:true}));
  const root=join(data,'media'); await mkdir(root);
  const lib=createFilmLibrary(root,{settleMs:0,...options});
  const {items:[item]}=await lib.importFile('Film.mp4',Readable.from(['12345']));
  return {root,data,lib,item};
}
test('package release totals owned files recursively; external symlinks and sibling content are preserved',async t=>{
  const {data,root,lib,item}=await fixture(t);
  await writeFile(join(data,'unrelated'),'external data');
  await mkdir(join(item.packagePath,'chunks'),{recursive:true});
  await writeFile(join(item.packagePath,'chunks','frames'),'1234567');
  await symlink(join(data,'unrelated'),join(item.packagePath,'linked'));
  await writeFile(join(item.subtitlesPath,'CC.vtt'),'WEBVTT\n');
  await writeFile(join(item.episodePath,'notes.txt'),'extra');
  const {revision,...usage}=await lib.spaceUsage(item.id);
  assert.deepEqual(usage,{videoBytes:5,subtitleBytes:7,packageBytes:7});
  await writeFile(join(item.packagePath,'added'),'new');
  await assert.rejects(lib.releaseSpace(item.id,'package',{revision}),/预览/);
  const preview=await lib.spaceUsage(item.id);
  const result=await lib.releaseSpace(item.id,'package',{revision:preview.revision});
  assert.equal(result.items.length,1); assert.equal(result.items[0].aiPackage,null);
  assert.equal(await readFile(join(data,'unrelated'),'utf8'),'external data');
  assert.equal(await readFile(join(item.episodePath,'notes.txt'),'utf8'),'extra');
  const updated=await lib.spaceUsage(item.id); assert.equal(updated.packageBytes,0); assert.equal(updated.subtitleBytes,7);
  await lib.releaseSpace(item.id,'package',{revision:updated.revision});
  assert.deepEqual(await readdir(root),['Film']);
});
test('media release and historical relink preserve extras and resolve an occupied original pathname',async t=>{
  const {lib,item}=await fixture(t);
  await writeFile(join(item.episodePath,'notes.txt'),'outside release');
  const {items}=await lib.releaseSpace(item.id,'media',await lib.spaceUsage(item.id));
  assert.deepEqual(items,[]); assert.deepEqual(await readdir(item.episodePath),['notes.txt']);
  const restored=(await lib.relinkFile(item.id,'new source.mkv',Readable.from(['restored']),{title:'Film'})).items[0];
  assert.equal(restored.id,item.id); assert.equal(restored.title,'Film (2)');
  assert.equal(await readFile(restored.absolutePath,'utf8'),'restored');
  await assert.rejects(lib.relinkFile(item.id,'other.mp4',Readable.from(['other'])),/已经关联/);
});
test('relink restores a Finder-removed video to its surviving identity, subtitles and package',async t=>{
  const {lib,item}=await fixture(t);
  await mkdir(item.packagePath);await writeFile(join(item.packagePath,'asset'),'pack');
  await writeFile(join(item.subtitlesPath,'old.vtt'),'WEBVTT\n');
  await rm(item.absolutePath);
  const {items:[restored]}=await lib.relinkFile(item.id,'picked.mkv',Readable.from(['restored']),{collection:'removed folder',title:'ignored'});
  assert.equal(restored.relativePath,'Film/Film.mkv');
  assert.equal(await readFile(join(restored.packagePath,'asset'),'utf8'),'pack');
  assert.equal(restored.subtitleTracks.length,1);
});
test('release blocks busy films, removes vacant episode directories and relink rejects interrupted transfers',async t=>{
  let busy=false;
  const {lib,item,root}=await fixture(t,{isBusy:()=>busy});
  busy=true; await assert.rejects(lib.releaseSpace(item.id,'media'),/处理/);
  busy=false; await lib.releaseSpace(item.id,'media');
  await assert.rejects(lstat(item.episodePath),{code:'ENOENT'});
  const stream=Readable.from((async function*(){yield 'part';throw Error('interrupted');})());
  await assert.rejects(lib.relinkFile(item.id,'Film.mp4',stream),/interrupted/);
  assert.deepEqual(await readdir(root),[]);
});

test('restart finishes a staged release after an interrupted process without touching unrelated siblings',async t=>{
  const {lib,item,root}=await fixture(t);
  const {inspectFilmSpace,releaseFilmSpace}=await import('../../src/media/film-space.mjs');
  const {rename}=await import('node:fs/promises');
  await mkdir(item.packagePath);await writeFile(join(item.packagePath,'frames'),'images');
  await writeFile(join(item.episodePath,'personal.txt'),'keep');
  const physical=await inspectFilmSpace(root,item.episodePath,'Film.mp4');
  await assert.rejects(releaseFilmSpace(root,item.episodePath,'media',physical,async pairs=>{
    for(const [from,to] of pairs) await rename(from,to);
    throw new Error('simulated process loss');
  }),/simulated/);
  const restarted=createFilmLibrary(root,{settleMs:0});
  assert.equal((await restarted.snapshot()).items.length,0);
  assert.deepEqual(await readdir(root),['Film']);
  assert.deepEqual(await readdir(item.episodePath),['personal.txt']);
});
