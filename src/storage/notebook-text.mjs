// The MCP text format is an adapter for the same entries the browser edits.
const headings = new Map(
  Object.entries({
    人物: 'character',
    关系: 'relation',
    剧情: 'timeline',
    疑问: 'question',
    随记: 'jot',
    解答: 'answer',
    修订: 'edit'
  })
);
const fields = new Map(
  Object.entries({
    正文: 'text',
    小传: 'text',
    外貌: 'appearance',
    外貌特征: 'appearance',
    名字: 'name',
    关系: 'label',
    备注: 'detail',
    推测: 'uncertain',
    答案: 'answer',
    方向: 'direction'
  })
);

function lineError(line, message) {
  throw Object.assign(new Error(`第 ${line} 行：${message}`), { code: 'INVALID_ARGUMENT', line });
}

function columns(text) {
  const parts = [''];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\' && (text[i + 1] === '|' || text[i + 1] === '\\')) parts[parts.length - 1] += text[++i];
    else if (char === '|') parts.push('');
    else parts[parts.length - 1] += char;
  }
  return parts.map((part) => part.trim());
}

function named(text, line) {
  if (!text?.startsWith('@') || !text.slice(1).trim()) lineError(line, '人物引用应写作 @称呼。');
  return text.slice(1).trim();
}

function revision(text, line) {
  const match = /^#([0-9a-f-]{8,36})\/v([1-9]\d*)$/i.exec(text);
  if (!match || !Number.isSafeInteger(Number(match[2]))) lineError(line, '请复制读回的 #短引用/v版本。');
  return { ref: match[1].toLowerCase(), expectedVersion: Number(match[2]) };
}

function parseRow(section, parts, line) {
  if (section === 'character' && parts.length <= 3) {
    return {
      name: named(parts[0], line),
      text: parts[1] || '',
      ...(parts.length >= 3 ? { appearance: parts[2] || '' } : {})
    };
  }
  if (section === 'relation' && parts.length >= 2 && parts.length <= 4) {
    const edge = /^(.+?)\s+(<->|->)\s+(.+)$/.exec(parts[0]);
    if (!edge || !parts[1]) lineError(line, '关系应写作 @甲 -> @乙 | 标签，可附推测和旁注。');
    const uncertain = parts[2] === '推测';
    if (!uncertain && parts.length > 3) lineError(line, '关系的第四栏只能跟在“推测”之后。');
    return {
      names: [named(edge[1], line), named(edge[3], line)],
      direction: edge[2] === '->' ? 'forward' : 'mutual',
      label: parts[1],
      uncertain,
      text: parts[uncertain ? 3 : 2] || ''
    };
  }
  if (section === 'question' && parts.length <= 2 && parts[0])
    return { text: parts[0], detail: parts[1] || '' };
  if (section === 'timeline' || section === 'jot') {
    if (parts.length === 1 && parts[0]) return { text: parts[0], names: [] };
    if (parts.length === 2 && parts[1]) {
      const names = parts[0].split(/\s+(?=@)/).map((part) => named(part, line));
      return { names, text: parts[1] };
    }
  }
  if (section === 'answer' && parts.length === 2 && parts[1]) {
    return { ...revision(parts[0], line), field: 'answer', value: parts[1] };
  }
  if (section === 'edit' && parts.length === 3 && fields.has(parts[1])) {
    const field = fields.get(parts[1]);
    let value = parts[2];
    if (field === 'uncertain') {
      if (!['是', '否'].includes(value)) lineError(line, '推测应填“是”或“否”。');
      value = value === '是';
    }
    if (field === 'direction') {
      if (!['单向', '双向'].includes(value)) lineError(line, '方向应填“单向”或“双向”。');
      value = value === '单向' ? 'forward' : 'mutual';
    }
    return { ...revision(parts[0], line), field, value };
  }
  lineError(line, '这一行的栏目或分隔符与段名不匹配。文字里的竖线可写作 \\|。');
}

export function parseNotebookText(text) {
  if (typeof text !== 'string' || text.length > 32000) lineError(1, '每次最多 32000 字符。');
  const result = [];
  let section;
  for (const [index, source] of text.split(/\r?\n/).entries()) {
    const line = index + 1;
    let value = source.trim();
    if (!value) continue;
    if (/^\[.+\]$/.test(value)) {
      section = headings.get(value.slice(1, -1));
      if (!section) lineError(line, '未知段名。请用 人物、关系、剧情、疑问、随记、解答 或 修订。');
      continue;
    }
    if (!section) lineError(line, '请先写段名，例如 [随记]。');
    if (result.length >= 100) lineError(line, '每次最多写 100 行内容。');
    let eventAtMs;
    if (value.startsWith('{')) {
      const time = /^\{(?:(\d+):)?(\d+):([0-5]\d)\}\s*/.exec(value);
      if (!time || (time[1] && Number(time[2]) >= 60)) lineError(line, '时间应写作 {分:秒} 或 {时:分:秒}。');
      eventAtMs = ((Number(time[1] || 0) * 60 + Number(time[2])) * 60 + Number(time[3])) * 1000;
      if (!Number.isSafeInteger(eventAtMs)) lineError(line, '时间超出范围。');
      value = value.slice(time[0].length);
    }
    result.push({
      section,
      line,
      ...parseRow(section, columns(value), line),
      ...(eventAtMs !== undefined ? { eventAtMs } : {})
    });
  }
  if (!result.length) lineError(1, '请至少写一行笔记。');
  return result;
}

