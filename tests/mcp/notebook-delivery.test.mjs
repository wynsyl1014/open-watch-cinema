import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCinemaClient } from '../../mcp/runtime/cinema-client.mjs';
import { createViewingSession } from '../../mcp/viewing/viewing-session.mjs';
import { createToolRegistry } from '../../mcp/tools/index.mjs';
import * as validation from '../../mcp/runtime/validation.mjs';
import { toolErrorResult } from '../../mcp/runtime/results.mjs';

async function startCinema(t) {
  const root = await mkdtemp(join(tmpdir(), 'owc-notebook-http-'));
  const media = join(root, 'media');
  await mkdir(media);

  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, LOCAL_DATA_ROOT: root, PORT: String(port), OPEN_BROWSER: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exit = once(child, 'exit');
  t.after(async () => {
    child.kill();
    await exit;
    await rm(root, { recursive: true, force: true });
  });
  let output = '';
  const url = 'http://127.0.0.1:' + port;
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('Open: ' + url)) resolve(); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('exit', () => reject(new Error(output)));
  });
  const imported = await fetch(url + '/api/library/import?name=test-film.mp4', {
    method: 'POST', body: 'local notebook fixture'
  });
  assert.equal(imported.status, 200, await imported.text());
  return createCinemaClient({ urls: [url] });
}

function participant(cinema) {
  const session = createViewingSession(cinema);
  const registry = createToolRegistry({ ...session, ...cinema, ...validation,
    CATCHUP_TIME_BUDGET_MS: Infinity, IMAGE_BUDGET_BYTES: Infinity });
  return (tool, args = {}) => registry.call(tool, args);
}

const content = result => result.mcpContent.map(block => block.text).join('\n');

test('a human correction reaches each AI once, with live names, independently of media preparation', { timeout: 15000 }, async t => {
  const cinema = await startCinema(t);
  const request = cinema.cinemaRequest;
  const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) });
  const mediaId = (await request('/api/media')).items[0].id;
  const open = () => post('/api/rooms/open', { mediaId });
  const { room } = await open();
  const book = '/api/rooms/' + room.id + '/notebook';
  const author = participant(cinema);
  const reader = participant(cinema);
  const { selectedId: authorId } = await post('/api/participants/ai-profiles', { action: 'create', name: '旧署名' });

  const write = { action: 'write', text: '[人物]\n@信使 | 雨夜抵达\n[随记]\n门响了两声' };
  await author('cinema_notebook', write);
  assert.match(content(await author('cinema_notebook', write)), /这笔已保存/);
  const entries = (await request(book)).entries;
  assert.equal(entries.length, 2);
  const character = entries.find(row => row.kind === 'character');
  const onlyNotes = content(await author('cinema_notebook', { action: 'read', section: 'jot' }));
  assert.match(onlyNotes, /门响了两声/);
  assert.doesNotMatch(onlyNotes, /雨夜抵达/);
  const bad = { action: 'write', text: '[随记]\n这行要回滚\n[未知]' };
  await assert.rejects(author('cinema_notebook', bad), error => {
    const detail = JSON.parse(toolErrorResult(error).content[0].text);
    return detail.line === 3 && detail.message.includes('未知段名');
  });
  assert.equal((await request(book)).entries.length, 2);
  const base = (await cinema.discoverCinema()).baseUrl;
  const stream = await fetch(base + '/api/events');
  const readerStream = stream.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    await author('cinema_notebook', { action: 'write', text: '[修订]\n#' + character.id + '/v' + character.version + ' | 小传 | 推门进屋' });
    let events = '';
    while (!events.includes('"active":false')) events += (await readerStream.read()).value;
    const packets = events.split('\n').filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6))).filter(packet => packet.type);
    assert.deepEqual(packets.map(packet => packet.type), ['notebook-edit', 'notebook', 'notebook-edit']);
    assert.equal(packets[0].token, packets[2].token);
    assert.equal(packets[0].actorName, '旧署名');
    assert.deepEqual(packets[0].targets, [{ ref: character.id, fields: ['text'] }]);
  } finally {
    await readerStream.cancel();
  }
  assert.deepEqual((await request(book)).editing, []);
  await assert.rejects(post(book, { id: character.id, expectedVersion: character.version, text: '敲门' }), { code: 'NOTEBOOK_VERSION_CONFLICT' });
  const changed = await post(book, { id: character.id, expectedVersion: character.version, name: '送信人' });
  assert.equal(changed.entries.find(row => row.id === character.id).text, '推门进屋');
  const chat = await post('/api/rooms/' + room.id + '/messages', { content: '这是一条弹幕' });
  await post('/api/participants/viewer', { name: '鹿鹿' });
  const message = await request('/api/rooms/' + room.id + '/messages?ids=' + chat.message.id);
  assert.deepEqual(message.messages, [{ id: chat.message.id, senderName: '鹿鹿' }]);
  await post('/api/participants/ai-profiles', { action: 'rename', id: authorId, name: '沈晏' });
  await post('/api/participants/ai-profiles', { action: 'create', name: '另一位观众' });

  for (const ai of [author, reader]) {
    const update = content(await ai('open_watch_cinema_tick'));
    assert.match(update, /观影笔记更新/);
    assert.match(update, /鹿鹿 修改了 沈晏 的观影小本本/);
    assert.doesNotMatch(update, /旧署名|房间互动|这是一条弹幕/);
    await assert.rejects(ai('open_watch_cinema_tick'), { code: 'AI_PACKAGE_INCOMPLETE' });
  }
  await post('/api/rooms/' + room.id + '/end', {});
  const { room: nextRoom } = await open();
  assert.notEqual(nextRoom.id, room.id);
  assert.match(content(await reader('cinema_notebook', { action: 'read' })), /送信人/);
  await assert.rejects(reader('open_watch_cinema_tick'), { code: 'AI_PACKAGE_INCOMPLETE' });

  const noteLines = Array.from({ length: 105 }, (_, i) => '存档观影笔记编号-' + String(i).padStart(3, '0'));
  for (const lines of [noteLines.slice(0, 100), noteLines.slice(100)]) {
    await reader('cinema_notebook', { action: 'write', text: '[随记]\n' + lines.join('\n') });
  }
  const nextRoomPath = '/api/rooms/' + nextRoom.id;
  const beforeRead = await request(nextRoomPath);
  const beforeEntries = (await request(nextRoomPath + '/notebook')).entries;
  const complete = content(await reader('cinema_notebook', { action: 'read' }));
  assert.match(complete, /送信人/);
  for (const text of noteLines) assert.ok(complete.includes(text), text);
  assert.deepEqual((await request(nextRoomPath)).messages, beforeRead.messages);
  assert.deepEqual((await request(nextRoomPath + '/notebook')).entries, beforeEntries);
});

