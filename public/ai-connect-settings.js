import { CHAT_SCREENING_STATUS } from './ai-activity.js';

const DEFAULT_LOOPBACK_PORTS = new Set([4182, 4183, 4184, 4185, 4186, 4187]);

function shellQuote(value, platform) {
  const text = String(value);
  if (!/[\s"'\\$`]/.test(text)) return text;
  if (platform === 'win32') return `"${text.replace(/"/g, '\\"')}"`;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

export function buildMcpArgs({ mcpServerPath, enableHistory = false, enableControl = false }) {
  const args = [mcpServerPath || '<open-watch-cinema>/mcp/server.mjs'];
  if (enableHistory) args.push('--with-history');
  if (enableControl) args.push('--with-control');
  return args;
}

export function buildClientConfig({
  client = 'codex',
  mcpServerPath = '<open-watch-cinema>/mcp/server.mjs',
  enableHistory = false,
  enableControl = false,
  port = 4182,
  platform = 'darwin'
} = {}) {
  const args = buildMcpArgs({ mcpServerPath, enableHistory, enableControl });
  const customUrl = Number.isInteger(port) && !DEFAULT_LOOPBACK_PORTS.has(port)
    ? `http://127.0.0.1:${port}` : null;
  const serverEntry = {
    command: 'node',
    args,
    ...(customUrl ? { env: { OPEN_WATCH_CINEMA_URL: customUrl } } : {})
  };
  const mcpServersJson = JSON.stringify({ mcpServers: { 'open-watch-cinema': serverEntry } }, null, 2);

  if (client === 'codex') {
    const lines = [
      '[mcp_servers.open-watch-cinema]',
      'command = "node"',
      `args = [${args.map(tomlString).join(', ')}]`
    ];
    if (customUrl) {
      lines.push('', '[mcp_servers.open-watch-cinema.env]', `OPEN_WATCH_CINEMA_URL = ${tomlString(customUrl)}`);
    }
    return {
      hint: '把下方片段加入 ~/.codex/config.toml（也可以直接贴给 Codex，请它帮你写进这个文件）。改完后重启 Codex 或新开一个会话生效，再发送下方 Prompt 即可开始看片。',
      content: lines.join('\n')
    };
  }
  if (client === 'claude-code') {
    const envPart = customUrl ? ` -e OPEN_WATCH_CINEMA_URL=${shellQuote(customUrl, platform)}` : '';
    const cmd = `claude mcp add open-watch-cinema${envPart} -- node ${args.map((a) => shellQuote(a, platform)).join(' ')}`;
    return {
      hint: '在终端运行下方命令即可注册（也可以让 Claude Code 帮你执行）。完成后新开会话生效，再发送下方 Prompt 开始看片。',
      content: cmd
    };
  }
  if (client === 'claude-desktop') {
    return {
      hint: '打开 Claude Desktop 的设置 → Developer → Edit Config，把下方内容合并进 claude_desktop_config.json 的 mcpServers 中，保存后完全重启 Claude Desktop 生效。',
      content: mcpServersJson
    };
  }
  if (client === 'antigravity') {
    return {
      hint: '把下方内容合并进 Antigravity 的 MCP 配置文件（mcp_config.json）的 mcpServers 中（也可以直接贴给 Antigravity 请它帮你写入），保存后刷新 MCP 列表生效。',
      content: mcpServersJson
    };
  }
  return {
    hint: '适用于其他支持本地 stdio MCP 的客户端：命令填 node，参数按下方 args 填写（也可以把这段配置发给客户端让它协助接入）。保存并重连后生效。',
    content: mcpServersJson
  };
}

export function buildViewingPrompt({
  intervalSeconds = 2,
  enableHistory = false,
  enableControl = false
} = {}) {
  const sec = Number.isFinite(Number(intervalSeconds)) && Number(intervalSeconds) > 0
    ? String(Number(intervalSeconds)) : '2';
  const toolLines = [
    `- 调用 open_watch_cinema_tick({}) 获取电影进度、分镜画面、对白、环境声音和房间消息，建议每 ${sec} 秒调用一次，不要长时间不调用（隔太久会一次性积压大量画面与对白，加重上下文负担或影响跟片节奏）。看到“待续”时继续调用；看到“正在准备”时保持正常间隔。`,
    '- 调用 cinema_post_message({ content }) 在房间内发言；如需发送房间互动，可附带 interaction（"popcorn"、"cola" 或 "cheers"）。',
    '- 调用 cinema_inspect_frame({ atMs }) 按毫秒时间重看已收到的分镜画面。',
    '- 调用 cinema_notebook 读写当前影片的共享手记（支持 read、write、candidates 等操作）。'
  ];
  if (enableHistory) {
    toolLines.push('- 调用 cinema_read_window({ fromMs, toMs }) 回查当前房间已播放范围内的历史对白与声音描述。');
  }
  if (enableControl) {
    toolLines.push('- 调用 cinema_manage 管理片库、准备观影包或按观众要求开关房间；调用 cinema_control 发起跳转建议（当前仍需观众手动拖动进度条）。');
  }
  return [
    '你已通过 MCP 连接到本地的 Open Watch Cinema 影院，身份会自动沿用影院设置中选中的 AI 档案。',
    '',
    '可用工具与用法：',
    ...toolLines,
    '',
    '基本规则：',
    '- 只基于已经收到的画面、对白、声音和房间消息进行交流，不提前剧透未播放的内容。',
    '- 观影期间的沟通与提醒都尽量通过 cinema_post_message 发到影院聊天室；若因故落后较多，可直接在影院里请观众暂停影片，等对齐进度后再继续。',
    '- 若中途影院检查间隔发生变化，tick 结果会自动附带更新提示。',
    '- 观众提出结束观影，或本轮对话需要告一段落时，自然收尾即可。'
  ].join('\n');
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const probe = document.createElement('textarea');
  probe.value = text;
  probe.setAttribute('readonly', '');
  probe.style.position = 'fixed';
  probe.style.opacity = '0';
  document.body.append(probe);
  probe.select();
  const ok = document.execCommand('copy');
  probe.remove();
  if (!ok) throw new Error('copy_failed');
}

export function createAiConnectSettings({ fetchJson, getIntervalSeconds, onOpenGuide, onOpenBridge }) {
  const enableHistoryInput = document.querySelector('#connectEnableHistory');
  const enableControlInput = document.querySelector('#connectEnableControl');
  const modeButtons = [...document.querySelectorAll('[data-connect-mode]')];
  const clientButtons = [...document.querySelectorAll('[data-connect-client]')];
  const configHint = document.querySelector('#connectConfigHint');
  const configOutput = document.querySelector('#connectConfigOutput');
  const copyConfigButton = document.querySelector('#connectCopyConfig');
  const copyConfigStatus = document.querySelector('#connectCopyConfigStatus');
  const promptInput = document.querySelector('#connectPromptInput');
  const copyPromptButton = document.querySelector('#connectCopyPrompt');
  const resetPromptButton = document.querySelector('#connectResetPrompt');
  const copyPromptStatus = document.querySelector('#connectCopyPromptStatus');
  const connectionStatus = document.querySelector('#connectInfoStatus');
  const openGuideLink = document.querySelector('#connectOpenGuide');

  let activeClient = 'codex';
  let connectionInfo = null;
  let promptCustomized = false;

  function currentOptions() {
    return {
      client: activeClient,
      mcpServerPath: connectionInfo?.mcpServerPath || '<open-watch-cinema>/mcp/server.mjs',
      platform: connectionInfo?.platform || 'darwin',
      port: connectionInfo?.port ?? 4182,
      enableHistory: Boolean(enableHistoryInput?.checked),
      enableControl: Boolean(enableControlInput?.checked),
      intervalSeconds: getIntervalSeconds?.() ?? 2
    };
  }

  function render() {
    const opts = currentOptions();
    const { hint, content } = buildClientConfig(opts);
    if (configHint) configHint.textContent = hint;
    if (configOutput) configOutput.value = content;
    for (const button of clientButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.connectClient === activeClient));
    }
    if (promptInput && !promptCustomized) {
      promptInput.value = buildViewingPrompt(opts);
    }
    if (resetPromptButton) resetPromptButton.hidden = !promptCustomized;
  }

  async function refresh() {
    render();
    if (connectionStatus) connectionStatus.textContent = '正在读取本机 MCP 路径…';
    try {
      connectionInfo = await fetchJson('/api/mcp-connection-info');
      if (connectionStatus) connectionStatus.textContent = '';
    } catch {
      connectionInfo = null;
      if (connectionStatus) {
        connectionStatus.textContent = '未能自动读取本机路径（请在本机浏览器打开影院，或手动替换 <open-watch-cinema> 为项目目录）。';
      }
    }
    render();
  }

  function syncInterval() {
    render();
  }

  function showFeedback(node, text) {
    if (!node) return;
    node.textContent = text;
    clearTimeout(node._owcTimer);
    node._owcTimer = setTimeout(() => { node.textContent = ''; }, 2400);
  }

  enableHistoryInput?.addEventListener('change', render);
  enableControlInput?.addEventListener('change', render);
  for (const button of clientButtons) {
    button.addEventListener('click', () => {
      activeClient = button.dataset.connectClient;
      render();
    });
  }
  promptInput?.addEventListener('input', () => {
    promptCustomized = true;
    if (resetPromptButton) resetPromptButton.hidden = false;
  });
  for (const button of modeButtons) {
    button.addEventListener('click', () => {
      for (const mode of modeButtons) {
        const selected = mode === button;
        mode.setAttribute('aria-pressed', String(selected));
        document.getElementById(mode.getAttribute('aria-controls')).hidden = !selected;
      }
      if (button.dataset.connectMode === 'bridge') onOpenBridge?.();
    });
  }
  resetPromptButton?.addEventListener('click', () => {
    promptCustomized = false;
    render();
    showFeedback(copyPromptStatus, '已恢复默认模板。');
  });
  copyConfigButton?.addEventListener('click', async () => {
    try {
      await copyText(configOutput?.value || '');
      showFeedback(copyConfigStatus, '配置已复制。');
    } catch {
      showFeedback(copyConfigStatus, '复制失败，请手动选中复制。');
    }
  });
  copyPromptButton?.addEventListener('click', async () => {
    try {
      await copyText(promptInput?.value || '');
      showFeedback(copyPromptStatus, '观影 Prompt 已复制。');
    } catch {
      showFeedback(copyPromptStatus, '复制失败，请手动选中复制。');
    }
  });
  openGuideLink?.addEventListener('click', (event) => {
    event.preventDefault();
    onOpenGuide?.();
  });

  render();
  return { refresh, syncInterval };
}

export function createMcpResumePromptSettings({ fetchJson }) {
  const endpoint = '/api/mcp-resume-prompt';
  const form = document.querySelector('#mcpResumePromptForm');
  const input = document.querySelector('#mcpResumePromptTemplate');
  const save = document.querySelector('#mcpResumePromptSave');
  const restore = document.querySelector('#mcpResumePromptRestore');
  const retry = document.querySelector('#mcpResumePromptRetry');
  const feedback = document.querySelector('#mcpResumePromptFeedback');
  let settings;
  let pending = false;
  let dirty = false;

  function status(message, error = false) {
    feedback.textContent = message;
    feedback.classList.toggle('error', error);
  }

  function setPending(value) {
    pending = value;
    input.disabled = save.disabled = restore.disabled = pending || !settings;
  }

  async function refresh() {
    if (pending) return;
    setPending(true);
    retry.hidden = true;
    try {
      settings = await fetchJson(endpoint);
      if (!dirty) {
        input.value = settings.template;
        status('');
      }
    } catch {
      retry.hidden = false;
      status('暂时无法读取续看提示词，请重试。', true);
    } finally {
      setPending(false);
    }
  }

  input.addEventListener('input', () => {
    dirty = true;
    status('');
  });
  restore.addEventListener('click', () => {
    input.value = settings.defaultTemplate;
    dirty = true;
    status('已载入出厂模板，保存后生效。');
  });
  retry.addEventListener('click', refresh);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending || !settings) return;
    const template = input.value;
    setPending(true);
    status('正在保存…');
    try {
      settings = await fetchJson(endpoint, { method: 'POST', body: JSON.stringify({ template }) });
      input.value = settings.template;
      dirty = false;
      retry.hidden = true;
      status('已保存为本机默认。');
    } catch (error) {
      status(error.message, true);
    } finally {
      setPending(false);
    }
  });
  return { refresh };
}

