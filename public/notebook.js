import { createBookWindow } from './notebook-window.js';
import { layoutGraph } from './notebook-graph.js';

const pageNames = { people: '人物关系', timeline: '剧情时间线', question: '线索疑问', jot: '观影随记' };
const empties = {
  people: '记下第一个人物，就能在这里连起关系。',
  timeline: '记下故事里第一个值得回看的时刻。',
  question: '有什么还说不清？把疑问留在这里。',
  jot: '留下此刻想说的一句话。'
};
const fieldNames = {
  name: '名字',
  text: '正文',
  appearance: '外貌',
  label: '关系',
  answer: '回应',
  detail: '线索',
  direction: '方向',
  uncertain: '推测'
};
const ns = 'http://www.w3.org/2000/svg';
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function button(text, action, fn) {
  const b = el('button', '', text);
  b.type = 'button';
  b.dataset.action = action;
  b.addEventListener('click', fn);
  return b;
}
function svg(tag, attrs) {
  const n = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attrs)) n.setAttribute(key, value);
  return n;
}
function authorName(actor) {
  return actor?.name || (actor?.kind === 'user' ? 'user' : actor?.kind === 'ai' ? 'AI' : '');
}
function plainField(entry, field) {
  if (field === 'direction') return entry.direction === 'forward' ? '单向 →' : '双向 ↔';
  if (field === 'uncertain') return entry.uncertain ? '推测' : '已知';
  return entry[field] ?? (field === 'label' ? entry.text : '') ?? '';
}
function avatarView(name) {
  return el('span', 'nb-avatar', Array.from(name || '？')[0]);
}

