// The server owns the selected profile. An open rename form keeps its original target
// when a different browser changes the default for future connections.
export function createAiProfileSettings(fetchJson) {
  const byId = (id) => document.getElementById(id);
  const select = byId('aiProfileSelect');
  const rename = byId('aiProfileRename');
  const form = byId('aiProfileEditor');
  const input = byId('aiProfileName');
  const label = byId('aiProfileNameLabel');
  const commit = byId('aiProfileCommit');
  const cancel = byId('aiProfileCancel');
  const status = byId('aiProfileStatus');
  const reload = byId('aiProfileReload');
  const endpoint = '/api/participants/ai-profiles';
  let snapshot;
  let editor;
  let saving = false;
  let request = 0;

  function report(message, error = false) {
    status.textContent = message;
    status.classList.toggle('error', error);
  }

  function controls() {
    select.disabled = saving || !snapshot || Boolean(editor);
    rename.disabled = select.disabled || !snapshot?.selectedId;
    commit.disabled = saving;
    cancel.disabled = saving;
    input.disabled = saving;
  }

  function apply(next) {
    if (
      !snapshot ||
      JSON.stringify(next.profiles) !== JSON.stringify(snapshot.profiles) ||
      Boolean(next.selectedId) !== Boolean(snapshot.selectedId)
    ) {
      const idsByName = new Map();
      for (const { name, id } of next.profiles) {
        if (!idsByName.has(name)) idsByName.set(name, []);
        idsByName.get(name).push(id);
      }
      const options = next.profiles.map(({ id, name }) => {
        const group = idsByName.get(name);
        if (group.length === 1) return new Option(name, id);
        const short = id.slice(-8);
        const suffix = group.some((other) => other !== id && other.endsWith(short)) ? id : short;
        return new Option(name + ' · ' + suffix, id);
      });
      if (!next.selectedId) {
        const placeholder = new Option(options.length ? '选择档案' : '还没有 AI 档案', '');
        placeholder.disabled = true;
        options.unshift(placeholder);
      }
      const add = new Option('＋ 添加 AI…', '+');
      add.dataset.action = 'create';
      options.push(add);
      select.replaceChildren(...options);
    }
    snapshot = next;
    select.value = next.selectedId || '';
    reload.hidden = true;
    controls();
  }

  async function refresh() {
    const serial = ++request;
    try {
      const next = await fetchJson(endpoint);
      if (serial !== request) return;
      apply(next);
      if (status.classList.contains('error') && !editor) report('');
    } catch {
      if (serial !== request) return;
      reload.hidden = false;
      report('未能读取 AI 档案，请检查影院连接后重试。', true);
    }
  }

  function closeEditor() {
    editor = null;
    form.hidden = true;
    input.value = '';
    input.setCustomValidity('');
    controls();
  }

  function edit(action) {
    const profile = snapshot.profiles.find((profile) => profile.id === snapshot.selectedId);
    if (action === 'rename' && !profile) return;
    editor = { action, id: action === 'rename' ? profile.id : null };
    if (action === 'rename') {
      label.textContent = '给「' + profile.name + '」改名';
      commit.textContent = '保存新名字';
      input.value = profile.name;
    } else {
      label.textContent = '新 AI 的名字';
      commit.textContent = '添加并选用';
      input.value = '';
    }
    select.value = snapshot.selectedId || '';
    report('');
    form.hidden = false;
    controls();
    input.focus();
    input.select();
  }

  async function save(patch) {
    if (saving) return;
    saving = true;
    controls();
    report('正在保存…');
    try {
      const next = await fetchJson(endpoint, { method: 'POST', body: JSON.stringify(patch) });
      ++request;
      apply(next);
      closeEditor();
      const name = next.profiles.find((profile) => profile.id === (patch.id || next.selectedId))?.name;
      report(patch.action === 'rename' ? '档案已改名为「' + name + '」。' : '新连接将使用「' + name + '」。');
    } catch (error) {
      select.value = snapshot?.selectedId || '';
      if (error.code === 'AI_NAME_TAKEN' || error.status === 409)
        report('这个名字已被其他档案使用。请换个名字，或取消后选用现有档案。', true);
      else if (error.status === 400) report('请填写 1 至 60 个字符的名字，避免重名和换行。', true);
      else {
        report('未能保存档案，请检查影院连接后重试。', true);
        reload.hidden = false;
      }
    } finally {
      saving = false;
      controls();
      if (
        !editor &&
        !form.closest('.cinema-settings-page').hidden &&
        form.closest('dialog').open &&
        document.activeElement === document.body
      )
        select.focus({ preventScroll: true });
    }
  }

  select.addEventListener('change', () => {
    if (select.selectedOptions[0]?.dataset.action === 'create') edit('create');
    else if (select.value) void save({ action: 'select', id: select.value });
  });
  rename.addEventListener('click', () => edit('rename'));
  reload.addEventListener('click', () => void refresh());
  cancel.addEventListener('click', () => {
    closeEditor();
    report('');
    select.focus();
  });
  input.addEventListener('input', () => input.setCustomValidity(''));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) {
      input.setCustomValidity('请填写 AI 名字。');
      input.reportValidity();
      return;
    }
    const { action, id } = editor;
    void save(action === 'rename' ? { action, id, name } : { action, name });
  });
  return { refresh };
}
