const byId = (id) => document.getElementById(id);
const busyJob = (job) => ['queued', 'processing'].includes(job?.status);
const failedJob = (job) => ['failed', 'interrupted'].includes(job?.status);
const chineseLanguageNames = new Intl.DisplayNames('zh-CN', { type: 'language', fallback: 'none', languageDisplay: 'standard' });
const englishLanguageNames = new Intl.DisplayNames('en', { type: 'language', fallback: 'none', languageDisplay: 'standard' });
const chineseVariants = {
  'zh-Hans': ['简体中文', '中文简体', '简体', '简中', '简字', 'Simplified Chinese', 'Chinese Simplified', 'Simplified', 'CHS', 'zh-Hans', 'zh-CN'],
  'zh-Hant': ['繁体中文', '繁體中文', '中文繁體', '繁体', '繁體', '繁中', '繁字', 'Traditional Chinese', 'Chinese Traditional', 'Traditional', 'CHT', 'zh-Hant', 'zh-TW']
};

function languageName(names, code) {
  try {
    return names.of(code);
  } catch {
    return undefined;
  }
}

function subtitleTrackName(track) {
  const code = (track.language || '').trim();
  const normalizedCode = code.toLowerCase().replaceAll('_', '-');
  const languageCode = ['en', 'zh', 'zh-Hans', 'zh-Hant'].includes(track.languageGroup)
    ? track.languageGroup : normalizedCode;
  const names = chineseVariants[languageCode];
  const language = names?.[0] || languageName(chineseLanguageNames, languageCode);
  if (!language && track.group === 'external') return track.fileName || track.title || track.label;
  if (!language) return track.title?.trim() || track.label || '未知语言';

  const english = languageName(englishLanguageNames, languageCode);
  const aliases = [
    ...(names || []), ...(languageCode.startsWith('zh') ? ['中文', 'Chinese'] : []),
    language, english, code, normalizedCode, normalizedCode.split('-')[0]
  ].filter(Boolean).sort((a, b) => b.length - a.length).map((value) => RegExp.escape(value));
  const aliasPattern = '(?:' + aliases.join('|') + ')';
  const prefix = new RegExp('^(?:[（(]' + aliasPattern + '[)）]|' + aliasPattern + ')(?=$|[\\s·:：/–—(（-])', 'iu');
  let title = (track.title || '').trim();
  const trimSeparators = (value) => value.replace(/^[\s·:：/–—-]+/u, '');
  while (prefix.test(title)) {
    title = trimSeparators(title.replace(prefix, ''));
    title = title.replace(/^[(（]([^()（）]*)[)）]$/u, '$1').trim();
  }

  const suffix = code && !/^(und|mul)$/i.test(code) && !languageCode.startsWith('zh') ? '（' + code.toUpperCase() + '）' : '';
  return [language + suffix, title].filter(Boolean).join(' · ');
}

export function subtitleJobSummary(job, offline = false) {
  if (!job) return '';
  const percent = Math.floor(Math.min(100, Math.max(0, Number(job.progress) || 0)));
  if (offline) return '字幕进度暂时无法读取 · 上次 ' + percent + '%';
  if (job.status === 'queued') return '内嵌字幕提取排队中';
  if (job.status === 'processing') return '正在提取内嵌字幕 · ' + percent + '%';
  if (job.status === 'completed') return '内嵌字幕提取完成 · 100%';
  if (job.status === 'interrupted') return '字幕提取已中断 · ' + (job.error || '影院在任务结束前关闭。');
  if (job.status === 'failed') return '字幕提取失败' + (job.error ? ' · ' + job.error : '');
  return '';
}

export function subtitleDeleteConfirmation(counts) {
  return '将从磁盘删除 ' + counts.embedded + ' 轨已提取的内嵌字幕和 ' + counts.external
    + ' 轨外挂字幕。' + (counts.external ? ' 外挂字幕以后需要重新导入。' : '')
    + ' 已准备的 AI 对白会保留。';
}

