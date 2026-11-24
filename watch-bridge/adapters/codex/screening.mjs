import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatFilmTime } from '../../../mcp/viewing/viewing-feed.mjs';
import { renderViewingInstructions } from '../../instructions.mjs';
import { watchCinema } from '../../session.mjs';
import { openCodexClient } from './client.mjs';
import { DEFAULT_INSTRUCTIONS, screeningInstructions } from './instructions.mjs';

const TICK = 'open_watch_cinema_tick';
const CURSORS = 'open-watch-cinema/bridgeCursors';
const CINEMA_TOOLS = new Set(['cinema_post_message', 'cinema_inspect_frame', 'cinema_notebook']);
const CINEMA_MCP = fileURLToPath(new URL('../../../mcp/server.mjs', import.meta.url));
const screeningDate = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

function fault(code, message) {
  return Object.assign(new Error(message), { code });
}

async function readAccount(client, signal) {
  const { account, userId } = await client.request('account/read', { refreshToken: false }, { signal });
  const user = userId ?? account?.email?.trim().toLowerCase();
  if (account?.type !== 'chatgpt' || !user) {
    throw fault('AUTH_REQUIRED', 'Codex 连续观影需要先登录可识别的 ChatGPT 账号。');
  }
  return createHash('sha256').update(user).digest('hex');
}

function convertContent(content, forTurn) {
  return content.map(block => {
    if (block.type === 'text') return { type: forTurn ? 'input_text' : 'inputText', text: block.text };
    if (block.type === 'image') {
      const imageUrl = 'data:' + block.mimeType + ';base64,' + block.data;
      return forTurn ? { type: 'input_image', image_url: imageUrl } : { type: 'inputImage', imageUrl };
    }
    throw new Error('影院返回了当前 Codex 观影入口无法读取的内容块。');
  });
}

function toolFailure(text) {
  return { success: false, contentItems: [{ type: 'inputText', text }] };
}

function cinemaMcpOverrides(servers, cwd) {
  return Object.fromEntries(Object.entries(servers ?? {}).filter(([name, server]) =>
    name.toLowerCase().replaceAll('_', '-') === 'open-watch-cinema'
    || [server?.command, ...(server?.args ?? [])].some(arg =>
      typeof arg === 'string' && resolve(server?.cwd ?? cwd, arg) === CINEMA_MCP)
  ).map(([name]) => [name, { enabled: false }]));
}

const sandboxModes = {
  readOnly: 'read-only',
  workspaceWrite: 'workspace-write',
  dangerFullAccess: 'danger-full-access'
};

async function resumePermissions(client, config, options, signal) {
  let permissions = config?.default_permissions;
  let sandbox = config?.sandbox_mode;
  let approvalPolicy = config?.approval_policy;
  let approvalsReviewer = config?.approvals_reviewer;
  if ((!permissions && !sandbox) || !approvalPolicy) {
    // Resume otherwise takes omitted settings from the old thread. Resolve
    // unset defaults in a transient thread so Codex applies project trust.
    const defaults = await client.request('thread/start', { ...options, ephemeral: true, environments: [] }, { signal });
    await client.request('thread/unsubscribe', { threadId: defaults.thread.id }, { signal });
    if (!permissions && !sandbox) {
      permissions = defaults.activePermissionProfile?.id;
      sandbox = sandboxModes[defaults.sandbox?.type];
    }
    approvalPolicy ??= defaults.approvalPolicy;
    approvalsReviewer ??= defaults.approvalsReviewer;
    if ((!permissions && !sandbox) || !approvalPolicy) {
      throw fault('CODEX_UNAVAILABLE', '无法读取用于恢复观影聊天的 Codex 权限。');
    }
  }
  return {
    ...(permissions ? { permissions } : { sandbox }),
    approvalPolicy,
    approvalsReviewer: approvalsReviewer ?? 'user'
  };
}

