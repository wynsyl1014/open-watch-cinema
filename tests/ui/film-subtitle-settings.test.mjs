import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { subtitleDeleteConfirmation, subtitleJobSummary } from '../../public/film-subtitle-settings.js';

const read = (path) => readFile(new URL('../../' + path, import.meta.url), 'utf8');

test('subtitle jobs show the server percentage, reconnection state and interruption reason', () => {
  assert.equal(subtitleJobSummary({ status: 'queued', progress: 0 }), '内嵌字幕提取排队中');
  const running = { status: 'processing', progress: 48.7 };
  assert.match(subtitleJobSummary(running), /48%/);
  assert.match(subtitleJobSummary(running, true), /暂时无法读取.*48%/);
  assert.match(subtitleJobSummary({ status: 'completed', progress: 100 }), /100%/);
  assert.match(subtitleJobSummary({ status: 'interrupted', error: '服务已停止' }), /中断.*服务已停止/);
  assert.match(subtitleJobSummary({ status: 'failed', error: '无法读取影片' }), /失败.*无法读取影片/);
});

test('subtitle deletion confirms the counts independently and explains the consequences', () => {
  const mixed = subtitleDeleteConfirmation({ embedded: 2, external: 1 });
  assert.match(mixed, /2 轨已提取的内嵌字幕和 1 轨外挂字幕/);
  assert.match(mixed, /外挂字幕以后需要重新导入/);
  assert.match(mixed, /已准备的 AI 对白会保留/);
  assert.doesNotMatch(subtitleDeleteConfirmation({ embedded: 1, external: 0 }), /需要重新导入/);
});

test('subtitle controls are wired to library and settings with separate inventory and extraction routes', async () => {
  const [app, html, shelf, client, server] = await Promise.all(
    ['public/app.js', 'public/index.html', 'public/library-shelf.js', 'public/film-subtitle-settings.js', 'server.mjs'].map(read)
  );
  assert.match(html, /data-settings-page="subtitles" aria-controls="settingsSubtitles"/);
  for (const value of ['zh-Hans', 'zh-Hant', 'en']) {
    assert.ok(html.includes('type="checkbox" value="' + value + '" checked'));
  }
  assert.match(html, /<legend>内嵌字幕<\/legend>[\s\S]*?<legend>外挂字幕<\/legend>/);
  assert.match(shelf, /settings\.title = '影片设置'/);
  assert.match(shelf, /settings\.innerHTML = '<span aria-hidden="true">⚙<\/span>'/);
  assert.match(shelf, /actions\.append\(rename, settings\)/);
  assert.match(app, /manageFilm: openFilmSettings/);
  assert.match(app, /filmSubtitleSettings\.open\(item, restoreFocus\)/);
  assert.match(app, /filmSubtitleSettings\.reconcile\(items\)/);
  assert.match(app, /notification\.type === 'subtitle-library-changed'\) \{\s*scheduleSubtitleLibraryRefresh\(\);\s*return;/);
  assert.doesNotMatch(app, /discoverEmbeddedSubtitles|subtitles\/prepare/);
  assert.match(client, /await request\(url\(target\.id\)\)/);
  assert.match(client, /change\('prepare', \{ retry: true \}\)/);
  assert.match(server, /\['\/film-subtitle-settings\.js', \['film-subtitle-settings\.js', 'text\/javascript; charset=utf-8'\]\]/);
});

function mockSubtitleDialog(t) {
  const elements = new Map();
  const node = () => ({
    classList: { toggle() {} },
    replaceChildren() { this.children = []; },
    append(...children) { (this.children ??= []).push(...children); },
    querySelectorAll() { return []; },
    addEventListener() {},
    showModal() { this.open = true; }
  });
  const originalDocument = globalThis.document;
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, node());
      return elements.get(id);
    },
    createElement: node
  };
  t.after(() => {
    if (originalDocument) globalThis.document = originalDocument;
    else delete globalThis.document;
  });
  return elements;
}

