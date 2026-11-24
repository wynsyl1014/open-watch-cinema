import assert from 'node:assert/strict';
import test from 'node:test';
import { renderNotebookHtml, renderRoomHtml } from '../../src/delivery/journal-html.mjs';
import { notebookJournal, roomJournal } from '../../src/delivery/journal-text.mjs';

test('room export prints normalized film-time order, distinct activity events and hostile speech as literal text', () => {
  const attack = '</p><script>alert("unsafe")</script>';
  const html = renderRoomHtml(roomJournal('Film < 1', '2026-11-21', [
    { id: 3, mediaTimeMs: 2000, senderName: 'B & C', content: attack + '\nnext line' },
    { id: 1, mediaTimeMs: 0, senderName: 'A', content: 'Opening' },
    { id: 2, mediaTimeMs: 0, senderName: 'A', content: '递来爆米花', interaction: 'popcorn' }
  ]));
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /<strong>3<\/strong>/);
  assert.match(html, /class="event"/);
  assert.match(html, /class="turn right"/);
  assert.match(html, /Opening[\s\S]*递来爆米花[\s\S]*0:02/);
  assert.match(html, /&lt;script&gt;alert\(&quot;unsafe&quot;\)&lt;\/script&gt;\nnext line/);
  assert.doesNotMatch(html, /<script|<iframe|<link /i);
});

test('notebook exports connected and labelled relationships, portrait fallbacks, human credits and answers', () => {
  const author = { name: '小满', kind: 'user', id: 'internal-user' };
  const editor = { name: '阿澈', kind: 'ai', id: 'internal-ai' };
  const entries = [
    { kind: 'character', id: 'private-protagonist', name: '甲', text: '归人', appearance: '黑风衣', author, eventAtMs: 0 },
    { kind: 'character', id: 'private-friend', name: '乙', text: '等他的人', author, eventAtMs: 1000 },
    { kind: 'character', id: 'private-other', name: '丙', text: '', eventAtMs: 2000 },
    { kind: 'relation', characterIds: ['private-friend', 'private-protagonist'], label: '寻找', direction: 'forward',
      text: '在桥下等', uncertain: true, author, eventAtMs: 3000 },
    { kind: 'relation', characterIds: ['private-protagonist', 'private-other'], label: '朋友', direction: 'mutual', author,
      eventAtMs: 4000 },
    { kind: 'note', section: 'timeline', text: '到了\n码头', characterIds: ['private-friend'], author, eventAtMs: 5000 },
    { kind: 'note', section: 'question', text: '他从哪里来？', detail: '关于船票', answer: '北方', answerAtMs: 12000,
      author, fieldAuthors: { answer: editor }, lastEditor: editor, eventAtMs: 6000 },
    { kind: 'note', section: 'jot', text: '& test', author, eventAtMs: 7000 }
  ];
  const html = renderNotebookHtml(notebookJournal('A "movie"', entries));
  assert.match(html, /<figure class="graph"/);
  assert.equal((html.match(/class="branch"/g) || []).length, 2);
  assert.match(html, /甲的人物关系图/);
  assert.match(html, /寻找[\s\S]*←[\s\S]*推测/);
  assert.match(html, /朋友[\s\S]*↔[\s\S]*已知/);
  assert.match(html, /到了\n码头/);
  assert.match(html, /他从哪里来？[\s\S]*关于船票[\s\S]*北方[\s\S]*0:12[\s\S]*阿澈/);
  assert.match(html, /记录 · 小满/);
  assert.match(html, /<span class="portrait" aria-hidden="true">甲<\/span>/);
  assert.match(html, /<strong>外貌<\/strong>　黑风衣/);
  assert.doesNotMatch(html, /private-protagonist|private-friend|internal-user|internal-ai/);
  assert.doesNotMatch(html, /<script|<iframe|https?:\/\//i);
});
