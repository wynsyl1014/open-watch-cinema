// This inspector reads responses already delivered to MCP. It never invokes a tool.
export const CHAT_SCREENING_STATUS = {
  waiting_card: '等待 ChatGPT 卡片开启跟片。',
  waiting_room: '卡片已开启，等待影院开房。',
  connecting: '正在连接 ChatGPT…',
  waiting_receipt: '等待 ChatGPT 回执。',
  cooldown: '已收到回执，等待下一批交付。',
  unconfirmed: '本轮交付未确认，请查看原 ChatGPT 对话。',
  watching: 'ChatGPT 已连接。'
};

const rootPath = '/api/ai/activity';
const pageSize = 40;

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});
function clock(timestamp) {
  return Number.isFinite(timestamp) ? dateFormatter.format(timestamp) : '—';
}

function retry(host, message, action) {
  const button = element('button', 'activity-link', '重试');
  button.type = 'button';
  button.onclick = action;
  host.replaceChildren(document.createTextNode(message + ' '), button);
}

function friendlyTool(call) {
  const titles = {
    open_watch_cinema_tick: '领取观影内容',
    cinema_notebook: '观影手记',
    cinema_inspect_frame: '查看分镜',
    cinema_post_message: '发送消息',
    cinema_settings: '查看设置',
    cinema_manage: '影院管理'
  };
  return titles[call.tool] || call.tool || '工具调用';
}

function renderResult(host, result, loadImage) {
  host.replaceChildren();
  if (!result.available) {
    host.textContent = '这次调用的返回正文未能保存。';
    return;
  }
  if (!result.content?.length) {
    host.textContent = '这次调用没有返回内容块。';
    return;
  }
  for (const [index, block] of result.content.entries()) {
    const figure = element('figure', 'activity-block');
    if (block.type === 'text') {
      const caption = element('figcaption', '', '文字 · ' + (index + 1));
      const text = element('pre', '', block.text);
      figure.append(caption, text);
    } else if (block.type === 'image') {
      const caption = element('figcaption', '', '图片 · ' + (index + 1));
      const image = element('img');
      image.alt = '工具返回的第 ' + (index + 1) + ' 块内容';
      image.loading = 'lazy';
      image.decoding = 'async';
      if (loadImage) {
        const button = element('button', 'activity-link', '加载图片');
        button.type = 'button';
        button.onclick = async () => {
          button.disabled = true;
          try {
            const src = await loadImage(block);
            if (!button.isConnected) return;
            image.src = src;
            image.onerror = () => { caption.textContent = '图片 · 暂时无法读取'; };
            button.replaceWith(image);
          } catch {
            button.textContent = '重新加载图片';
            button.disabled = false;
          }
        };
        figure.append(caption, button);
        host.append(figure);
        continue;
      }
      const url = new URL(block.url, location.origin);
      if (url.origin !== location.origin) {
        figure.append(caption, '图片不可用。');
      } else {
        image.src = url.href;
        image.onerror = () => {
          caption.textContent = '图片 · 暂时无法读取';
        };
        figure.append(caption, image);
      }
    } else {
      figure.append(
        element('figcaption', '', '返回内容 · ' + (index + 1)),
        element('pre', '', JSON.stringify(block, null, 2))
      );
    }
    host.append(figure);
  }
}

