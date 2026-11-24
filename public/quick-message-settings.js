export const FALLBACK_NOTEBOOK_QUICK_MESSAGE = Object.freeze({
  id: 'default-notebook',
  title: '整理观影手记',
  content: '方便的话，可以顺手帮我们把刚才看到的剧情和人物整理进观影手记里吗？不用写太长，记下重点就好～',
  isDefault: true
});

export function appendQuickMessage(currentValue, snippet, { maxLength = 800 } = {}) {
  const addition = String(snippet || '').trim();
  const base = String(currentValue || '');
  if (!addition) return base;
  if (!base.trim()) return addition.slice(0, maxLength);
  const separator = /\s$/.test(base) ? '' : ' ';
  return `${base}${separator}${addition}`.slice(0, maxLength);
}

export function createQuickMessageSettings({
  fetchJson,
  onOpenSettings,
  isRoomWritable
}) {
  const byId = (id) => document.getElementById(id);
  const popover = byId('quickMessagePopover');
  const triggers = [
    { button: byId('quickMessageTrigger'), input: byId('quickMessageInput') },
    { button: byId('sidebarQuickMessageTrigger'), input: byId('sidebarMessageInput') }
  ].filter((pair) => pair.button && pair.input);

  const listNode = byId('quickMessageList');
  const statusNode = byId('quickMessageStatus');
  const reloadButton = byId('quickMessageReload');
  const addForm = byId('quickMessageAddForm');
  const addTitleInput = byId('quickMessageNewTitle');
  const addContentInput = byId('quickMessageNewContent');
  const addSubmitButton = byId('quickMessageAddSubmit');

  let items = [{ ...FALLBACK_NOTEBOOK_QUICK_MESSAGE }];
  let defaultNotebook = { ...FALLBACK_NOTEBOOK_QUICK_MESSAGE };
  let editingId = null;
  let saving = false;
  let requestSerial = 0;
  let activeTriggerPair = null;

  function report(message, error = false) {
    if (!statusNode) return;
    statusNode.textContent = message;
    statusNode.classList.toggle('error', error);
  }

  function isPopoverOpen() {
    return Boolean(popover?.matches(':popover-open'));
  }

  function syncTriggerAria() {
    const open = isPopoverOpen();
    for (const pair of triggers) {
      pair.button.setAttribute('aria-expanded', String(open && pair === activeTriggerPair));
    }
  }

  function closePopover() {
    if (isPopoverOpen()) {
      try { popover.hidePopover(); } catch {}
    }
    activeTriggerPair = null;
    syncTriggerAria();
  }

  function placePopover() {
    if (!isPopoverOpen() || !activeTriggerPair) return;
    const anchor = activeTriggerPair.button.getBoundingClientRect();
    if (!anchor.width && !anchor.height) {
      closePopover();
      return;
    }
    const margin = 8;
    const gap = 8;
    const x = Math.max(margin, Math.min(anchor.left, window.innerWidth - popover.offsetWidth - margin));
    const y = anchor.top >= popover.offsetHeight + gap + margin
      ? anchor.top - popover.offsetHeight - gap
      : Math.min(anchor.bottom + gap, window.innerHeight - popover.offsetHeight - margin);
    popover.style.left = `${x}px`;
    popover.style.top = `${Math.max(margin, y)}px`;
  }

  function insertIntoActiveInput(content) {
    const targetInput = activeTriggerPair?.input || triggers[0]?.input;
    closePopover();
    if (!targetInput || targetInput.disabled) return;
    const maxLength = Number(targetInput.getAttribute('maxlength')) || 800;
    targetInput.value = appendQuickMessage(targetInput.value, content, { maxLength });
    targetInput.dispatchEvent(new Event('input', { bubbles: true }));
    targetInput.focus();
    const end = targetInput.value.length;
    try { targetInput.setSelectionRange(end, end); } catch {}
  }

  function renderPopover() {
    if (!popover) return;
    const list = document.createElement('div');
    list.className = 'quick-message-popover-list';
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'quick-message-popover-empty';
      empty.textContent = '还没有快捷消息，可以在设置里添加。';
      list.append(empty);
    } else {
      for (const item of items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'quick-message-popover-item';
        btn.title = item.content;
        const title = document.createElement('strong');
        title.textContent = item.title;
        const preview = document.createElement('span');
        preview.textContent = item.content;
        btn.append(title, preview);
        btn.addEventListener('click', () => insertIntoActiveInput(item.content));
        list.append(btn);
      }
    }

    const foot = document.createElement('div');
    foot.className = 'quick-message-popover-foot';
    const manageBtn = document.createElement('button');
    manageBtn.type = 'button';
    manageBtn.className = 'quick-message-manage-link';
    manageBtn.textContent = '管理快捷消息…';
    manageBtn.addEventListener('click', () => {
      closePopover();
      onOpenSettings?.();
    });
    foot.append(manageBtn);

    popover.replaceChildren(list, foot);
  }

  function isDefaultModified(item) {
    return item.isDefault && (
      item.title !== defaultNotebook.title ||
      item.content !== defaultNotebook.content
    );
  }

  async function persist(nextItems, successMessage) {
    if (saving) return false;
    saving = true;
    syncSettingsControls();
    report('正在保存…');
    try {
      const payload = await fetchJson('/api/quick-messages', {
        method: 'POST',
        body: JSON.stringify({ items: nextItems })
      });
      requestSerial += 1;
      apply(payload);
      editingId = null;
      renderSettingsList();
      report(successMessage);
      return true;
    } catch (error) {
      report(error.message || '暂时无法保存快捷消息，请重试。', true);
      return false;
    } finally {
      saving = false;
      syncSettingsControls();
    }
  }

  function syncSettingsControls() {
    if (addTitleInput) addTitleInput.disabled = saving;
    if (addContentInput) addContentInput.disabled = saving;
    if (addSubmitButton) addSubmitButton.disabled = saving;
    if (listNode) {
      for (const control of listNode.querySelectorAll('button, input, textarea')) {
        control.disabled = saving;
      }
    }
  }

  function renderSettingsList() {
    if (!listNode) return;
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'quick-message-empty';
      empty.textContent = '当前没有快捷消息。可以在下方新增，或恢复默认手记提示词。';
      listNode.replaceChildren(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'quick-message-item-card';
      card.dataset.quickMessageId = item.id;

      if (editingId === item.id) {
        const form = document.createElement('form');
        form.className = 'quick-message-edit-form';

        const titleLabel = document.createElement('label');
        titleLabel.className = 'viewing-cadence-label';
        const titleSpan = document.createElement('span');
        titleSpan.textContent = '标题';
        const titleInput = document.createElement('input');
        titleInput.type = 'text';
        titleInput.maxLength = 40;
        titleInput.required = true;
        titleInput.value = item.title;
        titleLabel.append(titleSpan, titleInput);

        const contentLabel = document.createElement('label');
        contentLabel.className = 'viewing-cadence-label';
        const contentSpan = document.createElement('span');
        contentSpan.textContent = '内容';
        const contentInput = document.createElement('textarea');
        contentInput.rows = 3;
        contentInput.maxLength = 800;
        contentInput.required = true;
        contentInput.value = item.content;
        contentLabel.append(contentSpan, contentInput);

        const actions = document.createElement('div');
        actions.className = 'settings-actions quick-message-item-actions';

        if (item.isDefault) {
          const restoreBtn = document.createElement('button');
          restoreBtn.type = 'button';
          restoreBtn.className = 'room-button';
          restoreBtn.textContent = '恢复默认提示词';
          restoreBtn.addEventListener('click', () => {
            titleInput.value = defaultNotebook.title;
            contentInput.value = defaultNotebook.content;
          });
          actions.append(restoreBtn);
        }

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'room-button';
        cancelBtn.textContent = '取消';
        cancelBtn.addEventListener('click', () => {
          editingId = null;
          report('');
          renderSettingsList();
        });

        const saveBtn = document.createElement('button');
        saveBtn.type = 'submit';
        saveBtn.className = 'room-button settings-primary-button';
        saveBtn.textContent = '保存';

        actions.append(cancelBtn, saveBtn);
        form.append(titleLabel, contentLabel, actions);
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const title = titleInput.value.trim();
          const content = contentInput.value.trim();
          if (!title || !content) {
            report('请填写快捷消息的标题和内容。', true);
            return;
          }
          const next = items.map((entry) => (
            entry.id === item.id ? { ...entry, title, content } : entry
          ));
          await persist(next, '快捷消息已保存。');
        });
        card.append(form);
      } else {
        const head = document.createElement('div');
        head.className = 'quick-message-item-head';

        const titleWrap = document.createElement('div');
        titleWrap.className = 'quick-message-item-title';
        const title = document.createElement('strong');
        title.textContent = item.title;
        titleWrap.append(title);
        if (item.isDefault) {
          const badge = document.createElement('span');
          badge.className = 'quick-message-default-badge';
          badge.textContent = '默认';
          titleWrap.append(badge);
        }

        const actions = document.createElement('div');
        actions.className = 'settings-actions quick-message-item-actions';

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'room-button quick-message-mini-btn';
        editBtn.textContent = '编辑';
        editBtn.addEventListener('click', () => {
          editingId = item.id;
          report('');
          renderSettingsList();
        });
        actions.append(editBtn);

        if (isDefaultModified(item)) {
          const restoreBtn = document.createElement('button');
          restoreBtn.type = 'button';
          restoreBtn.className = 'room-button quick-message-mini-btn';
          restoreBtn.textContent = '恢复默认';
          restoreBtn.addEventListener('click', async () => {
            const next = items.map((entry) => (
              entry.id === item.id ? { ...defaultNotebook } : entry
            ));
            await persist(next, '已恢复默认提示词。');
          });
          actions.append(restoreBtn);
        }

        if (!item.isDefault) {
          const deleteBtn = document.createElement('button');
          deleteBtn.type = 'button';
          deleteBtn.className = 'room-button danger quick-message-mini-btn';
          deleteBtn.textContent = '删除';
          deleteBtn.addEventListener('click', async () => {
            const next = items.filter((entry) => entry.id !== item.id);
            await persist(next, `已删除「${item.title}」。`);
          });
          actions.append(deleteBtn);
        }

        head.append(titleWrap, actions);

        const body = document.createElement('p');
        body.className = 'quick-message-item-content';
        body.textContent = item.content;

        card.append(head, body);
      }

      fragment.append(card);
    }
    listNode.replaceChildren(fragment);
    syncSettingsControls();
  }

  function apply(payload) {
    if (Array.isArray(payload?.items)) {
      items = payload.items;
    }
    if (payload?.defaults?.notebook) {
      defaultNotebook = payload.defaults.notebook;
    }
    if (reloadButton) reloadButton.hidden = true;
    renderPopover();
    renderSettingsList();
  }

  async function refresh() {
    const serial = ++requestSerial;
    try {
      const payload = await fetchJson('/api/quick-messages');
      if (serial !== requestSerial) return;
      apply(payload);
      if (statusNode?.classList.contains('error') && !editingId) report('');
    } catch {
      if (serial !== requestSerial) return;
      if (reloadButton) reloadButton.hidden = false;
      report('未能读取快捷消息，请检查影院连接后重试。', true);
    }
  }

  function updateControls() {
    const writable = Boolean(isRoomWritable?.());
    for (const pair of triggers) {
      pair.button.disabled = !writable;
    }
    if (!writable) closePopover();
  }

  if (popover) {
    for (const pair of triggers) {
      pair.button.addEventListener('click', () => {
        activeTriggerPair = pair;
      });
    }
    popover.addEventListener('toggle', () => {
      if (!isPopoverOpen()) activeTriggerPair = null;
      syncTriggerAria();
      placePopover();
    });
    window.addEventListener('scroll', placePopover, { passive: true, capture: true });
    window.addEventListener('resize', placePopover);
    document.addEventListener('fullscreenchange', () => requestAnimationFrame(placePopover));
  }

  reloadButton?.addEventListener('click', () => void refresh());

  addForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = addTitleInput.value.trim();
    const content = addContentInput.value.trim();
    if (!title || !content) {
      report('请填写快捷消息的标题和内容。', true);
      return;
    }
    const ok = await persist([...items, { title, content }], `已添加「${title}」。`);
    if (ok) {
      addTitleInput.value = '';
      addContentInput.value = '';
    }
  });

  renderPopover();
  renderSettingsList();
  updateControls();

  return { refresh, updateControls, closePopover };
}
