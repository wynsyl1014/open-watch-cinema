import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate as nextTick } from 'node:timers/promises';
import test from 'node:test';
import { runCodexScreening } from '../../watch-bridge/adapters/codex/screening.mjs';

const roomId = 'fixture-room';
const threadId = 'fixture-thread';
const toolNames = ['cinema_post_message', 'cinema_inspect_frame', 'cinema_notebook'];
const meta = 'open-watch-cinema/bridgeCursors';

function factory({ saved, userId = 'fixture-user', holdObserved, holdThread, authMode = 'inherit', failName, failDesktop,
  openingMessage, recentTurn, historyUnsupported, codexConfig, codexDefaults, resumeFromMs, readNotebook,
  instructions, viewerName } = {}) {
  const stop = new AbortController();
  const events = [];
  const calls = [];
  const mcpCalls = [];
  const ready = Promise.withResolvers();
  const interrupted = Promise.withResolvers();
  const ack = Promise.withResolvers();
  const threadAck = Promise.withResolvers();
  let watching;
  let callbacks;
  let seekVersion = 0;
  let thisTurn;
  let turnCount = 0;

  async function mockCodex(config) {
    callbacks = config;
    calls.push({ method: 'client/open', params: config.config });
    return {
      cwd: '/test/cinema-workspace',
      async openDesktopOnce() {
        calls.push({ method: 'desktop/open' });
        if (failDesktop) throw new Error('Desktop failed to open.');
      },
      async request(method, params) {
        calls.push({ method, params });
        switch (method) {
          case 'account/read': return { account: { type: 'chatgpt' }, userId };
          case 'config/read': return { config: { approval_policy: 'never', sandbox_mode: 'danger-full-access', ...codexConfig, mcp_servers: {
            open_watch_cinema: { command: 'node' }, personal: { command: 'example' }
          } } };
          case 'thread/start': return params.ephemeral ? { thread: { id: 'transient-thread' }, ...codexDefaults }
            : { thread: { id: threadId } };
          case 'thread/unsubscribe': return {};
          case 'thread/resume': return { thread: { id: threadId } };
          case 'thread/turns/list':
            if (historyUnsupported) throw Object.assign(new Error('Method not found'), { code: -32601 });
            return { data: recentTurn ? [recentTurn] : [], nextCursor: null };
          case 'thread/name/set':
            calls.at(-1).afterSaved = events.some(event => event.type === 'thread' && event.threadId === params.threadId);
            if (failName) throw new Error('name rejected');
            return {};
          case 'turn/start':
            if (!thisTurn) {
              thisTurn = 'turn-' + ++turnCount;
              callbacks.onNotification('turn/started', { threadId, turn: { id: thisTurn } });
            }
            return { turn: { id: thisTurn, status: 'inProgress' } };
          case 'turn/interrupt':
            interrupted.resolve(params.turnId);
            return {};
          default: assert.fail('Unexpected RPC ' + method);
        }
      },
      async close() { calls.push({ method: 'closed' }); }
    };
  }

  async function mockWatch(options) {
    watching = options;
    options.onPlaybackState({ roomId, seekVersion });
    await options.onConnect({
      signal: options.signal,
      async listTools() {
        return ['open_watch_cinema_tick', ...toolNames].map(name => ({
          name, description: name, inputSchema: { type: 'object' }
        }));
      },
      async callTool(tool, args, requestOptions) {
        mcpCalls.push({ tool, args, requestOptions });
        if (tool === 'cinema_notebook' && args.action === 'read' && readNotebook) return readNotebook();
        return { content: tool === 'cinema_inspect_frame'
          ? [{ type: 'image', mimeType: 'image/jpeg', data: '/9j/2Q==' }]
          : [{ type: 'text', text: 'posted' }] };
      }
    });
    if (options.signal.aborted) return;
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
  }

  function record(message) {
    events.push(message);
    if (message.type === 'ready') ready.resolve(message);
  }

  const run = runCodexScreening({
    roomId, ...saved,
    config: { profileId: 'fixture-profile', model: 'fixture-sol', authMode,
      profileName: 'Movie Companion', filmTitle: 'Weekend Cinema', openingMessage, resumeFromMs, instructions, viewerName,
      roomOpenedAt: new Date(2026, 10, 24, 0, 53, 27).toISOString() },
    signal: stop.signal, openClient: mockCodex, watch: mockWatch, emit: record,
    async persist(message) {
      record(message);
      if (holdObserved && message.type === 'observed') await ack.promise;
      if (holdThread && message.type === 'thread') await threadAck.promise;
    }
  });
  run.catch(() => {});
  return {
    run, ready: ready.promise, interrupted: interrupted.promise, ack, threadAck, calls, mcpCalls, events,
    get watching() { return watching; },
    stop: () => stop.abort(),
    tick(reason, id, ...content) {
      deliver(reason, reason === 'interval', id, ...content);
    },
    deliver,
    complete(status = 'completed') {
      const old = thisTurn;
      thisTurn = undefined;
      callbacks.onNotification('turn/completed', { threadId, turn: { status, id: old } });
    },
    seek() {
      watching.onPlaybackState({ roomId, seekVersion: ++seekVersion });
    },
    tool(tool, args = {}, turnId = thisTurn) {
      return callbacks.onRequest('item/tool/call', { threadId, turnId, namespace: null, tool, arguments: args });
    }
  };

  function deliver(reason, includesPlayback, id, ...content) {
    const result = { content: content.map(block => typeof block === 'string' ? { type: 'text', text: block } : block),
      _meta: { [meta]: { messageId: id, mediaMs: id * 6000, seekVersion } } };
    watching.onTick(result, { reason, includesPlayback, state: { roomId, seekVersion }, results: [result] });
  }
}

