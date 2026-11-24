import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { META, PACKAGE, SUBS, info, json, portable, problem, writeJson } from './library-files.mjs';
import { SIDECAR_EXTENSIONS } from './media-subtitles.mjs';

const marker = '.cinema-cleanup-';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const semanticKeys = ['video','subtitles','package','records','rooms','notebook','folder'];
const changed = () => problem('文件与预览时不同，请刷新后再确认。');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const under = (path,base) => path===base || path.startsWith(base+sep);
const benign = name => ['.DS_Store','Thumbs.db'].includes(name);
const validPart = p => p && p!=='.' && p!=='..' && !p.includes('\\') && !p.includes('\0');
function fromRelative(root,path) {
  if (typeof path!=='string' || !path.split('/').every(validPart)) throw changed();
  const file=resolve(root,path);
  if (!under(file,root) || file===root) throw changed();
  return file;
}
function receiptPath(root,id) {
  if (typeof id!=='string' || !uuid.test(id)) throw problem('清理操作编号无效。',400);
  return join(root,marker+id+'.json');
}
function flags(value) {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!semanticKeys.includes(key) || typeof value[key]!=='boolean')) throw problem('清理范围无效。',400);
  return Object.fromEntries(semanticKeys.map(key=>[key,value[key]===true]));
}
function kind(s) {return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';}
function signature(s) {return {kind:kind(s),dev:String(s.dev),ino:String(s.ino),size:String(s.size),mtime:String(s.mtimeNs)};}
function identity(s,row) {return s && kind(s)===row.kind && String(s.dev)===row.dev && String(s.ino)===row.ino;}
const bytes = () => ({videoBytes:0,subtitleBytes:0,packageBytes:0,videoCount:0,subtitleCount:0,packageCount:0,subtitleFileCount:0,packageFileCount:0});

function subtitleAsset(path,dir) {
  if (dir) return path==='.embedded' || path==='.webvtt';
  if (path==='manifest.json' || path==='.embedded/manifest.json') return true;
  if (path.startsWith('.webvtt/')) return /^\.webvtt\/(?:sidecar-[a-f0-9]{24}-)?[a-f0-9]{64}\.vtt$/i.test(path);
  if (path.startsWith('.embedded/')) return /^\.embedded\/[^/]+\.vtt$/i.test(path);
  return !path.includes('/') && SIDECAR_EXTENSIONS.has(extname(path).toLowerCase());
}
function packageAsset(path,dir,refs) {
  const chunk='chunks/chunk-\\d{4,}';
  if (dir) return path==='chunks' || new RegExp('^'+chunk+'(?:/storyboards)?$').test(path);
  if (path==='manifest.json' || new RegExp('^'+chunk+'/(visual|viewing|dialogue|audio|characters)\\.json$').test(path)) return true;
  if (refs.has(path)) return true;
  return new RegExp('^'+chunk+'/storyboards/(?:chunk-\\d{4,}-\\d{4,}-\\d+|scene-\\d{4,}-\\d+)(?:-part-\\d+)?\\.jpe?g$','i').test(path);
}
function upgradeAsset(path,dir,refs) {
  const tx='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  if (dir) {
    if (new RegExp('^'+tx+'(?:/(?:new(?:/观影包)?|old-package))?$','i').test(path)) return true;
  } else if (new RegExp('^'+tx+'/upgrade\\.json$','i').test(path)) return true;
  const nested=path.match(new RegExp('^'+tx+'/(?:old-package|new/观影包)/(.+)$','i'));
  return nested ? packageAsset(nested[1],dir,refs) : false;
}
async function pictureRefs(pkg) {
  const refs=new Set(),chunks=join(pkg,'chunks');
  if (!(await info(chunks))?.isDirectory()) return refs;
  for (const chunk of await readdir(chunks,{withFileTypes:true})) {
    if (!chunk.isDirectory() || !/^chunk-\d{4,}$/.test(chunk.name)) continue;
    const prefix='chunks/'+chunk.name+'/storyboards/';
    function image(ref) {
      if (typeof ref!=='string') return;
      const path=ref.startsWith('chunks/') ? ref : prefix+ref;
      if (path.startsWith(prefix) && /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpe?g|png|webp)$/i.test(path.slice(prefix.length))) refs.add(path);
    }
    for (const file of ['viewing.json','visual.json']) {
      const path=join(chunks,chunk.name,file);
      if (!(await info(path))?.isFile()) continue;
      try {
        const data=await json(path);
        const frames=file==='viewing.json' ? (data.segments||[]).flatMap(seg=>seg.entries||[]).filter(e=>e.type==='image')
          : (data.observations||[]).map(e=>e.storyboard).filter(Boolean);
        for (const frame of frames) {
          image(frame.storyboardRef || frame.filename);
          for (const part of frame.parts||[]) image(part.ref || part.filename);
          for (const panel of frame.panels||[]) image(panel.ref || panel.filename);
        }
      } catch { /* Unknown asset names in a damaged manifest remain protected. */ }
    }
  }
  return refs;
}
async function upgradePictureRefs(upgradesDir) {
  const refs=new Set();
  if (!(await info(upgradesDir))?.isDirectory()) return refs;
  for (const entry of await readdir(upgradesDir,{withFileTypes:true})) {
    if (!entry.isDirectory() || !uuid.test(entry.name)) continue;
    for (const sub of ['old-package',join('new',PACKAGE)]) {
      for (const ref of await pictureRefs(join(upgradesDir,entry.name,sub))) refs.add(ref);
    }
  }
  return refs;
}

