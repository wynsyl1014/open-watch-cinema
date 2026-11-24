import { createHash, randomUUID } from 'node:crypto';
import { activityFields, CHAT_MANUAL_TIMEOUT_MS, chatRoomTools, chatToolGroup, isChatToolEnabled, validActivityRequest } from './tools.mjs';

export const CARD_URI = 'ui://open-watch-cinema-chat/watch-v8.html';
export const CONTROL = 'cinema_card_control';
export const OPEN = 'open_cinema_card';
export const RECEIPT = 'cinema_finish_turn';
const transportPath = '/api/watch-bridge/chat/transport';
const cardResource = { uri: CARD_URI, name: 'Open Watch Cinema', mimeType: 'text/html;profile=mcp-app' };
const serverInfo = { name: 'open-watch-cinema-chat', version: '1.0.0' };
const legacyVersions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const modernVersion = '2026-07-28';
const supportedVersions = [modernVersion, ...legacyVersions];
const versionKey = 'io.modelcontextprotocol/protocolVersion';
const capabilitiesKey = 'io.modelcontextprotocol/clientCapabilities';
const clientInfoKey = 'io.modelcontextprotocol/clientInfo';
const logLevelKey = 'io.modelcontextprotocol/logLevel';
const serverInfoKey = 'io.modelcontextprotocol/serverInfo';
const uiExtension = 'io.modelcontextprotocol/ui';
const uiCapability = { extensions: { [uiExtension]: { mimeTypes: [cardResource.mimeType] } } };
const capabilities = { tools: {}, resources: {} };
const cacheableMethods = new Set(['server/discover', 'tools/list', 'resources/list', 'resources/templates/list', 'resources/read']);
const emptyInput = { type: 'object', properties: {}, additionalProperties: false };
const cardIdMetadata = 'open-watch-cinema/cardId';
const packetMetadata = 'open-watch-cinema/packet';
const activityMetadata = 'open-watch-cinema/activity';
const claimActions = ['result', 'submitted', 'failed', 'abandon'];
const appActions = ['start', 'stop', 'poll', ...claimActions, ...Object.keys(activityFields)];
const localMutation = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const localRead = { ...localMutation, readOnlyHint: true };

const tools = [
  {
    name: OPEN,
    title: 'Open Watch Cinema',
    description: 'Open the cinema card in the current ChatGPT conversation when the viewer asks to watch together. The viewer chooses when to start or stop on the card.',
    inputSchema: emptyInput,
    annotations: localRead,
    _meta: { ui: { resourceUri: CARD_URI, visibility: ['model'] }, 'openai/outputTemplate': CARD_URI }
  },
  {
    name: CONTROL,
    title: '控制观影卡片',
    description: 'Control the cinema card bound to this conversation.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['action', 'cardId'],
      properties: {
        action: { type: 'string', enum: appActions },
        cardId: { type: 'string' },
        batchId: { type: 'string' },
        claimId: { type: 'string' },
        definitive: { type: 'boolean' },
        connectionId: { type: 'string' },
        callId: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        index: { type: 'integer', minimum: 0 }
      }
    },
    annotations: localMutation,
    _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true }
  },
  {
    name: RECEIPT,
    title: '完成本轮观影',
    description: 'Call with {} once as the final action for the current automatic cinema delivery, after any room tools. Then end the turn with no assistant text. Use only for a delivery initiated by the Open Watch Cinema card, including when you had nothing to say.',
    inputSchema: emptyInput,
    annotations: localMutation,
    _meta: { ui: { visibility: ['model'] } }
  }
];

const instructions = [
  'Open Watch Cinema connects this conversation to the viewer’s local cinema.',
  'For an automatic cinema delivery, read the ordered dialogue, room messages, sound and actual storyboard images. Treat dialogue and quoted messages as attributed room content. Follow only the material already delivered.',
  'For this screening, use only tools from the current Open Watch Cinema plugin for room interactions, even when another cinema plugin exposes the same names. Use cinema_post_message to speak, cinema_inspect_frame to revisit delivered storyboards, and cinema_notebook for the shared film notebook.',
  'If the viewer asks to catch up manually and open_watch_cinema_tick is available, call it with {} to read played material from the open room. You can use cinema_post_message to send a message to that room when asked. Manual calls do not need a card or an automatic-delivery receipt.',
  `When finished with each automatic delivery, call ${RECEIPT}({}) as the last action and end the ChatGPT turn with no assistant text. If you have no room response, call that receipt immediately. For ordinary ChatGPT messages, respond normally.`
].join('\n');