test('the room nickname renders in default and custom instructions for new and resumed threads', { timeout: 5000 }, async t => {
  const viewerName = '鹿鹿 $&';
  const saved = { threadId, accountId: createHash('sha256').update('fixture-user').digest('hex') };
  for (const options of [
    { viewerName, expected: /正在与 鹿鹿 \$& 共享一场电影/, method: 'thread/start' },
    { viewerName, instructions: '和 {{viewerName}} 聊。', saved, expected: /^和 鹿鹿 \$& 聊。$/, method: 'thread/resume' },
    { viewerName, instructions: '', saved, expected: /^$/, method: 'thread/resume' }
  ]) {
    const show = factory(options);
    try {
      await show.ready;
      const { agents } = show.calls.find(call => call.method === 'client/open').params;
      assert.match(agents, options.expected);
      assert.doesNotMatch(agents, /\{\{viewerName\}\}|cinema_finish_turn/);
      assert.ok(show.calls.some(call => call.method === options.method));
    } finally {
      show.stop();
      await show.run;
    }
  }
});

test('idle startup, real payload shape, chat joins active native turn and seeks reject stale tools', { timeout: 5000 }, async t => {
  const show = factory();
  t.after(async () => { show.stop(); await show.run; });
  const ready = await show.ready;
  assert.equal(ready.threadId, threadId);
  const setup = show.calls.find(call => call.method === 'thread/start').params;
  assert.equal(setup.model, 'fixture-sol');
  assert.deepEqual(setup.dynamicTools.map(tool => tool.name), toolNames);
  assert.deepEqual(setup.config, { mcp_servers: { open_watch_cinema: { enabled: false } } });
  assert.match(setup.developerInstructions, /Movie Companion.*Weekend Cinema|Weekend Cinema.*Movie Companion/s);
  assert.equal(show.calls.some(call => call.method === 'turn/start'), false);

  show.tick('interval', 1, 'first line', { type: 'image', mimeType: 'image/jpeg', data: '/9j/2Q==' });
  await nextTick();
  const turns = () => show.calls.filter(call => call.method === 'turn/start');
  assert.deepEqual(turns()[0].params.toolOutput, {
    name: 'open_watch_cinema_tick', namespace: null, retain: true, output: [
      { type: 'input_text', text: 'first line' },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/2Q==' }
    ]
  });
  assert.deepEqual(turns()[0].params.input, []);
  const inspection = await show.tool('cinema_inspect_frame', { atMs: 1234 });
  assert.deepEqual(inspection.contentItems, [{ type: 'inputImage', imageUrl: 'data:image/jpeg;base64,/9j/2Q==' }]);
  assert.equal((await show.tool('open_watch_cinema_tick')).success, false);

  show.tick('interval', 2, 'queued line');
  await nextTick();
  assert.equal(turns().length, 1);
  show.tick('chat', 3, 'viewer question');
  await nextTick();
  assert.equal(turns().length, 2);
  assert.deepEqual(turns()[1].params.toolOutput.output.map(block => block.text), ['queued line', 'viewer question']);
  assert.equal(show.events.filter(event => event.type === 'started')[1].turnId, 'turn-1');

  show.tick('interval', 4, 'before rewind');
  show.seek();
  assert.equal(await show.interrupted, 'turn-1');
  assert.equal((await show.tool('cinema_post_message', { content: 'stale' })).success, false);
  show.complete('interrupted');
  show.tick('interval', 5, 'after rewind');
  await nextTick();
  assert.equal(turns().length, 3);
  assert.deepEqual(turns()[2].params.toolOutput.output.map(block => block.text), ['after rewind']);
  assert.equal((await show.tool('cinema_post_message', { content: 'up to date' })).success, true);
  assert.deepEqual(show.mcpCalls.at(-1).requestOptions, { expectedSeekVersion: 1 });
});

