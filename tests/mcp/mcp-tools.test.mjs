import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry } from '../../mcp/tools/index.mjs';
import { createViewingTools } from '../../mcp/tools/viewing.mjs';
import { createViewingSession } from '../../mcp/viewing/viewing-session.mjs';
import { readRuntimeConfig } from '../../mcp/runtime/configuration.mjs';
import { expectedDefaultTools, expectedHistoryTools, expectedControlTools } from './fixtures/mcp-tool-definitions.mjs';


function fixture(identity = 'test-client', options = {}) {
  const calls = [];
  const clientState = { identity, limits: {}, customLimits: false, tickInFlight: false, roomsWithCornerGuide: new Set() };
  const deps = {
    clientState,
    bindSelectedProfile: async () => identity,
    requireObject(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('arguments');
      return value;
    },
    requireString(value, label, { min = 1, max = 4000 } = {}) {
      if (typeof value !== 'string' || value.length < min || value.length > max) throw new TypeError(label);
      return value;
    },
    optionalString(value, label, options) {
      return value == null ? undefined : deps.requireString(value, label, options);
    },
    requireInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
      if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(label);
      return value;
    },
    cinemaError: (code, message) => Object.assign(new Error(message), { code }),
    cinemaRequest: async (path, options) => { calls.push({ path, options });
      return { path }; },
    discoverCinema: async (options) => { calls.push(options); return { baseUrl: 'http://test', health: { ok: true }, checkedAt: 123 }; },
    aiExperienceWarning: () => null,
    inspectFrameAtTime: async (args) => { calls.push(args); return { mcpContent: [] }; },
    DEFAULT_TICK_LIMITS: { maxMessages: 20 },
    enableHistory: Boolean(options.enableHistory),
    enableControl: Boolean(options.enableControl)
  };
  return { deps, calls, clientState, registry: createToolRegistry(deps) };
}

test('default surface exposes only watching and interaction tools; history and control are independent opt-ins', () => {
  assert.deepEqual(fixture().registry.definitions.map(t => t.name), [
    'open_watch_cinema_tick', 'cinema_inspect_frame', 'cinema_post_message', 'cinema_notebook'
  ]);
  assert.equal(createViewingTools(fixture().deps).length, 3);
  assert.deepEqual(fixture().registry.definitions, expectedDefaultTools);

  const withHistory = fixture('test-client', { enableHistory: true });
  assert.deepEqual(withHistory.registry.definitions, [...expectedDefaultTools, ...expectedHistoryTools]);

  const withControl = fixture('test-client', { enableControl: true });
  assert.deepEqual(withControl.registry.definitions, [...expectedDefaultTools, ...expectedControlTools]);

  const withBoth = fixture('test-client', { enableHistory: true, enableControl: true });
  assert.deepEqual(withBoth.registry.definitions, [...expectedDefaultTools, ...expectedHistoryTools, ...expectedControlTools]);

  assert.deepEqual(readRuntimeConfig({}, []).enableHistory, false);
  assert.deepEqual(readRuntimeConfig({}, []).enableControl, false);
  assert.deepEqual(readRuntimeConfig({}, ['--with-history']).enableHistory, true);
  assert.deepEqual(readRuntimeConfig({}, ['--with-history']).enableControl, false);
  assert.deepEqual(readRuntimeConfig({}, ['--with-control']).enableControl, true);
  assert.deepEqual(readRuntimeConfig({ OPEN_WATCH_CINEMA_ENABLE_HISTORY: '1', OPEN_WATCH_CINEMA_ENABLE_CONTROL: 'true' }, []).enableHistory, true);
  assert.deepEqual(readRuntimeConfig({ OPEN_WATCH_CINEMA_ENABLE_HISTORY: '1', OPEN_WATCH_CINEMA_ENABLE_CONTROL: 'true' }, []).enableControl, true);
});

