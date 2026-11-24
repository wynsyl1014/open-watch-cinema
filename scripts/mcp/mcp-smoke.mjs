import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'owc-mcp-smoke-'));
const port = 4850 + Math.floor(Math.random() * 100);
const baseUrl = `http://127.0.0.1:${port}`;
let cinema;
let child;
let output;
let stderr = '';
let cinemaStderr = '';

async function waitForCinema() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { cache: 'no-store' });
      if (response.ok) {
        const health = await response.json();
        if (
          Array.isArray(health.capabilities)
          && health.capabilities.includes('ai-window-v1')
          && health.capabilities.includes('ai-tick-v1')
          && health.capabilities.includes('ai-frame-v1')
        ) return health;
      }
    } catch {
      // The isolated cinema is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
  }
  throw new Error('Isolated cinema did not become MCP-compatible in time.');
}

const pending = new Map();
let nextId = 1;

function request(method, params = {}) {
  const id = nextId++;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectPromise(new Error(`MCP request timed out: ${method}`));
    }, 10_000);
    pending.set(id, {
      resolve(message) {
        clearTimeout(timer);
        resolvePromise(message);
      }
    });
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return promise;
}

function toolPayload(response) {
  if (response.error) throw new Error(response.error.message);
  const text = response.result?.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('MCP tool did not return text content.');
  const payload = JSON.parse(text);
  if (response.result.isError) throw new Error(payload.message || 'MCP tool failed.');
  return payload;
}

try {
  cinema = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      LOCAL_DATA_ROOT: temporaryRoot,
      PORT: String(port),
      OPEN_BROWSER: '0'
    },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  cinema.stderr.setEncoding('utf8');
  cinema.stderr.on('data', (chunk) => { cinemaStderr += chunk; });
  const isolatedHealth = await waitForCinema();

  child = spawn(process.execPath, [resolve(ROOT, 'mcp', 'server.mjs'), '--with-history', '--with-control'], {
    cwd: ROOT,
    env: {
      ...process.env,
      OPEN_WATCH_CINEMA_URL: baseUrl
    },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  output.on('line', (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    waiter.resolve(message);
  });

  const initialized = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'open-watch-cinema-smoke', version: '1.0.0' }
  });
  if (initialized.result?.serverInfo?.name !== 'open-watch-cinema') {
    throw new Error('Unexpected MCP server identity.');
  }

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

  const resources = await request('resources/list');
  const skill = (resources.result?.resources || []).find((item) => (
    item.uri === 'open-watch-cinema://skills/watch-together'
  ));
  if (!skill) throw new Error('MCP did not advertise the AI viewing skill resource.');
  const skillRead = await request('resources/read', { uri: skill.uri });
  const skillText = skillRead.result?.contents?.[0]?.text || '';
  if (!skillText.includes('## Normal viewing') || !skillText.includes('cinema_inspect_frame')) {
    throw new Error('AI viewing skill resource was incomplete.');
  }

  const listed = await request('tools/list');
  const toolNames = (listed.result?.tools || []).map((tool) => tool.name);
  const frameSchema = listed.result.tools.find((tool) => tool.name === 'cinema_inspect_frame')?.inputSchema;
  if (JSON.stringify(frameSchema?.required) !== JSON.stringify(['atMs'])
      || Object.keys(frameSchema?.properties || {}).some((field) => ['roomId', 'storyboardRef', 'mediaTimeMs'].includes(field))) {
    throw new Error('The model-facing frame tool exposed private file and room parameters.');
  }
  for (const required of [
    'cinema_manage', 'cinema_control',
    'open_watch_cinema_tick', 'cinema_read_window', 'cinema_inspect_frame', 'cinema_post_message', 'cinema_notebook'
  ]) {
    if (!toolNames.includes(required)) throw new Error(`Missing MCP tool: ${required}`);
  }
  if (toolNames.includes('cinema_settings')) throw new Error('Removed cinema_settings tool is still exposed.');

  const status = toolPayload(await request('tools/call', {
    name: 'cinema_manage', arguments: { action: 'status', parameters: {} }
  }));
  const media = toolPayload(await request('tools/call', {
    name: 'cinema_manage', arguments: { action: 'list_media', parameters: {} }
  }));
  if (toolNames.includes('cinema_set_name')) throw new Error('MCP exposed a profile-management tool.');
  const unbound = await request('tools/call', { name: 'cinema_post_message', arguments: { content: 'hello' } });
  if (JSON.parse(unbound.result.content[0].text).error !== 'AI_PROFILE_REQUIRED') {
    throw new Error('An unbound connection must direct the viewer to cinema settings.');
  }

  if (status.baseUrl !== baseUrl) throw new Error('MCP did not bind to the isolated cinema URL.');
  if (status.health?.apiVersion !== '0.5.0') throw new Error('MCP did not reach the expected cinema API version.');
  if ((media.items || []).length !== 0) throw new Error('Isolated MCP smoke cinema was not empty.');

  console.log(JSON.stringify({
    ok: true,
    serverInfo: initialized.result.serverInfo,
    toolCount: toolNames.length,
    requiredToolsPresent: true,
    isolated: true,
    cinemaBaseUrl: status.baseUrl,
    health: isolatedHealth,
    mediaCount: 0
  }, null, 2));
} catch (error) {
  throw new Error([
    error.message,
    cinemaStderr ? `Cinema stderr:\n${cinemaStderr}` : '',
    stderr ? `MCP stderr:\n${stderr}` : ''
  ].filter(Boolean).join('\n'));
} finally {
  if (child) {
    child.stdin.end();
    child.kill();
  }
  output?.close();
  if (cinema && !cinema.killed) cinema.kill();
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
