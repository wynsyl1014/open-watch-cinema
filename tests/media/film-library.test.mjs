import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createFilmLibrary } from '../../src/media/film-library.mjs';
import { createMediaId } from '../../src/media/media-library.mjs';
import { JOURNAL, recoverMoves } from '../../src/media/library-files.mjs';

async function fixture(t, options={}) {
  const data = await mkdtemp(join(tmpdir(),'cinema-folders-'));
  t.after(()=>rm(data,{recursive:true,force:true}));
  const root=join(data,'media'),legacy=join(data,'packages');
  await mkdir(root); await mkdir(legacy);
  const library=createFilmLibrary(root,{aiPackagesRoot:legacy,settleMs:0,...options});
  return {root,legacy,library};
}
test('legacy package, room identity, original title and subtitles follow nesting, external rename and repair', async t => {
  const {root,legacy,library}=await fixture(t);
  const name='Season.01_猫-123';
  const id=createMediaId(name+'.mkv');
  await writeFile(join(root,name+'.mkv'),'movie');
  await mkdir(join(legacy,id));
  await writeFile(join(legacy,id,'manifest.json'),JSON.stringify({packageKind:'open-watch-cinema-ai-package',sourceMediaId:id,sourceRelativePath:name+'.mkv'}));
  await mkdir(join(root,name+'.owc-subtitles'));
  await writeFile(join(root,name+'.owc-subtitles','manifest.json'),JSON.stringify({kind:'open-watch-cinema-subtitle-bundle',tracks:[]}));
  await writeFile(join(root,name+'.en.vtt'),'WEBVTT\n');
  let state=await library.snapshot();
  assert.deepEqual(state.issues,[]);
  assert.equal(state.items[0].id,id);
  assert.equal(state.items[0].title,name);
  assert.equal(state.items[0].subtitleTracks[0].fileName,name+'.en.vtt');
  await library.createCollection('剧'); await library.createCollection('剧/一');
  await library.moveFilms([id],'剧/一');
  state=await library.renameFilm(id,'新.名');
  assert.equal(state.items[0].relativePath,'剧/一/新.名/新.名.mkv');
  await rename(join(root,'剧/一/新.名'),join(root,'剧/一/文件夹改名'));
  state=await library.snapshot();
  assert.equal(state.items[0].relativePath,'剧/一/文件夹改名/文件夹改名.mkv');
  const item=state.items[0];
  assert.equal(JSON.parse(await readFile(join(item.packagePath,'manifest.json'))).sourceRelativePath,item.relativePath);
  await rename(item.absolutePath,join(item.episodePath,'文件夹改名.mp4'));
  state=await library.moveFilms([id],'');
  assert.equal(state.items[0].relativePath,'文件夹改名/文件夹改名.mp4');
  assert.equal(state.items[0].id,id);
});
test('imports, pending subtitle ownership, active downloads, duplicate targets and traversal', async t => {
  const {root,library}=await fixture(t);
  await writeFile(join(root,'down.mp4'),'active');
  await writeFile(join(root,'down.mp4.aria2'),'marker');
  const first=(await library.importFile('Film.mp4',Readable.from(['film']))).items[0];
  const next=await library.importFile('Film.Extended.mp4',Readable.from(['other']));
  assert.equal(next.items.length,2);
  const subs=await library.importFile('Film.Extended.en.vtt',Readable.from(['WEBVTT\n']));
  assert.equal(subs.pendingSubtitles[0].candidates.length,2);
  const assigned=await library.assignSubtitle('Film.Extended.en.vtt',first.id);
  assert.equal(assigned.items.find(i=>i.id===first.id).subtitleTracks.length,1);
  await assert.rejects(library.importFile('Film.mp4',Readable.from(['replace'])),/已存在/);
  await assert.rejects(library.createCollection('../escape'));
  await mkdir(join(root,'new'));
  await symlink(tmpdir(),join(root,'outside'));
  await assert.rejects(library.moveFilms([first.id],'outside'));
  assert.equal(await readFile(first.absolutePath,'utf8'),'film');
  await rm(join(root,'down.mp4.aria2'));
  assert.equal((await library.snapshot()).items.length,3);
});
test('unfinished file moves resume from the identity recorded before moving',async t=>{
  const {root}=await fixture(t);
  const a=join(root,'a'),b=join(root,'b');
  await writeFile(a,'source');
  const s=await lstat(a,{bigint:true});
  const journal={version:1,actions:[{from:a,to:b,dev:String(s.dev),ino:String(s.ino)}]};
  await writeFile(join(root,JOURNAL),JSON.stringify(journal));
  await rename(a,b);
  await recoverMoves(root,null);
  assert.equal(await readFile(b,'utf8'),'source');
  await assert.rejects(lstat(join(root,JOURNAL)),{code:'ENOENT'});
});

