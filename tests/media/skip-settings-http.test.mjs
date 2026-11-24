import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { buildViewingFeed } from '../../mcp/viewing/viewing-feed.mjs';
import { collectViewingCatchup } from '../../mcp/viewing/catchup-feed.mjs';
import { runObservationPrecompute } from '../../src/preparation/observation-precompute-runner.mjs';
import { imageSettingsForMode } from '../../src/visuals/image-settings.mjs';

test('HTTP persists skip settings, follows collection moves, and sends current names through the AI feed', { timeout: 35_000 }, async t => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('FFmpeg unavailable');
  const localData = await mkdtemp(join(tmpdir(), 'cinema-skip-settings-'));
  const project = resolve(import.meta.dirname, '../..');
  let child, exit;
  async function stop() {
    if (!child) return;
    child.kill();
    await exit;
    child = null;
  }
  t.after(async () => { await stop(); await rm(localData, { recursive: true, force: true }); });
  const availablePort = createServer();
  availablePort.listen(0, '127.0.0.1');
  await once(availablePort, 'listening');
  const { port } = availablePort.address();
  await new Promise(done => availablePort.close(done));
  const base = 'http://127.0.0.1:' + port;
  let serverLog = '';
  async function start() {
    child = spawn(process.execPath, ['server.mjs'], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LOCAL_DATA_ROOT: localData, PORT: String(port), OPEN_BROWSER: '0' } });
    exit = once(child, 'exit');
    for (const stream of [child.stdout, child.stderr]) stream.on('data', buffer => { serverLog += buffer; });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await fetch(base + '/api/health').then(response => response.ok, () => false)) return;
      await delay(30);
    }
    assert.fail(serverLog);
  }
  async function api(path, body, status) {
    const response = await fetch(base + path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    const payload = await response.json();
    if (status) assert.equal(response.status, status, JSON.stringify(payload));
    else assert.ok(response.ok, JSON.stringify(payload));
    return payload;
  }
  const episodeDir = join(localData, 'media', 'Series', 'Season', 'Film');
  const otherDir = join(localData, 'media', 'Old');
  const mediaId = 'f'.repeat(24);
  const oldId = 'a'.repeat(24);
  const inputPath = join(episodeDir, 'Film.mp4');
  const oldPath = join(otherDir, 'Old.mp4');
  await mkdir(episodeDir, { recursive: true });
  await mkdir(otherDir);
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=32x32:d=10', inputPath], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  await writeFile(oldPath, await readFile(inputPath));
  for (const [dir, video, id] of [[episodeDir, 'Film.mp4', mediaId], [otherDir, 'Old.mp4', oldId]]) {
    await writeFile(join(dir, '.cinema.json'), JSON.stringify({ version: 1, id, video }));
  }
  const config = { intro: { fromMs: 0, toMs: 2_000 }, middle: [{ fromMs: 5_000, toMs: 6_000 }], outro: { fromMs: 8_000, toMs: null } };
  for (const [outputRoot, source, skipConfig] of [[episodeDir, inputPath, config], [otherDir, oldPath, null]]) {
    await runObservationPrecompute(project, {
      inputPath: source, outputRoot, packageKey: '观影包', viewingIntervalMs: 1_000, initialBufferMs: 1_000,
      imageSettings: imageSettingsForMode('economy'), skipConfig, includeAudio: false,
      dialogueSource: { status: 'source_missing' },
      analyzeSegment: async () => ({ observations: [], frames: [] })
    });
  }

  const collection = (path, skipConfig) => api('/api/library/skip-settings', { collectionPath: path, skipConfig });
  const readCollection = (path, status) => api('/api/library/skip-settings?collectionPath=' + encodeURIComponent(path), undefined, status);
  const filmUrl = '/api/media/' + mediaId + '/skip-settings';
  const settingsUrl = '/api/viewing-settings';
  const timeline = [
    { kind: 'intro', fromMs: 0, toMs: 2_000 },
    { kind: 'middle', fromMs: 5_000, toMs: 6_000 },
    { kind: 'outro', fromMs: 8_000, toMs: 10_000 }
  ];
  await start();
  assert.equal((await api(settingsUrl)).settings.skipIntroOutroPrompt, false);
  const { settings } = await api(settingsUrl, { skipIntroOutroPrompt: true });
  assert.equal(settings.configured, false);
  assert.equal(settings.skipIntroOutroPrompt, true);
  const zeroIntro = { intro: { fromMs: 0, toMs: 1_500 }, middle: [] };
  const savedFilm = { skipConfig: zeroIntro, skipRanges: [{ kind: 'intro', ...zeroIntro.intro }] };
  assert.deepEqual(await api(filmUrl, { skipConfig: zeroIntro }), savedFilm);
  assert.deepEqual(await api(filmUrl), savedFilm);
  assert.deepEqual(JSON.parse(await readFile(join(episodeDir, '.cinema.json'), 'utf8')).skipConfig, zeroIntro);
  await collection('Series', { intro: { fromMs: 0, toMs: 1_000 } });
  await collection('Series/Season', config);
  assert.deepEqual(await api(filmUrl), savedFilm);
  const listedFilm = (await api('/api/media')).items.find(item => item.id === mediaId);
  assert.deepEqual(listedFilm.skipRanges, savedFilm.skipRanges);
  await api(filmUrl, { skipConfig: null });
  assert.deepEqual(await api(filmUrl), { skipConfig: null, skipRanges: timeline });
  assert.deepEqual(await api(filmUrl, { skipConfig: {} }), { skipConfig: { middle: [] }, skipRanges: [] });
  assert.deepEqual(JSON.parse(await readFile(join(episodeDir, '.cinema.json'), 'utf8')).skipConfig, { middle: [] });
  assert.deepEqual(await api(filmUrl, { skipConfig: null }), { skipConfig: null, skipRanges: timeline });
  assert.equal(Object.hasOwn(JSON.parse(await readFile(join(episodeDir, '.cinema.json'), 'utf8')), 'skipConfig'), false);
  await api('/api/library/rename-folder', { path: 'Series', name: 'Renamed' });
  assert.equal((await readCollection('Renamed')).skipConfig.intro.toMs, 1_000);
  assert.deepEqual((await readCollection('Renamed/Season')).skipConfig, config);
  await readCollection('Series/Season', 404);
  const dissolve = { collectionPath: 'Renamed' };
  const { preview } = await api('/api/library/cleanup-preview', dissolve);
  await api('/api/library/cleanup', { target: dissolve, token: preview.token, action: 'dissolve' });
  assert.deepEqual((await readCollection('Season')).skipConfig, config);
  await api('/api/library/folders', { name: 'Renamed' });
  assert.equal((await readCollection('Renamed')).skipConfig, null);

  await collection('Renamed', config);
  await api('/api/library/folders', { name: 'Empty', parentPath: 'Renamed' });
  await collection('Renamed/Empty', config);
  const { preview: removal } = await api('/api/library/cleanup-preview', dissolve);
  await api('/api/library/cleanup', { target: dissolve, token: removal.token, selected: { folder: true } });
  await api('/api/library/folders', { name: 'Renamed' });
  await api('/api/library/folders', { name: 'Empty', parentPath: 'Renamed' });
  assert.equal((await readCollection('Renamed')).skipConfig, null);
  assert.equal((await readCollection('Renamed/Empty')).skipConfig, null);

  await stop();
  await start();
  const film = (await api('/api/media')).items.find(item => item.id === mediaId);
  assert.deepEqual(film.skipRanges, timeline);
  assert.equal(film.skipConfig, null);
  assert.equal((await api(settingsUrl)).settings.skipIntroOutroPrompt, true);
  await api(filmUrl, { skipConfig: {} }); // The active package keeps its own ranges.
  const { room } = await api('/api/rooms/open', { mediaId });
  let state = { roomId: room.id, cursors: {} };
  async function poll(position) {
    await api('/api/rooms/' + room.id + '/playback', { mediaTimeMs: position, playbackState: 'paused', seeked: true });
    const packet = await collectViewingCatchup({
      ...state, identity: 'skip-settings-test',
      requestTick: ({ roomId, cursors, limits }) => api('/api/ai/tick', { roomId, cursors, limits })
    });
    state = packet.state;
    const feed = await buildViewingFeed(packet, { fetchFrame: () => assert.fail('fixture has no frames') });
    return feed.mcpContent.map(block => block.text).join('\n');
  }
  assert.match(await poll(0), /正在播放片头（已设置跳过，未准备画面与声音）/);
  assert.doesNotMatch(await poll(1_000), /正在播放片头/);
  assert.match(await poll(5_000), /正在播放中间片段（观众设置了跳过，未准备画面与声音）/);
  await api('/api/participants/viewer', { name: 'Sylvie' });
  assert.doesNotMatch(await poll(5_200), /正在播放中间片段/);
  assert.doesNotMatch(await poll(6_000), /正在播放中间片段/);
  assert.match(await poll(5_000), /正在播放中间片段（Sylvie设置了跳过，未准备画面与声音）/);
  assert.match(await poll(8_000), /正在播放片尾（已设置跳过，未准备画面与声音）/);
  assert.doesNotMatch(await poll(8_500), /正在播放片尾/);
  await api(settingsUrl, { skipIntroOutroPrompt: false });
  assert.match(await poll(1_000), /正在播放片头（已设置跳过，未准备画面与声音）/);
  assert.doesNotMatch(await poll(1_500), /正在播放片头/);
  assert.match(await poll(5_000), /正在播放中间片段（Sylvie设置了跳过，未准备画面与声音）/);
  await api('/api/rooms/' + room.id + '/end', { mediaTimeMs: 1_000 });
  const { room: oldRoom } = await api('/api/rooms/open', { mediaId: oldId });
  const legacy = await api('/api/ai/tick', { roomId: oldRoom.id });
  assert.equal(legacy.tick.skipPrompt, undefined);
  assert.equal(legacy.tick.awaitingPreparation, undefined);
});
