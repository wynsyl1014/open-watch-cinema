import { normalizeSkipConfig } from '../media/skip-ranges.mjs';

export function createCollectionSkipSettings(db) {
  db.exec(`create table if not exists collection_skip_settings (
    path text primary key,
    config text not null
  )`);
  return {
    get(path) {
      const row = db.prepare('select config from collection_skip_settings where path = ?').get(path);
      return row ? JSON.parse(row.config) : null;
    },
    set(path, config) {
      if (config === null) {
        db.prepare('delete from collection_skip_settings where path = ?').run(path);
      } else {
        db.prepare(`insert into collection_skip_settings(path, config) values (?, ?)
          on conflict(path) do update set config = excluded.config`).run(path, JSON.stringify(normalizeSkipConfig(config)));
      }
    },
    move(from, to) {
      db.prepare(`update or replace collection_skip_settings set path = ? || substr(path, length(?) + 1)
        where path = ? or substr(path, 1, length(?) + 1) = ? || '/'`).run(to, from, from, from, from);
    },
    remove(path, descendants) {
      db.prepare(`delete from collection_skip_settings
        where path = ? or (? and substr(path, 1, length(?) + 1) = ? || '/')`)
        .run(path, Number(descendants), path, path);
    }
  };
}
