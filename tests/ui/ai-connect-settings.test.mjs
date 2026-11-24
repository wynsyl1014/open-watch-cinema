import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClientConfig, buildViewingPrompt, createChatScreeningSettings, createWatchBridgeSettings, readEnabledViewingMode } from '../../public/ai-connect-settings.js';

test('buildClientConfig generates valid configs for each preset and independent flags', () => {
  const path = '/Users/demo/open-watch-cinema/mcp/server.mjs';

  const codexDefault = buildClientConfig({ client: 'codex', mcpServerPath: path });
  assert.match(codexDefault.content, /\[mcp_servers\.open-watch-cinema\]/);
  assert.match(codexDefault.content, /args = \["\/Users\/demo\/open-watch-cinema\/mcp\/server\.mjs"\]/);
  assert.doesNotMatch(codexDefault.content, /--with-history|--with-control|OPEN_WATCH_CINEMA_URL/);

  const claudeDesktop = buildClientConfig({
    client: 'claude-desktop', mcpServerPath: path, enableHistory: true, enableControl: false, port: 4999
  });
  const parsedDesktop = JSON.parse(claudeDesktop.content);
  assert.deepEqual(parsedDesktop.mcpServers['open-watch-cinema'], {
    command: 'node',
    args: [path, '--with-history'],
    env: { OPEN_WATCH_CINEMA_URL: 'http://127.0.0.1:4999' }
  });

  const claudeCode = buildClientConfig({
    client: 'claude-code', mcpServerPath: '/Users/my folder/mcp/server.mjs', enableControl: true, platform: 'darwin'
  });
  assert.match(claudeCode.content, /^claude mcp add open-watch-cinema -- node '\/Users\/my folder\/mcp\/server\.mjs' --with-control$/);

  const antigravity = buildClientConfig({
    client: 'antigravity', mcpServerPath: path, enableHistory: true, enableControl: true
  });
  const parsedAntigravity = JSON.parse(antigravity.content);
  assert.deepEqual(parsedAntigravity.mcpServers['open-watch-cinema'].args, [path, '--with-history', '--with-control']);
});

test('buildViewingPrompt reflects interval and enabled optional tools neutrally', () => {
  const base = buildViewingPrompt({ intervalSeconds: 3.5, enableHistory: false, enableControl: false });
  assert.match(base, /建议每 3\.5 秒调用一次/);
  assert.match(base, /open_watch_cinema_tick/);
  assert.match(base, /cinema_post_message/);
  assert.match(base, /cinema_inspect_frame/);
  assert.match(base, /cinema_notebook/);
  assert.doesNotMatch(base, /cinema_read_window|cinema_manage|cinema_control|cinema_settings/);

  const full = buildViewingPrompt({ intervalSeconds: 2, enableHistory: true, enableControl: true });
  assert.match(full, /cinema_read_window/);
  assert.match(full, /cinema_manage/);
  assert.match(full, /cinema_control/);
});

class TestControl extends EventTarget {
  classList = {
    classes: new Set(),
    contains(name) { return this.classes.has(name); },
    toggle(name, present) {
      if (present) this.classes.add(name);
      else this.classes.delete(name);
    }
  };

  fire(type, target) {
    const event = new Event(type, { cancelable: true });
    if (target) Object.defineProperty(event, 'target', { value: target });
    this.dispatchEvent(event);
  }
}

function mockControls(t) {
  const controls = new Map();
  const byId = id => {
    if (!controls.has(id)) controls.set(id, new TestControl());
    return controls.get(id);
  };
  const originalDocument = globalThis.document;
  globalThis.document = { getElementById: byId, querySelector: selector => byId(selector.slice(1)) };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  return byId;
}

test('the automatic viewing selector persists mode without resaving cadence or enabling the new adapter', async t => {
  const byId = mockControls(t);
  const calls = [];
  const selections = [];
  let saved = { mode: 'codex', intervalSeconds: 6, intervalMs: 6000 };
  const bridge = createWatchBridgeSettings({
    fetchJson: async (url, options) => {
      if (options) {
        const patch = JSON.parse(options.body);
        calls.push({ url, patch });
        saved = { ...saved, ...patch };
      }
      return saved;
    },
    onModeChange: mode => selections.push(mode)
  });
  await bridge.refresh();
  const selector = byId('watchBridgeMode');
  const interval = byId('watchBridgeInterval');
  const option = byId('watchBridgeChatOption');
  assert.equal(selector.value, 'codex');
  assert.equal(option.hidden, true);
  bridge.setChatAvailable(true);
  assert.equal(option.hidden, false);

  interval.value = '11';
  interval.fire('input');
  selector.value = 'chat';
  selector.fire('change');
  await new Promise(setImmediate);
  assert.deepEqual(calls, [{ url: '/api/watch-bridge/settings', patch: { mode: 'chat' } }]);
  assert.equal(selections.at(-1), 'chat');
  assert.equal(selector.value, 'chat');
  assert.equal(interval.value, '11');
  assert.equal(bridge.intervalMs(), 6000);

  selector.value = 'codex';
  selector.fire('change');
  await new Promise(setImmediate);
  assert.deepEqual(calls.at(-1).patch, { mode: 'codex' });

  saved = { ...saved, mode: 'chat' };
  await bridge.refresh();
  assert.equal(selector.value, 'chat');
});