export function createSubtitlePreferences(request) {
  const form = byId('subtitlePreferencesForm');
  const fields = byId('subtitlePreferenceFields');
  const save = byId('subtitlePreferencesSave');
  const retry = byId('subtitlePreferencesRetry');
  const status = byId('subtitlePreferencesStatus');
  let pending = false;
  let dirty = false;
  let loaded = false;

  async function load() {
    if (pending || dirty) return;
    pending = true;
    retry.hidden = true;
    fields.disabled = save.disabled = true;
    status.textContent = '正在读取字幕偏好…';
    try {
      const { languages } = await request('/api/subtitle-settings');
      for (const input of fields.querySelectorAll('input')) input.checked = languages.includes(input.value);
      loaded = true;
      status.textContent = '';
    } catch {
      loaded = false;
      retry.hidden = false;
      status.textContent = '暂时无法读取字幕偏好。';
    } finally {
      fields.disabled = save.disabled = !loaded;
      pending = false;
    }
  }

  retry.onclick = load;
  form.oninput = () => {
    dirty = true;
    status.textContent = '有尚未保存的更改。';
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (pending || !loaded) return;
    const languages = [...fields.querySelectorAll('input:checked')].map((input) => input.value);
    pending = true;
    fields.disabled = save.disabled = true;
    try {
      await request('/api/subtitle-settings', { method: 'POST', body: JSON.stringify({ languages }) });
      status.textContent = languages.length ? '已保存新入库影片的字幕偏好。' : '已保存。新入库影片将不自动提取字幕。';
      dirty = false;
    } catch {
      status.textContent = '暂时无法保存字幕偏好，请重试。';
    } finally {
      fields.disabled = save.disabled = false;
      pending = false;
    }
  };
  return { load };
}