test('queued images preserve private correction cursors and resolve queued chat names on the next page', async () => {
  const images = [100, 200].map(mediaTimeMs => ({ type: 'image', id: 'image-' + mediaTimeMs, fromMs: mediaTimeMs,
    toMs: mediaTimeMs, availableAtMs: mediaTimeMs, mediaTimeMs, storyboardRef: String(mediaTimeMs) }));
  const room = { id: 'room', status: 'active', lastPositionMs: 1000, seekVersion: 0 };
  const tick = { packageVersion: 3, playback: { timeMs: 1000, seekVersion: 0, state: 'playing' },
    range: { fromMs: 0, toMs: 1000 }, dialogueDelta: [], audioDescriptions: [], motionEvents: [],
    notebookChanges: [{ id: 3, atMs: 0, content: '第一次修正' }],
    newMessages: [{ messageId: 5, senderName: '旧名', content: '门口见', mediaTimeMs: 300 }],
    segments: [{ id: 'segment', fromMs: 0, toMs: 1000, entries: images }], storyboards: images };
  let fetches = 0;
  const cinemaRequest = async (path, options) => {
    if (path === '/api/participants/ai-profiles') return { selectedId: 'one', profiles: [{ id: 'one', name: '一' }] };
    if (path === '/api/ai/tick') {
      assert.equal(fetches++, 0);
      return { tick, state: { roomId: room.id, cursors: { mediaMs: 1000, messageId: 5,
        seekVersion: 0, observationSequence: 0, notebookEventId: 3 } } };
    }
    if (path === '/api/rooms/room/messages?ids=5') return { messages: [{ id: 5, senderName: '新名' }] };
    assert.equal(path, '/api/rooms/room/playback-state');
    if (options.headers) {
      assert.equal(options.headers['x-owc-notebook-after'], '3');
      return { room, notebookChanges: [{ id: 7, atMs: 0, content: '第二次修正' }] };
    }
    return { room };
  };
  const session = createViewingSession({ cinemaRequest });
  const registry = createToolRegistry({ ...session, ...validation, cinemaRequest, IMAGE_BUDGET_BYTES: 1,
    CATCHUP_TIME_BUDGET_MS: Infinity, readFrame: async () => ({
      image: { type: 'image', mimeType: 'image/jpeg', data: 'aW1hZ2U=' }
    }) });
  const first = content(await registry.call('open_watch_cinema_tick'));
  assert.match(first, /第一次修正/);
  assert.doesNotMatch(first, /门口见/);
  const next = content(await registry.call('open_watch_cinema_tick'));
  assert.match(next, /第二次修正/);
  assert.match(next, /新名：门口见/);
  assert.doesNotMatch(next, /第一次修正|旧名/);
  assert.equal(session.clientState.cursors.notebookEventId, 7);
});