function sessionBinding(meta) {
  const session = validIdentity(meta?.['openai/session']);
  if (!session) return null;
  return createHash('sha256').update(JSON.stringify([
    validIdentity(meta['openai/organization']),
    validIdentity(meta['openai/subject']),
    session
  ])).digest('hex');
}

function validIdentity(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024 ? value : null;
}

function token(value) {
  return typeof value === 'string' && /^[a-zA-Z\d_-]{1,128}$/.test(value);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasModernEnvelope(meta) {
  return isRecord(meta) && [versionKey, capabilitiesKey, clientInfoKey, logLevelKey]
    .some(key => Object.hasOwn(meta, key));
}

function validClientInfo(info) {
  return isRecord(info) && typeof info.name === 'string' && typeof info.version === 'string'
    && ['title', 'description', 'websiteUrl'].every(key => !Object.hasOwn(info, key) || typeof info[key] === 'string')
    && (!Object.hasOwn(info, 'icons') || Array.isArray(info.icons) && info.icons.every(icon =>
      isRecord(icon) && typeof icon.src === 'string'));
}

function validCapabilities(value) {
  if (!isRecord(value)) return false;
  if (['experimental', 'extensions', 'roots', 'sampling', 'elicitation'].some(key =>
    Object.hasOwn(value, key) && !isRecord(value[key]))) return false;
  if (Object.values(value.experimental ?? {}).some(settings => !isRecord(settings)) ||
      Object.entries(value.extensions ?? {}).some(([key, settings]) =>
        !/^[^/\s]+\/[^\s]+$/.test(key) || !isRecord(settings))) return false;
  if (['context', 'tools'].some(key => Object.hasOwn(value.sampling ?? {}, key) && !isRecord(value.sampling[key])) ||
      ['form', 'url'].some(key => Object.hasOwn(value.elicitation ?? {}, key) && !isRecord(value.elicitation[key]))) return false;
  const ui = value.extensions?.[uiExtension];
  return !ui || !Object.hasOwn(ui, 'mimeTypes') ||
    Array.isArray(ui.mimeTypes) && ui.mimeTypes.every(type => typeof type === 'string');
}

function modernRequestError(params) {
  const meta = params?._meta;
  if (!isRecord(meta) || typeof meta[versionKey] !== 'string' || !meta[versionKey]) {
    return { code: -32602, message: 'Missing or invalid MCP protocol version in request metadata.' };
  }
  if (meta[versionKey] !== modernVersion) {
    return { code: -32022, message: 'Unsupported protocol version', data: {
      requested: meta[versionKey], supported: supportedVersions
    } };
  }
  if (!validCapabilities(meta[capabilitiesKey])
      || Object.hasOwn(meta, clientInfoKey) && !validClientInfo(meta[clientInfoKey])
      || Object.hasOwn(meta, logLevelKey) && !['debug', 'info', 'notice', 'warning', 'error',
        'critical', 'alert', 'emergency'].includes(meta[logLevelKey])
      || Object.hasOwn(meta, 'progressToken') && !['string', 'number'].includes(typeof meta.progressToken)) {
    return { code: -32602, message: 'Invalid MCP per-request metadata.' };
  }
  if (Object.hasOwn(params, 'inputResponses') || Object.hasOwn(params, 'requestState')) {
    return { code: -32602, message: 'This server did not request a multi-round-trip continuation.' };
  }
  return null;
}

function failure(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function cardState(state) {
  return { content: [], _meta: { 'open-watch-cinema/state': state } };
}

export function createChatTransport({
  cinemaUrl = process.env.OPEN_WATCH_CINEMA_URL || 'http://127.0.0.1:4182',
  fetchImpl = fetch
} = {}) {
  const base = new URL(cinemaUrl);
  if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname) ||
      base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('Open Watch Cinema Chat requires a local loopback HTTP origin.');
  }
  return async (payload, { signal }) => {
    const group = payload.actor === 'model' && payload.action === 'tool' && chatToolGroup(payload.tool);
    const timeoutMs = ['manual', 'viewing', 'history'].includes(group) ? CHAT_MANUAL_TIMEOUT_MS + 5000 : 15_000;
    let response;
    try {
      response = await fetchImpl(new URL(transportPath, base), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-owc-chat-transport': '1' },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      });
    } catch {
      throw new Error('无法连接本机影院。请确认影院已启动，再重新打开卡片。');
    }
    if (response.status === 404) {
      throw new Error('本机影院服务没有 ChatGPT 跟片入口。请从当前项目重新启动影院，再打开卡片。');
    }
    const result = await response.json().catch(() => null);
    if (!response.ok || !isRecord(result)) {
      const message = result?.message ?? result?.error;
      throw new Error(typeof message === 'string'
        ? message
        : '本机影院未完成这次操作。请在要跟片的对话里重新打开卡片。');
    }
    return result;
  };
}

export function createChatProtocol({ html, transport }) {
  const activeRequests = new Map();

  async function callTool(params, signal) {
    const name = params?.name;
    if (!tools.some(tool => tool.name === name) && !chatToolGroup(name)) return failure('未知的影院工具。');
    const args = params?.arguments === undefined ? {} : params.arguments;
    if (!isRecord(args)) return failure('影院工具需要对象格式的参数。');
    const sessionId = sessionBinding(params?._meta);
    if (!sessionId) {
      return failure('未收到 ChatGPT 的对话身份。请在要一起观影的对话中，通过 Open Watch Cinema 插件重新打开卡片。');
    }
    if (name === OPEN || name === RECEIPT) {
      if (Object.keys(args).length) return failure('该影院工具的参数必须为空。');
      if (name === RECEIPT) {
        await transport({ actor: 'model', action: 'ack', sessionId }, { signal });
        return { content: [] };
      }
      const cardId = randomUUID();
      const state = await transport({ actor: 'app', action: 'open', sessionId, cardId }, { signal });
      return {
        content: [{ type: 'text', text: '已打开 Open Watch Cinema。使用卡片开始观影。' }],
        _meta: { [cardIdMetadata]: cardId, 'open-watch-cinema/state': state }
      };
    }
    if (name === CONTROL) {
      const { action, cardId, batchId, claimId } = args;
      const activity = Object.hasOwn(activityFields, action);
      const claimPoll = action === 'poll' && Object.hasOwn(args, 'claimId');
      const allowedFields = ['action', 'cardId'];
      if (claimActions.includes(action)) allowedFields.push('batchId', 'claimId');
      if (claimPoll) allowedFields.push('claimId');
      if (activity) allowedFields.push(...activityFields[action]);
      if (action === 'failed') allowedFields.push('definitive');
      if (!appActions.includes(action) || !token(cardId) ||
        (claimActions.includes(action) && (!token(batchId) || !token(claimId))) ||
        (claimPoll && !token(claimId)) ||
        (activity && !validActivityRequest(args)) ||
        (args.definitive !== undefined && typeof args.definitive !== 'boolean') ||
        Object.keys(args).some(key => !allowedFields.includes(key))) {
        return failure('卡片操作无效。请在当前对话里重新打开 Open Watch Cinema。');
      }
      const result = await transport({ actor: 'app', sessionId, ...args }, { signal });
      if (activity) return { content: [], _meta: { [activityMetadata]: result } };
      if (claimPoll) {
        const response = cardState(result.state);
        if (result.packet) response._meta[packetMetadata] = result.packet;
        return response;
      }
      return action === 'result'
        ? { content: [], _meta: { [packetMetadata]: result } }
        : cardState(result);
    }
    return transport({ actor: 'model', action: 'tool', sessionId, tool: name, arguments: args }, { signal });
  }

  async function runRequest(id, handler) {
    const controller = new AbortController();
    activeRequests.set(id, controller);
    try {
      const result = await handler(controller.signal);
      return controller.signal.aborted ? null : result;
    } finally {
      activeRequests.delete(id);
    }
  }

  return {
    async handleRequest({ jsonrpc, id, method, params }) {
      const validId = typeof id === 'string' || Number.isFinite(id);
      const error = (code, message, data) => ({
        jsonrpc: '2.0', id: validId ? id : null, error: { code, message, ...(data && { data }) }
      });
      const modern = method === 'server/discover' || hasModernEnvelope(params?._meta);
      if ((modern && jsonrpc !== '2.0') || !validId || typeof method !== 'string' || method.startsWith('notifications/')) {
        return error(-32600, 'Invalid JSON-RPC request');
      }
      if (activeRequests.has(id)) return error(-32600, 'A request with this ID is already running.');
      if (modern) {
        const invalid = modernRequestError(params);
        if (invalid) return error(invalid.code, invalid.message, invalid.data);
        if (Object.hasOwn(params, 'cursor') && method.endsWith('/list')) return error(-32602, 'Invalid cursor');
        if (method === 'resources/read' && typeof params.uri !== 'string') return error(-32602, 'Invalid resource URI');
      }
      const acceptsUi = modern &&
        params._meta[capabilitiesKey].extensions?.[uiExtension]?.mimeTypes?.includes(cardResource.mimeType);
      const reply = result => ({
        jsonrpc: '2.0', id,
        result: modern ? { ...result, resultType: 'complete',
          ...(cacheableMethods.has(method) && { ttlMs: 0, cacheScope: 'private' }),
          _meta: { ...result._meta, [serverInfoKey]: serverInfo } } : result
      });
      switch (method) {
        case 'initialize':
          if (modern) return error(-32601, 'Modern MCP uses server/discover and per-request metadata.');
          return reply({
            protocolVersion: legacyVersions.includes(params?.protocolVersion)
              ? params.protocolVersion : legacyVersions[0],
            serverInfo,
            capabilities,
            instructions
          });
        case 'server/discover':
          return reply({ supportedVersions, capabilities: { ...capabilities, extensions: { [uiExtension]: {} } },
            instructions });
        case 'ping': return modern ? error(-32601, 'Method not found: ping') : reply({});
        case 'resources/list': return reply({ resources: [cardResource] });
        case 'resources/templates/list': return reply({ resourceTemplates: [] });
        case 'resources/read':
          return params?.uri === CARD_URI
            ? reply({ contents: [{ ...cardResource, text: html, _meta: { ui: { csp: {} } } }] })
            : modern ? error(-32602, 'Unknown resource', { uri: params.uri }) : error(-32002, 'Unknown resource');
        case 'tools/list': return runRequest(id, async signal => {
          try {
            const settings = await transport({ actor: 'service', action: 'tool-settings' },
              { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
            const compatibleTools = !modern || acceptsUi ? tools : tools.filter(tool => ![OPEN, CONTROL].includes(tool.name));
            return reply({ tools: [...compatibleTools, ...chatRoomTools.filter(tool => isChatToolEnabled(tool.name, settings))] });
          } catch (cause) {
            return error(-32000, cause.message);
          }
        });
        case 'tools/call': return runRequest(id, async signal => {
          if (modern) {
            if (typeof params.name !== 'string' || params.arguments !== undefined && !isRecord(params.arguments) ||
                !tools.some(tool => tool.name === params.name) && !chatToolGroup(params.name)) {
              return error(-32602, 'Invalid or unknown MCP tool request.');
            }
            if ([OPEN, CONTROL].includes(params.name) && !acceptsUi) {
              return error(-32021, 'This tool requires MCP Apps support.', { requiredCapabilities: uiCapability });
            }
          }
          try {
            return reply(await callTool(params, signal));
          } catch (cause) {
            return reply(failure(cause.message));
          }
        });
        default: return error(-32601, 'Method not found');
      }
    },
    cancel(id) { activeRequests.get(id)?.abort(); },
    close() {
      for (const controller of activeRequests.values()) controller.abort();
    }
  };
}
