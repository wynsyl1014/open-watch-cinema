import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createViewingChunk, viewingPreparationState } from '../../src/delivery/viewing-package.mjs';
import {
  createObservationPrecomputeManifest, markObservationChunkComplete
} from '../../src/preparation/observation-precompute-plan.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const FILM_ID = '0123456789abcdef01234567';
const JPEG = Buffer.from('ffd8ffd9', 'hex');

async function seedFilm(root, extraFrames = []) {
  const film = join(root, 'media', 'Film');
  const pkg = join(film, '观影包');
  const chunk = 'chunks/chunk-0000';
  const storyboardRootRef = chunk + '/storyboards';
  const viewingRef = chunk + '/viewing.json';
  await mkdir(join(pkg, storyboardRootRef), { recursive: true });
  await writeFile(join(film, 'Film.mp4'), 'synthetic source');
  await writeFile(join(film, '.cinema.json'), JSON.stringify({ id: FILM_ID, video: 'Film.mp4' }));
  let manifest = createObservationPrecomputeManifest({ mediaIdentity: 'bridge-fixture', durationMs: 30_000, viewingIntervalMs: 6000 });
  const viewing = createViewingChunk({
    planId: manifest.planId, chunk: manifest.chunks[0], intervalMs: manifest.viewingIntervalMs,
    storyboardRootRef,
    analysis: {
      engine: 'fixture', protocolVersion: 2, observations: [],
      frames: [{ filename: 'frame.jpg', mediaTimeMs: 2000, panelTimesMs: [2000] }, ...extraFrames]
    },
    dialogue: {
      status: 'ready', sourceMode: 'fixture', cues: [
        { cueId: 'first', fromMs: 1000, toMs: 3300, text: 'A complete opening line.' },
        { cueId: 'second', fromMs: 7200, toMs: 8000, text: 'Another line after the first tick.' },
        { cueId: 'tail', fromMs: 10300, toMs: 11000, text: 'Tail before the pause.' },
        { cueId: 'superseded', fromMs: 14000, toMs: 14600, text: 'Tail superseded by a rewind.' }
      ]
    }
  });
  manifest = markObservationChunkComplete(manifest, 0, { observationCount: 0, storyboardCount: 1 });
  Object.assign(manifest.chunks[0], { viewingRef, audioStatus: 'unavailable' });
  Object.assign(manifest, { packageVersion: 3, packageKind: 'open-watch-cinema-ai-package', dialogueTrack: { status: 'ready' } });
  manifest.viewingTrack = viewingPreparationState(manifest);
  await Promise.all([
    writeFile(join(pkg, 'manifest.json'), JSON.stringify(manifest)),
    writeFile(join(pkg, viewingRef), JSON.stringify(viewing)),
    writeFile(join(pkg, storyboardRootRef, 'frame.jpg'), JPEG),
    ...extraFrames.map(frame => writeFile(join(pkg, storyboardRootRef, frame.filename), JPEG))
  ]);
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await delay(25);
  }
  assert.fail(description);
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}