test('a narrowed Chat horizon invalidates an unsubmitted image page and retains its unread cursors', async () => {
  const token = 'fixture-chat-only';
  const room = { id: 'room', status: 'active', lastPositionMs: 100, seekVersion: 0, deliveryHorizonMs: 200 };
  const images = [100, 200].map(ms => ({ type: 'image', id: String(ms), fromMs: ms,
    toMs: ms, availableAtMs: ms, mediaTimeMs: ms, storyboardRef: String(ms) }));
  const sourceReads = [];
  async function cinemaRequest(path, options) {
    assert.equal(options.headers['x-owc-chat-feed-token'], token);
    if (path.endsWith('/playback-state')) return { room };
    assert.equal(path, '/api/ai/tick');
    const { cursors } = JSON.parse(options.body);
    sourceReads.push(cursors);
    const cutoff = room.deliveryHorizonMs;
    const entries = images.filter(frame => frame.fromMs > cursors.mediaMs && frame.fromMs <= cutoff);
    return {
      tick: { packageVersion: 3,
        playback: { timeMs: room.lastPositionMs, seekVersion: 0, state: 'playing', deliveryHorizonMs: cutoff },
        range: { fromMs: cursors.mediaMs, toMs: cutoff }, dialogueDelta: [], audioDescriptions: [], newMessages: [],
        notebookChanges: cursors.notebookEventId === 3 ? [] : [{ id: 3, atMs: 0, content: '保留修正' }],
        segments: [{ id: 'segment', fromMs: 0, toMs: 200, entries }] },
      state: { roomId: room.id, cursors: { ...cursors, mediaMs: cutoff, notebookEventId: 3 } }
    };
  }
  const session = createViewingSession({ cinemaRequest, expectedRoomId: room.id, chatFeedToken: token,
    resumeCursors: { mediaMs: 0, observationSequence: 0, seekVersion: 0, messageId: 0, notebookEventId: 0 } });
  session.clientState.identity = 'selected-ai';
  const registry = createToolRegistry({ ...session, ...validation, cinemaRequest, chatFeedToken: token,
    CATCHUP_TIME_BUDGET_MS: Infinity, IMAGE_BUDGET_BYTES: 1, TRACK_IMAGE_REFS: true,
    readFrame: async (roomId, ref) => ({
      image: { type: 'image', mimeType: 'image/jpeg', data: Buffer.from(ref).toString('base64') }
    }) });
  const tick = () => registry.call('open_watch_cinema_tick');
  const deliveredImages = result => result.mcpContent.filter(block => block.type === 'image')
    .map(block => Buffer.from(block.data, 'base64').toString());
  const first = await tick();
  assert.equal(first.bridgeMoreImagePages, true);
  assert.deepEqual(deliveredImages(first), ['100']);
  room.deliveryHorizonMs = 100;
  await assert.rejects(tick(), { code: 'PLAYBACK_CHANGED' });
  assert.equal(session.clientState.cursors.notebookEventId, 0);
  const paused = await tick();
  assert.deepEqual(deliveredImages(paused), ['100']);
  assert.match(content(paused), /保留修正/);
  room.deliveryHorizonMs = 200;
  const continuation = await tick();
  assert.deepEqual(deliveredImages(continuation), ['200']);
  assert.doesNotMatch(content(continuation), /保留修正/);
  assert.deepEqual(sourceReads.map(cursors => cursors.mediaMs), [0, 0, 100]);
});

test('viewer-selected profiles persist across connections and previous credits follow a rename', async t => {
  const cinema = await startCinema(t);
  const request = cinema.cinemaRequest;
  const editProfile = body => request('/api/participants/ai-profiles', { method: 'POST', body: JSON.stringify(body) });
  const mediaId = (await request('/api/media')).items[0].id;
  await request('/api/rooms/open', { method: 'POST', body: JSON.stringify({ mediaId }) });
  const first = participant(cinema);
  const other = participant(cinema);
  const { selectedId } = await editProfile({ action: 'create', name: '沈晏' });
  await first('cinema_notebook', { action: 'write', text: '[随记]\n风声停了' });
  await editProfile({ action: 'create', name: '小星' });
  await other('cinema_notebook', { action: 'write', text: '[随记]\n灯也灭了' });
  await editProfile({ action: 'rename', id: selectedId, name: '晏' });
  await first('cinema_notebook', { action: 'write', text: '[随记]\n一片寂静' });
  await editProfile({ action: 'select', id: selectedId });
  const next = participant(cinema);
  await next('cinema_notebook', { action: 'write', text: '[随记]\n片尾' });
  const notes = content(await other('cinema_notebook', { action: 'read' }));
  for (const text of ['风声停了', '一片寂静', '片尾']) assert.match(notes, new RegExp('晏[^\n]*' + text));
  assert.match(notes, /小星[^\n]*灯也灭了/);
  assert.doesNotMatch(notes, /沈晏/);
});
