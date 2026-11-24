import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getRoomOpeningMessage } from '../storage/database.mjs';

const defaults = { enabled: false, authMode: 'inherit', model: null, instructions: null, openingPrompt: null };

function read(db, key) {
  return JSON.parse(db.prepare('select value from settings where key = ?').get(key)?.value ?? 'null');
}

function save(db, key, value) {
  db.prepare(`insert into settings (key, value, updated_at) values (?, ?, ?)
    on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, JSON.stringify(value), new Date().toISOString());
}

const isModelId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value);
const validTemplate = value => value === null || (typeof value === 'string' && value.length <= 12000);

export function createCodexScreening({ db, cinemaRoot, dataRoot, getRoom, getProfileId, getProfileName, getViewerName, onChange,
  spawn = runner => fork(runner, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true }) }) {
  const runner = join(cinemaRoot, 'watch-bridge', 'adapters', 'codex', 'runner.mjs');
  const available = () => ['runner.mjs','setup.mjs','instructions.mjs']
    .every(file => existsSync(join(cinemaRoot, 'watch-bridge', 'adapters', 'codex', file)));
  const key = 'watch_bridge_codex';
  const bindingKey = 'watch_bridge_codex_binding';
  let cinemaUrl;
  let processState;
  let failure;
  let shuttingDown = false;
  const connections = new Set();

  function settings() {
    return { ...defaults, ...read(db, key) };
  }

  function storeSettings(body) {
    const current = settings();
    const next = { ...current, ...body };
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(field => !Object.hasOwn(defaults, field))
      || typeof next.enabled !== 'boolean' || !['inherit', 'isolated'].includes(next.authMode)
      || (next.model !== null && !isModelId(next.model)) || !validTemplate(next.instructions) || !validTemplate(next.openingPrompt)) {
      throw new TypeError('Continuous viewing settings are invalid.');
    }
    if (next.enabled && !available()) throw new TypeError('请先安装 Codex 连续观影适配器。');
    save(db, key, next);
    return () => {
      if (processState && !processState.binding.threadId
        && ['authMode', 'model', 'instructions'].some(field => current[field] !== next[field])) stop();
      reconcile({ retry: true });
    };
  }

  function setSettings(body) {
    storeSettings(body)();
    return settings();
  }

  function stop() {
    const state = processState;
    if (!state || state.stopping) return state?.closed;
    state.stopping = true;
    onChange();
    if (state.child.connected) state.child.send({ type: 'stop' }, () => {});
    const deadline = setTimeout(() => state.child.kill('SIGTERM'), 4000);
    const force = setTimeout(() => state.child.kill('SIGKILL'), 7000);
    void state.closed.then(() => { clearTimeout(deadline); clearTimeout(force); });
    return state.closed;
  }

  function reconcile({ retry = false } = {}) {
    if (retry) failure = null;
    if (shuttingDown || !cinemaUrl) return;
    const room = getRoom();
    const config = settings();
    if (!room || !config.enabled) {
      failure = null;
      stop();
      return;
    }
    if (processState) {
      if (processState.roomId !== room.id) stop();
      return;
    }
    if (failure?.roomId === room.id) return;
    failure = null;
    const existing = read(db, bindingKey);
    const saved = existing?.roomId === room.id && existing.threadId ? existing : null;
    const profileId = saved?.profileId ?? getProfileId();
    if (!available() || !profileId) {
      failure = { roomId: room.id, needsProfile: available(), message: available() ? '请在「名字与档案」选好观影 AI。' : '找不到 Codex 连续观影适配器。' };
      onChange();
      return;
    }
    const binding = saved ?? { roomId: room.id, profileId, authMode: config.authMode, model: config.model,
      instructions: config.instructions };
    let child;
    try {
      save(db, bindingKey, binding);
      child = spawn(runner);
    } catch {
      failure = { roomId: room.id, message: '无法启动本场 Codex 连续观影。' };
      onChange();
      return;
    }
    const completion = Promise.withResolvers();
    const state = processState = {
      child, binding, closed: completion.promise, roomId: room.id, profileId, ready: false, stopping: false,
      connectionId: randomUUID(), connectedAt: Date.now()
    };
    connections.add(state.connectionId);

    function fail(message) {
      if (processState !== state || state.stopping) return;
      failure = { roomId: room.id, message };
      stop();
    }

    const startupDeadline = setTimeout(() => fail('等待 Codex 连接超时。请在「Codex App Server」检查账号状态。'), 60000);
    child.once('error', () => fail('Codex 连续观影进程无法启动。'));
    child.once('close', () => {
      clearTimeout(startupDeadline);
      if (!state.stopping) failure = { roomId: room.id, message: 'Codex 连续观影进程已断开。' };
      processState = null;
      completion.resolve();
      onChange();
      reconcile();
    });
    child.on('message', message => {
      if (getRoom()?.id !== room.id || (message.roomId && message.roomId !== room.id)) return;
      if (message.type === 'observed' && message.threadId && message.threadId === binding.threadId) {
        try {
          if (message.cursors) binding.cursors = message.cursors;
          if (message.openingDelivered === true) binding.openingDelivered = true;
          save(db, bindingKey, binding);
          if (child.connected) child.send({ type: 'observed-saved', roomId: room.id, threadId: binding.threadId,
            turnId: message.turnId, batchId: message.batchId }, () => {});
        } catch {
          fail('无法保存本场的观影进度。');
        }
        return;
      }
      if (state.stopping) return;
      if (message.type === 'ready') {
        clearTimeout(startupDeadline);
        state.ready = true;
        onChange();
      } else if (message.type === 'thread') {
        try {
          binding.threadId = message.threadId;
          binding.accountId = message.accountId;
          save(db, bindingKey, binding);
          if (child.connected) child.send({ type: 'thread-saved', roomId: room.id, threadId: binding.threadId }, () => {});
        } catch {
          fail('无法保存本场的 Codex 会话。');
        }
      } else if (message.type === 'fault') {
        const messages = {
          CODEX_UNAVAILABLE: '未找到兼容的 Codex，请在「Codex App Server」查看安装方法。',
          AUTH_REQUIRED: 'Codex 需要登录 ChatGPT。请在「Codex App Server」完成登录。',
          MODEL_UNAVAILABLE: '所选模型当前不可用。请在「Codex App Server」重新选择模型。',
          ACCOUNT_CHANGED: '当前 ChatGPT 账号与本场会话绑定的账号不同。'
        };
        fail(messages[message.code] ?? 'Codex 连续观影连接中断。请在「Codex App Server」中检查账号状态。');
      }
    });
    child.send({ type: 'start', cinemaUrl, roomId: room.id, connectionId: state.connectionId,
      threadId: binding.threadId, accountId: binding.accountId, cursors: binding.cursors,
      openingDelivered: binding.openingDelivered === true,
      config: { profileId, authMode: binding.authMode, model: binding.model, dataRoot,
        profileName: getProfileName(profileId), viewerName: getViewerName(),
        filmTitle: room.mediaTitle, roomOpenedAt: room.openedAt,
        instructions: binding.instructions, openingMessage: getRoomOpeningMessage(db, room.id),
        resumeFromMs: room.resumeFromMs ?? null }
    }, error => { if (error) fail('Codex 连续观影进程无法启动。'); });
    onChange();
  }

  function status() {
    const room = getRoom();
    const state = processState;
    const current = room && state?.roomId === room.id && !state.stopping;
    if (current) return {
      connectionId: state.connectionId, profileId: state.profileId, connectedAt: state.connectedAt,
      roomId: state.roomId, online: state.ready, connecting: !state.ready, paused: room.playbackState === 'paused'
    };
    return null;
  }

  return { settings, setSettings, storeSettings, available, reconcile, status, isManaged: id => connections.has(id),
    needsProfile: () => failure?.needsProfile === true, error: () => failure?.message ?? null,
    start(url) { cinemaUrl = url; reconcile(); },
    close() { shuttingDown = true; return stop(); }
  };
}
