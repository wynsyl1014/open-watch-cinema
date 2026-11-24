import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { openCodexClient, openCodexDesktopOnce, prepareCodexWorkspace } from '../../watch-bridge/adapters/codex/client.mjs';
import { cancelCodexLogin, checkCodexAccount, startCodexLogin } from '../../watch-bridge/adapters/codex/setup.mjs';

test('isolated workspace stores the selected instructions separately from inherited Codex', async t => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'owc-codex-workspace-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const isolated = { mode: 'isolated', dataRoot };
  const { cwd, codexHome } = await prepareCodexWorkspace({ ...isolated, agents: 'Watch the film.' });
  const inherited = await prepareCodexWorkspace({ mode: 'inherited', dataRoot });
  assert.equal(basename(cwd), 'cinema');
  assert.equal(basename(inherited.cwd), 'cinema');
  const defaultInstructions = await readFile(join(inherited.cwd, 'AGENTS.md'), 'utf8');
  assert.match(defaultInstructions, /正在与 观众 共享一场电影/);
  assert.doesNotMatch(defaultInstructions, /\{\{viewerName\}\}/);
  assert.equal(await readFile(join(cwd, 'AGENTS.md'), 'utf8'), 'Watch the film.');
  await prepareCodexWorkspace(isolated);
  assert.equal(await readFile(join(cwd, 'AGENTS.md'), 'utf8'), 'Watch the film.');
  await prepareCodexWorkspace({ ...isolated, agents: '' });
  assert.equal(await readFile(join(cwd, 'AGENTS.md'), 'utf8'), '');
  const { cwd: legacyCwd } = await prepareCodexWorkspace({ ...isolated, agents: '和放映员一起看。' }, { legacy: true });
  assert.equal(basename(legacyCwd), 'workspace');
  assert.equal(await readFile(join(legacyCwd, 'AGENTS.md'), 'utf8'), '和放映员一起看。');
  assert.equal(await readFile(join(cwd, 'AGENTS.md'), 'utf8'), '');
  assert.notEqual(cwd, inherited.cwd);
  assert.notEqual(codexHome, cwd);
  assert.equal(inherited.codexHome, undefined);
});

test('desktop auto-open claims the workspace once across concurrent launches and restarts', async t => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'owc-codex-desktop-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const { cwd } = await prepareCodexWorkspace({ mode: 'inherited', dataRoot });
  const launched = [];
  const launch = async workspace => { launched.push(workspace); };
  await openCodexDesktopOnce(cwd, { installed: async () => false, launch });
  assert.deepEqual(launched, []);
  await assert.rejects(openCodexDesktopOnce(cwd, { installed: async () => true,
    launch: async () => { throw new Error('Desktop command failed.'); }
  }), /Desktop command failed/);
  const options = { installed: async () => true, launch };
  await Promise.all([openCodexDesktopOnce(cwd, options), openCodexDesktopOnce(cwd, options)]);
  await openCodexDesktopOnce(cwd, { ...options, installed: async () => assert.fail('Already opened.') });
  assert.deepEqual(launched, [cwd]);
});

const fakeCodex = String.raw`const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex-cli 0.0.0-test');
} else if (args[1] === 'generate-ts') {
  const output = args.at(-1);
  mkdirSync(join(output, 'v2'));
  writeFileSync(join(output, 'v2', 'TurnStartParams.ts'), 'toolOutput?: TurnToolOutput | null');
} else {
  const input = createInterface({ input: process.stdin });
  const send = message => console.log(JSON.stringify(message));
  input.on('line', line => {
    const { id, method, params, result } = JSON.parse(line);
    const answer = result => send({ id, result });
    switch (method) {
      case 'initialize':
        return answer({ codexHome: process.env.CODEX_HOME });
      case 'account/read':
        return answer({ account: { type: 'chatgpt', email: 'viewer@example.test', planType: 'plus', accessToken: 'not-for-settings' } });
      case 'thread/read':
        return answer({ thread: { cwd: params.threadId === 'legacy'
          ? join(process.cwd(), '..', 'workspace') : process.cwd() } });
      case 'account/login/start':
        return answer({ type: 'chatgpt', loginId: 'private', authUrl: process.env.OWC_CODEX_TEST_LOGIN_URL });
      case 'account/login/cancel':
        return answer({ status: 'canceled' });
      case 'model/list':
        if (!params.cursor) {
          return answer({ nextCursor: 'next', data: [
            { id: 'entry-1', model: 'text-only', inputModalities: ['text'] },
            { id: 'entry-2', model: 'compat-vision', displayName: 'Legacy catalog' },
            { id: 'entry-3', model: 'hidden-vision', hidden: true }
          ] });
        }
        return answer({ nextCursor: null, data: [
          { id: 'entry-4', model: 'vision', displayName: 'Vision', isDefault: true, inputModalities: ['text', 'image'] }
        ] });
      case 'test/ping':
        send({ method: 'test/notification', params: { value: 1 } });
        send({ id: 'request', method: 'test/request', params: { value: 2 } });
        return answer({ hasApiKey: !!process.env.OPENAI_API_KEY, codexHome: process.env.CODEX_HOME, args });
      default:
        if (id === 'request') send({ method: 'test/response', params: result });
    }
  });
}
`;

