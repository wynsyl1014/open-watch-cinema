import readline from 'node:readline';
import { textResult, toolErrorResult } from './results.mjs';

const WATCH_SKILL_URI = 'open-watch-cinema://skills/watch-together';
const WATCH_SKILL_RESOURCE = {
  uri: WATCH_SKILL_URI,
  name: 'Open Watch Cinema AI Viewing Skill',
  description: 'A guide to watching movies together: joining a screening, following the film, chatting in the room, revisiting scenes, and keeping your place across calls.',
  mimeType: 'text/markdown'
};
const SERVER_INFO = { name: 'open-watch-cinema', version: '0.6.0' };

function buildInstructions(toolRegistry) {
  const names = new Set((toolRegistry?.definitions || []).map((tool) => tool.name));
  const lines = [
    'Welcome to Open Watch Cinema, a shared space to watch movies together.',
    '',
    `Read the viewing guide at ${WATCH_SKILL_URI}. This connection uses the AI profile selected by the viewer in cinema settings.`,
    '',
    'While watching, call open_watch_cinema_tick({}) at the pace agreed with the viewer to receive the latest moments of the film. The feed follows movie time, bringing together dialogue, environmental sounds, visual motion notes, storyboard images, and room messages.',
    '',
    'Use cinema_post_message({content}) to speak or send optional room interactions (popcorn, cola, cheers), cinema_inspect_frame({atMs}) to re-read a delivered storyboard, and cinema_notebook to read or write the shared film notebook.'
  ];
  if (names.has('cinema_read_window')) {
    lines.push('', 'Use cinema_read_window({fromMs, toMs}) when you need to look back at earlier dialogue or sound details in the active room.');
  }
  if (names.has('cinema_manage') || names.has('cinema_control')) {
    lines.push('', 'Optional cinema control tools are enabled: use cinema_manage for room and preparation actions, and cinema_control to propose a seek. Control requests cannot currently be approved or executed through MCP; the viewer must seek manually.');
  }
  lines.push('', 'Follow the current playback position and the material received so far. Continue checking for new moments while the active host turn allows it.');
  return lines.join('\n');
}

