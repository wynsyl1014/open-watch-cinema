import { resolve } from 'node:path';
import { codexLaunchDetails, detectCodexInstallation, openCodexClient } from './client.mjs';

const pendingLogins = new Map();
const REQUEST_TIMEOUT_MS = 10_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const LOGIN_ORIGINS = new Set(['https://auth.openai.com', 'https://chatgpt.com']);

function loginKey({ mode, dataRoot }) {
  return resolve(dataRoot, mode);
}

function request(client, method, params) {
  return client.request(method, params, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function readChatgptAccount(client) {
  const { account } = await request(client, 'account/read', { refreshToken: false });
  return account?.type === 'chatgpt' ? account : null;
}

async function readModels(client) {
  const models = new Map();
  const seenCursors = new Set();
  let cursor;
  do {
    const page = await request(client, 'model/list', { limit: 50, cursor, includeHidden: false });
    if (!Array.isArray(page.data)) throw new Error('Codex returned an invalid model catalog.');
    for (const model of page.data) {
      if (model.hidden || (Array.isArray(model.inputModalities) && !model.inputModalities.includes('image'))) continue;
      // thread/start consumes the model slug. The catalog can have a separate entry ID.
      if (typeof model.model !== 'string' || !model.model.trim()) continue;
      models.set(model.model, {
        id: model.model,
        name: typeof model.displayName === 'string' && model.displayName.trim() ? model.displayName : model.model,
        isDefault: model.isDefault === true
      });
    }
    cursor = page.nextCursor;
    if (cursor && seenCursors.has(cursor)) throw new Error('Codex repeated a model catalog page.');
    seenCursors.add(cursor);
  } while (cursor);
  return [...models.values()];
}

export async function checkCodexAccount(config) {
  const { mode, includeModels } = config;
  const installation = await detectCodexInstallation();
  const status = {
    mode, installed: installation.installed, compatible: installation.compatible,
    version: installation.version, executable: installation.executable, authenticated: false,
    loginPending: pendingLogins.has(loginKey(config)), ...codexLaunchDetails(config)
  };
  if (!installation.compatible) return status;

  let client;
  try {
    client = await openCodexClient({ config });
    status.configPath = client.configPath;
    const account = await readChatgptAccount(client);
    status.authenticated = Boolean(account);
    if (account?.planType) status.planType = account.planType;
    if (account?.email || account?.workspaceName) status.accountLabel = account.email || account.workspaceName;
    if (account && includeModels) status.models = await readModels(client);
  } catch {
    status.error = 'Could not read the local Codex account or model catalog.';
  } finally {
    await client?.close();
  }
  return status;
}

export async function listCodexModels(config) {
  const client = await openCodexClient({ config });
  try {
    if (!await readChatgptAccount(client)) throw new Error('Sign in to Codex with ChatGPT first.');
    return { models: await readModels(client) };
  } finally {
    await client.close();
  }
}

export async function startCodexLogin(config) {
  const key = loginKey(config);
  for (const session of pendingLogins.values()) {
    // Codex manages its own local OAuth callback listener across profiles.
    if (session.key === key) return session.started;
    throw new Error('Finish or cancel the current Codex sign-in first.');
  }
  const session = { key, abort: new AbortController() };
  pendingLogins.set(key, session);
  session.started = (async () => {
    try {
      const client = await openCodexClient({
        config,
        onFailure: () => { void finishLogin(session); },
        onNotification(method, params) {
          if (method === 'account/login/completed' && params?.loginId === session.loginId) {
            void finishLogin(session);
          }
        }
      });
      session.client = client;
      session.abort.signal.throwIfAborted();
      const login = await request(client, 'account/login/start', {
        type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'chatgpt'
      });
      session.abort.signal.throwIfAborted();
      session.loginId = login.loginId;
      const authUrl = new URL(login.authUrl);
      if (login.type !== 'chatgpt' || !login.loginId || !LOGIN_ORIGINS.has(authUrl.origin)
        || authUrl.username || authUrl.password) throw new Error('Codex did not return an official ChatGPT sign-in URL.');
      session.timer = setTimeout(() => { void finishLogin(session, true); }, LOGIN_TIMEOUT_MS);
      session.timer.unref();
      return { authUrl: authUrl.href };
    } catch {
      await finishLogin(session);
      await session.client?.close();
      throw new Error('Could not start the local Codex ChatGPT sign-in.');
    }
  })();
  return session.started;
}

async function finishLogin(session, cancel = false) {
  if (session.finishing) return session.finishing;
  session.abort.abort();
  clearTimeout(session.timer);
  session.finishing = (async () => {
    try {
      if (cancel && session.loginId) {
        await request(session.client, 'account/login/cancel', { loginId: session.loginId }).catch(() => {});
      }
      await session.client?.close();
    } finally {
      if (pendingLogins.get(session.key) === session) pendingLogins.delete(session.key);
    }
  })();
  return session.finishing;
}

export async function cancelCodexLogin(config) {
  const session = pendingLogins.get(loginKey(config));
  if (session) await finishLogin(session, true);
}
