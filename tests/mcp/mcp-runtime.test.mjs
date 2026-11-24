import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createCinemaClient } from '../../mcp/runtime/cinema-client.mjs';
import { createViewingSession } from '../../mcp/viewing/viewing-session.mjs';
import { createMcpProtocol, startStdio } from '../../mcp/runtime/protocol.mjs';
import { readRuntimeConfig } from '../../mcp/runtime/configuration.mjs';
import { toolErrorResult } from '../../mcp/runtime/results.mjs';

const health = { ok: true, capabilities: ['ai-window-v1', 'ai-tick-v1', 'ai-frame-v1', 'ai-playback-state-v1'] };
const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'x-open-watch-cinema': 'open-watch-cinema', 'content-type': 'application/json' }
});
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('configuration preserves defaults and validates explicit budgets', () => {
  const defaults = readRuntimeConfig({});
  assert.equal(defaults.urls.length, 6);
  assert.equal(defaults.CATCHUP_TIME_BUDGET_MS, Infinity);
  assert.equal(defaults.IMAGE_BUDGET_BYTES, Infinity);
  const custom = readRuntimeConfig({ OPEN_WATCH_CINEMA_URL: 'http://custom', OPEN_WATCH_CINEMA_IMAGE_BUDGET_BYTES: '1234' });
  assert.equal(custom.urls[0], 'http://custom');
  assert.equal(custom.IMAGE_BUDGET_BYTES, 1234);
  assert.throws(() => readRuntimeConfig({ OPEN_WATCH_CINEMA_CATCHUP_BUDGET_MS: '-1' }), TypeError);
});

test('required cinema URL disables fallback discovery even after a previously healthy connection fails', async () => {
  const config = { OPEN_WATCH_CINEMA_REQUIRE_URL: '1' };
  assert.throws(() => readRuntimeConfig(config), /OPEN_WATCH_CINEMA_URL is required/);

  const baseUrl = 'http://127.0.0.1:4190';
  const { urls } = readRuntimeConfig({ ...config, OPEN_WATCH_CINEMA_URL: baseUrl });
  assert.deepEqual(urls, [baseUrl]);
  const defaultConfig = readRuntimeConfig({ OPEN_WATCH_CINEMA_URL: baseUrl });
  assert.deepEqual(defaultConfig.urls, [baseUrl, ...readRuntimeConfig({}).urls]);

  const requests = [];
  const client = createCinemaClient({
    urls,
    fetchImpl: async (url) => {
      requests.push(url.href);
      if (requests.length === 1 || url.origin !== baseUrl) return json(health);
      throw new Error('cinema went offline');
    }
  });
  await assert.rejects(client.cinemaRequest('/read'), { code: 'CINEMA_UNREACHABLE' });
  assert.deepEqual(requests, [
    baseUrl + '/api/health',
    baseUrl + '/read',
    baseUrl + '/api/health'
  ]);
});

test('connection failure retries reads once, including explicitly marked read-only POST', async () => {
  for (const options of [{}, { method: 'POST', retryRead: true, body: '{}' }]) {
    let probes = 0; let reads = 0;
    const client = createCinemaClient({ urls: ['http://test'], fetchImpl: async (url) => {
      if (url.pathname === '/api/health') { probes++; return json(health); }
      if (++reads === 1) throw new Error('network lost');
      return json({ ok: true });
    } });
    assert.deepEqual(await client.cinemaRequest('/read', options), { ok: true });
    assert.equal(probes, 2); assert.equal(reads, 2);
  }
});

test('lost write response is uncertain and never automatically repeated', async () => {
  let writes = 0;
  const client = createCinemaClient({ urls: ['http://test'], fetchImpl: async (url) => {
    if (url.pathname === '/api/health') return json(health);
    writes++; throw new Error('response lost');
  } });
  await assert.rejects(client.cinemaRequest('/write', { method: 'POST', body: '{}' }), { code: 'WRITE_OUTCOME_UNKNOWN' });
  assert.equal(writes, 1);
});

test('backend conflicts are not retried and unsafe response headers are rejected', async () => {
  let reads = 0;
  const client = createCinemaClient({ urls: ['http://test'], fetchImpl: async (url) => {
    if (url.pathname === '/api/health') return json(health);
    reads++; return json({ code: 'REQUEST_CONFLICT', error: 'busy' }, 409);
  } });
  await assert.rejects(client.cinemaRequest('/read'), { code: 'REQUEST_CONFLICT', status: 409 });
  assert.equal(reads, 1);
  const incompatible = createCinemaClient({ urls: ['http://other'], fetchImpl: async () => new Response('{}') });
  await assert.rejects(incompatible.discoverCinema(), { code: 'CINEMA_INCOMPATIBLE' });
});

