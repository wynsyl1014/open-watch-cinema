import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../../src/storage/database.mjs';
import { formatNotebook, parseNotebookText } from '../../src/storage/notebook-text.mjs';
import { setParticipantName } from '../../src/storage/participants.mjs';
import { initializeNotebook, readNotebook, writeNotebook, writeNotebookBatch, readNotebookChanges } from '../../src/storage/notebook.mjs';

test('film notebook persists across rewinds and rooms, and latest revisions stay current', () => {
  const db = openDatabase(':memory:'); initializeNotebook(db);
  try {
    const room = { id: 'room-one', mediaId: 'film-one', status: 'active', lastPositionMs: 10000 };
    const saved = writeNotebook(db, room, { text: 'first', eventAtMs: 9000 });
    assert.equal(readNotebook(db, room.mediaId, 0).entries[0].text, 'first');
    const otherRoom = { ...room, id: 'room-two', lastPositionMs: 0 };
    const updated = writeNotebook(db, otherRoom, { id: saved.id, expectedVersion: saved.version, text: 'updated' });
    assert.equal(updated.eventAtMs, 9000);
    assert.equal(readNotebook(db, room.mediaId, 0).entries[0].text, 'updated');
    assert.equal(readNotebook(db, room.mediaId, 20000).entries[0].text, 'updated');
    assert.equal(readNotebook(db, 'other-film', 20000).entries.length, 0);
    writeNotebook(db, otherRoom, { action: 'delete', id: saved.id, expectedVersion: updated.version });
    assert.equal(readNotebook(db, room.mediaId, 0).entries.length, 0);
    assert.equal(db.prepare('select count(*) as count from notebook_revisions').get().count, 3);
  } finally { db.close(); }
});

test('character edits survive rewind while preserving name, text and appearance', () => {
  const db = openDatabase(':memory:'); initializeNotebook(db);
  try {
    const room = { id: 'room-one', mediaId: 'film-one', status: 'active', lastPositionMs: 10000 };
    const saved = writeNotebook(db, room, { kind: 'character', name: 'A', text: 'initial', appearance: '白发蓝眼' });
    const rewind = { ...room, lastPositionMs: 0 };
    const updated = writeNotebook(db, rewind, { id: saved.id, expectedVersion: saved.version, text: 'revised' });
    assert.equal(updated.text, 'revised');
    assert.equal(updated.appearance, '白发蓝眼');
    assert.equal(readNotebook(db, room.mediaId, 0).entries[0].name, 'A');
  } finally { db.close(); }
});

test('batch notebook text supports character appearance creation, read formatting and revision', () => {
  const db = openDatabase(':memory:'); initializeNotebook(db);
  try {
    const room = { id: 'room-app', mediaId: 'film-app', status: 'active', lastPositionMs: 5000 };
    const ai = { kind: 'ai', id: 'ai-1' };
    const created = writeNotebookBatch(db, room, {
      requestId: 'req-app-1',
      text: '[人物]\n@阿遥 | 刚上岛的旅人 | 短黑发，戴灰围巾'
    }, ai);
    assert.equal(created.entries[0].appearance, '短黑发，戴灰围巾');
    const formatted = formatNotebook(readNotebook(db, room.mediaId, 5000).entries);
    assert.match(formatted, /@阿遥 \| 刚上岛的旅人/);
    assert.match(formatted, /外貌 \| 短黑发，戴灰围巾/);
    const ref = '#' + created.entries[0].id.slice(0, 8) + '/v' + created.entries[0].version;
    const edited = writeNotebookBatch(db, room, {
      requestId: 'req-app-2',
      text: `[修订]\n${ref} | 外貌 | 换上了深蓝大衣`
    }, ai);
    assert.equal(edited.entries[0].appearance, '换上了深蓝大衣');
    assert.equal(edited.entries[0].text, '刚上岛的旅人');
  } finally { db.close(); }
});

function film(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  initializeNotebook(db);
  return { db, room: { id:'room-a', mediaId:'film', status:'active', lastPositionMs:22000 },
    ai: {kind:'ai',id:'stable-ai'}, viewer:{kind:'user',id:'viewer'} };
}

