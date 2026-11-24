import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createSkipSettingsEditor, formatSkipTime, parseSkipTime, readSkipConfig, shouldRemindBeforePreparation } from '../../public/skip-settings.js';

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');
const row = (from = '', to = '') => ({ from, to });

test('skip fields parse both clock forms and preserve existing millisecond precision', () => {
  assert.equal(parseSkipTime('00:00'), 0);
  assert.equal(parseSkipTime(' 01:30 '), 90_000);
  assert.equal(parseSkipTime('1:2:3'), 3_723_000);
  assert.equal(parseSkipTime('2:03:04.125'), 7_384_125);
  assert.equal(parseSkipTime('63:04'), 3_784_000);
  for (const ms of [0, 90_000, 63_500, 7_384_125]) assert.equal(parseSkipTime(formatSkipTime(ms)), ms);
  assert.equal(formatSkipTime(null), '');
  for (const input of ['-1:00', '0:60', '1:60:00', '10', '00:00.0001']) assert.equal(parseSkipTime(input), null);
});

test('skip fields save each kind, allow an open outro and require a valid range for partially filled rows', () => {
  assert.deepEqual(readSkipConfig({ intro: row('0:00', '1:30'), outro: row('1:20:00'), middle: [row(), row('12:45', '13:00')] }), {
    intro: { fromMs: 0, toMs: 90_000 }, outro: { fromMs: 4_800_000, toMs: null },
    middle: [{ fromMs: 765_000, toMs: 780_000 }]
  });
  assert.deepEqual(readSkipConfig({ intro: row(), outro: row(), middle: [] }), { middle: [] });
  assert.throws(() => readSkipConfig({ intro: row('01:30', '01:00'), outro: row(), middle: [] }), /晚于开始时间/);
  assert.throws(() => readSkipConfig({ intro: row(), outro: row(), middle: [row('01:00')] }), /中间时段/);
});

test('only fresh preparation with the reminder enabled and no effective ranges asks the viewer', () => {
  const settings = { skipIntroOutroPrompt: true };
  assert.equal(shouldRemindBeforePreparation({ skipRanges: [] }, settings), true);
  assert.equal(shouldRemindBeforePreparation({ skipConfig: { middle: [] }, skipRanges: [] }, settings), true);
  assert.equal(shouldRemindBeforePreparation({ skipConfig: null, skipRanges: [{ fromMs: 0, toMs: 15_000 }] }, settings), false);
  assert.equal(shouldRemindBeforePreparation({ skipRanges: [] }, { skipIntroOutroPrompt: false }), false);
  assert.equal(shouldRemindBeforePreparation({ aiPackage: { packageVersion: 3 }, skipRanges: [] }, settings), false);
});

