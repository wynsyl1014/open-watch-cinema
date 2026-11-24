import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { openDatabase, getQuickMessages, setQuickMessages, DEFAULT_NOTEBOOK_QUICK_MESSAGE } from '../../src/storage/index.mjs';
import { appendQuickMessage } from '../../public/quick-message-settings.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('appendQuickMessage fills empty inputs and appends cleanly after existing text', () => {
  assert.equal(appendQuickMessage('', '帮我们记一下手记～'), '帮我们记一下手记～');
  assert.equal(appendQuickMessage('   ', '帮我们记一下手记～'), '帮我们记一下手记～');
  assert.equal(appendQuickMessage('这一段好精彩', '帮我们记一下手记～'), '这一段好精彩 帮我们记一下手记～');
  assert.equal(appendQuickMessage('这一段好精彩 ', '帮我们记一下手记～'), '这一段好精彩 帮我们记一下手记～');
  assert.equal(appendQuickMessage('a'.repeat(795), '1234567890', { maxLength: 800 }).length, 800);
});

test('quick messages storage seeds the default notebook prompt and validates edits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owc-quick-messages-'));
  try {
    const db = openDatabase(join(dir, 'cinema.sqlite'));
    const initial = getQuickMessages(db);
    assert.equal(initial.items.length, 1);
    assert.equal(initial.items[0].id, DEFAULT_NOTEBOOK_QUICK_MESSAGE.id);
    assert.equal(initial.items[0].isDefault, true);
    assert.equal(initial.items[0].title, '整理观影手记');

    const updated = setQuickMessages(db, {
      items: [
        { id: DEFAULT_NOTEBOOK_QUICK_MESSAGE.id, title: '写小本本', content: '有空帮我们记一下重点呀' },
        { title: '暂停聊一下', content: '我们先暂停一会儿聊聊刚刚那一幕吧～' }
      ]
    });
    assert.equal(updated.items.length, 2);
    assert.equal(updated.items[0].isDefault, true);
    assert.equal(updated.items[0].title, '写小本本');
    assert.equal(updated.items[1].isDefault, false);
    assert.ok(updated.items[1].id.startsWith('qm-'));

    const reloaded = getQuickMessages(db);
    assert.deepEqual(reloaded.items, updated.items);
    assert.equal(reloaded.defaults.notebook.title, DEFAULT_NOTEBOOK_QUICK_MESSAGE.title);

    assert.throws(() => setQuickMessages(db, { items: [{ title: '', content: '内容' }] }), /标题/);
    assert.throws(() => setQuickMessages(db, { items: [{ title: '标题', content: '   ' }] }), /内容/);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('quick message triggers, shared popover, and settings tab are wired cleanly', async () => {
  const [html, server, app] = await Promise.all([
    readFile(resolve(ROOT, 'public/index.html'), 'utf8'),
    readFile(resolve(ROOT, 'server.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'public/app.js'), 'utf8')
  ]);

  assert.match(html, /id="quickMessageTrigger"[^>]*popovertarget="quickMessagePopover"/);
  assert.match(html, /id="sidebarQuickMessageTrigger"[^>]*popovertarget="quickMessagePopover"/);
  assert.match(html, /id="quickMessagePopover"[^>]*popover/);
  assert.ok(html.indexOf('id="quickMessagePopover"') < html.indexOf('id="aiActivityPanel"'), 'quick message popover stays inside cinemaWorkspace for fullscreen support');
  assert.match(html, /data-settings-page="quick-messages"[^>]*aria-controls="settingsQuickMessages"/);
  assert.match(html, /id="settingsQuickMessages"/);
  assert.match(server, /\/api\/quick-messages/);
  assert.match(server, /\/quick-message-settings\.js/);
  assert.match(app, /createQuickMessageSettings/);
});
