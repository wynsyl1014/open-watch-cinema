import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function openMcpClient({ script, cinemaUrl, roomId, profileId, connectionId, resumeCursors,
  enableHistory, trackImageRefs, feedToken, manualChat, onFailure }) {
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      OPEN_WATCH_CINEMA_URL: cinemaUrl,
      OPEN_WATCH_CINEMA_REQUIRE_URL: '1',
      OPEN_WATCH_CINEMA_ROOM_ID: roomId,
      OPEN_WATCH_CINEMA_PROFILE_ID: profileId,
      OPEN_WATCH_CINEMA_ACTIVITY_ID: connectionId,
      ...(enableHistory && { OPEN_WATCH_CINEMA_ENABLE_HISTORY: '1' }),
      ...(trackImageRefs && { OPEN_WATCH_CINEMA_BRIDGE_FRAME_REFS: '1' }),
      OPEN_WATCH_CINEMA_CHAT_FEED_TOKEN: feedToken,
      OPEN_WATCH_CINEMA_CHAT_MANUAL: manualChat ? '1' : undefined,
      OPEN_WATCH_CINEMA_RESUME_CURSORS: resumeCursors ? JSON.stringify(resumeCursors) : undefined
    },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true
  });
  const pending = new Map();
  let requestId = 0;
  let stopping = false;
  let failure;
  const exited = new Promise(resolve => child.once('close', (code, signal) => {
    fail(new Error(`Cinema MCP process closed (${signal ?? code}).`));
    resolve();
  }));

  function fail(error) {
    if (failure) return;
    failure = error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
    if (!stopping) onFailure(error);
  }

  child.once('error', fail);
  child.stdin.on('error', fail);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(new Error('Cinema MCP returned invalid JSON.'));
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });

  function send(method, params, id) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n');
  }

  async function request(method, params, signal) {
    signal.throwIfAborted();
    if (failure) throw failure;
    const id = ++requestId;
    const response = Promise.withResolvers();
    pending.set(id, response);
    function cancel() {
      pending.delete(id);
      response.reject(signal.reason);
      if (method === 'tools/call' && !failure) send('notifications/cancelled', { requestId: id });
    }
    signal.addEventListener('abort', cancel, { once: true });
    try {
      send(method, params, id);
      return await response.promise;
    } finally {
      pending.delete(id);
      signal.removeEventListener('abort', cancel);
    }
  }

  return {
    async initialize(signal) {
      const result = await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'open-watch-cinema-watch-bridge', version: '0.1.0' }
      }, signal);
      if (result?.serverInfo?.name !== 'open-watch-cinema') {
        throw new Error('The selected installation did not start Open Watch Cinema MCP.');
      }
      send('notifications/initialized');
    },
    async listTools(signal) {
      const result = await request('tools/list', undefined, signal);
      return result.tools;
    },
    callTool(name, args, signal, { expectedSeekVersion, feedMessagesOnly } = {}) {
      return request('tools/call', {
        name, arguments: args,
        ...(Number.isSafeInteger(expectedSeekVersion) || feedMessagesOnly ? {
          _meta: {
            ...(Number.isSafeInteger(expectedSeekVersion)
              && { 'open-watch-cinema/expectedSeekVersion': expectedSeekVersion }),
            ...(feedMessagesOnly && { 'open-watch-cinema/feedMessagesOnly': true })
          }
        } : {})
      }, signal);
    },
    async close() {
      stopping = true;
      child.stdin.end();
      const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
      try {
        await exited;
      } finally {
        clearTimeout(timeout);
        lines.close();
      }
    }
  };
}
