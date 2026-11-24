import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { info, json, META, PACKAGE, problem, SUBS, writeJson } from './library-files.mjs';

const releaseName = /^\.cinema-release-[a-f0-9-]{36}$/;
const receiptName = '.release.json';
const changed = () => problem('影片文件已发生变化，请刷新空间预览后重试。');

function identity(file) {
  return {dev:String(file.dev),ino:String(file.ino)};
}
function sameIdentity(file, known) {
  return String(file.dev) === known.dev && String(file.ino) === known.ino;
}
function relativeInside(path) {
  return typeof path === 'string' && path && !isAbsolute(path) && path.split(/[\\/]/u).every(p=>p && p!=='.' && p!=='..');
}
async function inspectTree(path, name, entries) {
  const file = await lstat(path,{bigint:true});
  const kind = file.isFile() ? 'file' : file.isDirectory() ? 'directory' : file.isSymbolicLink() ? 'link' : 'special';
  if (kind === 'special') throw problem('资料目录中含有不支持的特殊文件。');
  entries.push({name,kind,...identity(file),size:String(file.size),mtimeNs:String(file.mtimeNs)});
  if (kind === 'directory') {
    for (const child of (await readdir(path)).sort()) await inspectTree(join(path,child),name+'/'+child,entries);
  }
}
export async function inspectFilmSpace(root, episode, video) {
  if (await realpath(episode) !== episode) throw changed();
  const groups = {video:[],subtitles:[],package:[],metadata:[]};
  for (const [group,name] of [['video',video],['subtitles',SUBS],['package',PACKAGE],['metadata',META]]) {
    const path = join(episode,name);
    const file = await info(path);
    if (!file && (group === 'subtitles' || group === 'package')) continue;
    if (!file || (group==='video' || group==='metadata' ? !file.isFile() : !file.isDirectory())) throw changed();
    await inspectTree(path,name,groups[group]);
  }
  const bytes = entries => entries.reduce((n,row)=> n+(row.kind==='file' ? Number(row.size) : 0),0);
  const episodeRelative = relative(root,episode);
  const revision = createHash('sha256').update(JSON.stringify([episodeRelative,groups])).digest('hex');
  return {groups,summary:{videoBytes:bytes(groups.video),subtitleBytes:bytes(groups.subtitles),packageBytes:bytes(groups.package),revision}};
}
async function assertSource(entry, path, {recovery=false}={}) {
  const file = await lstat(path,{bigint:true}).catch(error=>{
    if (error.code==='ENOENT' && recovery) return null;
    throw error;
  });
  if (!file) return false;
  if (!sameIdentity(file,entry)) throw changed();
  const validType = entry.kind==='directory' ? file.isDirectory() : entry.kind==='file' ? file.isFile() : file.isSymbolicLink();
  if (!validType || (entry.kind!=='directory' && (String(file.size)!==entry.size || String(file.mtimeNs)!==entry.mtimeNs))) throw changed();
  return true;
}
async function finishRelease(root, staging, receipt) {
  if (receipt.kind!=='cinema-space-release' || receipt.version!==1 || !relativeInside(receipt.episode)
      || !['media','package'].includes(receipt.scope) || !Array.isArray(receipt.entries) || !receipt.entries.length
      || await realpath(staging)!==staging) throw problem('空间清理记录无效，已保留文件。');
  const expected = new Set(receipt.entries.map(entry=>entry.name));
  for (const entry of receipt.entries) {
    if (!relativeInside(entry.name) || entry.name.startsWith(receiptName) || !['directory','file','link'].includes(entry.kind)) throw changed();
    // A replaced intermediate directory must never redirect a recovery operation.
    const parentName = entry.name.slice(0,entry.name.lastIndexOf('/'));
    if (entry.name.includes('/') && !expected.has(parentName)) throw changed();
    await assertSource(entry,join(staging,entry.name),{recovery:true});
    if (entry.kind==='directory' && await info(join(staging,entry.name))) {
      const current = await readdir(join(staging,entry.name));
      if (current.some(child=>!expected.has(entry.name+'/'+child))) throw changed();
    }
  }
  // Children precede parents on removal. Missing entries were freed by a previous attempt.
  for (const entry of receipt.entries.toReversed()) {
    const path = join(staging,entry.name);
    if (!await assertSource(entry,path,{recovery:true})) continue;
    if (await realpath(dirname(path))!==dirname(path)) throw changed();
    if (entry.kind==='directory') await rmdir(path);
    else await unlink(path);
  }
  if (receipt.scope==='media') {
    const episode = join(root,receipt.episode);
    const file = await info(episode);
    if (file?.isDirectory() && sameIdentity(file,receipt.directory) && await realpath(episode)===episode) {
      await rmdir(episode).catch(error=>{ if (!['ENOTEMPTY','EEXIST'].includes(error.code)) throw error; });
    }
  }
  await unlink(join(staging,receiptName));
  await rmdir(staging);
}
export async function recoverReleases(root) {
  for (const entry of await readdir(root,{withFileTypes:true})) {
    if (!entry.isDirectory() || !releaseName.test(entry.name)) continue;
    const staging=join(root,entry.name);
    const receipt=join(staging,receiptName);
    const marker=await info(receipt);
    if (!marker) {
      if (!(await readdir(staging)).length) await rmdir(staging);
      continue;
    }
    if (!marker.isFile()) throw changed();
    await finishRelease(root,staging,await json(receipt));
  }
}
export async function releaseFilmSpace(root, episode, scope, inspection, move) {
  const {groups}=inspection;
  const entries = scope==='package' ? groups.package : [...groups.package,...groups.subtitles,...groups.video,...groups.metadata];
  if (!entries.length) return;
  const staging=join(root,'.cinema-release-'+randomUUID());
  await mkdir(staging,{mode:0o700});
  const receipt={kind:'cinema-space-release',version:1,scope,episode:relative(root,episode),
    directory:identity(await lstat(episode,{bigint:true})),entries};
  await writeJson(join(staging,receiptName),receipt);
  for (const entry of entries) await assertSource(entry,join(episode,entry.name));
  const roots=entries.filter(entry=>!entry.name.includes('/'));
  await move(roots.map(entry=>[join(episode,entry.name),join(staging,entry.name)]));
  await finishRelease(root,staging,receipt);
}
