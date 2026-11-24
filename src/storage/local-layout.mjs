import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

async function moveExisting(source, target) {
  if (!existsSync(source)) return;
  if (existsSync(target)) throw new Error(`迁移遇到同名资料，请先核对两个位置：${source}、${target}`);
  await mkdir(dirname(target), { recursive: true });
  await rename(source, target);
}

export async function migrateModels(root) {
  const audio = join(root, '模型', '声音描述');
  for (const name of ['audio-model-cache', 'audio-resources', 'audio-model.json']) {
    await moveExisting(join(root, name), join(audio, name));
  }
  const config = join(audio, 'audio-model.json');
  if (existsSync(config)) {
    const value = JSON.parse((await readFile(config, 'utf8')).replace(/^\uFEFF/, ''));
    let changed = false;
    for (const [field, folder] of [['modelPath', 'audio-model-cache'], ['resourcesPath', 'audio-resources']]) {
      if (!value[field] || !isAbsolute(value[field]) || !existsSync(join(audio, folder))) continue;
      const sub = relative(join(root, folder), value[field]);
      if (sub !== '..' && !sub.startsWith('..' + sep) && !isAbsolute(sub)) {
        value[field] = join(folder, sub);
        changed = true;
      }
    }
    if (changed) {
      await writeFile(config + '.moving', JSON.stringify(value, null, 2) + '\n');
      await rename(config + '.moving', config);
    }
  }
  await removeEmptyDirectory(join(root, 'models'));
}

export async function removeEmptyDirectory(path) {
  if (!existsSync(path)) return;
  const entries = await readdir(path);
  if (entries.every(name => name === '.DS_Store')) {
    if (entries.length) await unlink(join(path, '.DS_Store'));
    await rmdir(path).catch(error => { if (error.code !== 'ENOTEMPTY') throw error; });
  }
}

export async function migrateCinemaRecords(root) {
  const name = 'open-watch-cinema.sqlite';
  const old = join(root, name), dir = join(root, '影院记录'), dest = join(dir, name);
  await mkdir(dir, { recursive: true });
  if (!existsSync(old)) return dest;
  if (existsSync(dest)) throw new Error('发现两份影院数据库，请先核对影院记录目录和旧数据根目录。');
  const db = new DatabaseSync(old);
  try {
    // DELETE mode requires other WAL connections to release the old file first.
    const mode = db.prepare('pragma journal_mode = delete').get();
    if (mode.journal_mode !== 'delete') throw new Error('请关闭旧版影院服务再迁移记录。');
    const copy = join(dir, '迁移前备份.sqlite');
    if (!existsSync(copy)) {
      await backup(db, copy + '.partial');
      const check = new DatabaseSync(copy + '.partial', {readOnly: true});
      try {
        if (check.prepare('pragma quick_check').get().quick_check !== 'ok') throw new Error('影院记录备份验证失败。');
      } finally { check.close(); }
      await rename(copy + '.partial', copy);
    }
  } finally { db.close(); }
  await moveExisting(old, dest);
  return dest;
}