export function createFilmSubtitleSettings({ request, refreshLibrary, updateJobStatus }) {
  const dialog = byId('filmSettingsDialog');
  const status = byId('filmSubtitleStatus');
  const probeStatus = byId('filmSubtitleProbeStatus');
  const progress = byId('filmSubtitleProgress');
  const meter = byId('filmSubtitleMeter');
  const contents = byId('filmSubtitleContents');
  const extract = byId('filmSubtitleExtract');
  const remove = byId('filmSubtitleDelete');
  const retry = byId('filmSubtitleRetry');
  const reload = byId('filmSubtitleReload');
  const confirmation = byId('filmSubtitleDeleteDialog');
  const confirmText = byId('filmSubtitleDeleteText');
  const polls = new Map();
  let opened;
  let catalog;
  let pending = false;
  let selected = new Set();

  const url = (mediaId) => '/api/media/' + encodeURIComponent(mediaId) + '/subtitles';
  const trackSignature = (item) => JSON.stringify(item.subtitleTracks || []);

  function tracks() {
    return catalog ? [
      ...catalog.embedded.map((track) => ({ ...track, group: 'embedded' })),
      ...catalog.external.map((track) => ({ ...track, group: 'external' }))
    ] : [];
  }

  function refreshActions() {
    const locked = pending || busyJob(catalog?.job) || !catalog;
    const chosen = tracks().filter((track) => selected.has(track.id));
    extract.disabled = locked || !chosen.some((track) => track.extractable && !track.saved);
    remove.disabled = locked || !chosen.some((track) => track.saved);
    retry.hidden = !failedJob(catalog?.job);
    retry.disabled = locked;
    reload.disabled = pending;
    for (const group of contents.querySelectorAll('fieldset')) group.disabled = locked;
  }

  function paintProgress(job, offline = false) {
    progress.textContent = subtitleJobSummary(job, offline);
    progress.classList.toggle('error', failedJob(job) || offline);
    meter.hidden = !['processing', 'completed'].includes(job?.status);
    meter.value = job?.status === 'completed' ? 100 : (Number(job?.progress) || 0);
  }

  function renderCatalog() {
    probeStatus.textContent = catalog?.probeError ? '无法读取源片的内嵌字幕：' + catalog.probeError : '';
    const all = tracks();
    for (const group of ['embedded', 'external']) {
      const box = byId(group + 'SubtitleTracks');
      box.replaceChildren();
      const rows = all.filter((track) => track.group === group);
      const eligible = rows.filter((track) => track.saved || track.extractable);
      if (!rows.length) {
        box.textContent = group === 'external' ? '没有外挂字幕。'
          : catalog?.probeError ? '没有已保存的内嵌字幕。' : '没有内嵌字幕轨。';
        continue;
      }
      const makeChoice = (text, checked, handler, disabled = false) => {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = checked;
        input.disabled = disabled;
        input.onchange = () => handler(input.checked);
        const caption = document.createElement('span');
        caption.textContent = text;
        label.append(input, caption);
        box.append(label);
        return input;
      };
      const trackInputs = [];
      const selectAll = eligible.length && makeChoice('全选', false, (checked) => {
        for (const { input, id } of trackInputs) {
          if (input.disabled) continue;
          input.checked = checked;
          if (checked) selected.add(id);
          else selected.delete(id);
        }
        syncSelection();
      });
      function syncSelection() {
        const count = eligible.filter((track) => selected.has(track.id)).length;
        if (selectAll) {
          selectAll.checked = count === eligible.length;
          selectAll.indeterminate = count > 0 && count < eligible.length;
        }
        refreshActions();
      }
      const names = rows.map(subtitleTrackName);
      const nameCounts = new Map();
      for (const name of names) nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
      for (const [index, track] of rows.entries()) {
        const state = track.saved ? (group === 'embedded' ? '已提取' : '已保存')
          : track.extractable ? '可补提' : '不支持提取';
        const name = names[index];
        const stream = group === 'embedded' && nameCounts.get(name) > 1 && Number.isInteger(track.streamIndex)
          ? '流 #' + track.streamIndex : '';
        const caption = [name, stream, track.sourceCodec, state].filter(Boolean).join(' · ');
        const input = makeChoice(caption, selected.has(track.id), (checked) => {
          if (checked) selected.add(track.id);
          else selected.delete(track.id);
          syncSelection();
        }, !track.saved && !track.extractable);
        trackInputs.push({ input, id: track.id });
      }
      syncSelection();
    }
    paintProgress(catalog?.job);
    refreshActions();
  }

  function reloadCatalog(target) {
    target.revision++;
    if (!pending) return load(target);
  }

  function finishRequest(target, revision) {
    if (opened !== target) return;
    pending = false;
    if (dialog.open && revision !== target.revision) void load(target);
    else refreshActions();
  }

  async function load(target) {
    const revision = target.revision;
    const current = () => opened === target && dialog.open && revision === target.revision;
    pending = true;
    reload.hidden = true;
    status.textContent = '正在读取字幕清单…';
    refreshActions();
    try {
      const snapshot = await request(url(target.id));
      if (!current()) return;
      catalog = snapshot;
      const ids = new Set(tracks().map((track) => track.id));
      selected = new Set([...selected].filter((id) => ids.has(id)));
      status.textContent = '';
      syncJob(target.id, catalog.job);
      renderCatalog();
    } catch {
      if (!current()) return;
      status.textContent = '暂时无法读取字幕清单。';
      reload.hidden = false;
    } finally {
      finishRequest(target, revision);
    }
  }

  function syncJob(mediaId, job) {
    if (!busyJob(job) || polls.get(mediaId)?.id === job.id) return;
    const watch = { id: job.id };
    polls.set(mediaId, watch);
    async function poll() {
      try {
        const response = await request('/api/jobs/' + encodeURIComponent(watch.id));
        if (polls.get(mediaId) !== watch) return;
        job = response.job;
        updateJobStatus(mediaId, job);
        if (opened?.id === mediaId && dialog.open) {
          paintProgress(job);
          if (catalog && busyJob(job)) catalog.job = job;
        }
        if (!busyJob(job)) {
          polls.delete(mediaId);
          refreshLibrary();
          if (opened?.id === mediaId && dialog.open) void reloadCatalog(opened);
          return;
        }
      } catch {
        if (polls.get(mediaId) !== watch) return;
        updateJobStatus(mediaId, job, true);
        if (opened?.id === mediaId && dialog.open) paintProgress(job, true);
      }
      if (polls.get(mediaId) === watch) setTimeout(poll, 800);
    }
    setTimeout(poll, 600);
  }

  async function change(action, body) {
    const target = opened;
    if (!target || pending) return;
    const revision = target.revision;
    pending = true;
    status.textContent = action === 'prepare' ? '正在提交字幕提取…' : '正在删除字幕文件…';
    refreshActions();
    try {
      const snapshot = await request(url(target.id) + '/' + action, {
        method: 'POST',
        body: JSON.stringify(body)
      });
      if (opened !== target || revision === target.revision) {
        syncJob(target.id, snapshot.job);
        if (action === 'prepare') updateJobStatus(target.id, snapshot.job);
      }
      if (opened === target && dialog.open) selected.clear();
      if (opened === target && dialog.open && revision === target.revision) {
        if (action === 'delete') catalog = snapshot;
        else catalog.job = snapshot.job;
        status.textContent = action === 'delete' ? '已删除所选字幕文件。' : '';
        renderCatalog();
      }
      if (action === 'delete') refreshLibrary();
    } catch (error) {
      if (opened === target && dialog.open) {
        status.textContent = error.status
          ? error.message : '暂时无法确认操作结果。请重新读取清单。';
        reload.hidden = false;
      }
    } finally {
      finishRequest(target, revision);
    }
  }

  extract.onclick = () => change('prepare', { trackIds: tracks()
    .filter((track) => selected.has(track.id) && track.extractable && !track.saved)
    .map((track) => track.id) });
  retry.onclick = () => change('prepare', { retry: true });
  remove.onclick = () => {
    const chosen = tracks().filter((track) => selected.has(track.id) && track.saved);
    const counts = { embedded: 0, external: 0 };
    for (const track of chosen) counts[track.group]++;
    confirmText.textContent = subtitleDeleteConfirmation(counts);
    confirmation.returnValue = '';
    confirmation.addEventListener('close', () => {
      if (confirmation.returnValue === 'confirm') void change('delete', { trackIds: chosen.map((track) => track.id) });
    }, { once: true });
    confirmation.showModal();
  };
  byId('filmSettingsClose').onclick = () => dialog.close();
  reload.onclick = () => reloadCatalog(opened);

  return {
    reconcile(items) {
      const jobs = new Map(items.map((item) => [item.id, item.subtitleJob]));
      for (const [mediaId, watch] of polls) {
        const job = jobs.get(mediaId);
        if (!busyJob(job) || job.id !== watch.id) polls.delete(mediaId);
      }
      for (const item of items) syncJob(item.id, item.subtitleJob);
      if (!opened || !dialog.open) return;
      const item = items.find((entry) => entry.id === opened.id);
      if (!item) {
        dialog.close();
        return;
      }
      const job = item.subtitleJob;
      const signature = JSON.stringify([trackSignature(item), job?.id, job?.status]);
      if (signature !== opened.signature) {
        opened.signature = signature;
        if (!pending && catalog && busyJob(job) && catalog.job?.id === job.id) {
          catalog.job = job;
          paintProgress(job);
          refreshActions();
        } else void reloadCatalog(opened);
      }
    },
    open(item, restoreFocus) {
      opened = { id: item.id, revision: 0, signature: JSON.stringify([
        trackSignature(item), item.subtitleJob?.id, item.subtitleJob?.status
      ]) };
      catalog = null;
      selected.clear();
      probeStatus.textContent = '';
      byId('filmSettingsTitle').textContent = '影片设置 · ' + item.title;
      for (const group of ['embedded', 'external']) byId(group + 'SubtitleTracks').replaceChildren();
      paintProgress(item.subtitleJob);
      dialog.showModal();
      dialog.addEventListener('close', restoreFocus, { once: true });
      return load(opened);
    }
  };
}