test('matching names in separate series keep their own identities, including a released legacy name',async t=>{
  let eligible = true;
  const filename = 'E.01.mp4';
  const legacyId = createMediaId(filename);
  const {root,library} = await fixture(t,{isLegacyMedia:(id,path,file) => eligible && id===legacyId && path===filename && file.size===3});
  await writeFile(join(root,filename),'old');
  assert.equal((await library.snapshot()).items[0].id,legacyId);
  eligible=false;
  await library.createCollection('Series A');
  await library.moveFilms([legacyId],'Series A');
  await writeFile(join(root,filename),'new');
  const items=(await library.snapshot()).items;
  assert.equal(items.length,2);
  assert.notEqual(items[0].id,items[1].id);
  assert.equal(items.find(item=>item.collection==='Series A').id,legacyId);
});

test('scanning leaves an absent package available for interrupted upgrade recovery', async t => {
  const {library}=await fixture(t);
  const {items:[item]}=await library.importFile('测试.mp4',Readable.from(['test']));
  await assert.rejects(lstat(item.packagePath),{code:'ENOENT'});
  const token='00000000-0000-4000-8000-000000000001';
  const transaction=join(item.episodePath,'.upgrades',token);
  await mkdir(join(transaction,'old-package'),{recursive:true});
  await writeFile(join(transaction,'old-package','manifest.json'),JSON.stringify({packageKind:'open-watch-cinema-ai-package',status:'ready'}));
  await writeFile(join(transaction,'upgrade.json'),JSON.stringify({kind:'open-watch-cinema-package-upgrade',token,packageKey:'观影包',pid:2147483647,status:'switching'}));
  await library.snapshot();
  const {recoverPackageUpgrades}=await import('../../src/preparation/package-upgrade.mjs');
  assert.equal((await recoverPackageUpgrades(item.episodePath)).length,1);
  assert.equal((await library.snapshot()).items[0].aiPackage.status,'ready');
});

test('failed, interrupted and colliding imports leave no film or staging residue', async t => {
  const {root,library}=await fixture(t);
  const {readdir} = await import('node:fs/promises');
  const broken=Readable.from((async function*(){ yield 'partial bytes'; throw new Error('upload interrupted'); })());
  await assert.rejects(library.importFile('节目.mp4',broken),/interrupted/);
  assert.deepEqual(await readdir(root),[]);
  await library.importFile('节目.mp4',Readable.from(['original']));
  await assert.rejects(library.importFile('节目.mkv',Readable.from(['duplicate'])),/已存在/);
  assert.deepEqual(await readdir(root),['节目']);
  assert.equal(await readFile(join(root,'节目','节目.mp4'),'utf8'),'original');
});

test('a subtitle dropped inside its chosen episode belongs to that film',async t=>{
  const {library}=await fixture(t);
  const {items:[item]}=await library.importFile('히어로.mp4',Readable.from(['video']));
  await writeFile(join(item.episodePath,'任意文件名.vtt'),'WEBVTT\n');
  const {items,pendingSubtitles}=await library.snapshot();
  assert.deepEqual(pendingSubtitles,[]);
  assert.equal(items[0].subtitleTracks[0].fileName,'任意文件名.vtt');
});

test('case-only renames update both directory and video without removing either',async t=>{
  const {library}=await fixture(t);
  const {items:[item]}=await library.importFile('film.mp4',Readable.from(['original']));
  const {items:[updated]}=await library.renameFilm(item.id,'FILM');
  assert.equal(updated.relativePath,'FILM/FILM.mp4');
  assert.equal(updated.id,item.id);
  assert.equal(await readFile(updated.absolutePath,'utf8'),'original');
});

