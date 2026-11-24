import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import vm from 'node:vm';
import {
  CARD_URI, CONTROL, OPEN, RECEIPT, createChatProtocol, createChatTransport
} from '../../watch-bridge/adapters/chat/server.mjs';

const html = await readFile(new URL('../../watch-bridge/adapters/chat/card.html', import.meta.url), 'utf8');
const meta = { 'openai/session': 'chat-a', 'openai/subject': 'viewer-a', 'openai/organization': 'workspace-a' };
const cardMetadata = 'open-watch-cinema/cardId';
const packetMetadata = 'open-watch-cinema/packet';
const stateMetadata = 'open-watch-cinema/state';
let requestId = 0;

function request(protocol, method, params) {
  return protocol.handleRequest({ jsonrpc: '2.0', id: ++requestId, method, params });
}

async function tool(protocol, name, args, metadata = meta) {
  return (await request(protocol, 'tools/call', { name, arguments: args, _meta: metadata })).result;
}

test('Chat MCP negotiates, exposes the card, and binds every operation to host metadata', async () => {
  const commands = [];
  const protocol = createChatProtocol({
    html,
    async transport(command) {
      if (command.action === 'tool-settings') return { enableHistory: false, enableControl: false };
      commands.push(command);
      if (command.action === 'open') return { started: false, state: 'idle' };
      const open = commands[0];
      if (command.sessionId !== open.sessionId || (command.cardId && command.cardId !== open.cardId)) {
        throw new Error('Wrong conversation or card');
      }
      const packet = { content: [{ type: 'text', text: 'Film packet' }] };
      if (command.action === 'result') return packet;
      if (command.action === 'poll' && command.claimId) return { state: { state: 'pending' }, packet };
      return { ok: true };
    }
  });
  assert.equal((await request(protocol, 'initialize', { protocolVersion: '2025-06-18' })).result.protocolVersion, '2025-06-18');
  assert.deepEqual((await request(protocol, 'ping')).result, {});
  const resource = (await request(protocol, 'resources/list')).result.resources[0];
  assert.equal(resource.uri, 'ui://open-watch-cinema-chat/watch-v8.html');
  assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
  assert.equal((await request(protocol, 'resources/read', { uri: CARD_URI })).result.contents[0].text, html);
  assert.equal((await request(protocol, 'resources/read', { uri: 'ui://old/card.html' })).error.code, -32002);
  const definitions = (await request(protocol, 'tools/list')).result.tools;
  assert.deepEqual(definitions.slice(0, 3).map(entry => entry.name), [
    'open_cinema_card', 'cinema_card_control', 'cinema_finish_turn'
  ]);
  const definition = name => definitions.find(entry => entry.name === name);
  assert.deepEqual(definition(CONTROL)._meta.ui.visibility, ['app']);
  assert.deepEqual(definition(RECEIPT)._meta.ui.visibility, ['model']);
  assert.deepEqual(definition(RECEIPT).inputSchema.properties, {});
  assert.equal(definition(OPEN)._meta.ui.resourceUri, CARD_URI);
  assert.ok(definition('cinema_notebook'));
  assert.ok(definition('cinema_post_message'));
  assert.ok(definition('cinema_inspect_frame'));
  assert.equal(definition('open_watch_cinema_tick'), undefined);

  assert.equal((await tool(protocol, OPEN, { sessionId: 'fake' }, {})).isError, true);
  assert.equal((await tool(protocol, OPEN, { sessionId: 'fake' })).isError, true);
  assert.equal(commands.length, 0);
  const opened = await tool(protocol, OPEN, {});
  const cardId = opened._meta[cardMetadata];
  assert.match(cardId, /^[0-9a-f-]{36}$/);
  assert.match(commands[0].sessionId, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(opened.content).includes(cardId), false);
  const claim = { action: 'result', cardId, batchId: 'a', claimId: 'claim-a' };
  assert.equal((await tool(protocol, CONTROL, claim, {})).isError, true);
  assert.equal((await tool(protocol, CONTROL, claim, { ...meta, 'openai/session': 'chat-b' })).isError, true);
  assert.equal((await tool(protocol, CONTROL, claim, { ...meta, 'openai/subject': 'viewer-b' })).isError, true);
  assert.equal((await tool(protocol, CONTROL, { ...claim, cardId: 'other-card' })).isError, true);
  assert.equal((await tool(protocol, CONTROL, { ...claim, sessionId: commands[0].sessionId })).isError, true);
  const packet = await tool(protocol, CONTROL, claim);
  assert.deepEqual(packet.content, []);
  assert.deepEqual(packet._meta[packetMetadata].content, [{ type: 'text', text: 'Film packet' }]);
  const poll = { action: 'poll', cardId };
  const legacyPoll = await tool(protocol, CONTROL, poll);
  assert.deepEqual(legacyPoll, { content: [], _meta: { [stateMetadata]: { ok: true } } });
  assert.equal((await tool(protocol, CONTROL, { ...poll, claimId: '' })).isError, true);
  assert.equal((await tool(protocol, CONTROL, { ...poll, claimId: 'combined', batchId: 'forged' })).isError, true);
  const foreign = await tool(protocol, CONTROL, { ...poll, claimId: 'combined' }, { ...meta, 'openai/session': 'chat-b' });
  assert.equal(foreign.isError, true);
  assert.equal(foreign._meta, undefined);
  const combined = await tool(protocol, CONTROL, { ...poll, claimId: 'combined' });
  assert.deepEqual(combined.content, []);
  assert.equal(combined._meta[stateMetadata].state, 'pending');
  assert.deepEqual(combined._meta[packetMetadata], packet._meta[packetMetadata]);
  assert.equal((await tool(protocol, RECEIPT, { batchId: 'a' })).isError, true);
  assert.equal((await tool(protocol, RECEIPT, {}, { ...meta, 'openai/session': 'chat-b' })).isError, true);
  assert.deepEqual(await tool(protocol, RECEIPT, {}), { content: [] });
  assert.deepEqual(commands.at(-1), { actor: 'model', action: 'ack', sessionId: commands[0].sessionId });
});

