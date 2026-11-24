const byId = (id) => document.getElementById(id);
const fullPath = (path) => path ? '片库 / ' + path.split('/').join(' / ') : '片库';
const parentPath = (path) => path.split('/').slice(0, -1).join('/');
const pencilIcon = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="m4 20 1-5L16 4a2 2 0 0 1 4 4L9 19zM14 6l4 4"/></svg>';

function button(text, click) {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = text;
  node.addEventListener('click', click);
  return node;
}

export function createLibraryShelf({ request, refresh, filter, getItems, manageFilm, manageFolder, openFolderSettings, manageRetained }) {
  let path = '';
  let organizing = false;
  let library = { folders: [], issues: [], notices: [] };
  let visible = [];
  const selected = new Set();
  const dialog = byId('shelfDialog');
  const name = byId('shelfName');
  const destination = byId('shelfDestination');
  const librarySection = byId('librarySection');
  const selectionBar = byId('shelfSelectionBar');
  const organizeToggle = byId('toggleOrganize');
  const collectionSettings = byId('shelfCollectionSettings');
  let submit;
  const post = (url, data) => request('/api/library/' + url, { method: 'POST', body: JSON.stringify(data) });

  function setOrganizing(next) {
    organizing = Boolean(next);
    if (!organizing) selected.clear();
    if (librarySection) librarySection.classList.toggle('is-organizing', organizing);
    if (selectionBar) selectionBar.hidden = !organizing;
    if (organizeToggle) {
      organizeToggle.setAttribute('aria-pressed', String(organizing));
      organizeToggle.dataset.tip = organizing ? '完成整理' : '整理影片';
      organizeToggle.setAttribute('aria-label', organizing ? '完成整理' : '整理影片（多选、重命名和影片设置）');
    }
    syncSelection();
  }

  function status(message) {
    byId('shelfStatus').textContent = message;
    byId('shelfStatus').hidden = !message;
  }
  function syncSelection() {
    const total = selected.size;
    byId('selectShelf').checked = total > 0 && total === visible.length;
    byId('selectShelf').indeterminate = total > 0 && total < visible.length;
    byId('selectShelf').disabled = visible.length === 0;
    byId('selectionCount').textContent = '已选 ' + total + ' 部';
    byId('clearShelf').disabled = byId('moveShelf').disabled = total === 0;
    for (const check of document.querySelectorAll('[data-shelf-check]')) check.checked = selected.has(check.dataset.shelfCheck);
  }
  function enter(next) {
    path = next;
    selected.clear();
    byId('librarySearch').value = '';
    status('');
    paint();
    filter();
  }
  function paint() {
    const trail = byId('shelfTrail');
    trail.hidden = !path;
    collectionSettings.hidden = !path;
    trail.replaceChildren(button('片库', () => enter('')));
    let prefix = '';
    for (const segment of path.split('/').filter(Boolean)) {
      prefix = prefix ? prefix + '/' + segment : segment;
      const target = prefix;
      trail.append(' / ', button(segment, () => enter(target)));
    }
    trail.lastElementChild.setAttribute('aria-current', 'page');
    const folders = byId('shelfFolders');
    folders.replaceChildren();
    for (const folder of library.folders.filter((folder) => parentPath(folder.path) === path)) {
      const card = document.createElement('div');
      card.className = 'shelf-folder';
      const node = button('', () => enter(folder.path));
      node.className = 'folder-open';
      const label = document.createElement('span');
      label.textContent = folder.name;
      const icon = document.createElement('img');
      icon.src = '/collection-folder.svg';
      icon.alt = '';
      icon.className = 'shelf-folder-icon';
      icon.setAttribute('aria-hidden', 'true');
      node.append(icon, label);
      node.title = fullPath(folder.path);
      const rename = button('', () => manageFolder(folder,
        () => openForm('rename-folder', folder),
        () => (byId('shelfFolders').querySelector('[data-folder-path="' + CSS.escape(folder.path) + '"]') || byId('createFolder')).focus()
      ).catch(error => status(error.message)));
      rename.dataset.folderPath = folder.path;
      rename.className = 'folder-rename';
      rename.setAttribute('aria-label', '管理合集「' + folder.name + '」');
      rename.title = '管理合集';
      rename.innerHTML = pencilIcon;
      card.append(node, rename);
      folders.append(card);
    }
    const retained = byId('retainedFilms');
    retained.replaceChildren();
    for (const film of (library.retainedFilms || []).filter((film) => film.collection === path)) {
      const row = document.createElement('div');
      const label = document.createElement('span');
      label.textContent = film.title + ' · 原片已移除';
      const clean = button('清理剩余资料', () => manageRetained(film, () =>
        (retained.querySelector('[data-retained-id="' + CSS.escape(film.id) + '"]') || byId('createFolder')).focus()
      ).catch(error => status(error.message)));
      clean.dataset.retainedId = film.id;
      clean.setAttribute('aria-label', '清理《' + film.title + '》的剩余资料');
      row.append(label, clean);
      retained.append(row);
    }
    const issues = byId('shelfIssues');
    issues.replaceChildren();
    for (const notice of library.notices || []) {
      const row = document.createElement('p');
      row.textContent = [notice.relativePath, notice.message].filter(Boolean).join(' · ');
      issues.append(row);
    }
    for (const issue of library.issues || []) {
      const ids = new Set((issue.candidates || []).map((candidate) => candidate.id || candidate.mediaId || candidate));
      const candidates = getItems().filter((item) => ids.has(item.id));
      const row = document.createElement('div');
      const label = document.createElement('label');
      label.textContent = (issue.relativePath || issue.name) + ' · 字幕所属影片 ';
      const choice = document.createElement('select');
      choice.add(new Option('请选择影片', ''));
      for (const item of candidates) choice.add(new Option(item.relativePath || item.title, item.id));
      label.append(choice);
      const apply = button('关联字幕', async () => {
        apply.disabled = true;
        try {
          await post('subtitles', { issueId: issue.id, mediaId: choice.value });
          await refresh();
        } catch (error) { status(error.message); apply.disabled = false; }
      });
      apply.disabled = true;
      choice.onchange = () => { apply.disabled = !choice.value; };
      row.append(label, apply);
      issues.append(row);
    }
  }
  function openForm(action, item) {
    const move = action === 'move';
    const folderRename = action === 'rename-folder';
    const rename = action === 'rename';
    const ids = [...selected];
    const title = move ? '移动所选影片' : rename ? '重命名影片' : folderRename ? '重命名合集' : '新建合集';
    byId('shelfTitle').textContent = title;
    byId('shelfContext').textContent = fullPath(path) + (move ? ' · 已选 ' + ids.length + ' 部' : '');
    byId('shelfNameCaption').textContent = move ? '在目标下新建合集（可选）' : rename ? '影片名称（保留扩展名）' : '合集名称';
    byId('shelfDestinationLabel').hidden = !move;
    destination.replaceChildren(new Option('片库', ''));
    for (const folder of library.folders) destination.add(new Option(fullPath(folder.path), folder.path));
    destination.value = path;
    name.value = rename ? item.title : folderRename ? item.name : '';
    name.required = !move;
    byId('shelfError').hidden = true;
    submit = async () => {
      let target = destination.value;
      if (move && name.value) {
        await post('folders', { parentPath: target, name: name.value });
        target = [target, name.value].filter(Boolean).join('/');
        destination.add(new Option(fullPath(target), target));
        destination.value = target;
        name.value = '';
      }
      if (move) await post('move', { mediaIds: ids, collectionPath: target });
      else if (rename) await post('rename', { mediaId: item.id, name: name.value });
      else if (folderRename) await post('rename-folder', { path: item.path, name: name.value });
      else await post('folders', { parentPath: path, name: name.value });
      if (move) selected.clear();
      await refresh();
      status(move ? '已移至 ' + fullPath(target) : rename ? '已更新影片名称。' : folderRename ? '已更新合集名称。' : '已创建合集。');
    };
    dialog.showModal();
    (move ? destination : name).focus();
    if (rename || folderRename) name.select();
  }
  byId('shelfForm').onsubmit = async (event) => {
    event.preventDefault();
    const confirm = byId('shelfSubmit');
    confirm.disabled = true;
    byId('shelfCancel').disabled = true;
    try { await submit(); dialog.close(); }
    catch (error) {
      byId('shelfError').textContent = error.message;
      byId('shelfError').hidden = false;
    } finally { confirm.disabled = false; byId('shelfCancel').disabled = false; }
  };
  dialog.oncancel = (event) => { if (byId('shelfSubmit').disabled) event.preventDefault(); };
  byId('shelfCancel').onclick = () => dialog.close();
  byId('createFolder').onclick = () => openForm('create');
  collectionSettings.onclick = () => {
    const folder = library.folders.find(folder => folder.path === path);
    if (folder) openFolderSettings(folder, () => collectionSettings.focus());
  };
  byId('moveShelf').onclick = () => openForm('move');
  byId('clearShelf').onclick = () => { selected.clear(); syncSelection(); };
  if (organizeToggle) organizeToggle.onclick = () => setOrganizing(!organizing);
  setOrganizing(false);
  byId('selectShelf').onchange = (event) => {
    selected.clear();
    if (event.target.checked) for (const id of visible) selected.add(id);
    syncSelection();
  };
  byId('importFiles').onclick = () => byId('shelfFiles').click();
  byId('shelfFiles').onchange = async (event) => {
    const files = [...event.target.files];
    event.target.value = '';
    const target = path;
    const errors = [];
    byId('importFiles').disabled = true;
    try {
      for (const file of files) {
        status('正在导入 ' + file.name);
        try {
          const query = new URLSearchParams({ name: file.name, collectionPath: target });
          await request('/api/library/import?' + query, { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' } });
        } catch (error) { errors.push(file.name + ' · ' + error.message); }
      }
      await refresh();
      status('已导入 ' + (files.length - errors.length) + ' 个文件至 ' + fullPath(target) + (errors.length ? '。' + errors.join('；') : '。'));
    } finally { byId('importFiles').disabled = false; }
  };
  return {
    get path() { return path; },
    update(data) {
      library = data;
      if (path && !data.folders.some((folder) => folder.path === path)) path = '';
      paint();
    },
    paint,
    visible(ids) {
      visible = ids;
      const eligible = new Set(ids);
      for (const id of selected) if (!eligible.has(id)) selected.delete(id);
      syncSelection();
    },
    controls(item) {
      const wrap = document.createElement('div');
      wrap.className = 'shelf-card-tools';
      const label = document.createElement('label');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.dataset.shelfCheck = item.id;
      check.setAttribute('aria-label', '选择 ' + item.title);
      check.onchange = () => {
        if (check.checked) selected.add(item.id);
        else selected.delete(item.id);
        syncSelection();
      };
      label.append(check, ' 选片');
      const actions = document.createElement('div');
      actions.className = 'shelf-card-actions';
      const rename = button('', () => openForm('rename', item));
      rename.className = 'icon-tool-button';
      rename.title = '重命名';
      rename.setAttribute('aria-label', '重命名 · ' + item.title);
      rename.innerHTML = pencilIcon;
      const settings = button('', () => manageFilm(item, () => {
        const selector = '[data-film-settings="' + CSS.escape(item.id) + '"]';
        (document.querySelector(selector) || organizeToggle).focus();
      }));
      settings.className = 'icon-tool-button';
      settings.title = '影片设置';
      settings.innerHTML = '<span aria-hidden="true">⚙</span>';
      settings.dataset.filmSettings = item.id;
      settings.setAttribute('aria-label', '影片设置 · ' + item.title);
      settings.setAttribute('aria-haspopup', 'dialog');
      settings.setAttribute('aria-controls', 'filmSettingsDialog');
      actions.append(rename, settings);
      wrap.append(label, actions);
      return wrap;
    }
  };
}