export function createMcpProtocol({ toolRegistry, watchSkillText, bindSelectedProfile, activity }) {
  const WATCH_SKILL_TEXT = watchSkillText;
  const inFlightRequests = new Map();
  const reports = new WeakMap();
  async function handleRequest(message) {
    const { id, method, params } = message;
    if (method === 'initialize') {
      activity?.start();
      try {
        await bindSelectedProfile?.({ optional: true });
      } catch (error) {
        return { jsonrpc: '2.0', id, error: { code: -32000, message: error.message } };
      }
      activity?.start();
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false }
          },
          serverInfo: SERVER_INFO,
          instructions: buildInstructions(toolRegistry)
        }
      };
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'resources/list') {
      return { jsonrpc: '2.0', id, result: { resources: [WATCH_SKILL_RESOURCE] } };
    }
    if (method === 'resources/read') {
      if (params?.uri !== WATCH_SKILL_URI) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32002, message: `Unknown resource: ${params?.uri || ''}` }
        };
      }
      return {
        jsonrpc: '2.0',
        id,
        result: {
          contents: [{ uri: WATCH_SKILL_URI, mimeType: 'text/markdown', text: WATCH_SKILL_TEXT }]
        }
      };
    }
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: toolRegistry.definitions } };
    if (method === 'tools/call') {
      if (inFlightRequests.has(id)) {
        return { jsonrpc: '2.0', id, error: { code: -32600, message: 'A request with this ID is already running.' } };
      }
      const controller = new AbortController();
      inFlightRequests.set(id, controller);
      const started = activity?.begin();
      function finish(result, progress, viewingRoomId) {
        const response = { jsonrpc: '2.0', id, result };
        if (started) {
          const name = params?.name;
          const tool = typeof name === 'string' && /^[^\x00-\x1f\x7f]{1,128}$/u.test(name) ? name : 'unknown';
          const actions = toolRegistry.definitions.find(entry => entry.name === tool)?.inputSchema?.properties?.action?.enum;
          const action = actions?.includes(params?.arguments?.action) ? params.arguments.action : undefined;
          reports.set(response, { started, tool, action, progress, viewingRoomId,
            profileId: activity.getProfileId(), finishedAt: Math.max(started.startedAt, Date.now()) });
        }
        return response;
      }
      try {
        const result = await toolRegistry.call(params?.name, params?.arguments || {}, {
          requestId: id,
          expectedSeekVersion: params?._meta?.['open-watch-cinema/expectedSeekVersion'],
          feedMessagesOnly: params?._meta?.['open-watch-cinema/feedMessagesOnly'] === true,
          signal: controller.signal
        });
        if (controller.signal.aborted) return null;
        const bridgeMetadata = {
          ...(result?.bridgeCursors && { 'open-watch-cinema/bridgeCursors': result.bridgeCursors }),
          ...(Number.isSafeInteger(result?.viewerActualMs) && { 'open-watch-cinema/viewerActualMs': result.viewerActualMs }),
          ...(Number.isSafeInteger(result?.deliveryHorizonMs) && { 'open-watch-cinema/deliveryHorizonMs': result.deliveryHorizonMs }),
          ...(result?.bridgeBlockThroughMs && { 'open-watch-cinema/bridgeBlockThroughMs': result.bridgeBlockThroughMs }),
          ...(result?.bridgeFrameRefs && { 'open-watch-cinema/bridgeFrameRefs': result.bridgeFrameRefs }),
          ...(result?.bridgeMoreImagePages && { 'open-watch-cinema/bridgeMoreImagePages': true }),
          ...(typeof result?.bridgeHasMaterial === 'boolean' && { 'open-watch-cinema/bridgeHasMaterial': result.bridgeHasMaterial })
        };
        return finish(result?.mcpContent ? { content: result.mcpContent,
          ...(Object.keys(bridgeMetadata).length && { _meta: bridgeMetadata }) } : textResult(result),
          result?.deliveredProgress, result?.viewingRoomId);
      } catch (error) {
        // Cancellation stops this call's reads and never advances an unassembled tick.
        if (controller.signal.aborted) return null;
        return finish(error?.code === 'CATCHUP_BUDGET_EXHAUSTED'
          ? textResult({ state: 'waiting', reason: 'catchup_time_budget' })
          : toolErrorResult(error));
      } finally {
        inFlightRequests.delete(id);
      }
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    };
  }

  return {
    handleRequest,
    delivered(response) {
      const report = reports.get(response);
      if (!report) return;
      reports.delete(response);
      activity.delivered(report.started, { ...report,
        content: response.result.content, isError: response.result.isError === true });
    },
    cancel(requestId) {
      inFlightRequests.get(requestId)?.abort(
        new DOMException('The host cancelled this tool call.', 'AbortError'));
    },
    endActivity() { activity?.close(); },
    close() {
      for (const controller of inFlightRequests.values()) {
        controller.abort(new DOMException('The MCP input closed.', 'AbortError'));
      }
    }
  };
}

export function startStdio(protocol, { stdin = process.stdin, stdout = process.stdout } = {}) {
  const input = readline.createInterface({ input: stdin, crlfDelay: Infinity });
  let closing = false;
  let pendingWrites = 0;
  function endActivityWhenDrained() {
    if (closing && !pendingWrites) protocol.endActivity?.();
  }
  input.on('line', async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: error.message }
      })}\n`);
      return;
    }
    if (message.method === 'notifications/cancelled') {
      protocol.cancel(message.params?.requestId);
      return;
    }
    if (!Object.hasOwn(message, 'id')) return;
    const response = await protocol.handleRequest(message);
    if (response !== null) {
      pendingWrites++;
      stdout.write(JSON.stringify(response) + '\n', error => {
        if (!error) protocol.delivered?.(response);
        pendingWrites--;
        endActivityWhenDrained();
      });
    }
  });

  input.on('close', () => {
    closing = true;
    protocol.close();
    endActivityWhenDrained();
  });

  return input;
}