test('Chat tools/list reads independent live groups and retains the grouped MCP action schema', async () => {
  const settings = { enableHistory: false, enableControl: false, enableManual: false };
  const protocol = createChatProtocol({
    html,
    async transport(command) {
      assert.deepEqual(command, { actor: 'service', action: 'tool-settings' });
      return settings;
    }
  });
  const tools = async () => (await request(protocol, 'tools/list')).result.tools;
  assert.equal((await tools()).some(tool => tool.name === 'cinema_read_window'), false);
  assert.equal((await tools()).some(tool => tool.name === 'cinema_manage'), false);
  settings.enableHistory = true;
  assert.deepEqual((await tools()).slice(-1).map(tool => tool.name), ['cinema_read_window']);
  settings.enableHistory = false;
  settings.enableControl = true;
  const definitions = await tools();
  assert.equal(definitions.some(tool => tool.name === 'open_watch_cinema_tick'), false);
  assert.deepEqual(definitions.slice(-2).map(tool => tool.name), ['cinema_control', 'cinema_manage']);
  const actions = definitions.at(-1).inputSchema.properties.action.enum;
  assert.deepEqual(actions, ['status', 'rescan', 'list_media', 'prepare_ai', 'job_status', 'list_rooms', 'open_room', 'end_room']);
  settings.enableManual = true;
  const tick = (await tools()).find(entry => entry.name === 'open_watch_cinema_tick');
  assert.deepEqual(tick.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  assert.deepEqual(tick._meta.ui.visibility, ['model']);
  assert.equal(tick.annotations.readOnlyHint, true);
  for (const name of ['cinema_post_message', 'cinema_notebook']) {
    assert.equal((await tools()).find(entry => entry.name === name).annotations.readOnlyHint, false);
  }
  settings.enableManual = false;
  assert.equal((await tools()).some(entry => entry.name === tick.name), false);
});

test('Chat routes a manual tick and room message with the host conversation identity and no card', async () => {
  const received = [];
  const protocol = createChatProtocol({ html, async transport(command) {
    received.push(command);
    return { content: [{ type: 'text', text: 'Room result' }] };
  } });
  assert.equal((await tool(protocol, 'open_watch_cinema_tick', {}, {})).isError, true);
  assert.equal((await tool(protocol, 'cinema_post_message', { content: 'Hello' }, {})).isError, true);
  assert.equal(received.length, 0);
  const result = await tool(protocol, 'open_watch_cinema_tick', {});
  assert.equal(result.content[0].text, 'Room result');
  await tool(protocol, 'cinema_post_message', { content: 'Hello' });
  const [{ sessionId }] = received;
  assert.match(sessionId, /^[a-f0-9]{64}$/);
  assert.deepEqual(received, [
    { actor: 'model', action: 'tool', sessionId, tool: 'open_watch_cinema_tick', arguments: {} },
    { actor: 'model', action: 'tool', sessionId, tool: 'cinema_post_message', arguments: { content: 'Hello' } }
  ]);
});

test('self-contained Chat MCP requests use modern envelopes without a prior handshake', async () => {
  const versionKey = 'io.modelcontextprotocol/protocolVersion';
  const capabilitiesKey = 'io.modelcontextprotocol/clientCapabilities';
  const infoKey = 'io.modelcontextprotocol/clientInfo';
  const serverKey = 'io.modelcontextprotocol/serverInfo';
  const ui = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } };
  const modern = { [versionKey]: '2026-07-28', [capabilitiesKey]: ui };
  const observed = [];
  const protocol = createChatProtocol({ html, async transport(command) {
    if (command.action === 'tool-settings') return {};
    observed.push(command);
    return { state: 'idle', started: false };
  } });
  const discover = (await request(protocol, 'server/discover', { _meta: modern })).result;
  assert.equal(discover.resultType, 'complete');
  assert.equal(discover.supportedVersions[0], '2026-07-28');
  assert.ok(discover.supportedVersions.includes('2025-11-25'));
  assert.deepEqual(discover._meta[serverKey], { name: 'open-watch-cinema-chat', version: '1.0.0' });
  assert.equal(discover.serverInfo, undefined);
  assert.equal(discover.ttlMs, 0);
  assert.equal(discover.cacheScope, 'private');
  assert.ok(discover.capabilities.tools && discover.capabilities.resources);
  assert.equal((await request(protocol, 'server/discover')).error.code, -32602);
  assert.deepEqual((await request(protocol, 'tools/list', {
    _meta: { ...modern, [versionKey]: '2027-01-01' }
  })).error, { code: -32022, message: 'Unsupported protocol version', data: {
    requested: '2027-01-01', supported: discover.supportedVersions
  } });
  assert.equal((await request(protocol, 'ping', { _meta: modern })).error.code, -32601);
  assert.equal((await request(protocol, 'initialize', { _meta: modern })).error.code, -32601);

  const table = (await request(protocol, 'tools/list', { _meta: modern })).result;
  assert.equal(table.tools.find(entry => entry.name === OPEN)._meta.ui.resourceUri, CARD_URI);
  assert.deepEqual(table.tools.find(entry => entry.name === CONTROL)._meta.ui.visibility, ['app']);
  const resources = (await request(protocol, 'resources/list', { _meta: modern })).result;
  assert.equal(resources.resources[0].uri, CARD_URI);
  assert.equal(resources.resultType, 'complete');
  const card = (await request(protocol, 'resources/read', { uri: CARD_URI, _meta: modern })).result;
  assert.equal(card.contents[0].text, html);
  assert.equal(card.cacheScope, 'private');
  const unknownUri = 'ui://old/card.html';
  assert.deepEqual((await request(protocol, 'resources/read', { uri: unknownUri, _meta: modern })).error, {
    code: -32602, message: 'Unknown resource', data: { uri: unknownUri }
  });
  const templates = (await request(protocol, 'resources/templates/list', { _meta: modern })).result;
  assert.deepEqual(templates.resourceTemplates, []);
  assert.equal(templates.ttlMs, 0);
  const withoutUi = { ...modern, [capabilitiesKey]: {} };
  const fallback = (await request(protocol, 'tools/list', { _meta: withoutUi })).result;
  assert.equal(fallback.tools.some(entry => [OPEN, CONTROL].includes(entry.name)), false);
  assert.ok(fallback.tools.some(entry => entry.name === 'cinema_notebook'));

  const call = (name, metadata, argumentsValue = {}) => request(protocol, 'tools/call', {
    name, arguments: argumentsValue, _meta: metadata
  });
  assert.equal((await call(OPEN, { ...meta, ...withoutUi })).error.code, -32021);
  for (const metadata of [
    { ...meta, [versionKey]: modern[versionKey] },
    { ...meta, [capabilitiesKey]: {} },
    { ...meta, ...modern, [capabilitiesKey]: [] },
    { ...meta, ...modern, [infoKey]: { name: 'Incomplete identity' } },
    { ...meta, ...modern, [capabilitiesKey]: { sampling: { tools: true } } },
    { ...meta, ...modern, [capabilitiesKey]: { extensions: { 'io.modelcontextprotocol/ui': 'bad' } } }
  ]) {
    assert.equal((await call(RECEIPT, metadata)).error.code, -32602);
  }
  assert.equal((await call('unknown', modern)).error.code, -32602);
  assert.equal((await call(RECEIPT, { ...modern, ...meta }, [])).error.code, -32602);
  assert.equal((await call(OPEN, { ...modern, [infoKey]: { name: 'Unofficial', version: '1' } })).result.isError, true);
  assert.deepEqual(observed, []);

  const opened = (await call(OPEN, { ...modern, ...meta })).result;
  assert.equal(opened.resultType, 'complete');
  assert.ok(opened._meta[cardMetadata]);
  assert.deepEqual(opened._meta[serverKey], discover._meta[serverKey]);
  assert.equal(opened.ttlMs, undefined);
  const reply = (await call(CONTROL, { ...modern, ...meta }, {
    action: 'poll', cardId: opened._meta[cardMetadata]
  })).result;
  assert.equal(reply._meta[stateMetadata].state, 'idle');
  assert.equal(observed[0].sessionId, observed[1].sessionId);
  const ack = (await call(RECEIPT, { ...withoutUi, ...meta })).result;
  assert.deepEqual(ack.content, []);
  assert.equal(ack.resultType, 'complete');
  assert.equal(observed.at(-1).action, 'ack');
  const legacy = (await request(protocol, 'initialize', { protocolVersion: '2026-07-28' })).result;
  assert.equal(legacy.protocolVersion, '2025-11-25');
  assert.equal(legacy.resultType, undefined);
  assert.equal((await request(protocol, 'tools/list')).result.resultType, undefined);
});