test('duplicate IDs are reported and duplicate batch destinations leave every original in place',async t=>{
  const {root,library}=await fixture(t);
  await library.createCollection('一'); await library.createCollection('二');
  const first=(await library.importFile('片.mp4',Readable.from(['one']),{collection:'一'})).items[0];
  const items=(await library.importFile('片.mp4',Readable.from(['two']),{collection:'二'})).items;
  await assert.rejects(library.moveFilms(items.map(item=>item.id),''),/同名/);
  assert.equal(await readFile(first.absolutePath,'utf8'),'one');
  const second=items.find(item=>item.id!==first.id);
  assert.equal(await readFile(second.absolutePath,'utf8'),'two');
  const meta=await readFile(join(first.episodePath,'.cinema.json'));
  await writeFile(join(second.episodePath,'.cinema.json'),meta);
  const result=await library.snapshot();
  assert.equal(result.issues.length,2);
  assert.equal(result.items.length,0);
  await assert.rejects(lstat(join(root,'片')),{code:'ENOENT'});
});

test('a final video name held open by a writer is ingested only after close',async t=>{
  if (!['darwin','win32'].includes(process.platform)) return t.skip('Requires a supported desktop ownership probe');
  const {root,library}=await fixture(t);
  const {open}=await import('node:fs/promises');
  const handle=await open(join(root,'still-downloading.mp4'),'wx');
  try {
    await handle.writeFile('first packets');
    assert.deepEqual((await library.snapshot()).items,[]);
    await handle.writeFile('last packets');
  } finally { await handle.close(); }
  const {items:[finished]}=await library.snapshot();
  assert.equal(await readFile(finished.absolutePath,'utf8'),'first packetslast packets');
});

test('a contested destination preserves both files and unrelated films stay visible',async t=>{
  const {root,library}=await fixture(t);
  const {items:[item]}=await library.importFile('keep.mp4',Readable.from(['screenable']));
  const from=join(root,'a.srt'),to=join(root,'b.srt');
  await writeFile(from,'one'); await writeFile(to,'other');
  const f=await lstat(from,{bigint:true});
  await writeFile(join(root,JOURNAL),JSON.stringify({version:1,actions:[{from,to,dev:String(f.dev),ino:String(f.ino)}]}));
  const list=await library.snapshot();
  assert.equal(list.items[0].id,item.id);
  assert.ok(list.issues.some(issue=>issue.relativePath===JOURNAL));
  assert.equal(await readFile(from,'utf8'),'one');
  assert.equal(await readFile(to,'utf8'),'other');
});

test('renaming a collection updates nested paths and keeps film identity and subtitle tracks', async t => {
  let busyId;
  const {root, library} = await fixture(t,{isBusy:id => id === busyId});
  await library.createCollection('原名');
  await library.createCollection('原名/第一季');
  await library.createCollection('已有合集');
  const {items:[film]} = await library.importFile('第一集.mp4',Readable.from(['film']),{collection:'原名/第一季'});
  await library.importFile('第一集.zh.vtt',Readable.from(['WEBVTT\n']),{mediaId:film.id});
  for (const [path,name] of [['原名','已有合集'],['','新名'],['原名','../新名'],['原名','新名.part'],['原名/第一季/第一集','新名']]) {
    await assert.rejects(library.renameCollection(path,name));
  }
  busyId = film.id;
  await assert.rejects(library.renameCollection('原名','新名'),/正在处理/);
  busyId = null;
  await writeFile(join(root,'原名','第一季','在下载.mp4.part'),'part');
  await assert.rejects(library.renameCollection('原名','新名'),/下载/);
  await rm(join(root,'原名','第一季','在下载.mp4.part'));
  const snapshot = await library.renameCollection('原名','新名');
  assert.deepEqual(snapshot.collections.sort(),['已有合集','新名','新名/第一季'].sort());
  const [item] = snapshot.items;
  assert.equal(item.id,film.id);
  assert.equal(item.relativePath,'新名/第一季/第一集/第一集.mp4');
  assert.equal(item.subtitleTracks.length,1);
  assert.equal(await readFile(item.absolutePath,'utf8'),'film');
});
