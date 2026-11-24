import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { listIndexedMedia, openDatabase, syncMediaIndex } from '../../src/storage/database.mjs';

test('SQLite media index creates, updates, and hides missing entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-watch-cinema-db-'));
  const databasePath = join(root, 'cinema.sqlite');
  const db = openDatabase(databasePath);

  try {
    syncMediaIndex(db, [
      {
        id: 'a'.repeat(24),
        title: 'First Film',
        relativePath: 'First Film.mp4',
        extension: '.mp4',
        size: 123,
        modifiedAt: '2026-08-05T00:00:00.000Z'
      }
    ]);

    assert.equal(listIndexedMedia(db).length, 1);

    syncMediaIndex(db, []);
    assert.deepEqual(listIndexedMedia(db), []);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a legacy SQLite catalogue preserves films and preparation history when a pathname is reused',async t => {
  const {DatabaseSync} = await import('node:sqlite');
  const dir = await mkdtemp(join(tmpdir(),'cinema-index-paths-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'cinema.sqlite');
  const old=new DatabaseSync(path);
  old.exec(`create table media (id text primary key, title text not null,
    relative_path text not null unique, extension text not null, byte_size integer not null,
    modified_at text not null, present integer not null default 1, scanned_at text not null,
    compatibility_status text not null default 'unchecked');
    insert into media values ('a','A','Film.mp4','.mp4',1,'old',1,'old','ready')`);
  old.close();
  const db=openDatabase(path);
  t.after(()=>db.close());
  const A={id:'a',title:'A',relativePath:'Film.mp4',extension:'.mp4',size:1,modifiedAt:'old'};
  const B={...A,id:'b',title:'B'};
  syncMediaIndex(db,[B]);
  assert.equal(db.prepare("select compatibility_status from media where id='a'").get().compatibility_status,'ready');
  assert.equal(db.prepare("select present from media where id='a'").get().present,0);
  syncMediaIndex(db,[B,{...A,relativePath:'A/A.mp4'}]);
  syncMediaIndex(db,[{...A,relativePath:'Film.mp4'},{...B,relativePath:'A/A.mp4'}]);
  assert.equal(listIndexedMedia(db).find(row=>row.id==='a').compatibilityStatus,'ready');
  assert.throws(()=>syncMediaIndex(db,[A,B]),/UNIQUE/);
  assert.equal(listIndexedMedia(db).length,2);
});