test('transport sends private JSON to the local cinema and disallows redirects', async () => {
  assert.throws(() => createChatTransport({ cinemaUrl: 'http://192.0.2.11:4182' }), /loopback/);
  const transport = createChatTransport({
    cinemaUrl: 'http://127.0.0.1:8999',
    async fetchImpl(url, options) {
      assert.equal(String(url), 'http://127.0.0.1:8999/api/watch-bridge/chat/transport');
      assert.equal(options.headers['x-owc-chat-transport'], '1');
      assert.equal(options.redirect, 'error');
      assert.deepEqual(JSON.parse(options.body), { action: 'poll' });
      return Response.json({ state: 'idle' });
    }
  });
  assert.deepEqual(await transport({ action: 'poll' }, { signal: new AbortController().signal }), { state: 'idle' });
});

test('manual room tools allow backend preparation time while card calls keep their deadline', async t => {
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    deadlines.push(milliseconds);
    return new AbortController().signal;
  });
  const controller = new AbortController();
  const transport = createChatTransport({ async fetchImpl(_, { signal }) {
    if (deadlines.length === 4) {
      controller.abort();
      assert.equal(signal.aborted, true);
      signal.throwIfAborted();
    }
    return Response.json({});
  } });
  await transport({ actor: 'app', action: 'poll' }, { signal: controller.signal });
  await transport({ actor: 'model', action: 'tool', tool: 'cinema_manage' }, { signal: controller.signal });
  await transport({ actor: 'model', action: 'tool', tool: 'cinema_post_message' }, { signal: controller.signal });
  await assert.rejects(transport({ actor: 'model', action: 'tool', tool: 'open_watch_cinema_tick' },
    { signal: controller.signal }), /无法连接本机影院/);
  assert.deepEqual(deadlines, [15_000, 15_000, 30_000, 30_000]);
});