test('track names lead with the language and distinguish otherwise identical choices', async (t) => {
  const { createFilmSubtitleSettings } = await import('../../public/film-subtitle-settings.js');
  const elements = mockSubtitleDialog(t);
  const rows = [
    { language: 'eng', languageGroup: 'en', title: 'English (ENG) · SDH' },
    { language: 'chi', languageGroup: 'zh-Hans', title: 'Simplified' },
    { language: 'chi', languageGroup: 'zh-Hant', title: 'Traditional' },
    { language: 'cze', languageGroup: 'other', title: 'SDH' },
    { language: 'ger', languageGroup: 'other', title: 'German (SDH)' },
    { language: 'cze', languageGroup: 'other', label: 'cze' },
    { language: 'cze', languageGroup: 'other', label: 'cze' },
    { language: 'chi', languageGroup: 'zh', title: 'Chinese' },
    { language: 'chi', languageGroup: 'zh-Hant', title: 'Chinese (Hong Kong)' },
    { language: 'spa', languageGroup: 'other', title: 'Latin America (SDH)' },
    { language: 'xyz', languageGroup: 'other', title: 'Original' }
  ];
  const embedded = rows.map((track, index) => ({
    id: 'stream-' + index, streamIndex: index, sourceCodec: 'subrip', saved: true, ...track
  }));
  const external = [{ id: 'sidecar', language: 'und', fileName: 'episode.eng.srt', saved: true }];
  const settings = createFilmSubtitleSettings({
    request: async () => ({ embedded, external }),
    refreshLibrary() {},
    updateJobStatus() {}
  });
  await settings.open({ id: 'film', title: '影片' }, () => {});
  const captions = (group) => elements.get(group + 'SubtitleTracks').children.slice(1)
    .map((label) => label.children[1].textContent);
  assert.deepEqual(captions('embedded'), [
    '英语（ENG） · SDH', '简体中文', '繁体中文', '捷克语（CZE） · SDH', '德语（GER） · SDH',
    '捷克语（CZE） · 流 #5', '捷克语（CZE） · 流 #6', '中文', '繁体中文 · Hong Kong',
    '西班牙语（SPA） · Latin America (SDH)', 'Original'
  ].map((name) => name + ' · subrip · 已提取'));
  assert.deepEqual(captions('external'), ['episode.eng.srt · 已保存']);
});

test('terminal job invalidates an in-flight inventory and reloads saved tracks after probing fails', async (t) => {
  const { createFilmSubtitleSettings } = await import('../../public/film-subtitle-settings.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const elements = mockSubtitleDialog(t);

  const running = { id: 'job', status: 'processing', progress: 12 };
  const completed = { id: 'job', status: 'completed', progress: 100 };
  const stale = { embedded: [], external: [], job: running };
  const fresh = { embedded: [], external: [{ id: 'vtt', label: '外挂', saved: true }], job: completed, probeError: '源片损坏' };
  const requests = [];
  let deliverStale;
  const settings = createFilmSubtitleSettings({
    request(url) {
      requests.push(url);
      if (url.startsWith('/api/jobs/')) return Promise.resolve({ job: completed });
      if (requests.length === 1) return Promise.resolve(stale);
      if (requests.length === 2) return new Promise((resolve) => { deliverStale = resolve; });
      return Promise.resolve(fresh);
    },
    refreshLibrary() {},
    updateJobStatus() {}
  });

  await settings.open({ id: 'film', title: '影片', subtitleJob: running }, () => {});
  const rereading = elements.get('filmSubtitleReload').onclick();
  t.mock.timers.tick(600);
  await Promise.resolve();
  assert.match(elements.get('filmSubtitleProgress').textContent, /100%/);
  deliverStale(stale);
  await rereading;
  assert.deepEqual(requests, ['/api/media/film/subtitles', '/api/media/film/subtitles', '/api/jobs/job', '/api/media/film/subtitles']);
  assert.match(elements.get('filmSubtitleProbeStatus').textContent, /源片损坏/);
  assert.match(elements.get('filmSubtitleProgress').textContent, /100%/);
  const external = elements.get('externalSubtitleTracks');
  const selectAll = external.children[0].children[0];
  selectAll.checked = true;
  selectAll.onchange();
  assert.equal(elements.get('filmSubtitleDelete').disabled, false);
  assert.equal(elements.get('filmSubtitleExtract').disabled, true);
});
