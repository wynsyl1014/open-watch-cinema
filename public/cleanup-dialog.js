const byId = (id) => document.getElementById(id);
const byteCount = (n) => Number(n || 0).toLocaleString('zh-CN') + ' 字节';
const categories = [
  ['video', '影片文件', 'videoCount', '个', 'videoBytes'],
  ['subtitles', '字幕文件', 'subtitleCount', '个', 'subtitleBytes'],
  ['package', '观影包', 'packageCount', '个', 'packageBytes'],
  ['records', '观影记录（历史房间和小本本）', 'sessionCount', '个房间']
];

function describePaths(paths) {
  return (paths || []).map((path) => typeof path === 'string' ? path : [path.relativePath || path.path || path.name || path.from, path.to || path.message].filter(Boolean).join(' → '));
}

export function createCleanupDialog({ request, completed, formatDate }) {
  const dialog = byId('cleanupDialog');
  const scope = byId('cleanupScope');
  const options = byId('cleanupOptions');
  const mode = byId('collectionOperation');
  const confirm = byId('cleanupConfirm');
  const cancel = byId('cleanupCancel');
  const feedback = byId('cleanupFeedback');
  const error = byId('cleanupError');
  let context, preview, busy = false, opening = false;

  function details(title, lines) {
    if (!lines.length) return;
    const group = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = title + '（' + lines.length + '）';
    const list = document.createElement('ul');
    for (const text of lines) {
      const row = document.createElement('li');
      row.textContent = text;
      list.append(row);
    }
    group.append(summary, list);
    byId('cleanupDetails').append(group);
  }
  function checkbox(key, caption, enabled) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = key;
    input.disabled = !enabled;
    label.append(input, caption);
    options.append(label);
  }
  function selection() {
    const selected = Object.fromEntries(categories.map(([key]) => [key, false]));
    selected.folder = false;
    for (const input of options.querySelectorAll('input')) selected[input.name] = !input.disabled && input.checked;
    return selected;
  }
  function filmClearsAll(values) {
    if (context?.collection || !preview?.folderCount || preview.unknownPaths?.length) return false;
    const subtitleFiles = preview.subtitleFileCount ?? preview.subtitleCount;
    const hasRecords = Boolean(preview.sessionCount || preview.entryCount);
    const hasAny = Boolean(preview.videoCount || subtitleFiles || preview.packageCount || hasRecords);
    if (!hasAny) return values.folder;
    return (!preview.videoCount || values.video)
      && (!subtitleFiles || values.subtitles)
      && (!preview.packageCount || values.package)
      && (!hasRecords || values.records);
  }
  function update() {
    const operation = context.collection ? mode.value : 'cleanup';
    scope.hidden = operation !== 'cleanup';
    const subtitleFiles = preview.subtitleFileCount ?? preview.subtitleCount;
    const empty = preview.folderCount <= 1 && !preview.films?.length && !preview.videoCount && !subtitleFiles && !preview.packageCount && !preview.unknownPaths?.length;
    const selected = selection();
    const folder = options.querySelector('[name=folder]');
    if (folder) {
      folder.disabled = Boolean(preview.unknownPaths?.length
        || categories.slice(0, 3).some(([key,,count]) => (key === 'subtitles' ? subtitleFiles : preview[count]) && !selected[key])
        || (!context.collection && (preview.sessionCount || preview.entryCount) && !selected.records));
      if (folder.disabled) folder.checked = false;
    }
    const values = selection();
    const autoRemoveFilmFolder = !context.collection && !folder && filmClearsAll(values);
    const removingFolder = values.folder || autoRemoveFilmFolder;
    const fileBytes = categories.reduce((sum, [key,,,,bytes]) => sum + (values[key] && bytes ? preview[bytes] || 0 : 0), 0);
    let disabled = busy || Boolean(preview.busy);
    if (operation === 'rename') {
      feedback.textContent = '下一步填写新的合集名称。';
      confirm.textContent = '填写新名称';
      disabled = busy;
    } else if (operation === 'dissolve') {
      feedback.textContent = '把合集内的内容移到上一级，再移除这个合集。';
      confirm.textContent = '确认解散合集';
      disabled ||= !preview.canDissolve;
    } else if (operation === 'empty') {
      feedback.textContent = empty ? '仅移除空的合集目录。' : '合集里仍有文件。请先移出，或选择批量清理。';
      confirm.textContent = '确认删除空合集';
      disabled ||= !empty;
    } else {
      const labels = categories.filter(([key]) => values[key]).map(([,label]) => label);
      if (removingFolder) labels.push(context.collection ? '合集目录' : '空的影片目录');
      const effect = [];
      if (labels.length) {
        effect.push('将清理' + labels.join('、') + '。文件共 ' + byteCount(fileBytes) + '。');
        if (values.video) effect.push('原片移除后无法播放。');
        if (values.package) effect.push('再次让 AI 同看时需重新准备观影包。');
        if (values.records) effect.push('本次范围内的房间、聊天和小本本将一并删除。');
        if (!context.collection && removingFolder) effect.push('清理后将从片库移除这张片卡。');
      } else {
        effect.push('勾选要清理的项目。未勾选的内容会保留。');
      }
      feedback.textContent = effect.join(' ');
      confirm.textContent = '确认清理所选内容';
      disabled ||= !labels.length;
    }
    confirm.disabled = disabled;
  }
  function close() {
    const restore = context?.restoreFocus;
    context = null;
    dialog.close();
    restore?.();
  }
  cancel.onclick = close;
  dialog.oncancel = (event) => { event.preventDefault(); if (!busy) close(); };
  options.onchange = update;
  mode.onchange = update;
  confirm.onclick = async () => {
    if (busy || confirm.disabled) return;
    const operation = context.collection ? mode.value : 'cleanup';
    if (operation === 'rename') {
      const rename = context.rename;
      close();
      rename();
      return;
    }
    const selected = selection();
    if (operation === 'empty') {
      for (const key of Object.keys(selected)) selected[key] = key === 'folder';
    } else if (!context.collection && filmClearsAll(selected)) {
      selected.folder = true;
    }
    const body = { target: context.target, token: preview.token };
    if (operation === 'dissolve') body.action = 'dissolve';
    else body.selected = selected;
    busy = true;
    cancel.disabled = confirm.disabled = scope.disabled = mode.disabled = true;
    try {
      await request('/api/library/cleanup', { method: 'POST', body: JSON.stringify(body) });
      await completed(preview.mediaIds, body.selected || {});
      close();
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    } finally {
      busy = false;
      cancel.disabled = scope.disabled = mode.disabled = false;
      if (context) update();
    }
  };
  return async function open(action) {
    if (opening || dialog.open) return;
    opening = true;
    try {
      const result = await request('/api/library/cleanup-preview', {method:'POST', body:JSON.stringify(action.target)});
      context = action;
      preview = result.preview;
      byId('cleanupTitle').textContent = action.collection ? '管理合集' : '清理影片资料';
      byId('cleanupContext').textContent = action.name;
      byId('collectionOperationLabel').hidden = !action.collection;
      mode.value = action.collection ? 'rename' : 'cleanup';
      options.replaceChildren();
      let hasFilmAssets = false;
      for (const [key, label, field, unit, bytes] of categories) {
        const count = (key === 'subtitles' ? (preview.subtitleFileCount ?? preview.subtitleCount) : preview[field]) || 0;
        let caption = label + ' · ' + count + ' ' + unit;
        if (bytes) caption += ' · ' + byteCount(preview[bytes]);
        if (key === 'records') caption += ' · ' + preview.messageCount + ' 条消息 · ' + preview.notebookCount + ' 本手记 · ' + preview.entryCount + ' 条笔记';
        const enabled = count > 0 || (key === 'records' && preview.entryCount > 0);
        if (enabled) hasFilmAssets = true;
        checkbox(key, caption, enabled);
      }
      if (action.collection) {
        checkbox('folder', '同时移除清空后的合集目录 · ' + preview.folderCount + ' 个目录', false);
      } else if (!hasFilmAssets && preview.folderCount > 0) {
        checkbox('folder', '移除空的影片目录与片卡', !preview.unknownPaths?.length);
        const folderInput = options.querySelector('[name=folder]');
        if (folderInput && !folderInput.disabled) folderInput.checked = true;
      }
      byId('cleanupDetails').replaceChildren();
      details('涉及影片', (preview.films || []).map(film => film.title + (film.relativePath ? ' · ' + film.relativePath : '') + (film.hasVideo === false ? ' · 原片已移除' : '')));
      details('房间记录', (preview.rooms || []).map(room => room.mediaTitle + ' · ' + formatDate(room.openedAt) + ' · ' + room.messageCount + ' 条消息'));
      const warnings = [];
      if (preview.busy) warnings.push('有房间或准备任务正在使用这些资料，结束后可清理。' + (preview.busyFilms?.length ? '涉及影片：' + preview.busyFilms.join('、') : ''));
      if (preview.unknownPaths?.length) warnings.push('以下未识别文件会保留：' + describePaths(preview.unknownPaths).join('、'));
      if (preview.moveConflicts?.length) warnings.push('解散合集时会发生同名冲突：' + describePaths(preview.moveConflicts).join('、'));
      byId('cleanupWarnings').textContent = warnings.join('\n');
      error.hidden = true;
      update();
      dialog.showModal();
      cancel.focus();
    } finally { opening = false; }
  };
}
