import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, parse, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createMediaId, readAiPackage, VIDEO_EXTENSIONS } from './media-library.mjs';
import { readSubtitleBundle, SIDECAR_EXTENSIONS } from './media-subtitles.mjs';
import { createCleanup } from './collection-cleanup.mjs';
import { inspectFilmSpace, recoverReleases, releaseFilmSpace } from './film-space.mjs';
import { probeMedia } from './media-compatibility.mjs';
import { normalizeSkipConfig, resolveSkipRanges } from './skip-ranges.mjs';
import { META, SUBS, PACKAGE, JOURNAL, checkedName, info, json, moveTransaction, portable, problem, recoverMoves, writeJson } from './library-files.mjs';

const extension = name => extname(name).toLowerCase();
const isVideo = name => VIDEO_EXTENSIONS.has(extension(name)) && !/\.owc-(processing|backup)/i.test(name);
const isSubtitle = name => SIDECAR_EXTENSIONS.has(extension(name));
const fold = value => value.normalize('NFC').toLowerCase();
const idPattern = /^[a-f0-9]{24}$/;
const blockedSuffix = /(?:\.part|\.crdownload|\.aria2|\.!qb|\.download|\.partial|\.tmp)$/i;

const run = promisify(execFile);
async function writerOpen(path, recursive=false) {
  if (process.platform === 'win32') {
    // An existing writer must grant a sharing mode compatible with this read-only handle.
    const script = recursive ? `$ErrorActionPreference="Stop"
$dirs = [Collections.Generic.Stack[string]]::new()
$dirs.Push($env:OWC_FILE_TO_CHECK)
while ($dirs.Count) { foreach ($file in [IO.DirectoryInfo]::new($dirs.Pop()).EnumerateFileSystemInfos()) {
  if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
  if ($file -is [IO.DirectoryInfo]) { $dirs.Push($file.FullName) }
  else { [IO.File]::Open($file.FullName,"Open","Read","Read").Dispose() }
} }` : '$ErrorActionPreference="Stop"; [IO.File]::Open($env:OWC_FILE_TO_CHECK,"Open","Read","Read").Dispose()';
    try {
      await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:5000,env:{...process.env,OWC_FILE_TO_CHECK:path}});
      return false;
    } catch { return true; }
  }
  try {
    const {stdout} = await run(process.platform==='darwin' ? '/usr/sbin/lsof' : 'lsof',recursive ? ['-nP','-Ffa','+D',path] : ['-nP','-Ffa','--',path],{timeout:recursive ? 30000 : 5000});
    return /^a[uw]/m.test(stdout);
  } catch (error) {
    // lsof returns 1 with no matches. Linux hosts without lsof retain the stability check.
    if (error.code === 1 && !error.stderr) return /^a[uw]/m.test(error.stdout || '');
    return error.code !== 'ENOENT';
  }
}

