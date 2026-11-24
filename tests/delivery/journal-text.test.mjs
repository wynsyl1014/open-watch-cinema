import assert from 'node:assert/strict';
import test from 'node:test';
import { roomJournal, notebookJournal, renderRoomText, renderNotebookText } from '../../src/delivery/journal-text.mjs';
import { openDatabase } from '../../src/storage/database.mjs';
import { initializeNotebook, readNotebook, writeNotebook } from '../../src/storage/notebook.mjs';
import { setParticipantName } from '../../src/storage/participants.mjs';

test('room export orders rewound and simultaneous comments without losing line breaks or interactions',()=>{
  const raw=[
    {id:2,mediaTimeMs:90500,senderName:'小满',content:'第一行\n第二行'},
    {id:3,mediaTimeMs:3000,senderName:'阿澈',content:'递来一桶爆米花 🍿',interaction:'popcorn'},
    {id:1,mediaTimeMs:90500,senderName:'阿澈',content:'原话 | 保留'}
  ];
  const journal=roomJournal('影片','2026-11-21',raw);
  assert.deepEqual(journal.messages.map(row=>row.name),['阿澈','阿澈','小满']);
  assert.deepEqual(raw.map(row=>row.id),[2,3,1]);
  assert.equal(renderRoomText(journal),'《影片》观影对话 · 2026-11-21\n0:03　阿澈（互动）　递来一桶爆米花 🍿\n1:30　阿澈　原话 | 保留\n1:30　小满　第一行\n第二行\n');
});

test('film notebook exports current names, per-field credit, direction, uncertainty, time, answer and verbatim prose',()=>{
  const db=openDatabase(':memory:'); initializeNotebook(db);
  try {
    const ai={kind:'ai',id:'test-ai'},viewer={kind:'user',id:'viewer'};
    setParticipantName(db,ai,'旧名');setParticipantName(db,viewer,'小满');
    const room={id:'room-one',mediaId:'film-one',status:'active',lastPositionMs:4000000};
    const first=writeNotebook(db,room,{kind:'character',name:'甲',text:'人物小传',appearance:'戴红围巾',eventAtMs:0},ai);
    const second=writeNotebook(db,room,{kind:'character',name:'乙',eventAtMs:0},viewer);
    writeNotebook(db,room,{kind:'relation',label:'相信',text:'还在观察。',direction:'forward',uncertain:true,characterIds:[first.id,second.id],eventAtMs:2000},ai);
    writeNotebook(db,room,{section:'jot',text:'原话 | 换行\n第二行',characterIds:[second.id],eventAtMs:3000},viewer);
    writeNotebook(db,room,{text:'一次回头',eventAtMs:4000},viewer);
    const q=writeNotebook(db,room,{section:'question',text:'谁来了？',detail:'门外有声。',eventAtMs:5000},viewer);
    writeNotebook(db,room,{id:q.id,expectedVersion:q.version,answer:'是甲。',answerAtMs:3602000},ai);
    setParticipantName(db,ai,'阿澈');
    const rows=readNotebook(db,'film-one',4000000).entries;
    const normalized=notebookJournal('影片',rows);
    const text=renderNotebookText(normalized);
    for (const value of ['外貌：戴红围巾','甲 → 乙 · 相信 · 推测','还在观察。','阿澈','小满','解答 · 1:00:02 · 阿澈　是甲。','乙　原话 | 换行\n第二行','门外有声。','一次回头']) assert.ok(text.includes(value),value);
    for (const secret of [first.id,q.id,'/v','旧名','room-one','test-ai']) assert.ok(!text.includes(secret),secret);
    assert.equal(renderNotebookText(notebookJournal('空',[])),'《空》观影手记\n');
  } finally { db.close(); }
});
