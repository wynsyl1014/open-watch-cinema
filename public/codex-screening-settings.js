import { copyText } from './ai-connect-settings.js';

export function createCodexScreeningSettings({ fetchJson, onSaving }) {
  const endpoint = '/api/watch-bridge/codex';
  const byId = id => document.getElementById(id);
  const form = byId('codexScreeningForm');
  const fields = byId('codexScreeningFields');
  const enabled = byId('codexScreeningEnabled');
  const auth = byId('codexScreeningAuth');
  const model = byId('codexScreeningModel');
  const instructions = byId('codexScreeningInstructions');
  const feedback = byId('codexScreeningStatus');
  const accountStatus = byId('codexAccountStatus');
  const login = byId('codexAccountLogin');
  const cancel = byId('codexAccountCancel');
  const loginLink = byId('codexAccountLink');
  const check = byId('codexAccountCheck');
  const installation = byId('codexInstallationStatus');
  const derivedConfig = byId('codexDerivedConfig');
  let current;
  let models = [];
  let accountDetails;
  let dirty = false;
  let enabledDirty = false;
  let refreshAfterSave = false;
  let readSerial = 0;
  let requestPending = false;
  let accountRequest = 0;
  let loginTimer;

  function text(node, message, error = false) {
    node.textContent = message;
    node.classList.toggle('error', error);
  }

  function renderModels(selection) {
    model.replaceChildren(new Option('Codex 默认模型', ''));
    for (const item of models) model.append(new Option(item.name + (item.isDefault ? '（默认）' : ''), item.id));
    if (selection && !models.some(item => item.id === selection)) model.append(new Option(selection, selection));
    model.value = selection ?? '';
  }

  function renderConfiguration() {
    const matching = accountDetails?.authMode === current?.settings.authMode && accountDetails?.executable;
    byId('codexInstallationConfig').hidden = !matching;
    if (!matching) return;
    const { authMode, model: selectedModel } = current.settings;
    const { executable, configPath, launchArgs } = accountDetails;
    derivedConfig.value = JSON.stringify({ executable, launchArgs, configPath, authMode, model: selectedModel }, null, 2);
  }

  function apply(payload) {
    current = payload;
    fields.disabled = !payload.available;
    if (!enabledDirty) enabled.checked = payload.settings.enabled;
    if (!dirty) {
      auth.value = payload.settings.authMode;
      renderModels(payload.settings.model);
      instructions.value = payload.settings.instructions ?? payload.defaults.instructions;
    }
    if (!payload.available) text(feedback, '请将 Watch Bridge 解压到影院目录下的 watch-bridge 文件夹。', true);
    else if (payload.error) text(feedback, payload.error, true);
    else if (feedback.classList.contains('error')) text(feedback, '');
    renderConfiguration();
  }

  async function refresh() {
    if (requestPending) {
      refreshAfterSave = true;
      return;
    }
    const request = ++readSerial;
    try {
      const next = await fetchJson(endpoint);
      if (request === readSerial) apply(next);
    } catch {
      if (request === readSerial) text(feedback, '暂时无法读取 Codex 设置。', true);
    }
  }

  function loginAction(action, mode) {
    return fetchJson(endpoint + '/login?mode=' + mode, { method: 'POST', body: JSON.stringify({ action }) });
  }

  async function readAccount({ includeModels = true, signingIn = false } = {}) {
    clearTimeout(loginTimer);
    const serial = ++accountRequest;
    const mode = auth.value;
    check.disabled = true;
    try {
      const url = endpoint + '/account?mode=' + mode + (includeModels ? '&models=1' : '');
      const account = await fetchJson(url);
      if (serial !== accountRequest) return;
      login.hidden = !account.compatible || account.authenticated || account.loginPending;
      cancel.hidden = !account.loginPending;
      if (!account.loginPending) loginLink.hidden = true;
      installation.textContent = [account.executable, account.version].filter(Boolean).join(' · ');
      accountDetails = { ...account, authMode: mode };
      renderConfiguration();
      const status = !account.installed ? '未找到本机 Codex，请查看安装命令。'
        : !account.compatible ? '本机 Codex 版本需更新。'
        : account.loginPending ? '等待在浏览器完成登录…'
        : account.authenticated ? (account.accountLabel ? '已登录 ' + account.accountLabel : 'ChatGPT 已登录。') : '当前登录方式尚未连接 ChatGPT。';
      text(accountStatus, account.error || status, Boolean(account.error));
      if (account.models) {
        models = account.models;
        renderModels(model.value);
      }
      if (account.loginPending) {
        loginTimer = setTimeout(() => void readAccount({ includeModels: false, signingIn: true }), 2500);
      } else if (signingIn && account.authenticated) {
        await loginAction('reconnect', mode).catch(() => {});
        void readAccount();
      }
    } catch (error) {
      if (serial === accountRequest) text(accountStatus, error.message, true);
    } finally {
      if (serial === accountRequest) check.disabled = false;
    }
  }

  form.addEventListener('input', event => {
    if (event.target === enabled) enabledDirty = true;
    else dirty = true;
    text(feedback, '');
  });
  auth.addEventListener('change', () => {
    models = [];
    renderModels('');
    loginLink.hidden = true;
    void readAccount();
  });
  check.addEventListener('click', () => void readAccount());
  login.addEventListener('click', async () => {
    const mode = auth.value;
    login.disabled = true;
    try {
      const { authUrl } = await loginAction('start', mode);
      if (mode !== auth.value) return;
      const target = new URL(authUrl);
      if (!['https://auth.openai.com', 'https://chatgpt.com'].includes(target.origin) || target.username || target.password) {
        throw new Error('未收到有效的 ChatGPT 登录地址。');
      }
      loginLink.href = target.href;
      loginLink.hidden = false;
      await readAccount({ includeModels: false, signingIn: true });
    } catch (error) { text(accountStatus, error.message, true); }
    finally { login.disabled = false; }
  });
  cancel.addEventListener('click', async () => {
    try {
      await loginAction('cancel', auth.value);
      await readAccount();
    } catch (error) { text(accountStatus, error.message, true); }
  });
  byId('codexScreeningRestore').addEventListener('click', () => {
    instructions.value = current.defaults.instructions;
    dirty = true;
  });
  byId('codexInstallCopy').addEventListener('click', async () => {
    const copyStatus = byId('codexInstallCopyStatus');
    try { await copyText(byId('codexInstallCommand').textContent.trim()); text(copyStatus, '安装命令已复制。'); }
    catch { text(copyStatus, '复制失败，请手动复制安装命令。', true); }
  });
  byId('codexCopyConfig').addEventListener('click', async () => {
    const copyStatus = byId('codexInstallCopyStatus');
    try { await copyText(derivedConfig.value); text(copyStatus, '本机配置已复制。'); }
    catch { text(copyStatus, '复制失败，请手动复制本机配置。', true); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (requestPending || !current?.available) return;
    const body = {
      enabled: enabled.checked, authMode: auth.value, model: model.value || null,
      instructions: instructions.value === current.defaults.instructions ? null : instructions.value
    };
    readSerial += 1;
    requestPending = fields.disabled = true;
    onSaving(true);
    try {
      const next = await fetchJson(endpoint, { method: 'POST', body: JSON.stringify(body) });
      dirty = enabledDirty = false;
      apply(next);
      if (!next.error) text(feedback, 'Codex 设置已保存。');
    } catch (error) { text(feedback, error.message, true); }
    finally {
      requestPending = false;
      fields.disabled = !current?.available;
      onSaving(false);
      if (refreshAfterSave) {
        refreshAfterSave = false;
        void refresh();
      }
    }
  });

  return {
    refresh,
    clearEnabledDraft() {
      enabledDirty = false;
      enabled.checked = false;
    }
  };
}