export function createMcpResumeDialog() {
  const dialog = document.querySelector('#mcpResumeDialog');
  const input = document.querySelector('#mcpResumeText');
  const copy = document.querySelector('#mcpResumeCopy');
  const feedback = document.querySelector('#mcpResumeCopyStatus');
  let displayedRoomId;

  copy.addEventListener('click', async () => {
    const roomId = displayedRoomId;
    let message;
    try {
      await copyText(input.value);
      message = '提示词已复制。';
    } catch {
      message = '复制失败，请手动选中复制。';
    }
    if (dialog.open && displayedRoomId === roomId) feedback.textContent = message;
  });

  return {
    show({ roomId, template, title, time, intervalSeconds }) {
      const values = { 片名: title, 续看时间: time, 检查间隔秒数: String(intervalSeconds) };
      displayedRoomId = roomId;
      input.value = template.replace(/{{(片名|续看时间|检查间隔秒数)}}/g, (_, name) => values[name]);
      feedback.textContent = '';
      dialog.showModal();
    },
    close() {
      if (dialog.open) dialog.close();
    }
  };
}

const BRIDGE_SETTINGS_ENDPOINT = '/api/watch-bridge/settings';
const CHAT_SCREENING_ENDPOINT = '/api/watch-bridge/chat';

export async function readEnabledViewingMode(fetchJson) {
  try {
    const selection = await fetchJson(BRIDGE_SETTINGS_ENDPOINT);
    const mode = selection.mode === 'chat' ? 'chat' : 'codex';
    const { settings } = await fetchJson('/api/watch-bridge/' + mode);
    return settings.enabled ? mode : null;
  } catch (error) {
    if (error.status === 403) return null;
    throw error;
  }
}