export async function runCodexScreening({
  cinemaUrl, roomId, connectionId, config, threadId: savedThread, accountId: savedAccount, cursors, openingDelivered,
  signal: callerSignal, emit, persist = async message => emit(message),
  openClient = openCodexClient, watch = watchCinema
}) {
  const controller = new AbortController();
  const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
  let accountId;
  let threadId;
  let client;
  let mcp;
  let failure;
  let currentSeek;
  let activeTurn;
  let submitting;
  let terminalTurnId;
  let accountCheck;
  let openingText = !openingDelivered && config.openingMessage?.trim()
    ? '观众开场白\n' + config.openingMessage : null;
  let resumeText = !openingDelivered && config.resumeFromMs > 0
    ? '这是同一部影片的新放映房间，从上次结束的位置 ' + formatFilmTime(config.resumeFromMs) + ' 接着看。\n影片共用手记'
    : null;
  const queued = [];

  function fail(error) {
    if (signal.aborted || mcp?.signal.aborted) return;
    failure = error;
    controller.abort(error);
  }

  function interruptObsoleteTurn() {
    if (!activeTurn || activeTurn.seekVersion === currentSeek || activeTurn.interrupting || mcp.signal.aborted) return;
    activeTurn.interrupting = true;
    void client.request('turn/interrupt', { threadId, turnId: activeTurn.id }, { signal: mcp.signal }).catch(fail);
  }

  function onNotification(method, params) {
    if (method === 'account/updated' && accountId && !signal.aborted) {
      accountCheck = readAccount(client, signal).then(current => {
        if (current !== accountId) fail(fault('ACCOUNT_CHANGED', 'Codex 的登录账号已更改。'));
      }).catch(fail);
      return;
    }
    if (!threadId || params?.threadId !== threadId || mcp?.signal.aborted) return;
    if (method === 'turn/started' && submitting) {
      activeTurn = { id: params.turn.id, seekVersion: submitting.seekVersion };
      interruptObsoleteTurn();
      return;
    }
    if (method !== 'turn/completed') return;
    const { turn } = params;
    terminalTurnId = turn.id;
    const obsolete = activeTurn?.id === turn.id && activeTurn.interrupting;
    if (activeTurn?.id === turn.id) activeTurn = undefined;
    if (!obsolete && (turn.status === 'failed' || turn.status === 'interrupted')) {
      fail(new Error('Codex 未能完成这段观影，请查看连接并重试。'));
    }
    void flush();
  }

  async function onRequest(method, params) {
    if (method !== 'item/tool/call') throw new Error('此观影连接只处理影院工具请求。');
    if (params?.threadId !== threadId || !params?.turnId || !mcp || mcp.signal.aborted
      || (!activeTurn && !submitting) || (activeTurn && activeTurn.id !== params.turnId)) {
      return toolFailure('这次工具请求不属于当前观影轮次。');
    }
    if (params.namespace || !CINEMA_TOOLS.has(params.tool)) return toolFailure('这个工具不属于本场观影。');
    try {
      // Persist the delivered chat before permitting an irreversible reply, even if
      // the tool request arrived before the turn/start response.
      await submitting?.accepted.promise;
      await accountCheck;
      if (mcp.signal.aborted || activeTurn?.id !== params.turnId || activeTurn.seekVersion !== currentSeek) {
        return toolFailure('这场放映已跳转或结束，请跟随当前播放位置。');
      }
      const expectedSeekVersion = currentSeek;
      const result = await mcp.callTool(params.tool, params.arguments, { expectedSeekVersion });
      if (mcp.signal.aborted || expectedSeekVersion !== currentSeek) {
        return toolFailure('这场放映已跳转或结束，请跟随当前播放位置。');
      }
      return { success: !result.isError, contentItems: convertContent(result.content, false) };
    } catch {
      return toolFailure('影院工具调用没有完成。请核对房间里的结果再重试。');
    }
  }

  async function flush() {
    if (!threadId || submitting || mcp.signal.aborted || !queued.length || activeTurn?.interrupting
      || (activeTurn && !queued.some(entry => entry.reason === 'chat'))) return;
    const accepted = Promise.withResolvers();
    accepted.promise.catch(() => {});
    submitting = { seekVersion: currentSeek, accepted };
    try {
      await accountCheck;
      if (mcp.signal.aborted || !queued.length || submitting.seekVersion !== currentSeek) return;
      const batch = queued.splice(0);
      const includesIntro = Boolean(openingText || resumeText) && batch.some(entry => entry.includesPlayback);
      const intro = [];
      if (includesIntro && openingText) intro.push({ type: 'input_text', text: openingText });
      if (includesIntro && resumeText) {
        const notebook = await mcp.callTool('cinema_notebook', { action: 'read' }, { expectedSeekVersion: submitting.seekVersion });
        if (mcp.signal.aborted || submitting.seekVersion !== currentSeek) return;
        if (notebook.isError) throw new Error('影院暂时无法读取继续观看需要的影片手记。');
        intro.push({ type: 'input_text', text: resumeText }, ...convertContent(notebook.content, true));
      }
      const output = [...intro, ...batch.flatMap(entry => convertContent(entry.result.content, true))];
      const { turn } = await client.request('turn/start', {
        threadId, input: [], toolOutput: { name: TICK, namespace: null, output, retain: true },
        environments: []
      }, { signal: AbortSignal.any([mcp.signal, AbortSignal.timeout(15_000)]) });
      if (turn.status === 'inProgress' && turn.id !== terminalTurnId && activeTurn?.id !== turn.id) {
        activeTurn = { id: turn.id, seekVersion: submitting.seekVersion };
        interruptObsoleteTurn();
      }
      if (turn.status === 'failed' || (turn.status === 'interrupted' && submitting.seekVersion === currentSeek)) {
        throw new Error('Codex 未能完成这段观影，请查看连接并重试。');
      }
      const cursor = batch.findLast(entry => entry.cursors)?.cursors;
      if (cursor || includesIntro) await persist({
        type: 'observed', roomId, threadId, turnId: turn.id, batchId: randomUUID(), cursors: cursor,
        ...(includesIntro && { openingDelivered: true })
      });
      if (includesIntro) {
        openingText = null;
        resumeText = null;
      }
      accepted.resolve();
      emit({ type: 'started', roomId, threadId, turnId: turn.id });
    } catch (error) {
      accepted.reject(error);
      fail(error);
    } finally {
      accepted.resolve();
      submitting = undefined;
      void flush();
    }
  }

  try {
    await watch({
      cinemaUrl, roomId, profileId: config.profileId, connectionId,
      resumeCursors: savedThread ? cursors : undefined, signal,
      onPlaybackState(state) {
        if (currentSeek === state.seekVersion) return;
        currentSeek = state.seekVersion;
        queued.length = 0;
        interruptObsoleteTurn();
      },
      async onConnect(connection) {
        mcp = connection;
        const allTools = await mcp.listTools();
        const dynamicTools = allTools.filter(tool => CINEMA_TOOLS.has(tool.name))
          .map(({ name, description, inputSchema }) => ({ type: 'function', name, description, inputSchema }));
        if (dynamicTools.length !== CINEMA_TOOLS.size) throw new Error('本机影院缺少连续观影需要的 MCP 工具。');
        let opened;
        try {
          opened = await openClient({
            config: {
              mode: config.authMode === 'isolated' ? 'isolated' : 'inherited',
              dataRoot: config.dataRoot,
              agents: renderViewingInstructions(config.instructions ?? DEFAULT_INSTRUCTIONS, config.viewerName)
            },
            onNotification, onRequest, onFailure: fail
          });
        } catch (error) {
          throw fault('CODEX_UNAVAILABLE', error.message);
        }
        if (mcp.signal.aborted) {
          await opened.close();
          return;
        }
        client = opened;
        accountId = await readAccount(client, mcp.signal);
        if (savedThread && accountId !== savedAccount) {
          throw fault('ACCOUNT_CHANGED', '这场放映绑定了另一 Codex 账号。');
        }
        const cwd = savedThread && client.workspaceForThread
          ? await client.workspaceForThread(savedThread, mcp.signal)
          : client.cwd;
        const { config: loaded } = await client.request('config/read', { cwd, includeLayers: false }, { signal: mcp.signal });
        const duplicates = cinemaMcpOverrides(loaded?.mcp_servers, cwd);
        const options = {
          cwd, runtimeWorkspaceRoots: [cwd], model: config.model || undefined,
          ...(Object.keys(duplicates).length ? { config: { mcp_servers: duplicates } } : {}),
          developerInstructions: screeningInstructions(config)
        };
        let response;
        try {
          const permissions = config.authMode === 'isolated' ? { approvalPolicy: 'never', sandbox: 'read-only' }
            : savedThread ? await resumePermissions(client, loaded, options, mcp.signal) : {};
          response = await client.request(savedThread ? 'thread/resume' : 'thread/start',
            savedThread ? { ...options, ...permissions, threadId: savedThread, excludeTurns: true }
              : { ...options, ...permissions, environments: [], dynamicTools, ephemeral: false },
            { signal: mcp.signal });
        } catch (error) {
          if (/model.{0,60}(unavailable|not supported|not found)/i.test(error.rpcMessage ?? '')) {
            throw fault('MODEL_UNAVAILABLE', '所选 Codex 模型当前不可用。');
          }
          throw error;
        }
        const thread = response.thread;
        if (!thread?.id || (savedThread && thread.id !== savedThread)) throw new Error('Codex 未返回这场放映的聊天。');
        threadId = thread.id;
        await persist({ type: 'thread', roomId, threadId, accountId });
        if (savedThread && (openingText || resumeText)) {
          // Recover the first playback context if Codex retained it before the
          // bridge could save its checkpoint.
          const intro = [openingText, resumeText].filter(Boolean);
          const recent = await client.request('thread/turns/list', { threadId, limit: 1, itemsView: 'full' },
            { signal: mcp.signal }).catch(error => {
            if (error.code !== -32601) throw error;
          });
          const latest = recent?.data[0];
          if (latest?.items.some(item => item.type === 'functionCallOutput'
            && item.name === TICK && item.namespace === null && Array.isArray(item.output)
            && intro.every((text, i) => item.output[i]?.type === 'input_text' && item.output[i].text === text))) {
            await persist({
              type: 'observed', roomId, threadId, turnId: latest.id, batchId: randomUUID(), openingDelivered: true
            });
            openingText = null;
            resumeText = null;
          }
        }
        if (!savedThread && !mcp.signal.aborted) {
          const name = `${config.filmTitle} · ${screeningDate.format(new Date(config.roomOpenedAt))}`;
          const nameSignal = AbortSignal.any([mcp.signal, AbortSignal.timeout(2_000)]);
          await client.request('thread/name/set', { threadId, name }, { signal: nameSignal }).catch(() => {});
        }
        if (!savedThread && config.authMode !== 'isolated' && !mcp.signal.aborted) {
          await client.openDesktopOnce?.().catch(() => {});
        }
        emit({ type: 'ready', roomId, threadId, accountId });
      },
      onTick(result, { reason, results, state, includesPlayback }) {
        if (result.isError) throw new Error('影院暂时无法提供这段观影内容，请查看工具记录再重试。');
        if (state.seekVersion !== currentSeek) return;
        queued.push({
          result, reason, includesPlayback, cursors: results.findLast(packet => packet._meta?.[CURSORS])?._meta[CURSORS]
        });
        void flush();
      }
    });
    if (failure) throw failure;
  } finally {
    if (client) {
      if (threadId && activeTurn) {
        await client.request('turn/interrupt', { threadId, turnId: activeTurn.id },
          { signal: AbortSignal.timeout(700) }).catch(() => {});
      }
      await client.close();
    }
  }
}
