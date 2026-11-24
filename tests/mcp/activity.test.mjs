import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createActivityReporter } from '../../mcp/runtime/activity.mjs';
import { createMcpProtocol, startStdio } from '../../mcp/runtime/protocol.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 40; i++) {
    if (predicate()) return;
    await turn();
  }
  assert.fail('Expected activity was not observed.');
}

test('the reporter does not hold the MCP reply, duplicate errors, count cancellation or replay a prior run', async () => {
  const initialRegistration = Promise.withResolvers();
  const events = [];
  let currentRun = 'first-run';
  const reporter = createActivityReporter({ getProfileId: () => 'profile-a',
    cinemaRequest: async (path, options) => {
      assert.equal(path, '/api/ai/activity');
      const body = JSON.parse(options.body);
      events.push(body);
      if (body.op !== 'heartbeat' && body.runId !== currentRun) {
        throw Object.assign(new Error('changed'), { code: 'ACTIVITY_RUN_CHANGED' });
      }
      if (events.length === 1) await initialRegistration.promise;
      return { ok: true, runId: currentRun };
    } });
  const blocks = [{ type: 'text', text: 'before' }, { type: 'image', mimeType: 'image/jpeg', data: 'MTIz' },
    { type: 'text', text: 'after' }];
  const read = Promise.withResolvers();
  const registry = { definitions: [{ name: 'test', inputSchema: { properties: { action: { enum: ['read'] } } } }],
    call: async (name, args) => {
      if (args.error) throw new TypeError('Invalid input');
      if (args.delay) await read.promise;
      return { mcpContent: blocks };
    } };
  const protocol = createMcpProtocol({ toolRegistry: registry, activity: reporter });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const replies = new Map();
  stdout.on('data', value => { const msg = JSON.parse(value.toString()); replies.set(msg.id, msg); });
  const input = startStdio(protocol, { stdin, stdout });
  const call = (id, args) => stdin.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'test', arguments: args } }) + '\n');
  try {
    stdin.write('{"id":1,"method":"initialize"}\n');
    call(2, { action: 'read' });
    await until(() => replies.has(2));
    assert.deepEqual(replies.get(2).result.content, blocks);
    assert.equal(events.filter(event => event.op === 'call').length, 0);
    initialRegistration.resolve();
    await until(() => events.some(event => event.op === 'call'));
    const first = events.find(event => event.op === 'call');
    assert.deepEqual(first.content, blocks);
    assert.equal(first.action, 'read');
    assert.equal(first.profileId, 'profile-a');
    assert.equal(first.isError, false);
    assert.ok(first.startedAt <= first.finishedAt);
    call(3, { error: true, action: 'arbitrary text' });
    await until(() => events.filter(event => event.op === 'call').length === 2);
    const failed = events.filter(event => event.op === 'call').at(-1);
    assert.equal(failed.isError, true);
    assert.equal(failed.action, undefined);
    assert.deepEqual(failed.content, replies.get(3).result.content);

    call(4, { delay: true });
    stdin.write('{"method":"notifications/cancelled","params":{"requestId":4}}\n');
    read.resolve();
    await turn();
    assert.equal(replies.has(4), false);
    currentRun = 'second-run';
    call(5, {});
    await until(() => events.filter(event => event.op === 'heartbeat').length === 2);
    call(6, {});
    await until(() => events.filter(event => event.op === 'call').length === 4);
    const sent = events.filter(event => event.op === 'call');
    assert.deepEqual(sent.map(event => event.runId), ['first-run', 'first-run', 'first-run', 'second-run']);
    assert.equal(new Set(sent.map(event => event.callId)).size, 4);
    input.close();
    await until(() => events.some(event => event.op === 'close'));
    assert.equal(events.at(-1).runId, 'second-run');
    assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index + 1));
    assert.equal(new Set(events.map(event => event.connectionId)).size, 1);
  } finally {
    initialRegistration.resolve();
    input.close(); stdin.destroy(); stdout.destroy();
  }
});

test('oversize content preserves the call identity and ordered-block counts without holding its payload', async () => {
  const events = [];
  const reporter = createActivityReporter({ getProfileId: () => null,
    cinemaRequest: async (_, options) => { events.push(JSON.parse(options.body)); return { runId: 'run' }; } });
  const start = reporter.begin();
  reporter.delivered(start, { tool: 'test', isError: false, finishedAt: Date.now(), profileId: null,
    content: [...Array(1024).fill({ type: 'text', text: 'x' }), { type: 'image', mimeType: 'image/jpeg', data: 'MTIz' }] });
  await until(() => events.some(event => event.op === 'call'));
  const call = events.find(event => event.op === 'call');
  assert.equal(call.contentOmitted, true);
  assert.equal(call.content, undefined);
  assert.equal(call.blockCount, 1025);
  assert.equal(call.imageCount, 1);
  assert.equal(call.callId, start.callId);
  reporter.close();
});

test('idle heartbeats reconnect across runs and backlog losses stay scoped to the original run', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const events = [];
  let runId = 'first';
  const reporter = createActivityReporter({ getProfileId: () => null,
    cinemaRequest: async (_, options) => { events.push(JSON.parse(options.body)); return { runId }; } });
  reporter.start();
  await until(() => events.length === 1);
  for (let i = 0; i < 2100; i++) {
    const started = reporter.begin();
    reporter.delivered(started, { tool: 'test', content: [], profileId: null, isError: false, finishedAt: Date.now() });
  }
  await until(() => events.filter(event => event.op === 'call').length === 2048);
  t.mock.timers.tick(10000);
  await until(() => events.at(-1).op === 'heartbeat');
  assert.equal(events.at(-1).droppedCalls, 52);
  assert.equal(events.at(-1).runId, 'first');
  runId = 'second';
  t.mock.timers.tick(10000);
  await turn();
  t.mock.timers.tick(10000);
  await until(() => events.at(-1).runId === 'second');
  assert.equal(events.at(-1).droppedCalls, 0);
  assert.equal(events.filter(event => event.op === 'call' && event.runId === 'second').length, 0);
  reporter.close();
});