export function createChatScreeningSettings({ fetchJson, onAvailability, onSaving }) {
  const byId = id => document.getElementById(id);
  const form = byId('chatScreeningForm');
  const fields = byId('chatScreeningFields');
  const toolForm = byId('chatToolSettingsForm');
  const toolFields = byId('chatToolSettingsFields');
  const toolSave = byId('chatToolSettingsSave');
  const enabled = byId('chatScreeningEnabled');
  const lookaheadMode = byId('chatLookaheadMode');
  const lookaheadSeconds = byId('chatLookaheadSeconds');
  const customLookaheadField = byId('chatLookaheadCustomField');
  const instructions = byId('chatScreeningInstructions');
  const manual = byId('chatEnableManual');
  const history = byId('chatEnableHistory');
  const control = byId('chatEnableControl');
  const connection = byId('chatScreeningConnection');
  const feedback = byId('chatScreeningStatus');
  const toolFeedback = byId('chatToolSettingsStatus');
  let current;
  let instructionsDirty = false;
  let lookaheadDirty = false;
  let saving = false;
  let refreshAfterSave = false;
  let serial = 0;
  let enabledDirty = false;
  let manualDirty = false;
  let historyDirty = false;
  let controlDirty = false;

  function status(message, error = false, target = feedback) {
    target.textContent = message;
    target.classList.toggle('error', error);
  }

  function setFormAvailability(available) {
    fields.disabled = toolFields.disabled = toolSave.disabled = saving || !available;
  }

  function showCustomLookaheadField() {
    const custom = lookaheadMode.value === 'custom';
    customLookaheadField.hidden = !custom;
    lookaheadSeconds.disabled = !custom;
  }

  function apply(next) {
    const wasAvailable = current?.available;
    current = next;
    onAvailability(next.available);
    setFormAvailability(next.available);
    if (!enabledDirty) enabled.checked = next.settings.enabled;
    if (!lookaheadDirty) {
      const seconds = next.settings.lookaheadSeconds ?? 0;
      lookaheadMode.value = seconds > 0 ? 'custom' : 'off';
      lookaheadSeconds.value = seconds > 0 ? String(seconds) : '';
    }
    showCustomLookaheadField();
    if (!instructionsDirty) instructions.value = next.settings.instructions ?? next.defaults.instructions;
    if (!manualDirty) manual.checked = next.settings.enableManual === true;
    if (!historyDirty) history.checked = next.settings.enableHistory === true;
    if (!controlDirty) control.checked = next.settings.enableControl === true;
    connection.textContent = next.error || CHAT_SCREENING_STATUS[next.status] || '';
    connection.classList.toggle('error', Boolean(next.error) || next.status === 'unconfirmed');
    if (!next.available) {
      status('请先安装 ChatGPT Listener。', true);
      status('请先安装 ChatGPT Listener。', true, toolFeedback);
    } else if (!wasAvailable) {
      status('');
      status('', false, toolFeedback);
    }
  }

  async function refresh() {
    if (saving) {
      refreshAfterSave = true;
      return;
    }
    const request = ++serial;
    try {
      const next = await fetchJson(CHAT_SCREENING_ENDPOINT);
      if (serial === request) apply(next);
    } catch {
      if (serial !== request) return;
      current = null;
      onAvailability(false);
      setFormAvailability(false);
      status('暂时无法读取 ChatGPT 设置。', true);
      status('暂时无法读取 ChatGPT 设置。', true, toolFeedback);
    }
  }

  form.addEventListener('input', event => {
    if (event.target === enabled) enabledDirty = true;
    if (event.target === lookaheadMode || event.target === lookaheadSeconds) {
      lookaheadDirty = true;
      showCustomLookaheadField();
    }
    if (event.target === instructions) instructionsDirty = true;
    status('');
  });
  toolForm.addEventListener('input', event => {
    if (event.target === manual) manualDirty = true;
    if (event.target === history) historyDirty = true;
    if (event.target === control) controlDirty = true;
    status('', false, toolFeedback);
  });
  byId('chatScreeningRestore').addEventListener('click', () => {
    instructions.value = current.defaults.instructions;
    instructionsDirty = true;
    status('已载入出厂提示词，保存后生效。');
  });
  async function save(body, target, clearDraft) {
    if (saving || !current?.available || !Object.keys(body).length) return;
    serial += 1;
    saving = true;
    setFormAvailability(current.available);
    onSaving(true);
    status('正在保存…', false, target);
    try {
      const next = await fetchJson(CHAT_SCREENING_ENDPOINT, { method: 'POST', body: JSON.stringify(body) });
      clearDraft();
      apply(next);
      if (next.available) status(target === toolFeedback ? '已保存，请在 ChatGPT 刷新插件。' : 'ChatGPT 设置已保存。', false, target);
    } catch (error) {
      status(error.message, true, target);
    } finally {
      saving = false;
      setFormAvailability(current?.available);
      onSaving(false);
      if (refreshAfterSave) {
        refreshAfterSave = false;
        void refresh();
      }
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!current?.available) return;
    void save({
      ...(enabledDirty && { enabled: enabled.checked }),
      ...(lookaheadDirty && { lookaheadSeconds: lookaheadMode.value === 'custom' ? lookaheadSeconds.valueAsNumber : 0 }),
      ...(instructionsDirty && {
        instructions: instructions.value === current.defaults.instructions ? null : instructions.value
      })
    }, feedback, () => { lookaheadDirty = instructionsDirty = enabledDirty = false; });
  });
  toolForm.addEventListener('submit', event => {
    event.preventDefault();
    void save({
      ...(manualDirty && { enableManual: manual.checked }),
      ...(historyDirty && { enableHistory: history.checked }),
      ...(controlDirty && { enableControl: control.checked })
    }, toolFeedback, () => { manualDirty = historyDirty = controlDirty = false; });
  });
  return {
    refresh,
    clearEnabledDraft() {
      enabledDirty = false;
      enabled.checked = false;
    }
  };
}

