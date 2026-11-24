import { randomUUID } from 'node:crypto';

const KEY = 'quick_messages';
const MAX_ITEMS = 50;
const MAX_TITLE_LENGTH = 40;
const MAX_CONTENT_LENGTH = 800;

export const DEFAULT_NOTEBOOK_QUICK_MESSAGE = Object.freeze({
  id: 'default-notebook',
  title: '整理观影手记',
  content: '方便的话，可以顺手帮我们把刚才看到的剧情和人物整理进观影手记里吗？不用写太长，记下重点就好～',
  isDefault: true
});

export function defaultQuickMessages() {
  return [{ ...DEFAULT_NOTEBOOK_QUICK_MESSAGE }];
}

function normalizeQuickMessage(entry, index, usedIds) {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError(`第 ${index + 1} 条快捷消息格式无效。`);
  }
  const title = typeof entry.title === 'string' ? entry.title.replace(/\r?\n/g, ' ').trim() : '';
  const content = typeof entry.content === 'string' ? entry.content.trim() : '';
  if (!title || title.length > MAX_TITLE_LENGTH) {
    throw new TypeError(`快捷消息标题须为 1 至 ${MAX_TITLE_LENGTH} 个字符。`);
  }
  if (!content || content.length > MAX_CONTENT_LENGTH) {
    throw new TypeError(`快捷消息内容须为 1 至 ${MAX_CONTENT_LENGTH} 个字符。`);
  }
  const rawId = typeof entry.id === 'string' ? entry.id.trim() : '';
  const isDefault = rawId === DEFAULT_NOTEBOOK_QUICK_MESSAGE.id;
  let id = isDefault ? DEFAULT_NOTEBOOK_QUICK_MESSAGE.id : (rawId || `qm-${randomUUID().slice(0, 8)}`);
  if (usedIds.has(id)) {
    if (isDefault) throw new TypeError('默认快捷消息不能重复。');
    id = `qm-${randomUUID().slice(0, 8)}`;
  }
  usedIds.add(id);
  return { id, title, content, isDefault };
}

export function getQuickMessages(db) {
  const row = db.prepare('select value from settings where key = ?').get(KEY);
  let items = defaultQuickMessages();
  if (row?.value) {
    try {
      const parsed = JSON.parse(row.value);
      if (Array.isArray(parsed)) {
        const usedIds = new Set();
        items = parsed.slice(0, MAX_ITEMS).map((entry, index) => normalizeQuickMessage(entry, index, usedIds));
      }
    } catch {
      items = defaultQuickMessages();
    }
  }
  return {
    items,
    defaults: {
      notebook: { ...DEFAULT_NOTEBOOK_QUICK_MESSAGE }
    }
  };
}

export function setQuickMessages(db, payload) {
  if (!payload || !Array.isArray(payload.items)) {
    throw new TypeError('请提供快捷消息列表。');
  }
  if (payload.items.length > MAX_ITEMS) {
    throw new TypeError(`最多可保存 ${MAX_ITEMS} 条快捷消息。`);
  }
  const usedIds = new Set();
  const items = payload.items.map((entry, index) => normalizeQuickMessage(entry, index, usedIds));
  db.prepare(`insert into settings (key, value, updated_at) values (?, ?, ?)
    on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`)
    .run(KEY, JSON.stringify(items), new Date().toISOString());
  return {
    items,
    defaults: {
      notebook: { ...DEFAULT_NOTEBOOK_QUICK_MESSAGE }
    }
  };
}