test('a text batch resolves forward names, escapes, time, filters, and a versioned answer', t => {
  const {db,room,ai} = film(t);
  const text = '[关系]\n@一 -> @二 | 信任 | 推测\n[人物]\n@二 | 出场。\n@一\n[剧情]\n{0:03} @一 @二 | 刚刚见面。\n[疑问]\n信里写了什么？ | 只看到了信封。\n[随记]\n灯光 \\| 影子。';
  const create = () => writeNotebookBatch(db,room,{text,requestId:'first'},ai);
  const first = create();
  assert.equal(first.entries.length,6);
  const [edge,second,one,event,question,jot] = first.entries;
  assert.deepEqual(edge.characterIds,[one.id,second.id]);
  assert.equal(edge.uncertain,true);
  assert.equal(edge.direction,'forward');
  assert.equal(event.eventAtMs,3000);
  assert.equal(jot.text,'灯光 | 影子。');
  const replay = create();
  assert.equal(replay.replayed,true);
  assert.deepEqual(replay.entries,first.entries);
  assert.throws(() => writeNotebookBatch(db,room,{text:'[随记]\n另一次',requestId:'first'},ai),/different text/);
  assert.equal(db.prepare('select count(*) n from notebook_revisions').get().n,6);
  assert.match(formatNotebook(first.entries,{character:'@一',section:'relations'}),/@一 -> @二 \| 信任 \| 推测/);
  assert.match(formatNotebook(first.entries,{fromMs:2000,toMs:4000}),/刚刚见面/);
  assert.match(formatNotebook(first.entries,{unresolved:true}),/信里/);
  const answerText = '[解答]\n{0:18} #' + question.id.slice(0,8) + '/v' + question.version + ' | 是一张地图。';
  const answered = writeNotebookBatch(db,room,{text:answerText,requestId:'answer'},ai).entries[0];
  assert.equal(answered.answerAtMs,18000);
  assert.match(formatNotebook([answered]),/解答 · 0:18 \| 是一张地图/);
  assert.match(formatNotebook([answered],{unresolved:true}),/没有笔记/);
});

test('same-field conflicts and unrelated-field merges preserve authors, time, draft base and atomicity', t => {
  const {db,room,ai,viewer} = film(t);
  setParticipantName(db,ai,'Elias');
  setParticipantName(db,viewer,'鹿鹿');
  const seed = writeNotebook(db,room,{kind:'character',name:'旅人',text:'AI 的原文'},ai);
  const aiEdit = writeNotebook(db,room,{id:seed.id,expectedVersion:seed.version,text:'AI 更新'},ai);
  const human = writeNotebook(db,room,{id:seed.id,expectedVersion:seed.version,name:'小明'},viewer);
  assert.equal(human.name,'小明');
  assert.equal(human.text,'AI 更新');
  assert.deepEqual(human.author,{kind:'ai',id:'stable-ai',name:'Elias'});
  assert.equal(human.fieldAuthors.name.name,'鹿鹿');
  assert.equal(human.fieldAuthors.text.name,'Elias');
  assert.throws(()=>writeNotebook(db,room,{id:seed.id,expectedVersion:seed.version,text:'我的修改'},viewer),
    error=>error.code==='NOTEBOOK_VERSION_CONFLICT' && error.fields.includes('text') && error.current.version===human.version);
  const badBatch = '[随记]\n第一行可用\n[修订]\n#'+seed.id.slice(0,8)+'/v'+aiEdit.version+' | 名字 | 另一个人';
  assert.throws(()=>writeNotebookBatch(db,room,{requestId:'rollback',text:badBatch},ai),
    error=>error.line===4 && error.fields.includes('name'));
  assert.equal(readNotebook(db,room.mediaId,0).entries.length,1);
  const legacyForm = writeNotebook(db,room,{id:seed.id,expectedVersion:seed.version,name:'旅人',text:'AI 的原文'},viewer);
  assert.equal(legacyForm.version,human.version);
  assert.equal(readNotebookChanges(db,room.id,0,1).events.length,1);
});