test('new inherited rooms let Codex apply its current configuration while isolated rooms keep their policy', { timeout: 5000 }, async t => {
  for (const authMode of ['inherit', 'isolated']) {
    const show = factory({ authMode });
    t.after(async () => { show.stop(); await show.run; });
    await show.ready;
    const [start] = show.calls.filter(call => call.method === 'thread/start');
    assert.equal(start.params.ephemeral, false);
    assert.equal(start.params.approvalPolicy, authMode === 'isolated' ? 'never' : undefined);
    assert.equal(start.params.sandbox, authMode === 'isolated' ? 'read-only' : undefined);
    assert.equal(start.params.permissions, undefined);
  }
});

test('resume applies the current Codex approval policy and sandbox or named profile only in inherited mode', { timeout: 5000 }, async t => {
  const saved = { threadId, accountId: createHash('sha256').update('fixture-user').digest('hex') };
  const granular = { granular: { sandbox_approval: true, rules: true, skill_approval: false,
    request_permissions: true, mcp_elicitations: false } };
  for (const [authMode, codexConfig, expected] of [
    ['inherit', {}, { approvalPolicy: 'never', sandbox: 'danger-full-access', approvalsReviewer: 'user' }],
    ['inherit', { sandbox_mode: 'workspace-write', approval_policy: 'on-request' },
      { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user' }],
    ['inherit', { default_permissions: 'workspace-profile', sandbox_mode: null,
      approval_policy: granular, approvals_reviewer: 'auto_review' },
      { approvalPolicy: granular, permissions: 'workspace-profile', approvalsReviewer: 'auto_review' }],
    ['isolated', { default_permissions: 'workspace-profile', approval_policy: 'on-request', approvals_reviewer: 'auto_review' },
      { approvalPolicy: 'never', sandbox: 'read-only' }]
  ]) {
    const show = factory({ saved, authMode, codexConfig });
    t.after(async () => { show.stop(); await show.run; });
    await show.ready;
    assert.equal(show.calls.some(call => call.method === 'thread/start'), false);
    const { params } = show.calls.find(call => call.method === 'thread/resume');
    assert.equal(params.threadId, threadId);
    assert.deepEqual(Object.fromEntries(Object.keys(params).filter(key =>
      ['approvalPolicy', 'sandbox', 'permissions', 'approvalsReviewer'].includes(key)).map(key => [key, params[key]])), expected);
  }
});

test('resume resolves unset permissions using a transient chat in the same workspace', { timeout: 5000 }, async t => {
  const saved = { threadId, accountId: createHash('sha256').update('fixture-user').digest('hex') };
  const workspaceDefaults = { sandbox: { type: 'workspaceWrite' }, activePermissionProfile: { id: ':workspace' } };
  for (const [codexConfig, codexDefaults, expected] of [
    [{ sandbox_mode: null }, workspaceDefaults, { permissions: ':workspace' }],
    [{ sandbox_mode: null }, { sandbox: { type: 'readOnly' } }, { sandbox: 'read-only' }],
    [{ sandbox_mode: 'workspace-write' }, workspaceDefaults, { sandbox: 'workspace-write' }]
  ]) {
    const show = factory({ saved, codexConfig: { ...codexConfig, approval_policy: null },
      codexDefaults: { ...codexDefaults, approvalPolicy: 'on-request', approvalsReviewer: 'user' } });
    t.after(async () => { show.stop(); await show.run; });
    await show.ready;
    const [start, unsubscribe, resume] = show.calls.filter(call => call.method.startsWith('thread/'));
    assert.deepEqual([start.method, unsubscribe.method, resume.method], ['thread/start', 'thread/unsubscribe', 'thread/resume']);
    assert.equal(start.params.ephemeral, true);
    assert.equal(start.params.cwd, resume.params.cwd);
    assert.deepEqual(start.params.config, resume.params.config);
    assert.deepEqual(unsubscribe.params, { threadId: 'transient-thread' });
    assert.equal(resume.params.threadId, threadId);
    assert.equal(resume.params.approvalPolicy, 'on-request');
    assert.equal(resume.params.approvalsReviewer, 'user');
    assert.equal(resume.params.permissions, expected.permissions);
    assert.equal(resume.params.sandbox, expected.sandbox);
    assert.equal(show.calls.some(call => call.method === 'turn/start'), false);
  }
});

test('opening waits for playback and survives queued delivery, seek and resume', { timeout: 5000 }, async () => {
  const openingMessage = 'Watch patiently.';
  const show = factory({ openingMessage });
  try {
    await show.ready;
    const setup = show.calls.find(call => call.method === 'thread/start').params;
    assert.ok(!setup.developerInstructions.includes(openingMessage));
    const turns = () => show.calls.filter(call => call.method === 'turn/start').map(call => call.params);
    assert.equal(turns().length, 0);

    show.tick('chat', 1, 'before playing');
    await nextTick();
    assert.deepEqual(turns()[0].toolOutput.output, [{ type: 'input_text', text: 'before playing' }]);
    assert.ok(!show.events.some(event => event.openingDelivered));
    show.complete();
    show.tick('chat', 2, 'still paused before playing');
    await nextTick();
    assert.deepEqual(turns()[1].toolOutput.output, [{ type: 'input_text', text: 'still paused before playing' }]);
    assert.ok(!show.events.some(event => event.openingDelivered));

    show.tick('interval', 3, 'queued before rewind');
    await nextTick();
    assert.equal(turns().length, 2);
    show.seek();
    await show.interrupted;
    show.complete('interrupted');
    show.deliver('chat', true, 4, 'first film material and chat', { type: 'image', mimeType: 'image/jpeg', data: '/9j/2Q==' });
    await nextTick();
    assert.equal(turns().length, 3);
    assert.deepEqual(turns()[2].input, []);
    assert.deepEqual(turns()[2].toolOutput.output, [
      { type: 'input_text', text: '观众开场白\n' + openingMessage },
      { type: 'input_text', text: 'first film material and chat' },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/2Q==' }
    ]);
    const checkpoint = show.events.find(event => event.openingDelivered);
    assert.equal(checkpoint.cursors.messageId, 4);

    show.tick('interval', 5, 'later queued film');
    show.tick('chat', 6, 'viewer question');
    await nextTick();
    assert.deepEqual(turns()[3].toolOutput.output.map(block => block.text), ['later queued film', 'viewer question']);

    const { accountId } = await show.ready;
    const resumed = factory({ openingMessage, saved: { threadId, accountId, cursors: checkpoint.cursors, openingDelivered: true } });
    try {
      await resumed.ready;
      resumed.tick('interval', 7, 'next film interval');
      await nextTick();
      assert.deepEqual(resumed.calls.find(call => call.method === 'turn/start').params.toolOutput.output,
        [{ type: 'input_text', text: 'next film interval' }]);
    } finally {
      resumed.stop();
      await resumed.run;
    }
  } finally {
    show.stop();
    await show.run;
  }
});

test('new rooms get a local opening-time title in both Codex modes', { timeout: 5000 }, async () => {
  for (const authMode of ['inherit', 'isolated']) {
    const show = factory({ authMode });
    try {
      await show.ready;
      const setup = show.calls.filter(({ method }) => method.startsWith('thread/'));
      assert.deepEqual(setup.map(({ method }) => method), ['thread/start', 'thread/name/set']);
      assert.deepEqual(setup[1].params, { threadId, name: 'Weekend Cinema · 2026-11-24 00:53:27' });
      assert.equal(setup[1].afterSaved, true);
    } finally {
      show.stop();
      await show.run;
    }
  }
});

test('the opening prepends a queued playback status when chat wakes the active turn', { timeout: 5000 }, async t => {
  const show = factory({ openingMessage: 'Here we go.' });
  t.after(async () => { show.stop(); await show.run; });
  await show.ready;
  show.tick('chat', 1, 'Before playback');
  await nextTick();
  show.tick('interval', 2, '播放位置 00:06 · 播放中\n正在准备后续观影内容。');
  await nextTick();
  const turns = () => show.calls.filter(call => call.method === 'turn/start');
  assert.equal(turns().length, 1);
  show.tick('chat', 3, 'Viewer message');
  await nextTick();
  assert.deepEqual(turns()[1].params.toolOutput.output.map(block => block.text), [
    '观众开场白\nHere we go.', '播放位置 00:06 · 播放中\n正在准备后续观影内容。', 'Viewer message'
  ]);
});

test('first playback in a continued room gets the opening, shared notebook and tick together', { timeout: 5000 }, async t => {
  const notebook = '[人物]\n@阿遥\n[随记]\n手记最后一条';
  const show = factory({ openingMessage: '接着看。', resumeFromMs: 98_250,
    readNotebook: () => ({ content: [{ type: 'text', text: notebook }] }) });
  t.after(async () => { show.stop(); await show.run; });
  await show.ready;
  const turns = () => show.calls.filter(call => call.method === 'turn/start').map(call => call.params.toolOutput.output);
  show.tick('chat', 1, '暂停期间的留言');
  await nextTick();
  assert.deepEqual(turns()[0], [{ type: 'input_text', text: '暂停期间的留言' }]);
  assert.equal(show.mcpCalls.length, 0);
  assert.equal(show.events.some(event => event.openingDelivered), false);

  show.tick('interval', 2, '定时观影内容', { type: 'image', mimeType: 'image/jpeg', data: '/9j/2Q==' });
  await nextTick();
  assert.equal(turns().length, 1);
  show.tick('chat', 3, '播放中的留言');
  await nextTick();
  assert.deepEqual(show.mcpCalls, [{ tool: 'cinema_notebook', args: { action: 'read' },
    requestOptions: { expectedSeekVersion: 0 } }]);
  assert.deepEqual(turns()[1], [
    { type: 'input_text', text: '观众开场白\n接着看。' },
    { type: 'input_text', text: '这是同一部影片的新放映房间，从上次结束的位置 1:38.250 接着看。\n影片共用手记' },
    { type: 'input_text', text: notebook },
    { type: 'input_text', text: '定时观影内容' },
    { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/2Q==' },
    { type: 'input_text', text: '播放中的留言' }
  ]);
  assert.equal(show.events.find(event => event.openingDelivered).cursors.messageId, 3);
  show.complete();
  show.tick('interval', 4, '下一段内容');
  await nextTick();
  assert.deepEqual(turns()[2], [{ type: 'input_text', text: '下一段内容' }]);
  assert.equal(show.mcpCalls.length, 1);
});

test('a seek invalidates the pending first-playback snapshot without consuming its checkpoint', { timeout: 5000 }, async t => {
  const notebook = Promise.withResolvers();
  const show = factory({ resumeFromMs: 30_000, readNotebook: () => notebook.promise });
  t.after(async () => { show.stop(); await show.run; });
  await show.ready;
  show.tick('interval', 1, '跳转前内容');
  await nextTick();
  assert.equal(show.mcpCalls.length, 1);
  show.seek();
  show.tick('chat', 2, '跳转后暂停留言');
  notebook.resolve({ content: [{ type: 'text', text: '共用手记' }] });
  await nextTick();
  let turns = show.calls.filter(call => call.method === 'turn/start');
  assert.deepEqual(turns.map(call => call.params.toolOutput.output), [[{ type: 'input_text', text: '跳转后暂停留言' }]]);
  assert.equal(show.events.some(event => event.openingDelivered), false);
  show.complete();
  show.tick('interval', 3, '跳转后开始播放');
  await nextTick();
  turns = show.calls.filter(call => call.method === 'turn/start');
  assert.deepEqual(show.mcpCalls.map(call => call.requestOptions.expectedSeekVersion), [0, 1]);
  assert.deepEqual(turns[1].params.toolOutput.output.map(item => item.text), [
    '这是同一部影片的新放映房间，从上次结束的位置 0:30 接着看。\n影片共用手记', '共用手记', '跳转后开始播放'
  ]);
});

test('room reconnection recovers an accepted resume intro without opening words', { timeout: 5000 }, async t => {
  const saved = { threadId, accountId: createHash('sha256').update('fixture-user').digest('hex') };
  const recentTurn = {
    id: 'before-process-stop',
    items: [{ type: 'functionCallOutput', name: 'open_watch_cinema_tick', namespace: null, output: [
      { type: 'input_text', text: '这是同一部影片的新放映房间，从上次结束的位置 0:30 接着看。\n影片共用手记' },
      { type: 'input_text', text: '共用手记' },
      { type: 'input_text', text: '已经开始播放' }
    ] }]
  };
  for (const openingDelivered of [false, true]) {
    const show = factory({ resumeFromMs: 30_000, saved: { ...saved, openingDelivered }, recentTurn });
    t.after(async () => { show.stop(); await show.run; });
    await show.ready;
    assert.equal(show.events.find(event => event.openingDelivered)?.turnId, openingDelivered ? undefined : recentTurn.id);
    show.tick('interval', 1, '继续观影');
    await nextTick();
    assert.equal(show.mcpCalls.length, 0);
    assert.deepEqual(show.calls.find(call => call.method === 'turn/start').params.toolOutput.output,
      [{ type: 'input_text', text: '继续观影' }]);
  }
});

test('resume recovers a retained opening when the last turn was accepted before its checkpoint', { timeout: 5000 }, async t => {
  const openingMessage = 'Ready to watch.';
  const saved = { threadId, accountId: createHash('sha256').update('fixture-user').digest('hex') };
  const retained = {
    id: 'before-process-stop',
    items: [{
      type: 'functionCallOutput', id: 'fixture-output', name: 'open_watch_cinema_tick', namespace: null, output: [
        { type: 'input_text', text: '观众开场白\n' + openingMessage },
        { type: 'input_text', text: 'First tick' }
      ]
    }]
  };
  const show = factory({ saved, openingMessage, recentTurn: retained });
  t.after(async () => { show.stop(); await show.run; });
  await show.ready;
  assert.deepEqual(show.calls.find(call => call.method === 'thread/turns/list').params,
    { threadId, limit: 1, itemsView: 'full' });
  const recovered = show.events.find(event => event.openingDelivered);
  assert.equal(recovered.turnId, retained.id);
  assert.equal(recovered.cursors, undefined);
  show.tick('interval', 1, 'New playback');
  await nextTick();
  assert.deepEqual(show.calls.find(call => call.method === 'turn/start').params.toolOutput.output,
    [{ type: 'input_text', text: 'New playback' }]);

  const olderCli = factory({ saved, openingMessage, historyUnsupported: true });
  t.after(async () => { olderCli.stop(); await olderCli.run; });
  await olderCli.ready;
  olderCli.tick('interval', 1, 'First playback');
  await nextTick();
  assert.deepEqual(olderCli.calls.find(call => call.method === 'turn/start').params.toolOutput.output.map(block => block.text),
    ['观众开场白\n' + openingMessage, 'First playback']);
});

test('a title failure leaves the saved thread ready for viewing', { timeout: 5000 }, async t => {
  const show = factory({ failName: true });
  t.after(async () => { show.stop(); await show.run; });
  assert.equal((await show.ready).threadId, threadId);
  assert.ok(show.calls.some(({ method }) => method === 'thread/name/set'));
});

test('only new inherited chats open Desktop after the thread binding is saved', { timeout: 5000 }, async t => {
  const show = factory({ holdThread: true, failDesktop: true });
  t.after(async () => { show.threadAck.resolve(); show.stop(); await show.run; });
  await nextTick();
  assert.ok(show.events.some(event => event.type === 'thread'));
  assert.ok(!show.calls.some(call => call.method === 'desktop/open'));
  show.threadAck.resolve();
  await show.ready;
  assert.equal(show.calls.at(-1).method, 'desktop/open');

  const isolated = factory({ authMode: 'isolated' });
  t.after(async () => { isolated.stop(); await isolated.run; });
  await isolated.ready;
  assert.ok(!isolated.calls.some(call => call.method === 'desktop/open'));
});

test('cursor is saved before a reply and reused on same-account resume before prior turn completion', { timeout: 5000 }, async () => {
  const show = factory({ holdObserved: true });
  try {
    await show.ready;
    show.tick('chat', 7, 'a question');
    await nextTick();
    const reply = show.tool('cinema_post_message', { content: 'a reply' });
    await nextTick();
    assert.equal(show.mcpCalls.length, 0);
    show.ack.resolve();
    assert.equal((await reply).success, true);
    const checkpoint = show.events.find(event => event.type === 'observed');
    const binding = show.events.find(event => event.type === 'thread');
    assert.equal(checkpoint.cursors.messageId, 7);
    assert.equal(show.events.some(event => event.type === 'started'), true);
    show.stop();
    await show.run;

    const saved = { threadId, accountId: binding.accountId, cursors: checkpoint.cursors };
    const resumed = factory({ saved });
    try {
      await resumed.ready;
      assert.equal(resumed.watching.profileId, 'fixture-profile');
      assert.deepEqual(resumed.watching.resumeCursors, { messageId: 7, mediaMs: 42000, seekVersion: 0 });
      assert.ok(resumed.calls.some(call => call.method === 'thread/resume' && call.params.threadId === threadId));
      assert.ok(!resumed.calls.some(call => call.method === 'thread/name/set'));
      assert.ok(!resumed.calls.some(call => call.method === 'desktop/open'));
      assert.ok(!resumed.calls.some(call => call.method === 'turn/start'));
    } finally {
      resumed.stop();
      await resumed.run;
    }

    const changed = factory({ saved, userId: 'different-user' });
    await assert.rejects(changed.run, { code: 'ACCOUNT_CHANGED' });
    assert.ok(!changed.calls.some(call => call.method === 'thread/resume'));
  } finally {
    show.stop();
    await show.run;
  }
});