function callRow(connectionId, initial, fetchJson, fetchImage) {
  const node = element('details', 'activity-call');
  node.dataset.callId = initial.callId;
  const summary = element('summary');
  const when = element('time', 'activity-when');
  const title = element('span', 'activity-tool');
  const code = element('code', 'activity-code');
  const state = element('span', 'activity-call-state');
  summary.append(when, title, code, state);
  const body = element('div', 'activity-result');
  node.append(summary, body);
  let call = initial;
  let pending = false;
  let loaded = false;

  async function load() {
    if (!node.open || pending || loaded) return;
    if (!call.finishedAt) {
      body.textContent = '正在等待这次调用返回。';
      return;
    }
    if (!call.resultAvailable) {
      body.textContent = '这次调用的返回正文未能保存。';
      return;
    }
    pending = true;
    body.textContent = '正在读取返回内容…';
    try {
      const path =
        rootPath + '/' + encodeURIComponent(connectionId) + '/calls/' + encodeURIComponent(call.callId);
      const result = await fetchJson(path);
      if (!node.open || !node.isConnected) return;
      renderResult(body, result, fetchImage && (block => fetchImage(connectionId, call.callId, block.index)));
      loaded = true;
    } catch {
      if (node.open) retry(body, '未能读取返回内容。', load);
    } finally {
      pending = false;
    }
  }
  node.addEventListener('toggle', () => {
    if (node.open) void load();
    else {
      loaded = false;
      body.replaceChildren();
    }
  });
  function update(next) {
    call = next;
    setText(when, clock(call.finishedAt || call.startedAt));
    setText(title, friendlyTool(call));
    setText(
      code,
      [friendlyTool(call) === call.tool ? '' : call.tool, call.action].filter(Boolean).join(' · ')
    );
    code.hidden = !code.textContent;
    const status = !call.finishedAt ? '运行中' : call.isError ? '错误' : '已返回';
    setText(state, status + (call.imageCount ? ' · ' + call.imageCount + ' 图' : ''));
    state.classList.toggle('is-error', Boolean(call.isError));
    if (node.open && !loaded) void load();
  }
  update(initial);
  return { node, update };
}

// Keep an already loaded window when calls are prepended. Late or out-of-order
// reports can create a gap, so expose the next page from the new head in that case.
export function nextOlderOffset(result, previousHead, previousTotal, previousOffset) {
  const headShift = previousHead ? result.calls.findIndex((call) => call.callId === previousHead) : -1;
  if (headShift < 0 || headShift !== result.totalCalls - previousTotal) return result.nextOffset;
  if (previousOffset === null) return null;
  const next = previousOffset + headShift;
  return next < result.totalCalls ? next : null;
}

function connectionRow(initial, fetchJson, getRoom, formatTime, fetchImage) {
  const node = element('details', 'activity-connection');
  node.dataset.connectionId = initial.connectionId;
  const summary = element('summary');
  const label = element('span', 'activity-connection-name');
  const state = element('span', 'activity-state');
  const count = element('span', 'activity-count activity-tool-count');
  const countLabel = element('span');
  const toolIcon = document.querySelector('#aiActivityButton svg');
  if (toolIcon) count.append(toolIcon.cloneNode(true));
  count.append(countLabel);
  const delivered = element('span', 'activity-delivered');
  summary.append(label, state, count, delivered);
  const dates = element('p', 'activity-dates');
  const list = element('div', 'activity-timeline');
  const notice = element('div', 'activity-note');
  const more = element('button', 'activity-more', '更早的调用');
  more.type = 'button';
  more.hidden = true;
  node.append(summary, dates, list, notice, more);
  const rows = new Map();
  let connection = initial;
  let revision;
  let headId = null;
  let knownTotal = 0;
  let nextOffset = 0;
  let pending = false;
  let changed = false;

  function visible() {
    return node.open && !node.closest('#aiActivityPanel')?.hidden && node.closest('.activity-person')?.open;
  }
  function updateProgress() {
    const p = connection.progress;
    const current = getRoom();
    const context = p && p.roomId !== current?.id ? '上次房间 ' : '';
    setText(delivered, '已送达 ' + (p && Number.isFinite(p.mediaMs) ? context + formatTime(p.mediaMs) : '—'));
  }
  async function load(older = false) {
    if (!visible()) return;
    if (pending) {
      if (!older) changed = true;
      return;
    }
    const offset = older ? nextOffset : 0;
    if (offset === null) return;
    const seenRevision = revision;
    pending = true;
    more.disabled = true;
    if (!list.childElementCount) notice.textContent = '正在读取调用…';
    try {
      const result = await fetchJson(
        rootPath +
          '/' +
          encodeURIComponent(connection.connectionId) +
          '/calls?offset=' +
          offset +
          '&limit=' +
          pageSize
      );
      if (!node.isConnected) return;
      const calls = result.calls || [];
      // The server orders completed calls by finish time. Reports can arrive late.
      // Reuse rows by ID so a newer page never replaces an expanded response.
      let previous = null;
      for (const [index, call] of calls.entries()) {
        let row = rows.get(call.callId);
        if (row) row.update(call);
        else {
          row = callRow(connection.connectionId, call, fetchJson, fetchImage);
          rows.set(call.callId, row);
          row.node.dataset.finished = String(call.finishedAt);
          let anchor = previous?.nextElementSibling;
          if (!previous) {
            const nextKnown = calls.slice(index + 1).find((other) => rows.has(other.callId));
            anchor = nextKnown
              ? rows.get(nextKnown.callId).node
              : Array.from(list.children).find((other) => Number(other.dataset.finished) < call.finishedAt);
          }
          list.insertBefore(row.node, anchor || null);
        }
        previous = row.node;
      }
      if (older) {
        nextOffset = result.nextOffset;
      } else {
        nextOffset = nextOlderOffset(result, headId, knownTotal, nextOffset);
        headId = calls[0]?.callId || null;
      }
      knownTotal = result.totalCalls;
      more.hidden = nextOffset == null;
      notice.textContent = result.totalCalls ? '' : '这条连接还没有工具调用。';
    } catch {
      retry(notice, '未能读取调用记录。', () => void load(older));
    } finally {
      pending = false;
      more.disabled = false;
      if (changed || seenRevision !== revision) {
        changed = false;
        if (visible()) void load();
      }
    }
  }
  function update(next) {
    connection = next;
    const signature = [next.callCount, next.lastCall?.callId, next.lastCall?.finishedAt].join('/');
    const stale = signature !== revision;
    revision = signature;
    const shortId = String(next.connectionId).slice(-8);
    const transport = next.transport === 'codex' ? 'Codex'
      : next.transport === 'chat' ? 'ChatGPT Listener' : shortId;
    setText(label, (next.profileId ? next.name : '未绑定档案') + ' · ' + transport);
    label.title = String(next.connectionId);
    const presence = next.online ? (next.paused ? '在线 · 影片暂停中' : '在线') : next.connecting ? '连接中' : '离线';
    setText(state, presence);
    state.classList.toggle('is-online', Boolean(next.online));
    setText(
      countLabel,
      next.callCount +
        ' 次调用' +
        (next.droppedCalls ? ' · 另有 ' + next.droppedCalls + ' 次调用未收到详情' : '')
    );
    setText(
      dates,
      '接入 ' +
        clock(next.connectedAt) +
        (next.closedAt ? '　断开 ' + clock(next.closedAt) : '　上次联系 ' + clock(next.lastSeenAt))
    );
    updateProgress();
    if (stale && visible()) void load();
  }
  more.onclick = () => void load(true);
  node.ontoggle = () => {
    if (visible()) void load();
  };
  update(initial);
  return { node, update, refresh: () => void load(), updateProgress };
}