export function createCleanup(rootFn,{discover,isBusy,writersInDirectory,isVideo,move,snapshot,removeCollectionSettings}) {
  async function inspect(target) {
    const root=rootFn();
    if (!target || typeof target!=='object' || Object.keys(target).length!==1) throw problem('清理目标无效。',400);
    const tree=await discover(),byDir=new Map(tree.episodes.map(e=>[e.dir,e]));
    const knownCollections=new Set(tree.collections.map(p=>join(root,p)));
    let base,scope;
    if (Object.hasOwn(target,'mediaId')) {
      if (typeof target.mediaId!=='string' || !/^[a-f0-9]{24}$/.test(target.mediaId)) throw problem('影片 ID 无效。',400);
      const found=tree.episodes.filter(e=>e.meta.id===target.mediaId);
      if (found.length>1) throw problem('多个影片使用相同身份，请先处理重复文件夹。');
      base=found[0]?.dir;scope='film';
    } else if (typeof target.collectionPath==='string') {
      base=fromRelative(root,target.collectionPath);
      if (!knownCollections.has(base)) throw problem('合集不存在。',404);
      scope='collection';
    } else throw problem('清理目标无效。',400);
    const records=[],films=[],unknownPaths=[],directMembers=[],moveConflicts=[];
    let busy=false,collectionCount=0;
    async function visit(path,category,film=null,asset=null,refs=null,ownerBucket=null) {
      const s=await lstat(path,{bigint:true}),dir=s.isDirectory(),name=basename(path);
      const row={path:portable(root,path),category,...signature(s)};
      if (ownerBucket) row.ownerBucket=ownerBucket;
      if (s.isSymbolicLink() || (!s.isFile() && !dir)) row.category='unknown';
      if (dir && await realpath(path)!==path) throw changed();
      if (category==='collection' || category==='episode') {
        if (!dir) row.category='unknown';
      } else if (category==='metadata' && !s.isFile()) row.category='unknown';
      if (row.category==='unknown') unknownPaths.push(row.path);
      records.push(row);
      if (row.category==='episode') {
        const ep=byDir.get(path),v=ep.meta.video;
        if (basename(v || '')!==v || typeof v!=='string' || !isVideo(v)) throw problem('影片身份记录缺少有效视频名称。');
        if (tree.episodes.some(e=>e.dir!==path && e.meta.id===ep.meta.id)) throw problem('多个影片使用相同身份，请先处理重复文件夹。');
        film={id:ep.meta.id,title:name,relativePath:portable(root,join(path,v)),hasVideo:false,...bytes()};
        films.push(film);
        if (await isBusy(film.id)) busy=true;
      }
      if (row.category==='collection') collectionCount++;
      if (film && row.category==='video' && s.isFile()) {
        film.hasVideo=true;film.videoCount++;film.videoBytes+=Number(s.size);
      }
      if (film && ['subtitles','package'].includes(row.category)) {
        const key=row.category==='subtitles'?'subtitle':'package';
        if (s.isFile()) {
          film[key+'Bytes']+=Number(s.size);film[key+'FileCount']++;
          if (key==='subtitle' && !asset.includes('/.webvtt/') && !asset.startsWith('.webvtt/') && SIDECAR_EXTENSIONS.has(extname(asset).toLowerCase())) film.subtitleCount++;
        } else if (key==='package' && asset==='') film.packageCount++;
      }
      if (!dir || row.category==='unknown') return;
      const children=(await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'));
      for (const child of children) {
        const file=join(path,child.name),d=child.isDirectory();
        let next='unknown',sub=null,allowed=refs;
        if (benign(child.name) && child.isFile()) next='system';
        else if (row.category==='collection') {
          if (byDir.has(file)) next='episode';
          else if (knownCollections.has(file)) next='collection';
        } else if (row.category==='episode') {
          if (child.name===META && child.isFile()) next='metadata';
          else if (file===join(root,film.relativePath) && child.isFile()) next='video';
          else if (child.name===SUBS && d) {next='subtitles';sub='';}
          else if (child.name===PACKAGE && d) {next='package';sub='';allowed=await pictureRefs(file);}
          else if (child.name==='.upgrades' && d) {next='package';sub='.upgrades';allowed=await upgradePictureRefs(file);}
        } else if (row.category==='subtitles' || row.category==='package') {
          if (row.category==='package' && (asset==='.upgrades' || asset?.startsWith('.upgrades/'))) {
            const rel=asset==='.upgrades' ? child.name : asset.slice('.upgrades/'.length)+'/'+child.name;
            sub='.upgrades/'+rel;
            if (upgradeAsset(rel,d,refs)) next='package';
          } else {
            sub=asset ? asset+'/'+child.name : child.name;
            if (row.category==='subtitles' ? subtitleAsset(sub,d) : packageAsset(sub,d,refs)) next=row.category;
          }
        }
        if (/\.(?:part|crdownload|aria2|!qb|download|partial|tmp)$/i.test(child.name) || child.name==='.run-lock') busy=true;
        if (path===base && scope==='collection' && ['episode','collection'].includes(next)) directMembers.push(portable(root,file));
        await visit(file,next,film,sub,allowed,next==='system' && ['package','subtitles'].includes(row.category) ? row.category : null);
      }
    }
    if (base) {
      await visit(base,scope==='film'?'episode':'collection');
      if (!busy && await writersInDirectory(base)) busy=true;
      if (scope==='collection') for (const member of directMembers) {
        const dest=join(dirname(base),basename(member));
        if (await info(dest)) moveConflicts.push(portable(root,dest));
      }
    }
    const totals=bytes();
    for (const film of films) for (const key of Object.keys(totals)) totals[key]+=film[key];
    const summary={...totals,films,mediaIds:films.map(f=>f.id),filmCount:films.length,collectionCount,folderCount:collectionCount+films.length,
      unknownPaths,busy,moveConflicts,canDissolve:scope==='collection' && !busy && !moveConflicts.length && !unknownPaths.length,
      revision:hash([target,records,moveConflicts])};
    return {base,records,summary,directMembers};
  }
  function validateReceipt(root,data) {
    receiptPath(root,data.id);
    if (data.version!==1 || typeof data.digest!=='string' || typeof data.complete!=='boolean') throw changed();
    if (data.complete) return;
    const base=fromRelative(root,data.base);
    if (!Array.isArray(data.files) || !Array.isArray(data.dirs) || !Array.isArray(data.moves)) throw changed();
    for (const row of [...data.files,...data.dirs,...data.moves]) {
      if (!under(fromRelative(root,row.path),base)) throw changed();
    }
    for (const row of data.moves) if (dirname(fromRelative(root,row.path))!==base) throw changed();
  }
  async function status(root,row) {
    const path=fromRelative(root,row.path);
    const s=await lstat(path,{bigint:true}).catch(error=>{if (error.code!=='ENOENT') throw error;return null;});
    if (!s) return null;
    if (await realpath(dirname(path))!==dirname(path) || !identity(s,row) || (row.kind==='file' && (String(s.size)!==row.size || String(s.mtimeNs)!==row.mtime))) throw changed();
    return path;
  }
  async function finish(root,data) {
    validateReceipt(root,data);
    if (data.complete) return;
    const base=fromRelative(root,data.base);
    const pairs=[];
    for (const row of data.moves) {
      const path=await status(root,row);
      const destination=join(dirname(base),basename(row.path));
      if (path) pairs.push([path,destination]);
      else if (!identity(await lstat(destination,{bigint:true}).catch(()=>null),row)) throw changed();
    }
    // A newly arrived poster in a directory selected for removal blocks the entire
    // operation before any remaining approved assets are touched, including on replay.
    const children=new Map();
    for (const row of [...data.files,...data.dirs,...data.moves]) {
      const parent=dirname(row.path);
      if (!children.has(parent)) children.set(parent,new Set());
      children.get(parent).add(basename(row.path));
    }
    for (const row of data.dirs.filter(dir=>!dir.optional)) {
      const dir=await status(root,row);
      if (dir && (await readdir(dir)).some(name=>!children.get(row.path)?.has(name))) throw changed();
    }
    // Check all remaining file identities before removing anything else on a retry.
    for (const row of data.files) await status(root,row);
    if (pairs.length) await move(pairs, true);
    for (const row of data.files) {
      const path=await status(root,row);
      if (path) await unlink(path);
    }
    for (const row of data.dirs) {
      const path=await status(root,row);
      if (!path) continue;
      try { await rmdir(path); }
      catch(error) { if (!row.optional || !['ENOTEMPTY','EEXIST'].includes(error.code)) throw error; }
    }
    if (data.removeCollection) removeCollectionSettings?.(data.base, data.removeCollection === 'tree');
    await writeJson(receiptPath(root,data.id),{version:1,id:data.id,complete:true,digest:data.digest});
  }
  async function list() {
    const root=rootFn(),out=[];
    for (const e of await readdir(root,{withFileTypes:true})) {
      if (!e.isFile() || !e.name.startsWith(marker) || !e.name.endsWith('.json')) continue;
      const id=e.name.slice(marker.length,-5);
      if (!uuid.test(id)) continue;
      const data=await json(receiptPath(root,id));
      if (data.id!==id) throw changed();
      validateReceipt(root,data);out.push({id,complete:data.complete});
    }
    return out;
  }
  async function ack(id) {
    const path=receiptPath(rootFn(),id),file=await info(path);
    if (!file) return;
    if (!file.isFile()) throw changed();
    const data=await json(path);
    if (data.id!==id || data.complete!==true) throw problem('文件清理仍未完成。');
    await unlink(path);
  }
  async function apply(target,input,revision,id,action='cleanup') {
    const root=rootFn(),selected=flags(input),autoAck=id==null;
    if (action==='cleanup' && !Object.values(selected).some(Boolean)) throw problem('请先选择清理项目。',400);
    if (typeof revision!=='string' || !revision) throw problem('需要先预览清理范围。',400);
    id??=randomUUID();
    const path=receiptPath(root,id),digest=hash([target,action,selected,revision]);
    const existing=await info(path);
    if (existing) {
      if (!existing.isFile()) throw changed();
      const receipt=await json(path);
      if (receipt.id!==id || receipt.digest!==digest) throw problem('操作编号与之前的清理请求不一致。');
      if (!receipt.complete) {
        const base=fromRelative(root,receipt.base);
        if ((await info(base))?.isDirectory() && await writersInDirectory(base)) throw problem('文件正在写入，请稍后再恢复清理。');
        for (const mediaId of receipt.mediaIds || []) if (await isBusy(mediaId)) throw problem('影片正在使用，请稍后再恢复清理。');
      }
      await finish(root,receipt);
    } else {
      if ((await list()).some(receipt=>!receipt.complete)) throw problem('另一次文件清理等待恢复。');
      const {base,summary,records,directMembers}=await inspect(target);
      if (summary.revision!==revision) throw changed();
      if (summary.busy) throw problem('影片、合集或下载正在使用，请稍后重试。');
      if (action==='dissolve' && !summary.canDissolve) throw problem('合集含有未识别文件或上一级存在同名项目。');
      if (selected.folder && (summary.unknownPaths.length || records.some(row=>['video','subtitles','package'].includes(row.category) && !selected[row.category] && row.kind==='file'))) throw problem('文件夹内仍有要保留或未识别的文件。');
      const selection=records.filter(row=>{
        if (action==='dissolve') return row.category==='system' && dirname(fromRelative(root,row.path))===base;
        return selected[row.category] || (row.ownerBucket && selected[row.ownerBucket]) || (selected.folder && ['system','metadata'].includes(row.category));
      });
      const files=selection.filter(row=>row.kind==='file');
      const dirs=records.filter(row=>row.kind==='dir' && (action==='dissolve' ? fromRelative(root,row.path)===base : selected.folder || selected[row.category]))
        .sort((a,b)=>b.path.split('/').length-a.path.split('/').length).map(row=>({...row,optional:!selected.folder && action!=='dissolve'}));
      const moves=action==='dissolve' ? records.filter(row=>directMembers.includes(row.path)) : [];
      if (base) {
        const receipt={version:1,id,complete:false,digest,base:portable(root,base),mediaIds:summary.mediaIds,files,dirs,moves,
          ...(target.collectionPath && (selected.folder || action==='dissolve')
            ? {removeCollection: selected.folder ? 'tree' : 'single'} : {})};
        await writeJson(path,receipt);
        await finish(root,receipt);
      } else await writeJson(path,{version:1,id,complete:true,digest});
    }
    if (autoAck) await ack(id);
    return snapshot();
  }
  return {inspect,apply,list,ack};
}