test('preparation routes retain body, method, and cancellation signal', async () => {
  const { registry, calls } = fixture('test-client', { enableControl: true });
  const signal = new AbortController().signal;
  const mediaId = 'a'.repeat(24);
  await registry.call('cinema_manage', { action: 'prepare_ai', parameters: { mediaId, dialogueTrackId: 'track-1', storyboardProfile: { mode: 'economy' } } }, { signal });
  assert.deepEqual(calls[0], { path: `/api/media/${mediaId}/prepare-ai`, options: {
    method: 'POST', body: JSON.stringify({ dialogueTrackId: 'track-1', storyboardProfile: { mode: 'economy' } }), signal
  } });
  await registry.call('cinema_manage', { action: 'rescan', parameters: {} }, { signal });
  await registry.call('cinema_manage', { action: 'list_media', parameters: {} });
  await registry.call('cinema_manage', { action: 'job_status', parameters: { jobId: 'job-1' } });
  assert.equal(calls[1].path, '/api/media/rescan');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[2].path, '/api/media');
  assert.equal(calls[3].path, '/api/jobs/job-1');
});

test('discovery keeps refresh and status response shape', async () => {
  const { registry, calls } = fixture('test-client', { enableControl: true });
  const signal = new AbortController().signal;
  assert.deepEqual(await registry.call('cinema_manage', { action: 'status', parameters: {} }, { signal }), {
    baseUrl: 'http://test', health: { ok: true }, healthCheckedAt: 123
  });
  assert.deepEqual(calls[0], { signal, refresh: true });
});

test('MCP cannot rename a profile, call removed settings tool, or override its outgoing identity', async () => {
  const a = fixture('profile-a');
  await assert.rejects(a.registry.call('cinema_set_name', { name: 'Alice' }), { code: 'UNKNOWN_TOOL' });
  await assert.rejects(a.registry.call('cinema_settings', { action: 'guide', parameters: {} }), { code: 'UNKNOWN_TOOL' });
  await a.registry.call('cinema_post_message', { content: 'hello', senderIdentity: 'profile-b' });
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0].path, '/api/ai/messages');
  assert.deepEqual(JSON.parse(a.calls[0].options.body), { senderIdentity: 'profile-a', content: 'hello' });
});

test('frame retrieval delegates to the existing gated helper without reshaping content', async () => {
  const { registry, calls } = fixture();
  const signal = new AbortController().signal;
  assert.deepEqual(await registry.call('cinema_inspect_frame', { atMs: 123, quality: 'hd' }, { signal }), { mcpContent: [] });
  assert.deepEqual(calls[0], { atMs: 123, quality: 'hd', signal });
});