test('standalone bridge uses a real MCP connection, hot settings, paused chat and full content', { timeout: 20000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'owc-watch-bridge-'));
  const controller = new AbortController();
  let watch;
  let cinema;
  let relay;
  let cli;
  t.after(async () => {
    controller.abort();
    try {
      await watch;
    } finally {
      if (cli && cli.exitCode === null && cli.signalCode === null) {
        cli.kill();
        await once(cli, 'exit');
      }
      relay?.close();
      relay?.closeAllConnections();
      if (cinema && cinema.exitCode === null && cinema.signalCode === null) {
        cinema.kill();
        await once(cinema, 'exit');
      }
      await rm(temp, { recursive: true, force: true });
    }
  });
  const data = join(temp, 'data');
  await seedFilm(data);
  const standalone = join(temp, 'standalone');
  await cp(join(ROOT, 'watch-bridge'), standalone, { recursive: true });
  const { watchCinema } = await import(pathToFileURL(join(standalone, 'session.mjs')));

  const reservation = createServer();
  const cinemaUrl = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  cinema = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, OPEN_BROWSER: '0', LOCAL_DATA_ROOT: data, PORT: new URL(cinemaUrl).port },
    stdio: ['ignore', 'ignore', 'inherit'],
    windowsHide: true
  });
  let ticks = 0;
  let stateReads = 0;
  let failNextTick = false;
  relay = createServer((incoming, outgoing) => {
    if (incoming.url === '/api/watch-bridge/state') stateReads++;
    if (incoming.url === '/api/ai/tick') {
      ticks++;
      if (failNextTick) {
        failNextTick = false;
        incoming.resume();
        outgoing.writeHead(503, {
          'content-type': 'application/json', 'x-open-watch-cinema': 'open-watch-cinema'
        });
        outgoing.end(JSON.stringify({ code: 'AI_PROFILE_UNAVAILABLE', error: 'Fixture transient tick error.' }));
        return;
      }
    }
    const upstream = request(new URL(incoming.url, cinemaUrl), {
      headers: { ...incoming.headers, host: new URL(cinemaUrl).host },
      method: incoming.method
    }, response => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    outgoing.on('close', () => upstream.destroy());
    upstream.on('error', () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  const relayUrl = await listen(relay);
  async function api(path, body) {
    const response = await fetch(cinemaUrl + path, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    const payload = await response.json();
    assert.ok(response.ok, JSON.stringify(payload));
    return payload;
  }

  await waitFor(async () => (await fetch(cinemaUrl + '/api/health').catch(() => null))?.ok,
    'Cinema did not become healthy.');
  await api('/api/participants/ai-profiles', { action: 'create', name: 'Bridge fixture' });
  const { room } = await api('/api/rooms/open', { mediaId: FILM_ID });
  const roomPath = '/api/rooms/' + room.id;
  const playback = (mediaTimeMs, playbackState = 'playing', seeked = false) =>
    api(roomPath + '/playback', { mediaTimeMs, playbackState, seeked });
  async function advanceWithoutTick(update) {
    const reads = stateReads;
    const calls = ticks;
    await update();
    await waitFor(() => stateReads > reads, 'Bridge did not refresh the playback state.');
    await delay(80);
    assert.equal(ticks, calls);
  }

  const release = Promise.withResolvers();
  const beforePlaying = Promise.withResolvers();
  const delivered = [];
  watch = watchCinema({
    cinemaUrl: relayUrl, cinemaRoot: ROOT, signal: controller.signal,
    async onTick(result, context) {
      if (!context.includesPlayback) {
        beforePlaying.resolve({ result, ...context });
        return;
      }
      delivered.push({ result, ...context });
      if (delivered.length === 2) await release.promise;
    }
  });
  watch.catch(() => {});
  await waitFor(() => stateReads >= 1, 'Bridge did not read its initial state.');
  await delay(80);
  await api(roomPath + '/messages', { senderKind: 'user', content: 'Before playback', mediaTimeMs: 0 });
  const early = await beforePlaying.promise;
  assert.equal(early.reason, 'chat');
  assert.equal(early.state.playbackState, 'paused');
  assert.match(JSON.stringify(early.result), /Before playback/);
  await advanceWithoutTick(() => playback(0));
  await advanceWithoutTick(() => playback(5999));
  await playback(6000);
  const first = await waitFor(() => delivered[0], 'Default 6 second tick did not run.');
  assert.equal(first.state.playheadMs, 6000);
  assert.equal(first.reason, 'interval');
  assert.equal(first.includesPlayback, true);
  assert.equal(first.result, first.results[0]);
  assert.match(first.result.content.filter(x => x.type === 'text').map(x => x.text).join('\n'), /A complete opening line\./);
  assert.deepEqual(first.result.content.find(block => block.type === 'image'),
    { type: 'image', mimeType: 'image/jpeg', data: JPEG.toString('base64') });

  await advanceWithoutTick(() => playback(8000));
  await api('/api/watch-bridge/settings', { intervalSeconds: 2 });
  const second = await waitFor(() => delivered[1], 'Shorter setting did not apply to the next decision.');
  assert.equal(second.state.intervalMs, 2000);
  assert.equal(second.state.playheadMs, 8000);
  assert.match(JSON.stringify(second.result), /Another line after the first tick/);
  assert.doesNotMatch(JSON.stringify(second.result), /A complete opening line/);

  await advanceWithoutTick(() => api('/api/watch-bridge/settings', { intervalSeconds: 10 }));
  await advanceWithoutTick(() => playback(12000));
  await advanceWithoutTick(() => playback(12000, 'paused'));
  release.resolve();
  await waitFor(() => ticks === 4, 'The bridge did not capture the tail when playback paused.');
  await delay(80);
  assert.equal(delivered.length, 2);

  failNextTick = true;
  await api(roomPath + '/messages', { senderKind: 'user', content: 'A question during pause', mediaTimeMs: 12000 });
  const chat = await waitFor(() => delivered[2], 'Paused chat did not reach the same session.');
  assert.equal(ticks, 6);
  assert.equal(chat.reason, 'chat');
  assert.equal(chat.includesPlayback, true);
  assert.equal(chat.results.length, 2);
  assert.deepEqual(chat.result.content, chat.results.flatMap(packet => packet.content));
  assert.match(JSON.stringify(chat.result), /Tail before the pause/);
  assert.match(JSON.stringify(chat.result), /A question during pause/);

  await advanceWithoutTick(() => playback(15000));
  await playback(15000, 'paused');
  await waitFor(() => ticks === 7, 'Bridge did not capture the second pause.');
  await delay(80);
  await advanceWithoutTick(() => playback(3000, 'paused', true));
  assert.equal(delivered.length, 3);
  await advanceWithoutTick(() => playback(12999));
  await playback(13000);
  const resumed = await waitFor(() => delivered[3], 'Film did not continue at the changed cadence after seek.');
  assert.equal(resumed.state.playheadMs, 13000);
  assert.equal(resumed.reason, 'interval');
  assert.equal(resumed.results.length, 1);
  assert.doesNotMatch(JSON.stringify(resumed.result), /Tail superseded by a rewind/);

  const activity = await waitFor(async () => {
    const current = await api('/api/ai/activity');
    return current.totalCalls === 8 && current;
  }, 'MCP activity did not record all eight calls.');
  assert.equal(activity.connections.length, 1);
  await api(roomPath + '/end', { mediaTimeMs: 13000 });
  await watch;

  await api('/api/watch-bridge/settings', { intervalSeconds: 6 });
  const { room: secondRoom } = await api('/api/rooms/open', { mediaId: FILM_ID });
  const secondRoomPath = '/api/rooms/' + secondRoom.id;
  const reads = stateReads;
  cli = spawn(process.execPath, ['watch.mjs', '--cinema-url', relayUrl, '--cinema-root', ROOT], {
    cwd: standalone, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true
  });
  const lines = createInterface({ input: cli.stdout });
  const line = once(lines, 'line', { signal: AbortSignal.timeout(5000) });
  line.catch(() => {});
  const cliExit = once(cli, 'exit');
  await waitFor(() => stateReads > reads, 'The standalone CLI did not connect.');
  await delay(80);
  await api(secondRoomPath + '/playback', { mediaTimeMs: 6000, playbackState: 'playing' });
  const [json] = await line;
  const cliResult = JSON.parse(json);
  assert.deepEqual(cliResult, first.result);
  await api(secondRoomPath + '/end', { mediaTimeMs: 6000 });
  assert.deepEqual(await cliExit, [0, null]);

  const { room: continuedRoom } = await api('/api/rooms/open', {
    mediaId: FILM_ID, resume: { roomId: secondRoom.id, lastPositionMs: 6000 }
  });
  const continuedRoomPath = '/api/rooms/' + continuedRoom.id;
  const connected = Promise.withResolvers();
  const batches = [];
  watch = watchCinema({
    cinemaUrl: relayUrl, cinemaRoot: ROOT, signal: controller.signal, roomId: continuedRoom.id,
    onConnect: connected.resolve,
    onTick(result, context) { batches.push({ result, ...context }); }
  });
  watch.catch(() => {});
  await connected.promise;
  await api(continuedRoomPath + '/messages', { senderKind: 'user', content: 'Paused before continuing' });
  const paused = await waitFor(() => batches[0], 'The continued room did not deliver its paused chat.');
  assert.equal(paused.state.resumeFromMs, 6000);
  assert.equal(paused.state.playheadMs, 6000);
  assert.equal(paused.includesPlayback, false);
  assert.match(JSON.stringify(paused.result), /Paused before continuing/);
  assert.doesNotMatch(JSON.stringify(paused.result), /A complete opening line/);
  assert.equal(paused.result.content.some(block => block.type === 'image'), false);

  await api(continuedRoomPath + '/playback', { mediaTimeMs: 12000, playbackState: 'playing' });
  const continued = await waitFor(() => batches[1], 'The continued room did not deliver its first playback tick.');
  assert.equal(continued.includesPlayback, true);
  assert.match(JSON.stringify(continued.result), /Another line after the first tick/);
  assert.match(JSON.stringify(continued.result), /Tail before the pause/);
  assert.doesNotMatch(JSON.stringify(continued.result), /A complete opening line/);
  assert.equal(continued.result.content.some(block => block.type === 'image'), false);
  await api(continuedRoomPath + '/end', { mediaTimeMs: 12000 });
  await watch;
});

test('Chat optional tool groups update live and manage a screened room with recorded activity', { timeout: 15000 }, async t => {
  const { createChatProtocol, createChatTransport, OPEN, CONTROL, RECEIPT } = await import('../../watch-bridge/adapters/chat/server.mjs');
  const data = await mkdtemp(join(tmpdir(), 'owc-chat-tool-groups-'));
  let cinema;
  t.after(async () => {
    if (cinema && cinema.exitCode === null && cinema.signalCode === null) {
      cinema.kill();
      await once(cinema, 'exit');
    }
    await rm(data, { recursive: true, force: true });
  });
  await seedFilm(data, [{ filename: 'frame-two.jpg', mediaTimeMs: 4200, panelTimesMs: [4200] },
    { filename: 'frame-ahead.jpg', mediaTimeMs: 17000, panelTimesMs: [17000] }]);
  cinema = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT, env: { ...process.env, OPEN_BROWSER: '0', LOCAL_DATA_ROOT: data, PORT: '0',
      OPEN_WATCH_CINEMA_IMAGE_BUDGET_BYTES: String(JPEG.length) },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  let output = '';
  cinema.stdout.on('data', chunk => { output += chunk; });
  const cinemaUrl = await waitFor(() => /^Open: (http:\/\/127\.0\.0\.1:\d+)$/m.exec(output)?.[1], 'No cinema address');
  async function api(path, body) {
    const response = await fetch(cinemaUrl + path, body === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.ok(response.ok, path);
    return response.json();
  }
  const settingsEndpoint = '/api/watch-bridge/chat';
  const protocol = createChatProtocol({ html: '', transport: createChatTransport({ cinemaUrl }) });
  let id = 0;
  const meta = { 'openai/session': 'isolated-test-chat' };
  const rpc = async (method, params) => (await protocol.handleRequest({ id: ++id, method, params })).result;
  const tool = (name, args) => rpc('tools/call', { name, arguments: args, _meta: meta });
  const names = async () => (await rpc('tools/list')).tools.map(tool => tool.name);
  const manage = (action, parameters) => tool('cinema_manage', { action, parameters });
  const resultData = result => JSON.parse(result.content[0].text);

  assert.equal((await names()).includes('cinema_manage'), false);
  assert.equal((await names()).includes('cinema_read_window'), false);
  await api('/api/watch-bridge/settings', { intervalSeconds: 13 });
  await api(settingsEndpoint, { enabled: true, enableControl: true });
  assert.equal((await names()).includes('cinema_manage'), true);
  assert.equal((await manage('list_media')).isError, true);
  await api('/api/participants/ai-profiles', { action: 'create', name: 'Fixture Chat' });
  const cardId = (await tool(OPEN, {}))._meta['open-watch-cinema/cardId'];
  const app = (action, ids) => tool(CONTROL, { action, cardId, ...ids });
  assert.equal((await app('start'))._meta['open-watch-cinema/state'].status, 'waiting_room');
  assert.equal(resultData(await manage('list_media')).items[0].id, FILM_ID);
  const room = resultData(await manage('open_room', { mediaId: FILM_ID, allowIncomplete: true })).room;
  assert.equal(room.status, 'active');
  await waitFor(async () => (await api(settingsEndpoint)).status === 'watching', 'Chat bridge did not subscribe');
  const seek = resultData(await tool('cinema_control', { action: 'request', parameters: { targetMs: 500, reason: 'test' } }));
  assert.equal(seek.applied, false);
  assert.equal(seek.approvalChannel, 'unavailable');
  const play = mediaTimeMs => api('/api/rooms/' + room.id + '/playback', { mediaTimeMs, playbackState: 'playing' });
  await play(12000);
  const tuned = await api(settingsEndpoint, { lookaheadSeconds: 20 });
  assert.equal(tuned.intervalSeconds, 13);
  assert.equal(tuned.settings.lookaheadSeconds, 20);
  assert.equal((await api('/api/watch-bridge/state')).intervalMs, 13000);
  await play(12999);
  await delay(80);
  assert.equal((await app('poll'))._meta['open-watch-cinema/state'].state, 'watching');
  const waiting = await api('/api/ai/activity');
  assert.equal(waiting.connections.some(connection => connection.lastCall?.tool === 'open_watch_cinema_tick'), false);
  await play(13000);
  const ready = await waitFor(async () => {
    const reply = await app('poll');
    const state = reply._meta?.['open-watch-cinema/state'];
    return state?.state === 'ready' && state;
  }, 'No Chat playback packet');
  const packet = (await app('result', { batchId: ready.batchId, claimId: 'fixture' }))._meta['open-watch-cinema/packet'];
  assert.equal(packet.content.filter(item => item.type === 'image').length, 3);
  assert.ok(packet._meta['open-watch-cinema/filmSeconds'] > 13);
  assert.equal((await tool('cinema_read_window', { fromMs: 0, toMs: 3500 })).isError, true);
  await api(settingsEndpoint, { enableHistory: true });
  assert.equal((await names()).includes('cinema_read_window'), true);
  const history = resultData(await tool('cinema_read_window', { fromMs: 0, toMs: 3500 }));
  assert.ok(history.dialogue.some(cue => cue.text === 'A complete opening line.'));
  await api('/api/rooms/' + room.id + '/playback', { mediaTimeMs: 13200, playbackState: 'paused' });
  await api('/api/participants/viewer', { name: 'Fixture *viewer*' });
  const roomMessage = 'Pause while ahead.\n\n> Keep the original formatting.';
  const note = await api('/api/rooms/' + room.id + '/messages', { content: roomMessage, mediaTimeMs: 13200 });
  assert.equal(note.message.mediaTimeMs, 13200);
  assert.equal((await app('poll'))._meta['open-watch-cinema/state'].state, 'pending');
  assert.deepEqual(await tool(RECEIPT, {}), { content: [] });
  const paused = await waitFor(async () => {
    const reply = await app('poll');
    const state = reply._meta?.['open-watch-cinema/state'];
    return state?.state === 'ready' && state;
  }, 'Viewer message remained behind the delivered future film cursor');
  const priority = (await app('result', { batchId: paused.batchId, claimId: 'paused-message' }))._meta['open-watch-cinema/packet'];
  assert.equal(priority.content.filter(item => item.type === 'text' && item.text.includes(roomMessage)).length, 1);
  assert.ok(priority.content.some(item => item.type === 'text' &&
    item.text === '**Fixture \\*viewer\\*的房间留言 · 0:13.200**\n\n' + roomMessage));
  assert.equal(priority.content.some(item => item.type === 'image'), false);
  assert.equal(priority._meta['open-watch-cinema/filmSeconds'], 13.2);
  assert.equal(resultData(await manage('end_room')).room.status, 'ended');
  assert.equal((await api('/api/health')).roomOpen, false);
  await waitFor(async () => {
    const snapshot = await api('/api/ai/activity');
    for (const connection of snapshot.connections.filter(item => item.transport === 'chat' && item.callCount)) {
      const { calls } = await api('/api/ai/activity/' + connection.connectionId + '/calls');
      if (calls.some(call => call.tool === 'cinema_manage' && call.action === 'end_room')) return true;
    }
    return false;
  }, 'No management activity after ending room');
  await api(settingsEndpoint, { enableControl: false });
  assert.equal((await names()).includes('cinema_manage'), false);
  assert.equal((await names()).includes('cinema_read_window'), true);
  assert.equal((await manage('list_media')).isError, true);

  // These calls came from another adapter. The stopped card sees the same
  // service-run activity (including past rooms and other connections) as the player.
  await app('stop');
  const connectionId = randomUUID();
  const report = { connectionId, profileId: null };
  const { runId } = await api('/api/ai/activity', { ...report, seq: 1, op: 'heartbeat' });
  const callId = randomUUID();
  const now = Date.now();
  await api('/api/ai/activity', { ...report, runId, seq: 2, op: 'call', callId,
    tool: 'cinema_inspect_frame', startedAt: now, finishedAt: now, isError: false,
    content: [{ type: 'text', text: 'Earlier frame' }, { type: 'image', mimeType: 'image/jpeg', data: JPEG.toString('base64') }] });
  const activity = async (action, args) => {
    const result = await app(action, args);
    assert.deepEqual(result.content, []);
    return result._meta['open-watch-cinema/activity'];
  };
  const player = await api('/api/ai/activity');
  assert.deepEqual(await activity('activity'), { ...player, room: null });
  assert.deepEqual(await activity('activity_calls', { connectionId, offset: 0, limit: 1 }),
    await api('/api/ai/activity/' + connectionId + '/calls?offset=0&limit=1'));
  assert.deepEqual((await activity('activity_call', { connectionId, callId })).content, [
    { type: 'text', text: 'Earlier frame' },
    { type: 'image', index: 1, mimeType: 'image/jpeg', byteLength: JPEG.length }
  ]);
  assert.deepEqual(await activity('activity_image', { connectionId, callId, index: 1 }),
    { type: 'image', mimeType: 'image/jpeg', data: JPEG.toString('base64') });
  const foreign = await rpc('tools/call', { name: CONTROL, arguments: { action: 'activity', cardId },
    _meta: { 'openai/session': 'different-chat' } });
  assert.equal(foreign.isError, true);
  assert.equal(foreign._meta, undefined);
  assert.equal((await tool('activity', {})).isError, true);
  const nextCard = (await tool(OPEN, {}))._meta['open-watch-cinema/cardId'];
  await tool(CONTROL, { action: 'start', cardId: nextCard });
  assert.equal((await app('activity')).isError, true);
});

test('Chat stdio manual viewing follows settings and keeps each conversation cursor isolated', { timeout: 15000 }, async t => {
  const data = await mkdtemp(join(tmpdir(), 'owc-chat-manual-'));
  const processes = [];
  function start(script, env, input = 'ignore') {
    const child = spawn(process.execPath, [script], {
      cwd: ROOT, env: { ...process.env, ...env }, stdio: [input, 'pipe', 'inherit'], windowsHide: true
    });
    processes.push(child);
    return child;
  }
  t.after(async () => {
    await Promise.all(processes.map(async child => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }));
    await rm(data, { recursive: true, force: true });
  });
  await seedFilm(data);
  const cinema = start('server.mjs', { OPEN_BROWSER: '0', LOCAL_DATA_ROOT: data, PORT: '0' });
  let output = '';
  cinema.stdout.on('data', chunk => { output += chunk; });
  const url = await waitFor(() => /^Open: (http:\/\/127\.0\.0\.1:\d+)$/m.exec(output)?.[1], 'No cinema address');
  async function api(path, body) {
    const response = await fetch(url + path, body === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    const payload = await response.json();
    assert.ok(response.ok, JSON.stringify(payload));
    return payload;
  }
  async function connect(script) {
    const child = start(script, { OPEN_WATCH_CINEMA_URL: url, OPEN_WATCH_CINEMA_REQUIRE_URL: '1' }, 'pipe');
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    let id = 0;
    const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    const rpc = async (method, params) => {
      send({ id: ++id, method, params });
      const reply = JSON.parse((await lines.next()).value);
      assert.equal(reply.id, id);
      assert.equal(reply.error, undefined);
      return reply.result;
    };
    assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'isolated-test', version: '1' } })).protocolVersion, '2025-06-18');
    send({ method: 'notifications/initialized' });
    return rpc;
  }
  const chat = await connect('watch-bridge/adapters/chat/main.mjs');
  const ordinary = await connect('mcp/server.mjs');
  const tickName = 'open_watch_cinema_tick';
  const settings = '/api/watch-bridge/chat';
  const names = async () => (await chat('tools/list')).tools.map(tool => tool.name);
  const tool = (name, args = {}, session = 'chat-a') => chat('tools/call', {
    name, arguments: args, ...(session && { _meta: { 'openai/session': session } })
  });
  assert.equal((await names()).includes(tickName), false);
  assert.equal((await tool(tickName)).isError, true);
  await api(settings, { enableManual: true });
  assert.equal((await names()).includes(tickName), true);
  assert.equal((await tool(tickName)).isError, true);
  assert.equal((await tool(tickName, {}, null)).isError, true);

  await api('/api/participants/ai-profiles', { action: 'create', name: 'Manual Chat fixture' });
  const { room } = await api('/api/rooms/open', { mediaId: FILM_ID });
  const play = (mediaTimeMs, playbackState = 'playing') =>
    api('/api/rooms/' + room.id + '/playback', { mediaTimeMs, playbackState });
  await play(0);
  await play(4000, 'paused');
  const first = await tool(tickName);
  assert.equal(first.isError, undefined, JSON.stringify(first));
  assert.match(JSON.stringify(first.content), /A complete opening line/);
  assert.ok(first.content.some(block => block.type === 'image'));
  const regular = await ordinary('tools/call', { name: tickName, arguments: {} });
  assert.match(JSON.stringify(regular.content), /A complete opening line/);
  assert.doesNotMatch(JSON.stringify((await tool(tickName)).content), /A complete opening line/);
  assert.match(JSON.stringify((await tool(tickName, {}, 'chat-b')).content), /A complete opening line/);

  const posted = await tool('cinema_post_message', { content: 'From the manual Chat connection' });
  assert.equal(posted.isError, undefined, JSON.stringify(posted));
  assert.match(JSON.stringify(posted.content), /From the manual Chat connection/);
  await api(settings, { enabled: true });
  const card = (await tool('open_cinema_card'))._meta['open-watch-cinema/cardId'];
  const app = action => tool('cinema_card_control', { action, cardId: card });
  assert.equal((await app('start')).isError, undefined);
  const blocked = await tool(tickName);
  assert.match(blocked.content[0].text, /已开启自动跟片/);
  assert.equal(blocked.content.length, 1);
  await api(settings, { enabled: false });
  await play(8000);
  await play(8500, 'paused');
  const resumed = await tool(tickName);
  assert.equal(resumed.isError, undefined, JSON.stringify(resumed));
  assert.match(JSON.stringify(resumed.content), /Another line after the first tick/);
  assert.doesNotMatch(JSON.stringify(resumed.content), /A complete opening line/);
  await api(settings, { enableManual: false });
  assert.equal((await names()).includes(tickName), false);
  assert.equal((await tool(tickName)).isError, true);
  assert.equal((await tool('cinema_post_message', { content: 'Disabled by settings' })).isError, true);
});