test('card polls serially after 500ms and safely reconciles stale state after a host interruption', async () => {
  let started = false;
  let room = false;
  let now = 0;
  let nextBatchAt = 0;
  let batch = 1;
  let claimed;
  let seconds = null;
  let receipts = 0;
  const sent = [];
  const actions = [];
  const packet = [
    { type: 'text', text: '00:24 · Viewer: The first line.' },
    { type: 'image', mimeType: 'image/jpeg', data: '/9j/2Q==' },
    { type: 'text', text: '00:25 · Film dialogue.' }
  ];

  function state() {
    const ready = started && room && !claimed && now >= nextBatchAt;
    return { started, lastSubmittedSeconds: seconds, status: room ? 'watching' : 'waiting_room',
      state: ready ? 'ready' : room ? 'watching' : 'idle', ...(ready && { batchId: 'batch-' + batch }) };
  }

  const protocol = createChatProtocol({
    html,
    async transport(command) {
      actions.push(command);
      switch (command.action) {
        case 'open': return state();
        case 'poll': {
          const current = state();
          if (!command.claimId) return current;
          if (current.state !== 'ready') return { state: current };
          claimed = { ...command, batchId: command.claimId };
          return { state: state(), packet: { content: packet, _meta: { 'open-watch-cinema/filmSeconds': batch * 25 } } };
        }
        case 'start': started = true; return state();
        case 'stop':
          if (rejectNextStop) {
            rejectNextStop = false;
            throw new Error('暂时无法停止跟片。');
          }
          started = false;
          return state();
        case 'submitted':
        case 'abandon':
        case 'failed':
          assert.equal(command.batchId, claimed.batchId);
          assert.equal(command.claimId, claimed.claimId);
          if (command.action === 'submitted') seconds = batch * 25;
          if (command.action === 'abandon' || command.definitive) claimed = null;
          return state();
        case 'ack':
          assert.ok(claimed);
          receipts++;
          batch++;
          nextBatchAt = now + 1000;
          claimed = null;
          return { ok: true };
        default: throw new Error('Unexpected command ' + command.action);
      }
    }
  });

  const opened = await tool(protocol, OPEN, {});
  const elements = new Map(['#watch', '#display-mode', '#display-status', '#last-submitted', '#watch-status', 'main'].map(selector => [selector, {
    hidden: selector !== '#watch', events: {},
    addEventListener(type, fn) { this.events[type] = fn; }
  }]));
  const timers = new Map();
  const waitingForHost = [];
  const heldPolls = [];
  let holdNextPoll = false;
  let rejectNextStop = false;
  const requestedModes = [];
  let acceptMode = true;
  let timerId = 0;
  const windowEvents = new Map();
  const documentEvents = new Map();
  const origin = 'https://chat.example';
  const documentElement = { dataset: {} };
  const parent = {
    postMessage(message) {
      if (!message.method || !Object.hasOwn(message, 'id')) return;
      void (async () => {
        switch (message.method) {
          case 'ui/initialize':
            incoming({ id: message.id, result: {
              hostCapabilities: { experimental: { 'openai/message': {} }, message: { text: {} } },
              hostContext: { displayMode: 'inline', availableDisplayModes: ['inline'] }
            } });
            incoming({ method: 'ui/notifications/tool-result', params: opened });
            break;
          case 'ui/request-display-mode':
            requestedModes.push(message.params.mode);
            incoming({ id: message.id, result: { mode: acceptMode ? message.params.mode : 'inline' } });
            break;
          case 'tools/call': {
            const result = await tool(protocol, message.params.name, message.params.arguments);
            const response = { id: message.id, result };
            if (holdNextPoll && message.params.arguments.action === 'poll') {
              holdNextPoll = false;
              heldPolls.push(response);
            } else incoming(response);
            break;
          }
          case 'ui/message':
            sent.push(JSON.parse(JSON.stringify(message.params)));
            waitingForHost.push(message.id);
            break;
        }
      })();
    }
  };
  function incoming(message) {
    windowEvents.get('message')({ source: parent, origin, data: { jsonrpc: '2.0', ...message } });
  }
  async function advance(ms) {
    now += ms;
    for (const [id, { at, callback }] of timers) {
      if (at > now) continue;
      timers.delete(id);
      callback();
    }
    await setImmediate();
  }

  const document = {
    querySelector: selector => elements.get(selector),
    documentElement,
    visibilityState: 'visible',
    addEventListener(type, fn) { documentEvents.set(type, fn); }
  };
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    window: { parent, addEventListener(type, fn) { windowEvents.set(type, fn); } },
    document,
    ResizeObserver: class { observe() {} disconnect() {} },
    crypto: webcrypto,
    setTimeout(callback, ms) { timers.set(++timerId, { at: now + ms, callback }); return timerId; },
    clearTimeout(id) { timers.delete(id); }
  });
  await setImmediate();
  const button = elements.get('#watch');
  const displayButton = elements.get('#display-mode');
  const displayStatus = elements.get('#display-status');
  const time = elements.get('#last-submitted');
  const notice = elements.get('#watch-status');
  assert.equal(displayButton.hidden, true);
  incoming({ method: 'ui/notifications/host-context-changed',
    params: { availableDisplayModes: ['inline', 'fullscreen'] } });
  assert.equal(displayButton.hidden, false);
  await displayButton.events.click();
  assert.equal(displayButton.textContent, '退出全屏');
  assert.equal(documentElement.dataset.displayMode, 'fullscreen');
  await displayButton.events.click();
  assert.equal(displayButton.textContent, '全屏');
  assert.equal(documentElement.dataset.displayMode, 'inline');
  assert.deepEqual(requestedModes, ['fullscreen', 'inline']);
  acceptMode = false;
  await displayButton.events.click();
  assert.equal(documentElement.dataset.displayMode, 'inline');
  assert.equal(displayStatus.hidden, false);
  incoming({ method: 'ui/notifications/host-context-changed', params: { displayMode: 'fullscreen' } });
  assert.equal(displayButton.textContent, '退出全屏');
  incoming({ method: 'ui/notifications/host-context-changed', params: { displayMode: 'inline' } });
  assert.equal(displayButton.textContent, '全屏');
  await button.events.click();
  assert.equal(button.textContent, '停止跟片');
  assert.equal(time.hidden, true);
  holdNextPoll = true;
  const beforeFirstPoll = actions.length;
  await advance(499);
  assert.equal(actions.length, beforeFirstPoll);
  await advance(1);
  assert.equal(heldPolls.length, 1);
  assert.equal(actions.length, beforeFirstPoll + 1);
  await advance(1200);
  document.visibilityState = 'hidden';
  documentEvents.get('visibilitychange')();
  document.visibilityState = 'visible';
  documentEvents.get('visibilitychange')();
  windowEvents.get('focus')();
  assert.equal(actions.length, beforeFirstPoll + 1);
  incoming(heldPolls.shift());
  await setImmediate();
  assert.deepEqual(actions.slice(beforeFirstPoll).map(({ action, claimId }) => [action, Boolean(claimId)]),
    [['poll', true], ['poll', false]]);
  assert.equal(button.textContent, '停止跟片');
  assert.equal(sent.length, 0);

  room = true;
  const beforeClaim = actions.length;
  await advance(499);
  assert.equal(actions.length, beforeClaim);
  await advance(1);
  assert.equal(sent.length, 1);
  assert.deepEqual(actions.slice(beforeClaim).map(command => command.action), ['poll']);
  assert.match(actions.at(-1).claimId, /^[a-f0-9]{32}$/);
  assert.equal(sent[0].role, 'user');
  assert.deepEqual(sent[0].content, packet);
  assert.equal(time.hidden, true);
  incoming({ id: waitingForHost.shift(), result: {} });
  await setImmediate();
  assert.equal(time.hidden, false);
  assert.equal(time.textContent, '最近提交 · 影片 00:25');
  assert.deepEqual(await tool(protocol, RECEIPT, {}), { content: [] });

  await advance(500);
  assert.equal(actions.at(-1).action, 'poll');
  assert.equal(sent.length, 1);
  await advance(499);
  assert.equal(sent.length, 1);
  await advance(1);
  assert.equal(sent.length, 2);
  assert.equal(receipts, 1);
  await button.events.click();
  assert.equal(button.textContent, '开始观影');
  incoming({ id: waitingForHost.shift(), result: {} });
  await setImmediate();
  assert.equal(time.textContent, '最近提交 · 影片 00:25');
  assert.equal(seconds, 50);
  const afterStop = actions.length;
  await advance(7000);
  assert.equal(actions.length, afterStop);
  assert.equal(sent.length, 2);
  windowEvents.get('focus')();
  await setImmediate();
  assert.equal(actions.at(-1).claimId, undefined);
  assert.equal(time.textContent, '最近提交 · 影片 00:50');
  assert.equal(button.textContent, '开始观影');
  room = false;
  seconds = null;
  await button.events.click();
  assert.equal(button.textContent, '停止跟片');
  assert.equal(time.hidden, true);
  assert.deepEqual(await tool(protocol, RECEIPT, {}), { content: [] });

  room = true;
  await advance(500);
  assert.equal(claimed, null);
  holdNextPoll = true;
  await advance(500);
  assert.equal(heldPolls.length, 1);
  assert.equal(sent.length, 2);
  const stoppedClaim = claimed.claimId;
  await button.events.click();
  incoming(heldPolls.shift());
  await setImmediate();
  assert.equal(actions.at(-1).action, 'abandon');
  assert.equal(actions.at(-1).claimId, stoppedClaim);
  assert.equal(sent.length, 2);

  await button.events.click();
  holdNextPoll = true;
  await advance(500);
  assert.equal(heldPolls.length, 1);
  const lostClaim = claimed.claimId;
  await advance(20000);
  assert.equal(actions.at(-1).action, 'abandon');
  assert.equal(actions.at(-1).claimId, lostClaim);
  assert.equal(sent.length, 2);
  incoming(heldPolls.shift());
  await setImmediate();
  assert.equal(sent.length, 2);

  // The server can expire the lease while the host is not forwarding card requests.
  assert.match(notice.textContent, /卡片暂未收到影院回应，会再次查询/);
  assert.equal(notice.hidden, false);
  assert.equal(button.textContent, '停止跟片');
  started = false;
  const beforeReturn = actions.length;
  document.visibilityState = 'hidden';
  documentEvents.get('visibilitychange')();
  assert.equal(actions.length, beforeReturn);
  document.visibilityState = 'visible';
  documentEvents.get('visibilitychange')();
  windowEvents.get('focus')();
  await setImmediate();
  assert.equal(actions.length, beforeReturn + 1);
  assert.equal(actions.at(-1).action, 'poll');
  assert.equal(actions.at(-1).claimId, undefined);
  assert.equal(notice.hidden, true);
  assert.equal(button.textContent, '开始观影');
  await advance(1500);
  assert.equal(actions.length, beforeReturn + 1);

  await button.events.click();
  await advance(500);
  assert.equal(sent.length, 3);
  assert.notEqual(claimed.claimId, lostClaim);
  const explicitlyRejected = claimed.claimId;
  incoming({ id: waitingForHost.shift(), result: { isError: true } });
  await setImmediate();
  assert.equal(actions.at(-1).action, 'failed');
  assert.equal(actions.at(-1).claimId, explicitlyRejected);
  assert.equal(actions.at(-1).definitive, true);
  await advance(500);
  assert.equal(actions.at(-1).action, 'poll');
  assert.equal(actions.at(-1).claimId, undefined);
  assert.equal(sent.length, 3);

  rejectNextStop = true;
  await button.events.click();
  const afterFailedStop = actions.length;
  await advance(1500);
  assert.equal(actions.length, afterFailedStop);
  windowEvents.get('focus')();
  await setImmediate();
  assert.equal(actions.at(-1).action, 'poll');
  assert.equal(actions.at(-1).claimId, undefined);
  assert.match(notice.textContent, /尚未确认停止/);
  assert.equal(button.textContent, '停止跟片');
  const afterRead = actions.length;
  await advance(500);
  assert.equal(actions.length, afterRead);

  await button.events.click();
  await button.events.click();
  await advance(500);
  assert.equal(sent.length, 4);
  const unknownClaim = claimed.claimId;
  const afterSubmit = actions.length;
  await advance(1500);
  assert.equal(actions.length, afterSubmit);
  await advance(38500);
  assert.equal(actions.at(-1).action, 'failed');
  assert.equal(actions.at(-1).claimId, unknownClaim);
  assert.equal(actions.at(-1).definitive, undefined);
  await advance(3000);
  assert.equal(sent.length, 4);
  assert.equal(claimed.claimId, unknownClaim);

  incoming({ id: 10000, method: 'ui/resource-teardown' });
  await setImmediate();
  assert.equal(actions.at(-1).action, 'stop');
  const afterTeardown = actions.length;
  await advance(2000);
  assert.equal(actions.length, afterTeardown);
  assert.equal(sent.length, 4);
});
