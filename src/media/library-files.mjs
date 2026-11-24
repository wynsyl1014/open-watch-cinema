import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath, rename, rm, writeFile, link, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const META = '.cinema.json';
export const SUBS = '字幕';
export const PACKAGE = '观影包';
export const JOURNAL = '.cinema-moves.json';

export function problem(message, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode, status: statusCode });
}
export function checkedName(name) {
  if (typeof name !== 'string' || !name.trim() || /^[.]/u.test(name) || /[ .]$/u.test(name)
      || /[<>:"/\\|?*\x00-\x1f]/u.test(name) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(name)
      || [SUBS, PACKAGE].includes(name) || /\.owc-(subtitles|processing.*|backup.*)$/iu.test(name)) {
    throw problem('名称包含保留字符或与影院目录重名。', 400);
  }
  return name;
}
export const portable = (root, file) => relative(root, file).split(sep).join('/');
export async function info(file) {
  try { return await lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export async function json(file) { return JSON.parse(await readFile(file, 'utf8')); }
export async function writeJson(file, value) {
  const tmp = join(dirname(file), '.cinema-write-' + randomUUID());
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', flush: true });
    await rename(tmp, file);
  } finally { await rm(tmp, { force: true }); }
}
function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}
async function checkParent(roots, path) {
  const parent = await realpath(dirname(path));
  if (!roots.some(root => inside(root, parent)) || parent !== dirname(resolve(path))) {
    throw problem('文件路径超出片库或包含符号链接。');
  }
}
function same(entry, identity) { return entry && String(entry.dev) === identity.dev && String(entry.ino) === identity.ino; }

// Each action records its original file identity. A restart can distinguish an already
// completed move from a different file subsequently placed at the destination.
export async function moveTransaction(root, legacyRoot, pairs, { collections = false, onCollectionsMoved } = {}) {
  if (!pairs.length) return;
  const actions = [];
  const targets = new Set();
  const roots = [root, legacyRoot].filter(Boolean);
  for (const [from, to] of pairs) {
    if (from === to) continue;
    const targetKey = to.normalize('NFC').toLowerCase();
    const source = await lstat(from, { bigint: true });
    const dest = await lstat(to,{bigint:true}).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    let spellingOnly = false;
    if (dest && dirname(from) === dirname(to) && from.normalize('NFC').toLowerCase() === targetKey
        && dest.dev === source.dev && dest.ino === source.ino) {
      const names = await readdir(dirname(from));
      spellingOnly = names.includes(basename(from)) && !names.includes(basename(to));
    }
    if (targets.has(targetKey) || (dest && !spellingOnly)) throw problem('目标位置已有同名文件：' + basename(to));
    targets.add(targetKey);
    await checkParent(roots, from);
    if (!source.isFile() && !source.isDirectory()) throw problem('只支持普通文件和文件夹。');
    actions.push({from, to, spellingOnly, dev: String(source.dev), ino: String(source.ino)});
  }
  if (!actions.length) return;
  const journalPath = join(root, JOURNAL);
  if (await info(journalPath)) throw problem('上一次文件移动仍待恢复。');
  await writeJson(journalPath, {version:1, actions, ...(collections && { collections })});
  await recoverMoves(root, legacyRoot, onCollectionsMoved);
}
export async function recoverMoves(root, legacyRoot, onCollectionsMoved) {
  const journalPath = join(root, JOURNAL);
  if (!await info(journalPath)) return;
  const roots = [root, legacyRoot].filter(Boolean);
  const {version, actions, collections} = await json(journalPath);
  if (version !== 1 || !Array.isArray(actions)) throw problem('片库移动记录无效。');
  for (const {from, to, ...identity} of actions) {
    if (!roots.some(path => inside(path, from)) || !inside(root, to)) throw problem('片库移动记录含无效路径。');
    const target = await lstat(to, {bigint:true}).catch(e => { if(e.code !== 'ENOENT') throw e; return null; });
    const source = await lstat(from, {bigint:true}).catch(e => { if(e.code !== 'ENOENT') throw e; return null; });
    if (identity.spellingOnly && same(source,identity) && same(target,identity)) {
      await checkParent(roots, from);
      const names = await readdir(dirname(from));
      if (!names.includes(basename(to))) await rename(from,to);
      continue;
    }
    if (same(target, identity)) {
      if (source?.isFile() && same(source, identity)) {
        await checkParent(roots, from);
        await checkParent(roots, to);
        await unlink(from);
      }
      continue;
    }
    if (target || !same(source, identity)) throw problem('移动发生冲突，已保留文件：' + basename(to));
    await checkParent(roots, from);
    await checkParent(roots, to);
    if (source.isFile()) { await link(from, to); await unlink(from); }
    else if (source.isDirectory()) await rename(from, to);
    else throw problem('移动源类型无效。');
  }
  if (collections) onCollectionsMoved?.(actions);
  await unlink(journalPath);
}