test('opening settings read the saved switch of just the selected adapter', async () => {
  for (const [mode, enabled] of [['chat', true], ['codex', true], ['chat', false], [undefined, true]]) {
    const calls = [];
    const result = await readEnabledViewingMode(async url => {
      calls.push(url);
      return calls.length === 1 ? { mode } : { settings: { enabled } };
    });
    assert.deepEqual(calls, ['/api/watch-bridge/settings', '/api/watch-bridge/' + (mode ?? 'codex')]);
    assert.equal(result, enabled ? mode ?? 'codex' : null);
  }
  assert.equal(await readEnabledViewingMode(async () => {
    throw Object.assign(new Error('Local settings only'), { status: 403 });
  }), null);
});

test('Chat lookahead, prompts and optional tool groups save independently of runtime status', async t => {
  const byId = mockControls(t);
  let saved = {
    available: true,
    intervalSeconds: 6,
    settings: { enabled: false, lookaheadSeconds: 0, instructions: '我的提示词', enableHistory: false, enableControl: false },
    defaults: { instructions: '出厂提示词' },
    status: 'disabled'
  };
  const calls = [];
  const chat = createChatScreeningSettings({
    fetchJson: async (url, options) => {
      if (options) {
        const patch = JSON.parse(options.body);
        calls.push({ url, patch });
        saved = { ...saved, settings: { ...saved.settings, ...patch } };
      }
      return saved;
    },
    onAvailability() {},
    onSaving() {}
  });
  const form = byId('chatScreeningForm');
  const enabled = byId('chatScreeningEnabled');
  const toolForm = byId('chatToolSettingsForm');
  const manual = byId('chatEnableManual');
  const instructions = byId('chatScreeningInstructions');
  const history = byId('chatEnableHistory');
  const control = byId('chatEnableControl');
  const lookaheadMode = byId('chatLookaheadMode');
  const lookaheadSeconds = byId('chatLookaheadSeconds');
  const customField = byId('chatLookaheadCustomField');
  await chat.refresh();
  assert.equal(instructions.value, '我的提示词');
  assert.equal(lookaheadMode.value, 'off');
  assert.equal(lookaheadSeconds.value, '');
  assert.equal(customField.hidden, true);
  assert.equal(lookaheadSeconds.disabled, true);
  assert.equal(manual.checked, false);
  assert.equal(history.checked, false);
  assert.equal(control.checked, false);
  form.fire('submit');
  assert.deepEqual(calls, []);
  history.checked = true;
  toolForm.fire('input', history);
  manual.checked = true;
  toolForm.fire('input', manual);
  enabled.checked = true;
  form.fire('input', enabled);
  byId('chatScreeningRestore').fire('click');
  saved = { ...saved, status: 'waiting_card' };
  await chat.refresh();
  assert.equal(enabled.checked, true);
  assert.equal(instructions.value, '出厂提示词');
  const connection = byId('chatScreeningConnection');
  assert.match(connection.textContent, /等待 ChatGPT 卡片/);
  for (const [status, text] of [
    ['waiting_receipt', /等待 ChatGPT 回执/],
    ['cooldown', /已收到回执，等待下一批交付/],
    ['unconfirmed', /交付未确认/]
  ]) {
    saved = { ...saved, status };
    await chat.refresh();
    assert.match(connection.textContent, text);
    assert.equal(history.checked, true);
    assert.equal(control.checked, false);
  }
  toolForm.fire('submit');
  await new Promise(setImmediate);
  assert.deepEqual(calls, [{
    url: '/api/watch-bridge/chat',
    patch: { enableManual: true, enableHistory: true }
  }]);
  assert.match(byId('chatToolSettingsStatus').textContent, /已保存.*刷新插件/);
  assert.equal(enabled.checked, true);
  assert.equal(instructions.value, '出厂提示词');
  form.fire('submit');
  await new Promise(setImmediate);
  assert.deepEqual(calls.at(-1).patch, { enabled: true, instructions: null });
  assert.match(byId('chatScreeningStatus').textContent, /已保存/);
  saved.settings = { ...saved.settings, enabled: false, instructions: '另一窗口的新提示词' };
  control.checked = true;
  toolForm.fire('input', control);
  toolForm.fire('submit');
  await new Promise(setImmediate);
  assert.deepEqual(calls.at(-1).patch, { enableControl: true });
  await chat.refresh();
  assert.equal(enabled.checked, false);
  assert.equal(instructions.value, '另一窗口的新提示词');
  assert.equal(history.checked, true);
  assert.equal(control.checked, true);
  lookaheadMode.value = 'custom';
  form.fire('input', lookaheadMode);
  assert.equal(customField.hidden, false);
  assert.equal(lookaheadSeconds.disabled, false);
  lookaheadSeconds.value = '20';
  lookaheadSeconds.valueAsNumber = 20;
  form.fire('input', lookaheadSeconds);
  await chat.refresh();
  assert.equal(lookaheadMode.value, 'custom');
  assert.equal(lookaheadSeconds.value, '20');
  form.fire('submit');
  await new Promise(setImmediate);
  assert.deepEqual(calls.at(-1).patch, { lookaheadSeconds: 20 });
  await chat.refresh();
  assert.equal(lookaheadMode.value, 'custom');
  assert.equal(lookaheadSeconds.value, '20');

  lookaheadMode.value = 'off';
  form.fire('input', lookaheadMode);
  assert.equal(customField.hidden, true);
  assert.equal(lookaheadSeconds.disabled, true);
  form.fire('submit');
  await new Promise(setImmediate);
  assert.deepEqual(calls.at(-1).patch, { lookaheadSeconds: 0 });
  await chat.refresh();
  assert.equal(lookaheadMode.value, 'off');
  assert.equal(lookaheadSeconds.value, '');
  assert.equal(instructions.value, '另一窗口的新提示词');
  assert.equal(history.checked, true);
  assert.equal(control.checked, true);
  chat.clearEnabledDraft();
  assert.equal(enabled.checked, false);
});