export function createWatchBridgeSettings({ fetchJson, onModeChange }) {
  const form = document.querySelector('#watchBridgeSettingsForm');
  const input = document.querySelector('#watchBridgeInterval');
  const save = document.querySelector('#watchBridgeSave');
  const reload = document.querySelector('#watchBridgeReload');
  const feedback = document.querySelector('#watchBridgeFeedback');
  const mode = document.querySelector('#watchBridgeMode');
  const chatOption = document.querySelector('#watchBridgeChatOption');
  const modeFeedback = document.querySelector('#watchBridgeModeFeedback');
  let settings = null;
  let dirty = false;
  let saving = false;
  let chatAvailable = false;
  let adapterSaving = false;
  let refreshAfterSave = false;
  let readSerial = 0;

  function status(node, message, error = false) {
    node.textContent = message;
    node.classList.toggle('error', error);
  }

  function renderControls() {
    const selected = settings?.mode === 'chat' ? 'chat' : 'codex';
    mode.value = selected;
    chatOption.hidden = !chatAvailable && selected !== 'chat';
    chatOption.disabled = !chatAvailable;
    mode.disabled = saving || adapterSaving || !settings?.mode;
    input.disabled = save.disabled = saving || !settings;
    onModeChange(selected, saving);
  }

  function apply(next) {
    settings = next;
    if (!dirty) input.value = String(next.intervalSeconds);
    renderControls();
    reload.hidden = true;
  }

  async function refresh() {
    if (saving) {
      refreshAfterSave = true;
      return;
    }
    const serial = ++readSerial;
    try {
      const next = await fetchJson(BRIDGE_SETTINGS_ENDPOINT);
      if (serial === readSerial) {
        apply(next);
        if (feedback.classList.contains('error') && !dirty) status(feedback, '');
      }
    } catch {
      if (serial !== readSerial) return;
      reload.hidden = false;
      status(feedback, '暂时无法读取自动观影设置，请重试。', true);
    }
  }

  async function persist(patch, target) {
    if (saving || !settings || (patch.mode && adapterSaving)) return;
    saving = true;
    readSerial += 1;
    renderControls();
    status(target, '正在保存…');
    try {
      const next = await fetchJson(BRIDGE_SETTINGS_ENDPOINT, { method: 'POST', body: JSON.stringify(patch) });
      if (patch.intervalSeconds !== undefined) dirty = false;
      apply(next);
      status(target, '已保存。');
    } catch (error) {
      status(target, error.message, true);
    } finally {
      saving = false;
      renderControls();
      if (refreshAfterSave) {
        refreshAfterSave = false;
        void refresh();
      }
    }
  }

  mode.addEventListener('change', () => void persist({ mode: mode.value }, modeFeedback));
  input.addEventListener('input', () => {
    dirty = true;
    status(feedback, '');
  });
  reload.addEventListener('click', refresh);
  form.addEventListener('submit', event => {
    event.preventDefault();
    void persist({ intervalSeconds: input.valueAsNumber }, feedback);
  });

  return {
    refresh,
    setChatAvailable(available) {
      chatAvailable = available;
      renderControls();
    },
    setAdapterSaving(value) {
      adapterSaving = value;
      renderControls();
    },
    intervalMs: () => settings?.intervalMs ?? 6000
  };
}