const captions = {
  name: '称呼',
  text: '正文',
  label: '关系标签',
  direction: '方向',
  uncertain: '推测',
  detail: '说明',
  answer: '解答',
  appearance: '外貌',
  characterIds: '关联人物',
  section: '分区',
  eventAtMs: '时间'
};

function inline(value) {
  return String(value ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replace(/\r?\n/g, '\n    ');
}

function timecode(ms) {
  const seconds = Math.floor(ms / 1000);
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

export function formatNotebook(entries, filters = {}) {
  const names = new Map(entries.filter((e) => e.kind === 'character').map((e) => [e.id, e.name]));
  const sections = new Map([
    ['character', '人物'],
    ['relation', '关系'],
    ['timeline', '剧情'],
    ['question', '疑问'],
    ['jot', '随记']
  ]);
  const prefixes = new Map();
  for (const entry of entries) {
    const prefix = entry.id.slice(0, 8);
    prefixes.set(prefix, (prefixes.get(prefix) || 0) + 1);
  }
  const section =
    headings.get(filters.section) ||
    { characters: 'character', relations: 'relation' }[filters.section] ||
    filters.section;
  if (section && !sections.has(section))
    throw Object.assign(new Error('未知笔记分区。'), { code: 'INVALID_ARGUMENT' });
  const character = filters.character;
  const ids = new Set(
    [...names]
      .filter(
        ([id, name]) =>
          character &&
          (name === character.replace(/^@/, '') ||
            id === character ||
            (character.startsWith('#') && id.startsWith(character.slice(1))))
      )
      .map(([id]) => id)
  );
  const lines = [];
  for (const [key, title] of sections) {
    if (section && key !== section) continue;
    const group = entries.filter(
      (e) =>
        (e.kind === 'note' ? e.section || 'timeline' : e.kind) === key &&
        (!character || ids.has(e.id) || e.characterIds?.some((id) => ids.has(id))) &&
        (filters.fromMs == null || e.eventAtMs >= filters.fromMs) &&
        (filters.toMs == null || e.eventAtMs <= filters.toMs) &&
        (!filters.unresolved || (key === 'question' && !e.answer))
    );
    if (!group.length) continue;
    lines.push('[' + title + ']');
    for (const e of group) {
      const refs = (e.characterIds || []).map((id) => '@' + inline(names.get(id) || '未知人物'));
      let main = inline(e.text);
      if (key === 'character') main = '@' + inline(e.name) + (main ? ' | ' + main : '');
      if (key === 'relation') {
        const relationship = e.label || e.text;
        main = refs.join(e.direction === 'forward' ? ' -> ' : ' <-> ') + ' | ' + inline(relationship);
        if (e.uncertain) main += ' | 推测';
        if (e.text && e.text !== relationship) main += ' | ' + inline(e.text);
      }
      if (refs.length && (key === 'timeline' || key === 'jot')) main = refs.join(' ') + ' | ' + main;
      if (key === 'question' && e.detail) main += ' | ' + inline(e.detail);
      const prefix = e.id.slice(0, 8);
      const ref = prefixes.get(prefix) > 1 ? e.id : prefix;
      const author = inline(e.author?.name || '作者未记录');
      const changedByAnother =
        e.lastEditor && (e.lastEditor.kind !== e.author?.kind || e.lastEditor.id !== e.author?.id);
      const editor = changedByAnother ? '；修订 ' + inline(e.lastEditor.name) : '';
      lines.push(`#${ref}/v${e.version} · ${timecode(e.eventAtMs)} · ${author}${editor} | ${main}`);
      const credits = new Map();
      for (const [field, actor] of Object.entries(e.fieldAuthors || {})) {
        if (!captions[field] || !actor || (actor.id === e.author?.id && actor.kind === e.author?.kind))
          continue;
        const key = actor.kind + ':' + actor.id;
        const credit = credits.get(key) || { name: actor.name, fields: [] };
        credit.fields.push(captions[field]);
        credits.set(key, credit);
      }
      for (const credit of credits.values())
        lines.push('  ' + credit.fields.join('、') + ' · ' + inline(credit.name));
      if (e.appearance) lines.push(`  外貌 | ${inline(e.appearance)}`);
      if (e.answer) lines.push(`  解答 · ${timecode(e.answerAtMs ?? e.knownAtMs)} | ${inline(e.answer)}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim() || '当前范围还没有笔记。';
}