test('stored references follow participant renames; edits are room-scoped and independently pageable', t=>{
  const {db,room,ai,viewer} = film(t);
  setParticipantName(db,ai,'Elias');
  setParticipantName(db,viewer,'鹿鹿');
  const first=writeNotebook(db,room,{text:'Elias 原文'},ai);
  const second=writeNotebook(db,room,{id:first.id,expectedVersion:first.version,text:'Elias 修正一'},viewer);
  writeNotebook(db,room,{id:first.id,expectedVersion:second.version,text:'Elias 修正二'},viewer);
  const before=readNotebookChanges(db,room.id,0,1);
  assert.equal(before.hasMore,true);
  assert.match(before.events[0].content,/鹿鹿 修改了 Elias 的观影小本本/);
  const next=readNotebookChanges(db,room.id,before.events[0].id,1);
  assert.equal(next.hasMore,false);
  assert.equal(next.events.length,1);
  assert.ok(next.events[0].id>before.events[0].id);
  setParticipantName(db,ai,'新名字');
  setParticipantName(db,viewer,'');
  const after=readNotebookChanges(db,room.id,0).events[0];
  assert.match(after.content,/user 修改了 新名字 的观影小本本/);
  assert.equal(readNotebookChanges(db,'room-b',0).events.length,0);
  const view=readNotebook(db,room.mediaId,0).entries;
  assert.equal(view[0].text,'Elias 修正二');
  assert.match(formatNotebook(view),/新名字；修订 user/);
  const stored=db.prepare('select payload_json from notebook_revisions where version=?').get(second.version);
  const payload=JSON.parse(stored.payload_json);
  assert.deepEqual(payload.author,ai);
  assert.deepEqual(payload.lastEditor,viewer);
});

test('text rejects ambiguous names, missing revisions and future timestamps without partial writes', t=>{
  const {db,room,ai}=film(t);
  const batch=(text,id)=>writeNotebookBatch(db,room,{text,requestId:id},ai);
  batch('[人物]\n@相同\n@相同','names');
  assert.throws(()=>batch('[关系]\n@相同 -> @第三位 | 同学','ambiguous'),/第 2 行.*歧义/);
  assert.throws(()=>batch('[随记]\n{0:55} 未来的事','future'),/eventAtMs/);
  assert.throws(()=>parseNotebookText('[解答]\n#12345678 | 没有版本'),/第 2 行/);
  assert.throws(()=>parseNotebookText('[陌生段名]\nX'),/第 1 行/);
  assert.throws(()=>parseNotebookText('[随记]\n'+'X\n'.repeat(101)),/100/);
  assert.equal(readNotebook(db,room.mediaId,0).entries.length,2);
});

test('reads legacy snapshots, keeps author unknown and permits editing after linked people are removed', t => {
  const {db,room,viewer} = film(t);
  const person = writeNotebook(db,room,{kind:'character',name:'旧名字'});
  const legacyId = 'aabbccdd-0000-4000-8000-000000000001';
  const saved = db.prepare(`insert into notebook_revisions
    (media_id,entry_id,source_room_id,known_at_ms,deleted,payload_json,created_at) values(?,?,?,?,0,?,?)`)
    .run(room.mediaId,legacyId,room.id,7200,JSON.stringify({kind:'note',text:'旧正文',
      characterIds:[person.id],eventAtMs:4700}),new Date().toISOString());
  writeNotebook(db,room,{action:'delete',id:person.id,expectedVersion:person.version});
  const before = readNotebook(db,room.mediaId,0).entries[0];
  assert.equal(before.section,'timeline');
  assert.deepEqual(before.characterIds,[]);
  assert.equal(before.author,null);
  const edit = writeNotebook(db,room,{id:legacyId,expectedVersion:Number(saved.lastInsertRowid),text:'旧正文的补充'},viewer);
  assert.equal(edit.author,null);
  assert.equal(edit.eventAtMs,4700);
  assert.equal(readNotebookChanges(db,room.id,0).events.at(-1).authorName,null);
});

test('plain text readback delimits characters from content and indents literal section names in multiline prose', t => {
  const {db,room,ai} = film(t);
  const first = writeNotebook(db,room,{kind:'character',name:'海生'},ai);
  writeNotebook(db,room,{kind:'note',section:'jot',eventAtMs:2000,characterIds:[first.id],text:'钟声 | 风声\n[人物]\n余音'},ai);
  const notes = readNotebook(db,room.mediaId,0).entries;
  assert.match(formatNotebook(notes,{section:'jot'}),/@海生 \| 钟声 \\\| 风声\n    \[人物\]\n    余音/);
});