test('a film can save and reopen its own skip ranges, including edits to inherited defaults', async t => {
  const node = () => ({ value: '', textContent: '', classList: { toggle() {} } });
  const fields = () => {
    const inputs = { '[data-from]': node(), '[data-to]': node() };
    return { querySelector: selector => inputs[selector] };
  };
  const inherit = node();
  const rows = {
    '[data-skip-inherit]': { querySelector: () => inherit },
    '[data-skip-source]': node(),
    '[data-skip-status]': node(),
    '[data-skip-fields]': node(),
    '[data-skip-intro]': fields(),
    '[data-skip-outro]': fields(),
    '[data-skip-middle]': { children: [], replaceChildren() {} },
    '[data-skip-add]': node(),
    '[type=submit]': node()
  };
  const dialog = { open: true };
  const form = { append() {}, closest: () => dialog, querySelector: selector => rows[selector] };
  const originalDocument = globalThis.document;
  globalThis.document = { querySelector: () => ({ content: { cloneNode() {} } }) };
  t.after(() => {
    if (originalDocument) globalThis.document = originalDocument;
    else delete globalThis.document;
  });

  let saved = null;
  let defaults = null;
  const open = createSkipSettingsEditor(form, {
    film: true,
    refresh() {},
    async request(url, options) {
      if (url.startsWith('/api/library/')) return { skipConfig: defaults };
      if (options) saved = JSON.parse(options.body).skipConfig;
      return { skipConfig: saved };
    }
  });
  const film = { id: 'film', collectionPath: 'Season' };
  await open(film);
  assert.equal(inherit.checked, false);
  assert.equal(rows['[data-skip-fields]'].disabled, false);
  const intro = rows['[data-skip-intro]'];
  intro.querySelector('[data-from]').value = '00:00';
  intro.querySelector('[data-to]').value = '01:30';
  await form.onsubmit({ preventDefault() {} });
  assert.deepEqual(saved, { intro: { fromMs: 0, toMs: 90_000 }, middle: [] });
  dialog.open = false;
  dialog.open = true;
  await open(film);
  assert.equal(intro.querySelector('[data-from]').value, '00:00');
  assert.equal(intro.querySelector('[data-to]').value, '01:30');

  defaults = { intro: { fromMs: 0, toMs: 15_000 } };
  await open(film);
  assert.equal(inherit.checked, false);
  assert.equal(intro.querySelector('[data-to]').value, '01:30');

  saved = null;
  await open(film);
  assert.equal(inherit.checked, true);
  assert.equal(rows['[data-skip-fields]'].disabled, false);
  assert.equal(intro.querySelector('[data-to]').value, '00:15');
  await form.onsubmit({ preventDefault() {} });
  assert.equal(saved, null);

  intro.querySelector('[data-to]').value = '00:45';
  rows['[data-skip-fields]'].oninput();
  assert.equal(inherit.checked, false);
  await form.onsubmit({ preventDefault() {} });
  assert.deepEqual(saved, { intro: { fromMs: 0, toMs: 45_000 }, middle: [] });
  await open(film);
  assert.equal(intro.querySelector('[data-to]').value, '00:45');
  assert.equal(defaults.intro.toMs, 15_000);
});

test('cinema connects the reminder and both editors to the settings and playback routes', async () => {
  const [html, app, editor, shelf, server] = await Promise.all(
    ['public/index.html', 'public/app.js', 'public/skip-settings.js', 'public/library-shelf.js', 'server.mjs'].map(read)
  );
  assert.match(html, /<input id="skipIntroOutroPromptInput" name="skipIntroOutroPrompt" type="checkbox">/);
  assert.match(html, /value="fill"[^>]*>去填写/);
  assert.match(html, /value="continue"[^>]*>继续整片准备/);
  assert.match(html, /id="shelfCollectionSettings"[^>]*hidden>默认跳过片头片尾/);
  assert.doesNotMatch(html, /<option value="skip-settings">/);
  assert.match(html, /id="filmSkipSettingsForm"/);
  assert.match(html, /id="collectionSkipSettingsForm"/);
  assert.match(html, /data-skip-add aria-label="新增中间跳过时段"/);
  assert.match(app, /skipIntroOutroPromptInput\.checked = settings\.skipIntroOutroPrompt === true/);
  assert.match(app, /skipIntroOutroPrompt: skipIntroOutroPromptInput\.checked/);
  assert.match(app, /if \(shouldRemindBeforePreparation\(item, viewingSettings\)\)[\s\S]+editSkip: true[\s\S]+if \(decision !== 'continue'\) return;[\s\S]+chooseAiDialogueTrack\(item\)/);
  assert.match(app, /playbackSkip\.finishSeek\(videoPlayer\.currentTime \* 1000\)[\s\S]+schedulePlaybackSync\(\{ seeked: true \}\)/);
  assert.match(editor, /当前继承文件夹默认/);
  assert.match(editor, /重新准备观影包后生效/);
  assert.match(editor, /opened\.url, \{ method: 'POST', body: JSON\.stringify\(body\) \}/);
  assert.match(shelf, /collectionSettings\.hidden = !path/);
  assert.match(shelf, /openFolderSettings\(folder, \(\) => collectionSettings\.focus\(\)\)/);
  for (const file of ['skip-settings.js', 'playback-skip.js']) assert.ok(server.includes("['/" + file + "',"));
});