export function createFilmLibrary(mediaRoot, { aiPackagesRoot = null, isBusy = () => false, isLegacyMedia = () => false,
  newSubtitleJob = () => null, settleMs = 2500, collectionSkipSettings = null } = {}) {
  let root, legacy, queue = Promise.resolve();
  const observations = new Map();
  const referenceVersions = new Map();
  const durations = new Map();
  async function setup() {
    root = await realpath(mediaRoot);
    legacy = aiPackagesRoot && resolve(aiPackagesRoot);
    if (legacy && await info(legacy)) legacy = await realpath(legacy);
  }
  function serial(fn,{allowInspection=false,cleanupRecovery=false}={}) {
    const result = queue.then(async () => {
      await setup();
      try {
        await recoverMoves(root,legacy,onCollectionsMoved);
        await recoverReleases(root);
        if (!cleanupRecovery && (await cleanup.list()).some(receipt=>!receipt.complete)) {
          throw problem('有一项已确认的文件清理等待恢复。');
        }
      }
      catch (error) {
        if (!allowInspection) throw error;
        return snapshot(new Set(),error);
      }
      return fn();
    });
    queue = result.catch(() => {});
    return result;
  }
  const rel = path => portable(root, path);
  const onCollectionsMoved = actions => {
    for (const {from, to} of actions) collectionSkipSettings?.move(rel(from), rel(to));
  };
  const transaction = (pairs, collections = false) =>
    moveTransaction(root, legacy, pairs, {collections, onCollectionsMoved});
  async function sourceDuration(id, path, file) {
    const identity = [file.dev, file.ino, file.size, file.mtimeMs].join(':');
    const cached = durations.get(id);
    if (cached?.identity === identity) return cached.durationMs;
    const probe = await probeMedia(path);
    const durationMs = Math.round(probe.durationSeconds * 1000);
    if (Number.isSafeInteger(durationMs) && durationMs > 0) {
      durations.set(id, {identity, durationMs});
      return durationMs;
    }
    return null;
  }
  async function discover() {
    const tree = {collections:[], episodes:[], videos:[], subtitles:[], markers:new Set(), issues:[]};
    async function walk(dir) {
      for (const entry of await readdir(dir, {withFileTypes:true})) {
        const {name} = entry;
        const path = join(dir, name);
        if (blockedSuffix.test(name)) tree.markers.add(fold(path.replace(blockedSuffix, '')));
        if (name.startsWith('.') || entry.isSymbolicLink()) continue;
        if (entry.isFile()) {
          if (isVideo(name)) tree.videos.push(path);
          if (isSubtitle(name)) tree.subtitles.push(path);
        }
        if (!entry.isDirectory() || blockedSuffix.test(name) || /\.owc-(subtitles|processing.*|backup.*)$/i.test(name)) continue;
        const marker = await info(join(path, META));
        if (marker) {
          try {
            if (!marker.isFile()) throw problem('影片身份文件类型无效。');
            const meta = await json(join(path, META));
            if (!idPattern.test(meta.id)) throw problem('影片 ID 无效。');
            const files = await readdir(path,{withFileTypes:true});
            tree.episodes.push({dir:path,meta,files});
            for (const file of files) {
              const input = join(path,file.name);
              if (blockedSuffix.test(file.name)) tree.markers.add(fold(input.replace(blockedSuffix,'')));
              if (file.isFile() && !file.name.startsWith('.') && isSubtitle(file.name)) tree.subtitles.push(input);
            }
          } catch (e) { tree.issues.push({relativePath:rel(path),message:e.message}); }
        } else {
          tree.collections.push(rel(path));
          await walk(path);
        }
      }
    }
    await walk(root);
    return tree;
  }
  async function available(path, tree, trusted) {
    if (tree.markers.has(fold(path)) || tree.markers.has(fold(join(dirname(path),parse(path).name)))) return false;
    const entry = await stat(path);
    if (!entry.size) return false;
    const key = [entry.ino, entry.size, entry.mtimeMs,entry.ctimeMs].join('/');
    if (trusted) observations.set(path, {key,since:Date.now()-settleMs, imported:true});
    if (settleMs === 0 || (observations.get(path)?.key === key && observations.get(path).imported)) return true;
    if (isVideo(path) && Date.now() - Math.max(entry.mtimeMs,entry.ctimeMs) >= settleMs
        && await isLegacyMedia(createMediaId(rel(path)),rel(path),entry)) return true;
    const previous = observations.get(path);
    if (!previous || previous.key !== key) {
      observations.set(path, {key,since:Date.now()});
      return false;
    }
    return Date.now() - previous.since >= settleMs && Date.now() - entry.mtimeMs >= settleMs;
  }
  function collectionPath(name, tree) {
    if (name === '') return root;
    if (!tree.collections.includes(name)) throw problem('合集不存在。',404);
    return join(root, name);
  }
  async function legacyIdentity(path) {
    const relativePath = rel(path);
    const id = createMediaId(relativePath);
    if (await isLegacyMedia(id,relativePath,await stat(path))) return id;
    const manifest = legacy && join(legacy,id,'manifest.json');
    if (manifest && (await info(manifest))?.isFile()) {
      const prior = await json(manifest);
      if (prior.packageKind === 'open-watch-cinema-ai-package' && prior.sourceMediaId === id
        && prior.sourceRelativePath === relativePath) return id;
    }
    return null;
  }
  const newId = () => randomUUID().replaceAll('-','').slice(0,24);
  async function ingest(source, collection, filename, id, {useLegacyAssets = true, isNew = false} = {}) {
    const title = checkedName(parse(filename).name);
    const dest = join(collection,title);
    if (await info(dest)) throw problem('同名影片或合集已存在：' + title);
    const staging = await mkdtemp(join(root,'.cinema-stage-'));
    try {
      const subtitleJob = isNew ? newSubtitleJob(id) : null;
      await writeJson(join(staging,META),{version:1,id,video:filename,...(subtitleJob && {subtitleJob})});
      const pairs = [[staging,dest],[source,join(dest,filename)]];
      const bundle = join(dirname(source),title + '.owc-subtitles');
      const oldPackage = useLegacyAssets && legacy && join(legacy,id);
      for (const [prior,name] of [[bundle,SUBS],[oldPackage,PACKAGE]]) {
        const entry = prior && await info(prior);
        if (entry && !entry.isDirectory()) throw problem('已有资料目录无效：' + name);
        if (entry) pairs.push([prior,join(dest,name)]);
        else if (name === SUBS) await mkdir(join(staging,name));
      }
      await transaction(pairs);
    } finally { if (!await info(join(root,JOURNAL))) await rm(staging,{recursive:true,force:true}); }
  }
  async function updateReferences(path, fields, kind) {
    const entry = await info(path);
    if (!entry) return;
    if (!entry.isFile()) throw problem('清单文件无效。');
    const version = [entry.ino,entry.size,entry.mtimeMs,entry.ctimeMs,...Object.values(fields)].join('/');
    if (referenceVersions.get(path) === version) return;
    const data = await json(path);
    if ((data.kind || data.packageKind) !== kind) return;
    if (Object.entries(fields).some(([key,value]) => data[key] !== value)) await writeJson(path,{...data,...fields});
    referenceVersions.set(path,version);
  }
  async function itemFor({dir,meta,files:entries}, issues, inspectOnly) {
    const files = entries.filter(entry => entry.isFile() && isVideo(entry.name));
    if (files.length !== 1) throw problem('影片文件夹应包含一个视频文件。');
    const current = files[0].name;
    const title = basename(dir);
    const filename = title + extname(current);
    const busy = inspectOnly || await isBusy(meta.id);
    const video = busy ? current : filename;
    if (!busy && current !== filename) await transaction([[join(dir,current),join(dir,filename)]]);
    const absolutePath = join(dir,video);
    const relativePath = rel(absolutePath);
    const packagePath = join(dir,PACKAGE);
    const subtitlesPath = join(dir,SUBS);
    for (const path of [packagePath,subtitlesPath]) {
      const entry = await info(path);
      if (entry && !entry.isDirectory()) throw problem('资料目录无效：' + basename(path));

    }
    if (!busy) {
      if (meta.video !== video) await writeJson(join(dir,META),{...meta,video});
      const manifests = [
        [join(packagePath,'manifest.json'),{sourceFileName:video,sourceRelativePath:relativePath},'open-watch-cinema-ai-package'],
        [join(subtitlesPath,'manifest.json'),{targetMediaFileName:video},'open-watch-cinema-subtitle-bundle']
      ];
      const embedded = join(subtitlesPath,'.embedded');
      if ((await info(embedded))?.isDirectory()) {
        manifests.push([join(embedded,'manifest.json'),{targetMediaFileName:video},'open-watch-cinema-subtitle-bundle']);
      }
      for (const [path,fields,kind] of manifests) {
        try { await updateReferences(path,fields,kind); }
        catch (error) { issues.push({relativePath:rel(path),message:error.message}); }
      }
    }
    let subtitleTracks = [];
    try { if (!inspectOnly) subtitleTracks = await readSubtitleBundle(absolutePath); }
    catch (error) { issues.push({relativePath:rel(subtitlesPath),message:error.message}); }
    const file = await stat(absolutePath);
    const collection = rel(dirname(dir));
    const skipConfig = meta.skipConfig == null ? null : normalizeSkipConfig(meta.skipConfig);
    const effectiveSkipConfig = skipConfig ?? collectionSkipSettings?.get(collection) ?? null;
    let durationMs = null;
    let skipRanges = [];
    if (effectiveSkipConfig?.intro || effectiveSkipConfig?.outro || effectiveSkipConfig?.middle.length) {
      try {
        durationMs = await sourceDuration(meta.id, absolutePath, file);
        if (durationMs !== null) skipRanges = resolveSkipRanges(effectiveSkipConfig, durationMs);
      } catch (error) { issues.push({relativePath,message:error.message}); }
    }
    return { id:meta.id,title,relativePath,absolutePath,episodePath:dir,collection,packagePath,subtitlesPath,
      extension:extension(video),size:file.size,modifiedAt:file.mtime.toISOString(),
      skipConfig, effectiveSkipConfig, skipRanges, durationMs,
      subtitleJob:meta.subtitleJob || null,subtitleTracks,aiPackage:await readAiPackage(null,meta.id,{packagePath}) };
  }
  async function snapshot(trusted = new Set(), recoveryError = null) {
    let tree = await discover();
    const issues = [...tree.issues];
    if (recoveryError) issues.push({relativePath:JOURNAL,message:recoveryError.message});
    const knownIds = new Set(tree.episodes.map(e => e.meta.id));
    const looseTargets = new Map();
    for (const path of tree.videos) {
      const target = fold(join(dirname(path),parse(path).name));
      looseTargets.set(target,(looseTargets.get(target)||0)+1);
    }
    for (const path of tree.videos) {
      if (recoveryError) break;
      try {
        const legacyId = await legacyIdentity(path);
        const id = legacyId || newId();
        if (looseTargets.get(fold(join(dirname(path),parse(path).name))) > 1) throw problem('多个视频使用相同的影片文件夹名称。');
        if (knownIds.has(id)) throw problem('此来源的影片 ID 已存在，请通过导入入口作为新影片加入。');
        if (await isBusy(id) || !await available(path,tree,trusted.has(path)) || await writerOpen(path)) continue;
        const oldBundle = await info(join(dirname(path),parse(path).name + '.owc-subtitles'));
        await ingest(path,dirname(path),basename(path),id,{isNew:!legacyId && !oldBundle});
        observations.delete(path);
        knownIds.add(id);
      } catch (e) {
        if (await info(join(root,JOURNAL))) throw e;
        issues.push({relativePath:rel(path),message:e.message});
      }
    }
    if (!recoveryError) tree = await discover();
    const items = [], pendingSubtitles = [], retainedFilms = [];
    const counts = new Map();
    for (const {meta} of tree.episodes) counts.set(meta.id,(counts.get(meta.id)||0)+1);
    for (const episode of tree.episodes) {
      try {
        if (counts.get(episode.meta.id)>1) throw problem('多个影片文件夹持有相同的影片 ID。');
        if (!episode.files.some(entry=>isVideo(entry.name)) && typeof episode.meta.video==='string' && basename(episode.meta.video)===episode.meta.video && isVideo(episode.meta.video)) {
          retainedFilms.push({id:episode.meta.id,title:basename(episode.dir),collection:rel(dirname(episode.dir)),relativePath:rel(join(episode.dir,episode.meta.video))});
          continue;
        }
        items.push(await itemFor(episode,issues,Boolean(recoveryError)));
      } catch(e) {
        if (!recoveryError && await info(join(root,JOURNAL))) throw e;
        issues.push({relativePath:rel(episode.dir),message:e.message});
      }
    }
    for (const path of tree.subtitles) {
      if (recoveryError) break;
      if (!await available(path,tree,trusted.has(path)) || await writerOpen(path)) continue;
      const inCollection = items.filter(item => dirname(item.episodePath) === dirname(path));
      const stem = fold(parse(path).name);
      const matchesTitle = title => stem === fold(title) || ['.',' ','-','_'].some(separator => stem.startsWith(fold(title)+separator));
      const owner = items.find(item => item.episodePath === dirname(path));
      const matches = owner ? [owner] : inCollection.filter(item => matchesTitle(item.title));
      const looseMatch = tree.videos.some(video => dirname(video) === dirname(path) && matchesTitle(parse(video).name));
      if (!looseMatch && matches.length === 1 && !await isBusy(matches[0].id)) {
        const item = matches[0];
        try {
          await mkdir(item.subtitlesPath,{recursive:true});
          await transaction([[path,join(item.subtitlesPath,basename(path))]]);
          observations.delete(path);
          item.subtitleTracks = await readSubtitleBundle(item.absolutePath);
          continue;
        } catch(e) {
          if (await info(join(root,JOURNAL))) throw e;
          issues.push({relativePath:rel(path),message:e.message});
        }
      }
      pendingSubtitles.push({relativePath:rel(path),name:basename(path),candidates:(matches.length ? matches : items).map(i=>i.id)});
    }
    const sort = (a,b) => a.localeCompare(b,undefined,{numeric:true});
    items.sort((a,b)=>sort(a.title,b.title));
    return {items,retainedFilms,collections:tree.collections.sort(sort),pendingSubtitles,issues};
  }
  async function getItems(ids) {
    const {items} = await snapshot();
    return Promise.all(ids.map(async id => {
      const item = items.find(i=>i.id===id);
      if (!item) throw problem('影片不存在。',404);
      if (await isBusy(id)) throw problem('影片正在处理中，请稍后再试。');
      return item;
    }));
  }
  async function physicalFilm(id) {
    if (!idPattern.test(id)) throw problem('影片 ID 无效。',400);
    const {episodes}=await discover();
    const matches=episodes.filter(item=>item.meta.id===id);
    if (!matches.length) throw problem('影片文件已不在片库。',404);
    if (matches.length!==1) throw problem('有多个文件夹使用相同影片 ID。');
    const episode=matches[0];
    const videos=episode.files.filter(entry=>entry.isFile() && isVideo(entry.name));
    if (videos.length!==1 || videos[0].name!==episode.meta.video) throw problem('影片文件发生变化，请先重新扫描片库。');
    return {episode:episode.dir,video:videos[0].name,meta:episode.meta};
  }
  async function upload(filename,readable,{collection='',mediaId=null,relinkId=null,title=null}={}) {
    checkedName(filename);
    if (!isVideo(filename) && (!isSubtitle(filename) || relinkId)) throw problem('不支持此文件格式。',400);
    const pickDestination = async () => {
      const tree = await discover();
      const matches = relinkId && tree.episodes.filter(item=>item.meta.id===relinkId);
      if (relinkId && (await isBusy(relinkId) || matches.length>1)) throw problem('影片正在处理或有重复的影片 ID。');
      if (matches?.length) {
        const episode = matches[0];
        if (episode.files.some(entry=>isVideo(entry.name))) throw problem('该影片已经关联了本地文件。');
        return {episode:episode.dir,filename:basename(episode.dir)+extname(filename)};
      }
      const preferred = title==null ? parse(filename).name : checkedName(title);
      let parent;
      if (relinkId && collection && !tree.collections.includes(collection)) {
        collection.split('/').forEach(checkedName);
        parent=root; // The archived collection may itself have been removed in Finder.
      } else parent=collectionPath(collection,tree);
      let stem=preferred;
      if (relinkId) {
        for (let copy=2; await info(join(parent,stem)); copy++) stem=preferred+' ('+copy+')';
      }
      return {parent,filename:stem+extname(filename)};
    };
    let destination=await pickDestination();
    const staged = await mkdtemp(join(root,'.cinema-import-'));
    const file = join(staged,filename);
    try {
      await pipeline(readable,createWriteStream(file,{flags:'wx'}));
      if (!(await stat(file)).size) throw problem('无法导入空文件。',400);
      if (isVideo(filename)) {
        if (relinkId) destination=await pickDestination();
        if (destination.episode) {
          await transaction([[file,join(destination.episode,destination.filename)]]);
        } else await ingest(file,destination.parent,destination.filename,relinkId || newId(),{useLegacyAssets:false,isNew:!relinkId});
      } else {
        const target = mediaId ? (await getItems([mediaId]))[0].subtitlesPath : destination.parent;
        if (mediaId) await mkdir(target,{recursive:true});
        await transaction([[file,join(target,filename)]]);
        return await snapshot(new Set([join(target,filename)]));
      }
      return await snapshot();
    } finally { if (!await info(join(root,JOURNAL))) await rm(staged,{recursive:true,force:true}); }
  }
  const cleanup=createCleanup(()=>root,{discover,isBusy,writersInDirectory:path=>writerOpen(path,true),isVideo,move:transaction,snapshot,
    removeCollectionSettings:(path, descendants) => collectionSkipSettings?.remove(path, descendants)});
  // Receipt inspection does not initiate filesystem recovery.
  function receiptOperation(fn) {
    const result=queue.then(async()=>{await setup();return fn();});
    queue=result.catch(()=>{});
    return result;
  }
  return {
    snapshot:() => serial(() => snapshot(),{allowInspection:true}),
    collectionSkipConfig:path => receiptOperation(async () => {
      collectionPath(path, await discover());
      return collectionSkipSettings.get(path);
    }),
    saveCollectionSkipConfig:(path,config) => serial(async () => {
      collectionPath(path, await discover());
      collectionSkipSettings.set(path, config);
      return snapshot();
    }),
    saveFilmSkipConfig:(id,config) => serial(async () => {
      const {episode,meta} = await physicalFilm(id);
      if (config === null) delete meta.skipConfig;
      else meta.skipConfig = normalizeSkipConfig(config);
      await writeJson(join(episode,META), meta);
      return snapshot();
    }),
    subtitleTracks:item => receiptOperation(() => readSubtitleBundle(item.absolutePath)),
    saveSubtitleJob:(item,job) => receiptOperation(async () => {
      const path = join(item.episodePath,META);
      if (await realpath(path) !== path) throw problem('影片身份文件已移动。');
      const meta = await json(path);
      if (meta.id !== item.id) throw problem('影片身份已变化。');
      await writeJson(path,{...meta,subtitleJob:job});
    }),
    createCollection:name => serial(async () => {
      if (typeof name !== 'string') throw problem('合集名称无效。',400);
      const parts = name.split('/').map(checkedName);
      const tree = await discover();
      const parent = collectionPath(parts.slice(0,-1).join('/'),tree);
      if (await info(join(parent,parts.at(-1)))) throw problem('同名合集或影片已存在。');
      await mkdir(join(parent,parts.at(-1)));
      return snapshot();
    }),
    renameCollection:(path,name) => serial(async () => {
      if (!path || typeof path !== 'string') throw problem('请选择要改名的合集。',400);
      checkedName(name);
      if (blockedSuffix.test(name)) throw problem('合集名称不能使用临时下载扩展名。',400);
      const tree = await discover();
      const source = collectionPath(path,tree);
      if (basename(source) === name) return snapshot();
      const inside = file => rel(file).startsWith(path + '/');
      for (const episode of tree.episodes) {
        if (inside(episode.dir) && await isBusy(episode.meta.id)) throw problem('合集中有影片正在处理，请稍后再试。');
      }
      const prefix = fold(source + sep);
      if ([...tree.markers].some(marker => marker.startsWith(prefix))) throw problem('合集中有文件正在下载，请稍后再试。');
      for (const file of [...tree.videos, ...tree.subtitles].filter(inside)) {
        if (await writerOpen(file)) throw problem('合集中有文件正在写入，请稍后再试。');
      }
      await transaction([[source,join(dirname(source),name)]], true);
      return snapshot();
    }),
    moveFilms:(ids,collection) => serial(async () => {
      if (!Array.isArray(ids) || !ids.length) throw problem('请选择影片。',400);
      const items = await getItems([...new Set(ids)]);
      const target = collectionPath(collection,await discover());
      await transaction(items.map(item=>[item.episodePath,join(target,item.title)]));
      return snapshot();
    }),
    renameFilm:(id,title) => serial(async () => {
      checkedName(title);
      const [item] = await getItems([id]);
      await transaction([[item.episodePath,join(dirname(item.episodePath),title)]]);
      return snapshot();
    }),
    assignSubtitle:(relativePath,id) => serial(async () => {
      const [item] = await getItems([id]);
      const tree = await discover();
      const path = tree.subtitles.find(file => rel(file) === relativePath);
      if (!path) throw problem('待归属字幕不存在。',404);
      if (!await available(path,tree,false) || await writerOpen(path)) throw problem('字幕文件仍在写入，请稍后再试。');
      await mkdir(item.subtitlesPath,{recursive:true});
          await transaction([[path,join(item.subtitlesPath,basename(path))]]);
      return snapshot();
    }),
    previewCleanup:target => serial(async () => (await cleanup.inspect(target)).summary),
    applyCleanup:(target,selected,revision,id) => serial(()=>cleanup.apply(target,selected,revision,id),{cleanupRecovery:true}),
    dissolveCollection:(path,revision,id) => serial(()=>cleanup.apply({collectionPath:path},{},revision,id,'dissolve'),{cleanupRecovery:true}),
    listCleanupOperations:() => receiptOperation(cleanup.list),
    ackCleanup:id => receiptOperation(()=>cleanup.ack(id)),
    spaceUsage:id => serial(async () => {
      const {episode,video}=await physicalFilm(id);
      return (await inspectFilmSpace(root,episode,video)).summary;
    }),
    releaseSpace:(id,scope,{revision=null}={}) => serial(async () => {
      if (!['package','media'].includes(scope)) throw problem('未知的空间清理范围。',400);
      if (await isBusy(id)) throw problem('影片正在处理中。');
      const {episode,video}=await physicalFilm(id);
      const inspection=await inspectFilmSpace(root,episode,video);
      if (revision!==null && revision!==inspection.summary.revision) throw problem('文件与预览时不同，请刷新后确认。');
      if (await isBusy(id) || (scope==='media' && await writerOpen(join(episode,video)))) throw problem('影片正在写入或处理中。');
      await releaseFilmSpace(root,episode,scope,inspection,transaction);
      return snapshot();
    }),
    relinkFile:(id,filename,readable,{collection='',title=null}={}) => serial(async () => {
      if (!idPattern.test(id)) throw problem('影片 ID 无效。',400);
      return upload(filename,readable,{collection,title,relinkId:id});
    }),
    importFile:(filename,readable,{collection='',mediaId=null}={}) => serial(() => upload(filename,readable,{collection,mediaId}))
  };
}