test('cancelling one discovery waiter does not cancel the shared probe or another waiter', async () => {
  let finish; let probes = 0; let probeSignal;
  const client = createCinemaClient({ urls: ['http://test'], fetchImpl: async (_url, options) => {
    probes++; probeSignal = options.signal;
    await new Promise(resolve => { finish = resolve; });
    return json(health);
  } });
  const controller = new AbortController();
  const cancelled = client.discoverCinema({ signal: controller.signal });
  const other = client.discoverCinema();
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(probeSignal.aborted, false);
  finish();
  assert.equal((await other).baseUrl, 'http://test');
  assert.equal(probes, 1);
});

test('separate cinema client instances do not share address caches', async () => {
  let probes = 0;
  const fetchImpl = async () => { probes++; return json(health); };
  const a = createCinemaClient({ urls: ['http://a'], fetchImpl });
  const b = createCinemaClient({ urls: ['http://b'], fetchImpl });
  assert.equal((await a.discoverCinema()).baseUrl, 'http://a');
  assert.equal((await b.discoverCinema()).baseUrl, 'http://b');
  await a.discoverCinema(); assert.equal(probes, 2);
});

test('session state and frame histories remain private, bounded, and room gated', async () => {
  const requests = [];
  const cinemaRequest = async (...args) => { requests.push(args); return { data: 'aW1hZ2U=', mimeType: 'image/jpeg', metadata: { privatePath: 'hidden' } }; };
  const a = createViewingSession({ cinemaRequest });
  const b = createViewingSession({ cinemaRequest });
  assert.equal(a.clientState.identity, null);
  assert.equal(b.clientState.identity, null);
  a.clientState.limits.maxMessages = 1;
  assert.equal(b.clientState.limits.maxMessages, 20);
  a.clientState.roomId = 'room-a'; b.clientState.roomId = 'room-a';
  a.rememberDeliveredFrames('room-a', Array.from({ length: 65 }, (_, atMs) => ({ atMs, parts: [{ ref: `private/${atMs}`, times: [atMs], text: String(atMs) }] })));
  assert.equal(a.clientState.frameSelections.size, 64);
  await assert.rejects(a.inspectFrameAtTime({ atMs: 0 }), { code: 'FRAME_UNAVAILABLE' });
  await assert.rejects(b.inspectFrameAtTime({ atMs: 64 }), { code: 'FRAME_UNAVAILABLE' });
  const result = await a.inspectFrameAtTime({ atMs: 64, quality: 'hd' });
  assert.deepEqual(result.mcpContent, [
    { type: 'text', text: '0:00.064' },
    { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/jpeg' }
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][2], true);
  assert.ok(requests[0][0].includes('quality=hd'));
  a.rememberDeliveredFrames('room-a', [{ atMs: 4000, parts: [
    { ref: 'full.jpg', times: [2500], text: '0:02.5' },
    { ref: 'detail.jpg', times: [3000], text: '0:02.5 → 0:03' }
  ] }]);
  const detail = await a.inspectFrameAtTime({ atMs: 3000 });
  assert.equal(detail.mcpContent[0].text, '0:02.5 → 0:03');
  assert.match(requests.at(-1)[0], /storyboardRef=detail.jpg.*mediaTimeMs=4000/);
  await a.inspectFrameAtTime({ atMs: 2500 });
  assert.match(requests.at(-1)[0], /storyboardRef=full.jpg.*mediaTimeMs=4000/);
  a.rememberDeliveredFrames('room-b', []);
  await assert.rejects(a.inspectFrameAtTime({ atMs: 64 }), { code: 'FRAME_UNAVAILABLE' });
});

test('unbound connections may retry, and concurrent lookups bind one stable profile per connection', async () => {
  let selectedId = null;
  let requests = 0;
  const cinemaRequest = async () => {
    requests++;
    return { selectedId, profiles: ['first', 'second'].map(id => ({ id, name: id })) };
  };
  const a = createViewingSession({ cinemaRequest });
  assert.equal(await a.bindSelectedProfile({ optional: true }), null);
  await assert.rejects(a.bindSelectedProfile(), { code: 'AI_PROFILE_REQUIRED' });
  selectedId = 'first';
  assert.deepEqual(await Promise.all([a.bindSelectedProfile(), a.bindSelectedProfile()]), ['first', 'first']);
  assert.equal(requests, 3);
  selectedId = 'second';
  const b = createViewingSession({ cinemaRequest });
  assert.equal(await b.bindSelectedProfile(), 'second');
  assert.equal(await a.bindSelectedProfile(), 'first');
  assert.equal(requests, 4);
});

test('a stalled cinema lookup still permits the stdio initialization response', { timeout: 3500 }, async () => {
  const session = createViewingSession({ cinemaRequest: (_, { signal }) => new Promise((_, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  const protocol = createMcpProtocol({ bindSelectedProfile: session.bindSelectedProfile });
  // Node timers driving an AbortSignal are unreferenced; keep this isolated fixture running as stdio would.
  const keepAlive = setTimeout(() => {}, 2500);
  try {
    const result = await protocol.handleRequest({ id: 1, method: 'initialize' });
    assert.equal(result.result.serverInfo.name, 'open-watch-cinema');
    assert.equal(session.clientState.identity, null);
  } finally { clearTimeout(keepAlive); }
});

test('protocol publishes unchanged tool/resource envelopes and content blocks', async () => {
  const definitions = [{ name: 'test', inputSchema: { type: 'object' } }];
  const blocks = [{ type: 'text', text: 'film content' }];
  const protocol = createMcpProtocol({ watchSkillText: 'guide', toolRegistry: { definitions, call: async () => ({ mcpContent: blocks }) } });
  const initialize = await protocol.handleRequest({ id: 1, method: 'initialize', params: { protocolVersion: 'test-version' } });
  assert.equal(initialize.result.protocolVersion, 'test-version');
  assert.equal(initialize.result.serverInfo.name, 'open-watch-cinema');
  assert.deepEqual((await protocol.handleRequest({ id: 2, method: 'tools/list' })).result.tools, definitions);
  const listed = await protocol.handleRequest({ id: 3, method: 'resources/list' });
  const resource = await protocol.handleRequest({ id: 4, method: 'resources/read', params: { uri: listed.result.resources[0].uri } });
  assert.equal(resource.result.contents[0].text, 'guide');
  assert.deepEqual((await protocol.handleRequest({ id: 5, method: 'tools/call', params: { name: 'test' } })).result, { content: blocks });
});

test('protocol rejects duplicate in-flight IDs and cancellation suppresses responses', async () => {
  let signal;
  const protocol = createMcpProtocol({ watchSkillText: '', toolRegistry: { call: async (_name, _args, context) => {
    signal = context.signal;
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } } });
  const message = { id: 7, method: 'tools/call', params: { name: 'slow' } };
  const pending = protocol.handleRequest(message);
  assert.equal((await protocol.handleRequest(message)).error.code, -32600);
  protocol.cancel(7);
  assert.equal(await pending, null); assert.equal(signal.aborted, true);
  const again = protocol.handleRequest(message);
  protocol.close();
  assert.equal(await again, null);
});

test('stdio preserves parse errors, ignores notifications, and sends ping replies', async () => {
  const stdin = new PassThrough(); const stdout = new PassThrough(); let output = '';
  stdout.on('data', chunk => { output += chunk; });
  const protocol = createMcpProtocol({ watchSkillText: '', toolRegistry: {} });
  const input = startStdio(protocol, { stdin, stdout });
  stdin.write('not-json\n');
  stdin.write(JSON.stringify({ method: 'notifications/initialized' }) + '\n');
  stdin.write(JSON.stringify({ id: 42, method: 'ping' }) + '\n');
  await nextTurn();
  const messages = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].error.code, -32700);
  assert.deepEqual(messages[1], { jsonrpc: '2.0', id: 42, result: {} });
  input.close(); stdin.destroy(); stdout.destroy();
});

test('public errors do not expose backend private paths or stacks', () => {
  const result = toolErrorResult(Object.assign(new Error('C:/private/backend/path'), { code: 'REQUEST_CONFLICT', status: 409 }));
  assert.equal(result.isError, true);
  assert.ok(!JSON.stringify(result).includes('private/backend'));
  assert.equal(JSON.parse(result.content[0].text).error, 'REQUEST_CONFLICT');
});
