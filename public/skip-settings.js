export function shouldRemindBeforePreparation(item, settings) {
  return settings?.skipIntroOutroPrompt === true && !item.aiPackage && !item.skipRanges?.length;
}

export function parseSkipTime(value) {
  const match = /^(?:(\d+):([0-5]?\d)|(\d+)):([0-5]?\d)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const [, hours, clockMinutes, minutes, seconds, fraction = ''] = match;
  const ms = ((Number(hours || 0) * 60 + Number(clockMinutes || minutes)) * 60 + Number(seconds)) * 1000
    + Number(fraction.padEnd(3, '0'));
  return Number.isSafeInteger(ms) ? ms : null;
}

export function formatSkipTime(ms) {
  if (ms == null) return '';
  const seconds = Math.floor(ms / 1000);
  const clock = [Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
  const hours = Math.floor(seconds / 3600);
  const fraction = ms % 1000;
  return (hours ? hours + ':' : '') + clock + (fraction ? '.' + String(fraction).padStart(3, '0') : '');
}

function parseRange({ from, to }, label, openEnd = false) {
  if (!from.trim() && !to.trim()) return null;
  const fromMs = parseSkipTime(from);
  const toMs = parseSkipTime(to);
  if (fromMs === null || (toMs === null && !(openEnd && !to.trim()))) {
    throw new Error(label + '请输入分:秒或时:分:秒，例如 01:30。');
  }
  if (toMs !== null && toMs <= fromMs) throw new Error(label + '结束时间要晚于开始时间。');
  return { fromMs, toMs };
}

export function readSkipConfig({ intro, outro, middle }) {
  const opening = parseRange(intro, '片头：');
  const closing = parseRange(outro, '片尾：', true);
  const clips = middle.map((row, index) => parseRange(row, '第 ' + (index + 1) + ' 个中间时段：')).filter(Boolean);
  return { ...(opening && { intro: opening }), ...(closing && { outro: closing }), middle: clips };
}

function formatConfig(config) {
  const row = range => ({ from: formatSkipTime(range?.fromMs), to: formatSkipTime(range?.toMs) });
  return { intro: row(config?.intro), outro: row(config?.outro), middle: (config?.middle ?? []).map(row) };
}

function inputs(row) {
  return { from: row.querySelector('[data-from]'), to: row.querySelector('[data-to]') };
}

function editRow(row, values) {
  const { from, to } = inputs(row);
  from.value = values.from;
  to.value = values.to;
}

function readRow(row) {
  const { from, to } = inputs(row);
  return { from: from.value, to: to.value };
}

const collectionUrl = path => '/api/library/skip-settings?collectionPath=' + encodeURIComponent(path);
const hasSkipIntervals = config => Boolean(config?.intro || config?.outro || config?.middle?.length);

export function createSkipSettingsEditor(form, { request, refresh, film = false }) {
  form.append(document.querySelector('#skipSettingsFieldsTemplate').content.cloneNode(true));
  const dialog = form.closest('dialog');
  const inheritLabel = form.querySelector('[data-skip-inherit]');
  const inherit = inheritLabel.querySelector('input');
  const source = form.querySelector('[data-skip-source]');
  const fields = form.querySelector('[data-skip-fields]');
  const intro = form.querySelector('[data-skip-intro]');
  const outro = form.querySelector('[data-skip-outro]');
  const middle = form.querySelector('[data-skip-middle]');
  const save = form.querySelector('[type=submit]');
  const status = form.querySelector('[data-skip-status]');
  let target = null;
  let draft = formatConfig(null);

  function feedback(message, error = false) {
    status.textContent = message;
    status.classList.toggle('error', error);
  }

  function addRow(values = { from: '', to: '' }) {
    const row = document.querySelector('#skipMiddleRowTemplate').content.firstElementChild.cloneNode(true);
    editRow(row, values);
    const remove = row.querySelector('button');
    remove.onclick = () => {
      editRanges();
      const next = row.nextElementSibling || row.previousElementSibling;
      row.remove();
      (next ? next.querySelector('button') : form.querySelector('[data-skip-add]')).focus();
    };
    middle.append(row);
    return inputs(row).from;
  }

  function showRows(values) {
    editRow(intro, values.intro);
    editRow(outro, values.outro);
    middle.replaceChildren();
    for (const row of values.middle) addRow(row);
  }

  const readRows = () => ({ intro: readRow(intro), outro: readRow(outro), middle: [...middle.children].map(readRow) });
  const visible = opened => target === opened && dialog.open;

  function updateControls() {
    const enabled = target?.loaded && !target.saving;
    inherit.disabled = !enabled;
    fields.disabled = !enabled;
    save.disabled = !enabled;
    source.textContent = inherit.checked
      ? (hasSkipIntervals(target.defaultConfig) ? '当前继承文件夹默认。' : '文件夹暂未填写默认跳过区间。')
        + '可直接编辑并保存为本片设置。'
      : '';
  }

  function editRanges() {
    if (inherit.checked) {
      inherit.checked = false;
      updateControls();
    }
    feedback('');
  }

  inherit.onchange = () => {
    if (inherit.checked) draft = readRows();
    showRows(inherit.checked ? formatConfig(target.defaultConfig) : draft);
    updateControls();
    feedback('');
  };
  fields.oninput = editRanges;
  form.querySelector('[data-skip-add]').onclick = () => {
    editRanges();
    addRow().focus();
  };

  form.onsubmit = async event => {
    event.preventDefault();
    const opened = target;
    if (!opened?.loaded || opened.saving) return;
    try {
      const config = inherit.checked ? null : readSkipConfig(readRows());
      const skipConfig = film || hasSkipIntervals(config) ? config : null;
      const body = film ? { skipConfig } : { collectionPath: opened.collectionPath, skipConfig };
      opened.saving = true;
      updateControls();
      feedback('正在保存…');
      const saved = await request(opened.url, { method: 'POST', body: JSON.stringify(body) });
      if (visible(opened) && !inherit.checked) showRows(formatConfig(saved.skipConfig));
      if (visible(opened)) {
        const note = saved.skipConfig === null
          ? (film ? '已保存为沿用文件夹默认。' : '已清除合集默认跳过区间。')
          : hasSkipIntervals(saved.skipConfig) ? '已保存。' : '已保存为空区间。';
        feedback(note + (opened.prepared ? '重新准备观影包后生效。' : ''));
      }
    } catch (error) {
      if (visible(opened)) feedback(error.message, true);
      return;
    } finally {
      opened.saving = false;
      if (visible(opened)) updateControls();
    }
    void refresh();
  };

  return async function open(item, { edit = false } = {}) {
    const collectionPath = film ? item.collectionPath : item.path;
    const opened = {
      collectionPath, loaded: false, defaultConfig: null, prepared: Boolean(item.aiPackage?.packageVersion),
      url: film ? '/api/media/' + encodeURIComponent(item.id) + '/skip-settings' : '/api/library/skip-settings'
    };
    target = opened;
    inheritLabel.hidden = !film || !collectionPath;
    inherit.checked = false;
    showRows(formatConfig(null));
    updateControls();
    feedback('正在读取跳过设置…');
    try {
      const [settings, defaults] = await Promise.all([
        request(film ? opened.url : collectionUrl(collectionPath)),
        film && collectionPath ? request(collectionUrl(collectionPath)) : null
      ]);
      if (!visible(opened)) return;
      opened.defaultConfig = defaults?.skipConfig ?? null;
      inherit.checked = film && settings.skipConfig === null && hasSkipIntervals(opened.defaultConfig);
      draft = formatConfig(settings.skipConfig ?? opened.defaultConfig);
      showRows(draft);
      opened.loaded = true;
      updateControls();
      feedback('');
      if (edit) inputs(intro).from.focus();
    } catch (error) {
      if (visible(opened)) feedback(error.message, true);
    }
  };
}
