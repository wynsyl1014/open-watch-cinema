import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createFilmLibrary } from '../../src/media/film-library.mjs';

test('subtitle settings apply at import, jobs survive reconnect, interrupted selections can retry', {timeout:30000}, async t => {
  if (spawnSync('ffmpeg',['-version']).status !== 0) return t.skip('FFmpeg unavailable');
  const root = await mkdtemp(join(tmpdir(),'cinema-subtitle-jobs-'));
  let stop;
  t.after(async () => { if (stop) await stop(); await rm(root,{recursive:true,force:true}); });
  const fixture = join(root,'sample.mkv');
  await writeFile(join(root,'eng.srt'),'1\n00:00:00,100 --> 00:00:00,800\nHello\n');
  const generated = spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=s=16x16:d=1','-i',join(root,'eng.srt'),
    '-map','0:v','-map','1:s','-c:v','ffv1','-c:s','srt','-metadata:s:s:0','language=eng',fixture],{encoding:'utf8'});
  assert.equal(generated.status,0,generated.stderr);
  const source = await readFile(fixture);
  const legacyDir = join(root,'media','Old');
  await mkdir(legacyDir,{recursive:true});
  await writeFile(join(legacyDir,'.cinema.json'),JSON.stringify({version:1,id:'b'.repeat(24),video:'Old.mkv'}));
  await writeFile(join(legacyDir,'Old.mkv'),source);
  const probe = createServer();
  probe.listen(0,'127.0.0.1');
  await once(probe,'listening');
  const port = probe.address().port;
  await new Promise(done => probe.close(done));
  const base = 'http://127.0.0.1:'+port;
  async function api(path, options) {
    const r = await fetch(base+path,options);
    const result = await r.json();
    assert.ok(r.ok,JSON.stringify(result));
    return result;
  }
  async function waitFor(fn) {
    const until = Date.now()+6000;
    do { const result = await fn(); if (result) return result; await delay(40); } while (Date.now()<until);
    assert.fail('Timed out waiting for the isolated cinema.');
  }
  async function start() {
    const child = spawn(process.execPath,['server.mjs'],{cwd:resolve(import.meta.dirname,'../..'),stdio:'ignore',
      env:{...process.env,LOCAL_DATA_ROOT:root,PORT:String(port),OPEN_BROWSER:'0'}});
    const exit = once(child,'exit');
    stop = async () => { child.kill(); await exit; stop = null; };
    await waitFor(()=>fetch(base+'/api/health').then(r=>r.ok,()=>false));
  }
  const post = data => ({method:'POST',body:JSON.stringify(data)});
  const importFilm = async name => {
    const {items} = await api('/api/library/import?name='+name+'.mkv',{method:'POST',body:source});
    return items.find(item=>item.title===name);
  };
  const finish = job => waitFor(async () => {
    const current = (await api('/api/jobs/'+job.id)).job;
    if (['queued','processing'].includes(current.status)) return false;
    assert.equal(current.status,'completed',current.error);
    assert.equal(current.progress,100);
    return current;
  });
  await start();
  assert.deepEqual((await api('/api/subtitle-settings')).languages,['zh-Hans','zh-Hant','en']);
  const first = await importFilm('First');
  await finish(first.subtitleJob);
  const url = '/api/media/'+first.id+'/subtitles';
  const {embedded:[english]} = await api(url);
  assert.equal(english.saved,true);
  const forbidden = await fetch(base+url+'/delete',{...post({trackIds:[english.id]}),headers:{origin:'https://elsewhere.example'}});
  assert.equal(forbidden.status,403);
  assert.equal((await api(url+'/delete',post({trackIds:[english.id]}))).embedded[0].saved,false);
  await api('/api/subtitle-settings',post({languages:[]}));
  const second = await importFilm('Second');
  assert.equal(second.subtitleJob,null);
  await api('/api/subtitle-settings',post({languages:['en']}));
  const old = '/api/media/'+'b'.repeat(24)+'/subtitles';
  assert.equal((await api(old)).embedded[0].saved,false);
  const secondUrl = '/api/media/'+second.id+'/subtitles';
  assert.equal((await api(secondUrl)).embedded[0].saved,false);
  const starts = await Promise.all([1,2].map(() => api(secondUrl+'/prepare',post({trackIds:[english.id]}))));
  const manual = starts[0].job;
  assert.equal(starts[1].job.id,manual.id);
  await finish(manual);
  await stop();
  const metaPath = join(root,'media','First','.cinema.json');
  const meta = JSON.parse(await readFile(metaPath,'utf8'));
  meta.subtitleJob = {...meta.subtitleJob,status:'processing',trackIds:[english.id],plannedTrackIds:[english.id]};
  await writeFile(metaPath,JSON.stringify(meta));
  await start();
  await waitFor(async ()=>(await api(url)).job?.status==='interrupted');
  assert.equal((await api(url)).embedded[0].saved,false);
  assert.equal((await api(old)).job,null);
  await finish((await api(url+'/prepare',post({retry:true}))).job);
  assert.equal((await api(url)).embedded[0].saved,true);
  assert.deepEqual((await api('/api/subtitle-settings')).languages,['en']);
});

test('a scanned download snapshots the admission choice and a previous subtitle bundle keeps its tracks', async t => {
  const root = await mkdtemp(join(tmpdir(),'cinema-subtitle-admission-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'New.mkv'),'movie');
  await writeFile(join(root,'Legacy.mkv'),'existing movie');
  await mkdir(join(root,'Legacy.owc-subtitles'));
  await writeFile(join(root,'New.mkv.part'),'downloading');
  let languages = ['zh-Hant'];
  const library = createFilmLibrary(root,{settleMs:0,newSubtitleJob:id=>({mediaId:id,languages})});
  const first = await library.snapshot();
  assert.deepEqual(first.items.map(item=>item.title),['Legacy']);
  assert.equal(first.items[0].subtitleJob,null);
  languages = ['en'];
  await rm(join(root,'New.mkv.part'));
  const completed = (await library.snapshot()).items.find(item=>item.title==='New');
  assert.deepEqual(completed.subtitleJob.languages,['en']);
  languages = [];
  const rescanned = (await library.snapshot()).items.find(item=>item.id===completed.id);
  assert.deepEqual(rescanned.subtitleJob.languages,['en']);
});