test('aborted calls, invalid envelopes and unknown names never reach HTTP', async () => {
  const { registry, calls } = fixture('test-client', { enableControl: true });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(registry.call('cinema_manage', { action: 'rescan', parameters: {} }, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(registry.call('cinema_manage', []), TypeError);
  await assert.rejects(registry.call('missing', {}), { code: 'UNKNOWN_TOOL' });
  assert.equal(calls.length, 0);
});

test('tick concurrency remains isolated', async () => {
  const { registry, clientState } = fixture(); clientState.tickInFlight = true;
  assert.deepEqual(await registry.call('open_watch_cinema_tick'), { state: 'waiting', reason: 'tick_in_progress' });
});

test('history read_window and end_room resolve the active room automatically without roomId', async () => {
  const { deps, calls } = fixture('test-client', { enableHistory: true, enableControl: true });
  deps.cinemaRequest = async (path, options) => {
    calls.push({ path, options });
    if (path === '/api/rooms') return { activeRoom: { id: 'room-active', status: 'active', lastPositionMs: 42000, seekVersion: 3 } };
    if (path.startsWith('/api/rooms/room-active/ai-window')) {
      return { window: { dialogue: [{ fromMs: 1000, toMs: 2000, text: '你好' }], audioDescriptions: [] } };
    }
    if (path === '/api/rooms/room-active/playback-state') {
      return { room: { id: 'room-active', status: 'active', lastPositionMs: 42000, seekVersion: 3 } };
    }
    if (path === '/api/rooms/room-active/end') return { ended: true };
    return { path };
  };
  const registry = createToolRegistry(deps);
  const read = await registry.call('cinema_read_window', { fromMs: 0, toMs: 5000 });
  assert.deepEqual(read, { dialogue: [{ fromMs: 1000, toMs: 2000, text: '你好' }], sounds: [] });
  assert.match(calls[1].path, /playheadMs=42000/);

  await registry.call('cinema_manage', { action: 'end_room', parameters: {} });
  const endCall = calls.at(-1);
  assert.equal(endCall.path, '/api/rooms/room-active/end');
  assert.deepEqual(JSON.parse(endCall.options.body), { mediaTimeMs: 42000 });
});

for (const outcome of ['success', 'playback-change', 'cancel']) {
  test(`viewing tick preserves orchestration and cursor commit boundary: ${outcome}`, async () => {
    const { deps, clientState } = fixture();
    const controller = new AbortController();
    const cursors = { mediaMs: 1000, seekVersion: 1, messageId: 0, observationSequence: 0 };
    Object.assign(clientState, {
      roomId: 'room-1', cursors: { ...cursors, mediaMs: 0 }, settingsRevision: 'old',
      frameSelections: new Map(), deliveredAudioIds: new Set(), pendingAudioRanges: []
    });
    const originalCursors = { ...clientState.cursors };
    deps.describeViewingSettings = () => 'Updated settings';
    const remembered = [];
    deps.rememberDeliveredFrames = (room, frames) => remembered.push({ room, frames });
    deps.IMAGE_BUDGET_BYTES = Infinity;
    deps.CATCHUP_TIME_BUDGET_MS = Infinity;
    deps.readFrame = async () => ({
      image: { type: 'image', mimeType: 'image/jpeg', data: 'aW1hZ2U=' },
      metadata: { panelTimesMs: [500],
        views: [{ sourceIndex: 0, type: 'full', mediaTimeMs: 500, box: [0, 0, 100, 60] }] }
    });
    let activeRoom = 'room-1';
    deps.cinemaRequest = async (path, options) => {
      if (path === '/api/ai/tick') {
        assert.equal(JSON.parse(options.body).consumerIdentity, 'test-client');
        const entries = [{ id: 'frame', type: 'image', fromMs: 500, mediaTimeMs: 500, storyboardRef: 'frame.jpg' }];
        return {
          tick: {
            packageVersion: 3, pairedCorners: true, playback: { timeMs: 1000, state: 'playing', seekVersion: 1 },
            range: { fromMs: 0, toMs: 1000 }, segments: [{ id: 'section', fromMs: 0, toMs: 1000, entries }],
            dialogueDelta: [], audioDescriptions: [],
            newMessages: [], storyboards: [], motionEvents: []
          },
          state: { roomId: activeRoom, cursors }, viewingSettings: { revision: 'new' }
        };
      }
      assert.equal(path, `/api/rooms/${activeRoom}/playback-state`);
      if (outcome === 'cancel') controller.abort();
      return { room: { id: activeRoom, status: 'active', seekVersion: outcome === 'playback-change' ? 2 : 1, lastPositionMs: 1000 } };
    };
    const registry = createToolRegistry(deps);
    const promise = registry.call('open_watch_cinema_tick', {}, { signal: controller.signal });
    if (outcome === 'success') {
      const result = await promise;
      assert.ok(result.mcpContent.some(part => part.text?.includes('Updated settings')));
      assert.deepEqual(clientState.cursors, cursors);
      assert.equal(clientState.settingsRevision, 'new');
      assert.ok(result.mcpContent.some(block => block.text?.includes('相同角标标出同一处')));
      assert.deepEqual(remembered, [{ room: 'room-1', frames: [
        { atMs: 500, parts: [{ ref: 'frame.jpg', times: [500], text: '0:00.5' }] }
      ] }]);
      const again = await registry.call('open_watch_cinema_tick', {}, { signal: controller.signal });
      assert.ok(again.mcpContent.every(block => !block.text?.includes('相同角标')));
      activeRoom = 'room-2';
      const secondRoom = await registry.call('open_watch_cinema_tick');
      assert.ok(secondRoom.mcpContent.some(block => block.text?.includes('相同角标')));
      activeRoom = 'room-1';
      const returned = await registry.call('open_watch_cinema_tick');
      assert.ok(returned.mcpContent.every(block => !block.text?.includes('相同角标')));
    } else {
      await assert.rejects(promise, outcome === 'cancel' ? { name: 'AbortError' } : { code: 'PLAYBACK_CHANGED' });
      assert.deepEqual(clientState.cursors, originalCursors);
      assert.equal(clientState.settingsRevision, 'old');
      assert.equal(clientState.roomsWithCornerGuide.size, 0);
      assert.deepEqual(remembered, []);
    }
    assert.equal(clientState.tickInFlight, false);
  });
}

test('a timed out JPEG page retries only pending files and inspection reads completed files byte for byte', async () => {
  const { deps } = fixture();
  const refs = ['first.jpg', 'second.jpg', 'third.jpg'];
  const packages = new Map(refs.map((ref, index) => [ref, Buffer.from([0xff, 0xd8, index, 0xff, 0xd9])]));
  const entry = { id: 'group', type: 'image', fromMs: 500, mediaTimeMs: 500, storyboardRef: refs[0],
    parts: refs.slice(0, 2).map(ref => ({ ref, mediaTimeMs: 500 })) };
  const nextGroup = { id: 'other-group', type: 'image', fromMs: 500, mediaTimeMs: 500, storyboardRef: refs[2] };
  let seekVersion = 1;
  let tickReads = 0;
  let failPlaybackCheck = false;
  const requestedRefs = [];
  async function cinemaRequest(path) {
    if (path === '/api/participants/ai-profiles') return { profiles: [{ id: 'profile' }], selectedId: 'profile' };
    if (path === '/api/ai/tick') {
      tickReads++;
      return {
        tick: { packageVersion: 3, playback: { timeMs: 1000, state: 'playing', seekVersion },
          range: { fromMs: 0, toMs: 1000 },
          segments: [{ id: 'section', fromMs: 0, toMs: 1000, entries: [entry, nextGroup] }],
          dialogueDelta: [], audioDescriptions: [], newMessages: [], storyboards: [], motionEvents: [] },
        state: { roomId: 'room-1', cursors: { mediaMs: 1000, seekVersion } }
      };
    }
    const url = new URL(path, 'http://test');
    if (url.pathname.endsWith('/ai-frame')) {
      const ref = url.searchParams.get('storyboardRef');
      requestedRefs.push(ref);
      return { data: packages.get(ref).toString('base64'), mimeType: 'image/jpeg' };
    }
    assert.equal(url.pathname, '/api/rooms/room-1/playback-state');
    if (failPlaybackCheck) throw new Error('playback request timed out');
    return { room: { id: 'room-1', status: 'active', seekVersion, lastPositionMs: 1000 } };
  }
  const session = createViewingSession({ cinemaRequest });
  const registry = createToolRegistry({ ...deps, ...session, cinemaRequest, IMAGE_BUDGET_BYTES: 2 });
  const images = async (tool, args) => (await registry.call(tool, args)).mcpContent
    .filter(block => block.type === 'image').map(block => Buffer.from(block.data, 'base64'));
  const tick = () => images('open_watch_cinema_tick', {});
  const inspect = () => images('cinema_inspect_frame', { atMs: 500 });
  assert.deepEqual(await tick(), [packages.get(refs[0])]);
  assert.deepEqual(await inspect(), [packages.get(refs[0])]);
  requestedRefs.length = 0;
  failPlaybackCheck = true;
  await assert.rejects(tick(), /playback request timed out/);
  failPlaybackCheck = false;
  assert.deepEqual(await tick(), [packages.get(refs[1])]);
  assert.deepEqual(await tick(), [packages.get(refs[2])]);
  assert.ok(!requestedRefs.includes(refs[0]));
  assert.equal(tickReads, 1);
  assert.deepEqual(await inspect(), [...packages.values()]);
  assert.equal(session.clientState.cursors.mediaMs, 1000);
  seekVersion++;
  assert.deepEqual(await tick(), [packages.get(refs[0])]);
  assert.deepEqual(await inspect(), [packages.get(refs[0])]);
});

test('frame inspection is exposed only under its explicit inspection name', async () => {
  const { registry } = fixture();
  assert.ok(registry.definitions.some(tool => tool.name === 'cinema_inspect_frame'));
  assert.ok(!registry.definitions.some(tool => tool.name === 'cinema_get_frame'));
  await assert.rejects(registry.call('cinema_get_frame', { atMs: 123 }), { code: 'UNKNOWN_TOOL' });
});

test('control cannot self-authorize, execute, or cross client boundaries', async () => {
  const { deps, calls } = fixture('test-client', { enableControl: true });
  deps.cinemaRequest = async (path, options) => {
    calls.push({ path, options });
    if (path === '/api/rooms') return { activeRoom: { id: 'r', status: 'active', seekVersion: 2 } };
    return { room: { id: 'r', status: 'active', seekVersion: 2 } };
  };
  const registry = createToolRegistry(deps);
  const result = await registry.call('cinema_control', { action: 'request', parameters: { targetMs: 1234, reason: 'revisit' } });
  assert.equal(result.applied, false); assert.equal(result.state, 'waiting_for_user');
  for (const action of ['approve', 'execute', 'seek']) await assert.rejects(registry.call('cinema_control', { action }), { code: 'INVALID_ACTION' });
  await assert.rejects(registry.call('cinema_control', { action: 'request', parameters: { targetMs: 0, reason: 'x', approved: true } }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(fixture('test-client', { enableControl: true }).registry.call('cinema_control', { action: 'status', parameters: { requestId: result.requestId } }), { code: 'REQUEST_NOT_FOUND' });
  assert.equal((await registry.call('cinema_control', { action: 'status', parameters: { requestId: result.requestId } })).state, 'waiting_for_user');
  assert.equal((await registry.call('cinema_control', { action: 'cancel', parameters: { requestId: result.requestId } })).state, 'cancelled');
  assert.ok(calls.every(c => (c.path === '/api/rooms' || c.path.endsWith('/playback-state')) && !c.options.method));
});

test('control expires, invalidates on seek, and supersedes previous requests', async () => {
  const { deps } = fixture('test-client', { enableControl: true }); let seekVersion = 1;
  deps.cinemaRequest = async (path) => (path === '/api/rooms'
    ? { activeRoom: { id: 'r', status: 'active', seekVersion } }
    : { room: { id: 'r', status: 'active', seekVersion } });
  const registry = createToolRegistry(deps);
  const ask = () => registry.call('cinema_control', { action: 'request', parameters: { targetMs: 2, reason: 'again' } });
  const status = requestId => registry.call('cinema_control', { action: 'status', parameters: { requestId } });
  const a = await ask(); const b = await ask();
  await assert.rejects(status(a.requestId), { code: 'REQUEST_NOT_FOUND' });
  seekVersion++; assert.equal((await status(b.requestId)).state, 'invalidated');
  const c = await ask(); const original = Date.now;
  try { Date.now = () => c.expiresAt; assert.equal((await status(c.requestId)).state, 'expired'); }
  finally { Date.now = original; }
});