export function createNotebook({ fetchJson, getViewer, interactionsOn, video, formatTime }) {
  const byId = (id) => document.getElementById(id);
  const book = byId('notebookDialog'),
    cover = byId('notebookButton'),
    pages = byId('notebookPages'),
    tabActions = byId('notebookTabActions'),
    status = byId('notebookStatus');
  let room = null,
    media = null,
    section = 'people',
    entries = new Map(),
    editing = new Map(),
    selection = null;
  let requestSerial = 0,
    graphSignature = '',
    mapObserver = null,
    statusTimer;
  const drafts = new Map(),
    paneMap = new Map(),
    nodes = new Map();
  try {
    section = localStorage.getItem('owc-notebook-page') || 'people';
  } catch {}
  if (!Object.hasOwn(pageNames, section)) section = 'people';
  const roomPath = (suffix = '') => '/api/rooms/' + encodeURIComponent(room?.id) + '/notebook' + suffix;
  const tell = (text) => {
    clearTimeout(statusTimer);
    status.textContent = text;
    status.hidden = !text;
    if (text)
      statusTimer = setTimeout(() => {
        status.hidden = true;
      }, 9500);
  };
  function valueText(entry, field) {
    if (field === 'characterIds') {
      const separator = entry.kind === 'relation' ? (entry.direction === 'forward' ? ' → ' : ' ↔ ') : '、';
      return (entry.characterIds || []).map((id) => entries.get(id)?.name || '未知人物').join(separator);
    }
    if (field === 'eventAtMs') return formatTime(entry.eventAtMs);
    return plainField(entry, field);
  }
  const humanBody = (body) => ({ ...body, viewerName: getViewer(), returnEntry: true });
  const readOnly = () => room?.status === 'ended';
  const post = (url, body) => {
    if (readOnly()) return Promise.reject(new Error('历史手记仅供回看。'));
    return fetchJson(url, { method: 'POST', body: JSON.stringify(body) });
  };
  const win = createBookWindow(
    cover,
    book,
    () => {
      cover.querySelector('.nb-dot').hidden = true;
      if (!readOnly() && interactionsOn())
        void post(roomPath('/peek'), { senderName: getViewer(), requestId: crypto.randomUUID() }).catch(
          () => {}
        );
      render();
      void refresh();
    },
    () => {}
  );
  function navigate(name) {
    const leaving = paneMap.get(section);
    if (leaving) leaving.scrollTop = pages.scrollTop;
    section = name;
    try {
      localStorage.setItem('owc-notebook-page', name);
    } catch {}
    render();
    pages.scrollTop = paneMap.get(name)?.scrollTop || 0;
  }
  for (const tab of book.querySelectorAll('[data-notebook-tab]'))
    tab.onclick = () => navigate(tab.dataset.notebookTab);
  const apiError = (err) => tell(err.message);
  function setRoom(next, title) {
    byId('notebookFilm').textContent = [title, next?.status === 'ended' ? '只读回看' : ''].filter(Boolean).join(' · ');
    if (next?.id === room?.id && next?.status === room?.status && next?.mediaAvailable === room?.mediaAvailable) return;
    win.enable(false);
    room = next;
    media = next?.mediaId;
    requestSerial++;
    status.hidden = true;
    selection = null;
    graphSignature = '';
    mapObserver?.disconnect();
    mapObserver = null;
    entries.clear();
    drafts.clear();
    editing.clear();
    paneMap.clear();
    nodes.clear();
    pages.replaceChildren();
    tabActions?.replaceChildren();
    cover.querySelector('.nb-dot').hidden = true;
    win.enable(Boolean(next));
  }
  async function refresh() {
    if (!room || !win.open) return;
    const serial = ++requestSerial;
    try {
      const result = await fetchJson(roomPath());
      if (serial !== requestSerial || !room || !win.open) return;
      media = result.mediaId;
      entries = new Map(result.entries.map((e) => [e.id, e]));
      if (Array.isArray(result.editing)) editing = new Map(result.editing.map((e) => [e.token, e]));
      render();
    } catch (err) {
      if (serial === requestSerial) apiError(err);
    }
  }
  function notify(event) {
    if (!room || event.roomId !== room.id) return;
    if (event.type === 'notebook-edit') {
      if (event.active) editing.set(event.token, event);
      else editing.delete(event.token);
      if (win.open) updateBusy();
    } else if (win.open) void refresh();
    else cover.querySelector('.nb-dot').hidden = false;
  }
  function updateBusy() {
    for (const field of book.querySelectorAll('.nb-field')) {
      const id = field.closest('[data-entry-id]')?.dataset.entryId;
      const name = field.dataset.field;
      const active = [...editing.values()].find((e) =>
        e.targets?.some(
          (t) =>
            id?.replaceAll('-', '').startsWith(String(t.ref).replace(/^#/, '').replaceAll('-', '')) &&
            (t.fields.includes(name) || t.fields.includes('*'))
        )
      );
      const label = field.querySelector('.nb-busy');
      if (label) {
        label.textContent = active ? (active.actorName || 'AI') + ' 正在更新' : '';
        label.hidden = !active;
      }
    }
  }
  function syncTabActions(key, pane) {
    if (!tabActions) return;
    tabActions.replaceChildren();
    if (readOnly()) return;
    if (key === 'people') {
      tabActions.append(
        button('＋ 人物', 'add-character', () => showComposer(pane, 'character')),
        button('＋ 关系', 'add-relation', () => showComposer(pane, 'relation'))
      );
    } else {
      tabActions.append(
        button('＋ ' + { timeline: '事件', question: '疑问', jot: '随记' }[key], 'add-' + key, () =>
          showComposer(pane, key)
        )
      );
    }
  }
  function addPane(key) {
    const pane = el('section', 'nb-page nb-page-' + key);
    pane.dataset.page = key;
    const area = el('div', 'nb-compose-area');
    pane.append(area);
    const body = el('div', key === 'people' ? 'nb-spread' : 'nb-note-list');
    if (key === 'people') {
      const map = el('div', 'nb-map-scroll');
      map.id = 'notebookMap';
      map.addEventListener('click', (e) => {
        if (
          selection &&
          (e.target === map || e.target.classList.contains('nb-map-stage') || e.target.closest('.nb-lines'))
        ) {
          selection = null;
          render();
        }
      });
      if (typeof ResizeObserver !== 'undefined') {
        mapObserver?.disconnect();
        mapObserver = new ResizeObserver(() => {
          if (win.open && room && section === 'people') {
            const people = [...entries.values()].filter((e) => e.kind === 'character'),
              relations = [...entries.values()].filter((e) => e.kind === 'relation');
            graph(map, people, relations);
          }
        });
        mapObserver.observe(map);
      }
      const detail = el('div', 'nb-detail');
      detail.id = 'notebookDetails';
      detail.hidden = true;
      body.append(map, detail);
    }
    pane.append(body);
    pages.append(pane);
    paneMap.set(key, { pane, body, area });
    return paneMap.get(key);
  }
  function showComposer(pane, kind) {
    const area = pane.querySelector('.nb-compose-area');
    const existing = area.querySelector('form');
    if (existing) {
      existing.querySelector('input,textarea,select')?.focus();
      return;
    }
    const form = el('form', 'nb-composer');
    form.dataset.kind = kind;
    const elements = {};
    function field(label, name, type, opts) {
      const wrap = el('label', 'nb-input-label', label),
        node = el(type);
      node.name = name;
      node.maxLength = name === 'name' ? 80 : name === 'label' ? 120 : name === 'appearance' ? 2000 : 4000;
      if (type === 'textarea') node.rows = 2;
      if (opts)
        for (const [val, caption] of opts) {
          const option = el('option', '', caption);
          option.value = val;
          node.append(option);
        }
      wrap.append(node);
      form.append(wrap);
      elements[name] = node;
      return node;
    }
    if (kind === 'character') {
      field('人物称呼', 'name', 'input').required = true;
      field('小传（可选）', 'text', 'textarea');
      field('外貌（可选）', 'appearance', 'textarea');
    } else if (kind === 'relation') {
      const people = [...entries.values()].filter((e) => e.kind === 'character').map((e) => [e.id, e.name]);
      if (people.length < 2) {
        tell('先在人物页记下两个人，再连起关系。');
        return;
      }
      field('从', 'from', 'select', people);
      field('到', 'to', 'select', people).selectedIndex = 1;
      field('关系名称', 'label', 'input').required = true;
      field('方向', 'direction', 'select', [
        ['mutual', '双向 ↔'],
        ['forward', '单向 →']
      ]);
      field('确定程度', 'uncertain', 'select', [
        ['false', '已知'],
        ['true', '推测']
      ]);
      field('旁注（可选）', 'text', 'textarea');
    } else {
      field(kind === 'question' ? '你的疑问' : pageNames[kind], 'text', 'textarea').required = true;
    }
    const tools = el('div', 'nb-tools'),
      save = el('button', 'nb-primary', '记下来');
    save.type = 'submit';
    save.dataset.action = 'create';
    tools.append(
      save,
      button('取消', 'cancel', () => area.replaceChildren())
    );
    form.append(tools);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const id = room?.id;
      const data = Object.fromEntries(Object.entries(elements).map(([key, n]) => [key, n.value.trim()]));
      if (kind === 'relation') {
        if (data.from === data.to) {
          tell('请选择两个不同的人物。');
          return;
        }
        data.characterIds = [data.from, data.to];
        delete data.from;
        delete data.to;
        data.uncertain = data.uncertain === 'true';
      }
      const body = ['character', 'relation'].includes(kind)
        ? { kind, ...data }
        : { kind: 'note', section: kind, ...data };
      save.disabled = true;
      try {
        await post(roomPath(), humanBody({ action: 'save', ...body }));
        if (id !== room?.id) return;
        area.replaceChildren();
        await refresh();
      } catch (err) {
        if (id === room?.id) apiError(err);
      } finally {
        save.disabled = false;
      }
    };
    area.append(form);
    form.querySelector('input,textarea,select').focus({ preventScroll: true });
    area.scrollIntoView({ block: 'nearest' });
  }

  function sectionOf(entry) {
    return entry.kind === 'note' ? entry.section || 'timeline' : 'people';
  }
  function authorTag(entry, field) {
    if (entry[field] == null || entry[field] === '' || (Array.isArray(entry[field]) && !entry[field].length))
      return '';
    const person = entry.fieldAuthors?.[field] || entry.author;
    return authorName(person);
  }
  function fieldNode(article, entry, field, title) {
    let host = article.querySelector('.nb-field[data-field="' + field + '"]');
    if (!host) {
      host = el('div', 'nb-field');
      host.dataset.field = field;
      host.append(
        el('span', 'nb-field-label', title),
        el(readOnly() ? 'span' : 'button', 'nb-value'),
        el('small', 'nb-credit'),
        el('small', 'nb-busy')
      );
      const value = host.querySelector('.nb-value');
      if (field === 'eventAtMs') {
        let jumpTimer = null;
        if (readOnly()) {
          value.title = '单击跳到这一刻';
          value.onclick = () => {
            const latest = entries.get(entry.id);
            if (latest && Number.isFinite(latest.eventAtMs) && video?.readyState > 0) {
              video.currentTime = latest.eventAtMs / 1000;
            }
          };
        } else {
          value.type = 'button';
          value.title = '单击跳到这一刻 · 双击修改时间';
          const edit = () => {
            clearTimeout(jumpTimer);
            openEditor(host, entries.get(entry.id), field);
          };
          value.ondblclick = edit;
          value.onclick = (e) => {
            if (e.detail === 0) {
              edit();
              return;
            }
            clearTimeout(jumpTimer);
            jumpTimer = setTimeout(() => {
              const latest = entries.get(entry.id);
              if (latest && Number.isFinite(latest.eventAtMs) && video?.readyState > 0) {
                video.currentTime = latest.eventAtMs / 1000;
              }
            }, 220);
          };
        }
      } else if (!readOnly()) {
        value.type = 'button';
        value.title = '双击编辑，或聚焦后按 Enter';
        const edit = () => openEditor(host, entries.get(entry.id), field);
        value.ondblclick = edit;
        value.onclick = (e) => {
          if (e.detail === 0) edit();
        };
      }
      if (field === 'eventAtMs') article.querySelector('.nb-entry-meta').prepend(host);
      else article.querySelector('.nb-fields').append(host);
    }
    const current = valueText(entry, field);
    const valNode = host.querySelector('.nb-value');
    host.classList.toggle('is-empty', !current);
    if (field === 'characterIds' && entry.kind === 'note' && entry.characterIds?.length) {
      valNode.replaceChildren();
      for (const cid of entry.characterIds) {
        valNode.append(el('span', 'nb-char-chip', entries.get(cid)?.name || '未知人物'));
      }
    } else {
      valNode.textContent =
        current || (readOnly() ? '—' : field === 'answer' ? '写下回应…' : field === 'characterIds' ? '＋ 关联人物' : '双击填写…');
    }
    const name = authorTag(entry, field);
    const credit = host.querySelector('.nb-credit');
    credit.textContent = name;
    credit.hidden = !name;
    const draft = drafts.get(entry.id + '/' + field);
    if (draft) {
      if (!host.querySelector('form')) openEditor(host, entry, field, draft);
      if (entry.version > draft.version && JSON.stringify(entry[field] ?? null) !== draft.base) {
        draft.conflict = entry;
        const form = host.querySelector('.nb-inline');
        const notice = form.querySelector('.nb-conflict');
        notice.hidden = false;
        notice.textContent = '当前版本：' + valueText(entry, field);
        form.querySelector('[data-action=save]').textContent =
          field === 'characterIds' ? '采用我的选择' : '采用我的文字';
      }
    }
    return host;
  }
  function characterLinkInputs(entry, draft) {
    const choices = el('div', 'nb-link-choices'),
      people = [...entries.values()].filter((person) => person.kind === 'character');
    const relation = entry.kind === 'relation';
    if (relation) {
      for (const [index, label] of ['从', '到'].entries()) {
        const wrap = el('label', 'nb-input-label', label),
          select = el('select');
        for (const person of people) {
          const opt = el('option', '', person.name);
          opt.value = person.id;
          select.append(opt);
        }
        select.value = draft.value[index] || '';
        select.onchange = () => {
          draft.value[index] = select.value;
        };
        wrap.append(select);
        choices.append(wrap);
      }
    } else
      for (const person of people) {
        const label = el('label', 'nb-toggle'),
          check = el('input');
        check.type = 'checkbox';
        check.checked = draft.value.includes(person.id);
        check.onchange = () => {
          draft.value = check.checked
            ? [...draft.value, person.id]
            : draft.value.filter((id) => id !== person.id);
        };
        label.append(check, person.name);
        choices.append(label);
      }
    if (!people.length) choices.append(el('p', 'nb-empty', '在人物关系页记下人物后，就能在这里选中了。'));
    return choices;
  }

  function fieldInput(field, draft) {
    const choice = field === 'uncertain' || field === 'direction';
    const input = el(
      choice ? 'select' : ['name', 'label', 'eventAtMs'].includes(field) ? 'input' : 'textarea'
    );
    if (choice) {
      const values =
        field === 'direction'
          ? [
              ['mutual', '双向 ↔'],
              ['forward', '单向 →']
            ]
          : [
              ['false', '已知'],
              ['true', '推测']
            ];
      for (const [val, caption] of values) {
        const option = el('option', '', caption);
        option.value = val;
        input.append(option);
      }
    }
    if (input.tagName === 'TEXTAREA') input.rows = 3;
    if (field === 'eventAtMs') input.placeholder = '分:秒';
    input.setAttribute('aria-label', field === 'eventAtMs' ? '影片时间' : fieldNames[field] || field);
    input.name = field;
    input.value = draft.value || (field === 'direction' ? 'mutual' : field === 'uncertain' ? 'false' : '');
    input.oninput = () => {
      draft.value = input.value;
    };
    return input;
  }

  function openEditor(host, entry, field, restored) {
    if (readOnly()) return;
    if (!entry || host.querySelector('form')) return;
    const key = entry.id + '/' + field;
    const initialValue =
      field === 'characterIds'
        ? [...(entry.characterIds || [])]
        : field === 'eventAtMs'
          ? formatTime(entry.eventAtMs)
          : String(entry[field] ?? (field === 'label' ? entry.text : '') ?? '');
    const draft = restored || {
      version: entry.version,
      base: JSON.stringify(entry[field] ?? null),
      value: initialValue,
      conflict: null
    };
    drafts.set(key, draft);
    const form = el('form', 'nb-inline');
    form.dataset.field = field;
    const input = field === 'characterIds' ? characterLinkInputs(entry, draft) : fieldInput(field, draft);
    const conflict = el('p', 'nb-conflict');
    const save = el('button', 'nb-primary');
    save.type = 'submit';
    save.dataset.action = 'save';
    const showConflict = () => {
      conflict.textContent = draft.conflict ? '当前版本：' + valueText(draft.conflict, field) : '';
      conflict.hidden = !draft.conflict;
      save.textContent = draft.conflict
        ? field === 'characterIds'
          ? '采用我的选择'
          : '采用我的文字'
        : '保存';
    };
    showConflict();
    const cancel = () => {
      drafts.delete(key);
      form.remove();
      host.classList.remove('editing');
      host.querySelector('.nb-value').focus({ preventScroll: true });
    };
    const actions = el('div', 'nb-tools');
    actions.append(save, button('取消', 'cancel', cancel));
    form.append(input, conflict, actions);
    host.append(form);
    host.classList.add('editing');
    form.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
      if (
        e.target === input &&
        e.key === 'Enter' &&
        !e.isComposing &&
        !e.shiftKey &&
        (input.tagName !== 'TEXTAREA' || !e.altKey)
      ) {
        e.preventDefault();
        form.requestSubmit();
      }
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (save.disabled || !room) return;
      const r = room.id;
      save.disabled = true;
      try {
        let value =
          field === 'characterIds'
            ? draft.value
            : field === 'uncertain'
              ? input.value === 'true'
              : input.value.trim();
        if (field === 'characterIds' && entry.kind === 'relation' && value[0] === value[1])
          throw Error('请选择不同的人物。');
        if (field === 'eventAtMs') {
          if (!/^(?:\d+:)?\d+:[0-5]\d$/.test(value)) throw Error('请填写 分:秒 或 时:分:秒。');
          value = value.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0) * 1000;
        }
        await post(
          roomPath(),
          humanBody({
            action: 'save',
            id: entry.id,
            expectedVersion: draft.conflict?.version ?? draft.version,
            [field]: value
          })
        );
        if (r !== room?.id) return;
        cancel();
        await refresh();
      } catch (err) {
        if (r !== room?.id) return;
        if (err.current && err.code === 'NOTEBOOK_VERSION_CONFLICT') {
          draft.conflict = err.current;
          entries.set(entry.id, err.current);
          showConflict();
          render();
        } else apiError(err);
      } finally {
        save.disabled = false;
      }
    };
    if (!restored) {
      const focusTarget = field === 'characterIds' ? input.querySelector('select,input') || save : input;
      focusTarget.focus({ preventScroll: true });
      focusTarget.select?.();
    }
  }
  function articleFor(entry) {
    let article = nodes.get(entry.id);
    if (!article) {
      article = el('article', 'nb-entry');
      article.dataset.entryId = entry.id;
      nodes.set(entry.id, article);
      const meta = el('div', 'nb-entry-meta');
      meta.append(el('span', 'nb-entry-type'), el('span', 'nb-entry-author'));
      const del = button('移除', 'delete', async () => {
        const latest = entries.get(entry.id),
          r = room?.id;
        if (!latest || !window.confirm('移除这条手记？')) return;
        try {
          await post(
            roomPath(),
            humanBody({ action: 'delete', id: entry.id, expectedVersion: latest.version })
          );
          if (r === room?.id) await refresh();
        } catch (err) {
          if (r === room?.id) {
            apiError(err);
            await refresh();
          }
        }
      });
      del.className = 'nb-delete';
      if (!readOnly()) meta.append(del);
      article.append(meta, el('div', 'nb-fields'));
    }
    const page = sectionOf(entry);
    article.dataset.pageKind = page;
    if (page === 'question') article.dataset.answered = entry.answer ? 'true' : 'false';
    else delete article.dataset.answered;
    fieldNode(article, entry, 'eventAtMs', '影片时间');
    article.querySelector('.nb-entry-author').textContent = authorName(entry.author);
    article.querySelector('.nb-entry-type').textContent =
      entry.kind === 'relation'
        ? '人物关系'
        : entry.kind === 'character'
          ? '人物'
          : page === 'question'
            ? entry.answer
              ? '已解'
              : '待解'
            : pageNames[page];
    let fields;
    if (entry.kind === 'character')
      fields = [
        ['name', '称呼'],
        ['text', '小传'],
        ['appearance', '外貌']
      ];
    else if (entry.kind === 'relation')
      fields = [
        ['label', '关系'],
        ['text', '旁注'],
        ['direction', '方向'],
        ['uncertain', '确定程度']
      ];
    else if (page === 'question')
      fields = [
        ['text', '疑问'],
        ['detail', '线索'],
        ['answer', entry.answerAtMs != null ? '回应 · ' + formatTime(entry.answerAtMs) : '回应']
      ];
    else fields = [['text', page === 'jot' ? '随记' : '事件']];
    if (entry.kind === 'relation' || (entry.kind === 'note' && page !== 'question'))
      fields.push(['characterIds', '关联人物']);
    for (const [field, title] of fields) {
      const host = fieldNode(article, entry, field, title);
      host.querySelector('.nb-field-label').textContent = title;
    }
    return article;
  }
  function choose(id, field) {
    if (!field && selection === id) {
      selection = null;
      render();
      return;
    }
    selection = id;
    render();
    const card = nodes.get(id);
    if (field) {
      const host = card?.querySelector('[data-field="' + field + '"]');
      if (host) openEditor(host, entries.get(id), field);
    }
    if (card && book.clientWidth < 616) card.scrollIntoView({ block: 'nearest' });
  }
  function graph(map, people, relations) {
    const mapWidth = Math.max(260, Math.floor(map.clientWidth || 340));
    const mapHeight = Math.max(168, Math.floor(map.clientHeight || 240));
    const signature = JSON.stringify([
      mapWidth,
      mapHeight,
      people.map((e) => [e.id, e.name]),
      relations.map((e) => [e.id, e.label, e.text, e.uncertain, e.direction, e.characterIds])
    ]);
    if (signature !== graphSignature) {
      graphSignature = signature;
      const scroll = map.scrollTop;
      map.replaceChildren();
      if (!people.length) {
        map.append(el('p', 'nb-empty', empties.people));
        return;
      }
      const stage = el('div', 'nb-map-stage');
      const layout = layoutGraph({ people, relations, width: mapWidth, height: mapHeight });
      const { height } = layout,
        pos = layout.nodes;
      stage.style.width = mapWidth + 'px';
      stage.style.height = height + 'px';
      stage.style.setProperty('--nb-node-scale', String(layout.scale));
      map.append(stage);
      const lines = svg('svg', {
        viewBox: '0 0 ' + mapWidth + ' ' + height,
        width: mapWidth,
        height,
        class: 'nb-lines',
        'aria-hidden': 'true'
      });
      const defs = svg('defs', {}),
        marker = svg('marker', {
          id: 'nb-arrow',
          markerWidth: 6,
          markerHeight: 6,
          refX: 5,
          refY: 3,
          orient: 'auto'
        });
      marker.append(svg('path', { d: 'M0,0 L6,3 L0,6Z', fill: '#a6cde2' }));
      defs.append(marker);
      lines.append(defs);
      stage.append(lines);
      const byId = new Map(relations.map((e) => [e.id, e]));
      for (const route of layout.edges) {
        const edge = byId.get(route.id);
        const { start, control, end } = route;
        const path = svg('path', {
          d: 'M ' + start.x + ' ' + start.y + ' Q ' + control.x + ' ' + control.y + ' ' + end.x + ' ' + end.y
        });
        if (edge.direction === 'forward') path.setAttribute('marker-end', 'url(#nb-arrow)');
        if (edge.uncertain) path.setAttribute('stroke-dasharray', '4 4');
        lines.append(path);
        const text = route.text;
        const link = button(text, 'relation', (e) => {
          if (e.detail <= 1) choose(edge.id);
        });
        link.className = 'nb-edge';
        link.dataset.graphId = edge.id;
        link.title = text + (readOnly() ? ' · 查看关系' : ' · 单击展开/收起，双击编辑');
        link.style.left = route.label.x + 'px';
        link.style.top = route.label.y + 'px';
        link.ondblclick = () => choose(edge.id, 'label');
        stage.append(link);
      }
      for (const person of people) {
        const point = pos.get(person.id),
          b = button('', 'character', (e) => {
            if (e.detail <= 1) choose(person.id);
          });
        b.dataset.graphId = person.id;
        b.className = 'nb-person';
        b.title = person.name + ' · 单击展开/收起详情';
        b.ondblclick = () => choose(person.id, 'name');
        b.style.left = point.x + 'px';
        b.style.top = point.y + 'px';
        b.append(
          avatarView(person.name),
          el('span', 'nb-person-name', person.name)
        );
        stage.append(b);
      }
      map.scrollTop = scroll;
    }
    map
      .querySelectorAll('[data-graph-id]')
      .forEach((n) => n.classList.toggle('selected', n.dataset.graphId === selection));
  }
  function render() {
    if (!win.open || !room) return;
    const { pane, body } = paneMap.get(section) || addPane(section);
    syncTabActions(section, pane);
    for (const [key, p] of paneMap) p.pane.hidden = key !== section;
    for (const tab of book.querySelectorAll('[data-notebook-tab]'))
      tab.setAttribute('aria-pressed', String(tab.dataset.notebookTab === section));
    for (const [id, node] of nodes)
      if (!entries.has(id)) {
        const editingHere = node.querySelector('form');
        if (editingHere) {
          node.classList.add('nb-deleted');
          editingHere.querySelector('[data-action=save]').disabled = true;
          tell('这条笔记已移除，草稿仍可复制。');
        } else {
          node.remove();
          nodes.delete(id);
        }
      }
    if (section === 'people') {
      const people = [...entries.values()].filter((e) => e.kind === 'character'),
        relations = [...entries.values()].filter((e) => e.kind === 'relation');
      if (selection && !entries.has(selection)) selection = null;
      const map = body.querySelector('#notebookMap'),
        panel = body.querySelector('#notebookDetails'),
        entry = entries.get(selection);
      const hadSelection = body.classList.contains('has-selection');
      body.classList.toggle('has-selection', Boolean(entry));
      panel.hidden = !entry;
      const previous = panel.querySelector('.nb-entry');
      if (previous?.dataset.entryId !== selection) previous?.remove();
      if (entry) {
        let head = panel.querySelector('.nb-detail-head');
        if (!head) {
          head = el('div', 'nb-detail-head');
          const label = el('span', 'nb-detail-title');
          const closeBtn = button('✕', 'close-detail', () => {
            selection = null;
            render();
          });
          closeBtn.className = 'nb-detail-close';
          closeBtn.title = '收起详情';
          closeBtn.setAttribute('aria-label', '收起详情');
          head.append(label, closeBtn);
          panel.prepend(head);
        }
        head.querySelector('.nb-detail-title').textContent =
          entry.kind === 'character' ? entry.name || '人物详情' : '关系详情';
        const card = articleFor(entry);
        if (!card.isConnected || card.parentElement !== panel) head.after(card);
        if (entry.kind === 'character') {
          let header = card.querySelector('.nb-portrait');
          if (!header) {
            header = el('div', 'nb-portrait');
            card.prepend(header);
          }
          const sig = JSON.stringify([entry.name]);
          if (header.dataset.signature !== sig) {
            header.dataset.signature = sig;
            header.replaceChildren(avatarView(entry.name));
          }
        }
      } else {
        panel.querySelector('.nb-detail-head')?.remove();
      }
      graph(map, people, relations);
      if (hadSelection !== Boolean(entry)) {
        requestAnimationFrame(() => {
          if (win.open && room && section === 'people') graph(map, people, relations);
        });
      }
    } else {
      const relevant = [...entries.values()]
        .filter((e) => sectionOf(e) === section)
        .sort((a, b) => a.eventAtMs - b.eventAtMs || a.id.localeCompare(b.id));
      body.querySelector('.nb-empty')?.remove();
      let cursor = body.firstElementChild;
      for (const e of relevant) {
        const card = articleFor(e);
        if (card !== cursor) body.insertBefore(card, cursor);
        cursor = card.nextElementSibling;
      }
      for (const child of [...body.children]) {
        const e = entries.get(child.dataset.entryId);
        if (e && sectionOf(e) !== section) child.remove();
      }
      if (!relevant.length && !body.children.length) body.append(el('p', 'nb-empty', empties[section]));
    }
    updateBusy();
  }
  return {
    bind: setRoom,
    notify,
    reconnect: () => {
      if (win.open) void refresh();
    }
  };
}