export function createAiActivity({ fetchJson, formatTime, getRoom, getPosition, fetchImage, embedded = false }) {
  const byId = (id) => document.getElementById(id);
  const button = byId('aiActivityButton'),
    panel = byId('aiActivityPanel'),
    badge = byId('aiActivityBadge');
  const groups = byId('aiActivityConnections'),
    notice = byId('aiActivityNotice');
  const connections = new Map(),
    people = new Map();
  let snapshot = null,
    pending = false,
    dirty = false,
    timer,
    generation = 0;
  const currentRoom = embedded ? () => snapshot?.room : getRoom;

  let progressRoomId;
  function updatePlayhead() {
    if (panel.hidden) return;
    const room = currentRoom();
    if (progressRoomId !== room?.id) {
      progressRoomId = room?.id;
      for (const connection of connections.values()) connection.updateProgress();
    }
    setText(byId('aiActivityFilm'), room?.mediaTitle || '当前没有活动房间');
    setText(byId('aiActivityTime'), room ? formatTime(getPosition?.() ?? room.lastPositionMs) : '');
  }
  function person(key) {
    if (people.has(key)) return people.get(key);
    const node = element('details', 'activity-person');
    const summary = element('summary'),
      name = element('span', 'activity-person-name'),
      count = element('span', 'activity-count');
    summary.append(name, count);
    const body = element('div', 'activity-person-connections');
    node.append(summary, body);
    groups.append(node);
    node.ontoggle = () => {
      if (node.open && !panel.hidden) {
        for (const child of body.children) connections.get(child.dataset.connectionId)?.refresh();
      }
    };
    const group = { node, body, name, count };
    people.set(key, group);
    return group;
  }
  function render() {
    if (!snapshot) return;
    const online = snapshot.connections.filter((c) => c.online).length;
    if (!embedded) {
      button.classList.toggle('is-online', online > 0);
      setText(byId('aiActivityPresence'), online + ' 在线');
      setText(badge, snapshot.totalCalls + ' 次');
      button.dataset.tip = `AI 工具动态 · ${online} 在线 · ${snapshot.totalCalls} 次调用`;
      button.setAttribute(
        'aria-label',
        'AI 工具动态，' + online + ' 条在线，共 ' + snapshot.totalCalls + ' 次调用'
      );
    }
    if (panel.hidden) return;
    const counts = new Map(),
      retained = new Set();
    setText(byId('aiActivityStats'), online + ' 条在线连接 · 共 ' + snapshot.totalCalls + ' 次调用');
    for (const c of snapshot.connections) {
      const key = c.profileId || '';
      const group = person(key);
      const stats = counts.get(key) || { online: 0, calls: 0, total: 0 };
      stats.online += Number(c.online);
      stats.calls += c.callCount;
      stats.total++;
      counts.set(key, stats);
      setText(group.name, c.profileId ? c.name : '尚未绑定档案');
      retained.add(c.connectionId);
      let row = connections.get(c.connectionId);
      if (!row) {
        row = connectionRow(c, fetchJson, currentRoom, formatTime, fetchImage);
        connections.set(c.connectionId, row);
      } else row.update(c);
      if (row.node.parentElement !== group.body) {
        const previous = row.node.closest('.activity-person');
        const focus = row.node.contains(document.activeElement) ? document.activeElement : null;
        if (previous?.open && (focus || row.node.open)) group.node.open = true;
        group.body.append(row.node);
        if (focus) focus.focus({ preventScroll: true });
      }
    }
    for (const [key, group] of people) {
      const s = counts.get(key);
      if (s) setText(group.count, s.online + ' / ' + s.total + ' 条连接在线 · ' + s.calls + ' 次调用');
      else {
        group.node.remove();
        people.delete(key);
      }
    }
    for (const [id, row] of connections)
      if (!retained.has(id)) {
        row.node.remove();
        connections.delete(id);
      }
    const chatStatus = snapshot.chatStatus === 'watching' ? '' : CHAT_SCREENING_STATUS[snapshot.chatStatus];
    notice.textContent = snapshot.chatError || snapshot.codexError || chatStatus ||
      (snapshot.connections.length ? '' : '尚无 AI 工具调用。');
    updatePlayhead();
  }
  function forgetConnections() {
    connections.clear();
    people.clear();
    groups.replaceChildren();
  }
  function clear() {
    generation++;
    snapshot = null;
    progressRoomId = undefined;
    forgetConnections();
    setText(byId('aiActivityStats'), '');
    setText(byId('aiActivityFilm'), '');
    setText(byId('aiActivityTime'), '');
    setText(notice, '正在读取连接状态…');
  }
  async function refresh() {
    if (embedded && panel.hidden) return;
    if (pending) {
      dirty = true;
      return;
    }
    pending = true;
    const requestedGeneration = generation;
    try {
      const next = await fetchJson(rootPath);
      if (requestedGeneration !== generation) return;
      if (snapshot && next.runId !== snapshot.runId) forgetConnections();
      snapshot = next;
      render();
    } catch {
      if (requestedGeneration !== generation) return;
      if (embedded) clear();
      if (!snapshot && badge) setText(badge, '—');
      if (!panel.hidden) retry(notice, '暂时无法读取连接状态。', refresh);
    } finally {
      pending = false;
      if (dirty) {
        dirty = false;
        notify();
      }
    }
  }
  function notify() {
    if (timer || (embedded && panel.hidden)) return;
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, 200);
  }
  function open(show) {
    panel.hidden = !show;
    button?.setAttribute('aria-expanded', String(show));
    if (show) {
      render();
      void refresh();
      for (const c of connections.values()) c.refresh();
      if (!embedded) panel.querySelector('.activity-header').scrollIntoView({ block: 'nearest' });
    } else if (embedded) {
      clearTimeout(timer);
      timer = null;
      clear();
    } else button?.focus({ preventScroll: true });
  }
  if (!embedded) {
    button.onclick = () => open(panel.hidden);
    byId('aiActivityClose').onclick = () => open(false);
    panel.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        open(false);
      }
    };
    notify();
  }
  return { notify, updatePlayhead, setVisible: open, clear };
}