test('Codex stdio works with toolOutput detection, account and model browsing, and managed sign-in', { skip: process.platform === 'win32' }, async t => {
  const sandbox = await mkdtemp(join(tmpdir(), 'owc-codex-client-'));
  const bin = join(sandbox, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'codex'), '#!' + process.execPath + '\n' + fakeCodex, { mode: 0o700 });
  const previousPath = process.env.PATH;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.PATH = bin + delimiter + previousPath;
  process.env.OPENAI_API_KEY = 'must-not-be-passed';
  t.after(async () => {
    process.env.PATH = previousPath;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    await rm(sandbox, { recursive: true, force: true });
  });
  const config = { mode: 'isolated', dataRoot: sandbox };
  const account = await checkCodexAccount({ ...config, includeModels: true });
  assert.equal(account.compatible, true);
  assert.equal(account.authenticated, true);
  assert.equal(account.planType, 'plus');
  assert.equal(account.accountLabel, 'viewer@example.test');
  assert.equal(account.configPath, join(sandbox, 'watch-bridge', 'codex', 'isolated', 'home', 'config.toml'));
  assert.equal(JSON.stringify(account).includes('not-for-settings'), false);
  assert.deepEqual(account.models, [
    { id: 'compat-vision', name: 'Legacy catalog', isDefault: false },
    { id: 'vision', name: 'Vision', isDefault: true }
  ]);
  for (const authUrl of ['https://auth.openai.com/oauth/authorize', 'https://chatgpt.com/auth/codex']) {
    process.env.OWC_CODEX_TEST_LOGIN_URL = authUrl;
    assert.deepEqual(await startCodexLogin(config), { authUrl });
    try {
      assert.equal((await checkCodexAccount(config)).loginPending, true);
    } finally {
      await cancelCodexLogin(config);
      delete process.env.OWC_CODEX_TEST_LOGIN_URL;
    }
  }
  process.env.OWC_CODEX_TEST_LOGIN_URL = 'https://auth.openai.com.example.test/authorize';
  try {
    await assert.rejects(startCodexLogin(config), /Could not start the local Codex ChatGPT sign-in/);
  } finally {
    delete process.env.OWC_CODEX_TEST_LOGIN_URL;
  }
  assert.equal((await checkCodexAccount(config)).loginPending, false);

  const notifications = [];
  const response = Promise.withResolvers();
  const client = await openCodexClient({
    config,
    onNotification(method, params) {
      notifications.push([method, params]);
      if (method === 'test/response') response.resolve();
    },
    onRequest(method, params) {
      assert.equal(method, 'test/request');
      return { value: params.value + 1 };
    }
  });
  try {
    assert.equal(client.capabilities.toolOutput, true);
    assert.equal(await client.workspaceForThread('legacy'), client.cwd);
    const legacyWorkspace = join(dirname(client.cwd), 'workspace');
    await mkdir(legacyWorkspace);
    await writeFile(join(legacyWorkspace, 'AGENTS.md'), 'Legacy instructions.');
    assert.equal(await client.workspaceForThread('legacy'), legacyWorkspace);
    assert.equal(await readFile(join(legacyWorkspace, 'AGENTS.md'), 'utf8'), 'Legacy instructions.');
    assert.equal(await client.workspaceForThread('new'), client.cwd);
    assert.deepEqual(await client.request('test/ping', {}), {
      hasApiKey: false,
      codexHome: join(sandbox, 'watch-bridge', 'codex', 'isolated', 'home'),
      args: account.launchArgs
    });
    await Promise.race([response.promise, new Promise((_, reject) => {
      AbortSignal.timeout(5_000).addEventListener('abort', () => reject(new Error('No Codex server request response.')));
    })]);
    assert.deepEqual(notifications, [['test/notification', { value: 1 }], ['test/response', { value: 3 }]]);
  } finally {
    await client.close();
  }
});
