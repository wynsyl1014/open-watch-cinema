import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { renderViewingInstructions } from '../../instructions.mjs';
import { DEFAULT_INSTRUCTIONS } from './instructions.mjs';

const exec = promisify(execFile);
const LOGIN_ENV_NAMES = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CHATGPT_ACCESS_TOKEN'];
const installations = new Map();
const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function macDesktopApps() {
  return ['/Applications', join(homedir(), 'Applications')]
    .flatMap(base => ['ChatGPT.app', 'Codex.app'].map(app => join(base, app)));
}

function codexEnv(codexHome) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    const normalized = name.toUpperCase();
    if (LOGIN_ENV_NAMES.includes(normalized)
      || (codexHome && ['CODEX_HOME', 'CODEX_SQLITE_HOME'].includes(normalized))) delete env[name];
  }
  if (codexHome) env.CODEX_HOME = codexHome;
  return env;
}

function candidates() {
  const windows = process.platform === 'win32';
  const executable = windows ? 'codex.exe' : 'codex';
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute);
  const local = windows
    ? [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links')]
    : [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  if (process.platform === 'darwin') {
    for (const app of macDesktopApps()) {
      const resources = join(app, 'Contents', 'Resources');
      local.push(resources, join(resources, 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS'));
    }
  }
  const paths = [...pathDirs, ...local.filter(Boolean)].map(dir => join(dir, executable));
  if (windows) {
    // npm's Windows shim targets a native binary. Resolve the package binary without a shell.
    const npmRoots = [...pathDirs, ...[process.env.APPDATA].filter(Boolean).map(dir => join(dir, 'npm'))];
    const cpu = process.arch === 'arm64' ? 'arm64' : 'x64';
    const target = cpu === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    for (const dir of npmRoots) {
      const pkg = join(dir, 'node_modules', '@openai');
      paths.push(join(pkg, 'codex-win32-' + cpu, 'vendor', target, 'codex', executable));
      paths.push(join(pkg, 'codex', 'node_modules', '@openai', 'codex-win32-' + cpu, 'vendor', target, 'codex', executable));
      paths.push(join(pkg, 'codex', 'vendor', target, 'codex', executable));
    }
  }
  return paths;
}

async function inspectCodex(executable) {
  const options = { cwd: tmpdir(), env: codexEnv(), windowsHide: true, timeout: 10_000 };
  const { stdout } = await exec(executable, ['--version'], options);
  const version = /^codex-cli\s+(\S+)/m.exec(stdout)?.[1];
  if (!version) throw new Error('The executable does not report a Codex CLI version.');
  const output = await mkdtemp(join(tmpdir(), 'owc-codex-schema-'));
  try {
    const schemaOptions = { ...options, env: codexEnv(output) };
    await exec(executable, ['app-server', 'generate-ts', '--experimental', '--out', output], schemaOptions);
    const params = await readFile(join(output, 'v2', 'TurnStartParams.ts'), 'utf8');
    const toolOutput = /\btoolOutput\??\s*:\s*TurnToolOutput\b/.test(params);
    return { executable, version, compatible: toolOutput, capabilities: { toolOutput } };
  } catch {
    return { executable, version, compatible: false, capabilities: { toolOutput: false } };
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

export async function detectCodexInstallation() {
  const visited = new Set();
  let incompatible;
  for (const path of candidates()) {
    let executable;
    let file;
    try {
      executable = await realpath(path);
      const fromProject = relative(PROJECT_ROOT, executable);
      if (!isAbsolute(fromProject) && !fromProject.startsWith('..' + sep)) continue;
      if (visited.has(executable)) continue;
      visited.add(executable);
      await access(executable, constants.X_OK);
      file = await stat(executable);
      if (!file.isFile() || (process.platform !== 'win32' && (file.mode & 0o002))) continue;
    } catch {
      continue;
    }
    const key = executable + ':' + file.mtimeMs + ':' + file.size;
    if (!installations.has(key)) installations.set(key, inspectCodex(executable).catch(() => null));
    const candidate = await installations.get(key);
    if (candidate?.compatible) return { ...candidate, installed: true };
    incompatible ??= candidate;
  }
  return { ...incompatible, installed: Boolean(incompatible), compatible: false };
}

function workspacePaths({ mode, dataRoot }) {
  if (!['inherited', 'isolated'].includes(mode) || !dataRoot) throw new TypeError('A Codex mode and local data root are required.');
  const root = resolve(dataRoot, 'watch-bridge', 'codex', mode);
  return { cwd: join(root, 'cinema'), legacyCwd: join(root, 'workspace'),
    codexHome: mode === 'isolated' ? join(root, 'home') : undefined };
}

export function codexLaunchDetails(config) {
  const { cwd, codexHome } = workspacePaths(config);
  const launchArgs = ['app-server', '-c', 'model_provider="openai"', '-c', 'project_root_markers=[]'];
  if (codexHome) launchArgs.push('-c', 'cli_auth_credentials_store="file"');
  const effectiveHome = codexHome ?? resolve(cwd, process.env.CODEX_HOME || join(homedir(), '.codex'));
  return { configPath: join(effectiveHome, 'config.toml'), launchArgs };
}

export async function prepareCodexWorkspace(config, { legacy = false } = {}) {
  const { agents } = config;
  const paths = workspacePaths(config);
  const { codexHome } = paths;
  const cwd = legacy ? paths.legacyCwd : paths.cwd;
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const instructions = join(cwd, 'AGENTS.md');
  if (typeof agents === 'string') {
    const staging = await mkdtemp(join(cwd, '.instructions-'));
    try {
      const draft = join(staging, 'AGENTS.md');
      await writeFile(draft, agents, { mode: 0o600 });
      await rename(draft, instructions);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  } else {
    try {
      await writeFile(instructions, renderViewingInstructions(DEFAULT_INSTRUCTIONS), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  if (codexHome) await mkdir(codexHome, { recursive: true, mode: 0o700 });
  return { cwd, codexHome };
}

async function desktopInstalled() {
  if (process.platform === 'darwin') {
    return (await Promise.all(macDesktopApps().map(app =>
      access(join(app, 'Contents', 'Info.plist')).then(() => true, () => false)))).some(Boolean);
  }
  if (process.platform === 'win32') {
    return exec('reg.exe', ['query', 'HKCR\\codex\\shell\\open\\command', '/ve'],
      { windowsHide: true, timeout: 3000 }).then(() => true, () => false);
  }
  return false;
}

export async function openCodexDesktopOnce(cwd, { installed = desktopInstalled, launch } = {}) {
  const marker = join(cwd, '.desktop-opened');
  const alreadyOpened = await access(marker).then(() => true, error => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  });
  if (alreadyOpened || !launch || !await installed()) return;
  try {
    await writeFile(marker, '', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return;
  }
  try {
    await launch(cwd);
  } catch (error) {
    // A timed-out command could have already handed the workspace to Desktop.
    if (!error.killed) await rm(marker, { force: true });
    throw error;
  }
}

function startRpc(child, { onNotification, onRequest, onFailure }) {
  const pending = new Map();
  const exited = Promise.withResolvers();
  const input = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let nextId = 0;
  let stopping;
  let failure;

  function fail(error) {
    if (failure) return;
    failure = error;
    for (const waiter of pending.values()) waiter.reject(error);
    if (!stopping) onFailure?.(error);
  }

  function send(message) {
    if (failure) throw failure;
    child.stdin.write(JSON.stringify(message) + '\n');
  }

  async function request(method, params, { signal } = {}) {
    signal?.throwIfAborted();
    const id = ++nextId;
    const waiter = Promise.withResolvers();
    const cancel = () => waiter.reject(signal.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    pending.set(id, waiter);
    try {
      send({ id, method, params });
      return await waiter.promise;
    } finally {
      signal?.removeEventListener('abort', cancel);
      pending.delete(id);
    }
  }

  async function dispatch(line) {
    const message = JSON.parse(line);
    if (typeof message.method === 'string') {
      if (message.id === undefined) {
        await onNotification?.(message.method, message.params);
        return;
      }
      let result;
      try {
        if (!onRequest) {
          send({ id: message.id, error: { code: -32601, message: 'Unsupported Codex server request.' } });
          return;
        }
        result = await onRequest(message.method, message.params);
      } catch {
        if (!stopping && !failure) send({ id: message.id, error: { code: -32603, message: 'The bridge could not handle this Codex request.' } });
        return;
      }
      if (!stopping && !failure) send({ id: message.id, result: result ?? null });
      return;
    }

    const waiter = pending.get(message.id);
    if (!waiter) return;
    if (message.error) {
      const error = new Error('Codex app-server rejected the request.');
      error.code = message.error.code;
      // Runtime uses the server's error only for classification. Keep detail out of logs.
      Object.defineProperty(error, 'rpcMessage', { value: message.error.message });
      waiter.reject(error);
    } else {
      waiter.resolve(message.result);
    }
  }

  input.on('line', line => {
    if (line.trim()) dispatch(line).catch(() => fail(new Error('The Codex app-server connection returned an invalid message.')));
  });
  child.stdin.on('error', () => fail(new Error('The Codex app-server connection was interrupted.')));
  child.on('error', () => fail(new Error('Could not start the local Codex app-server.')));
  child.once('close', () => {
    input.close();
    fail(new Error('The local Codex app-server stopped.'));
    exited.resolve();
  });

  function close() {
    if (!stopping) {
      stopping = (async () => {
        child.stdin.end();
        const terminate = setTimeout(() => child.kill(), 1_000);
        const force = setTimeout(() => child.kill('SIGKILL'), 3_000);
        terminate.unref();
        force.unref();
        try {
          await exited.promise;
        } finally {
          clearTimeout(terminate);
          clearTimeout(force);
        }
      })();
    }
    return stopping;
  }

  return { request, notify: (method, params) => send({ method, params }), close };
}

export async function openCodexClient({ config, onNotification, onRequest, onFailure }) {
  const installation = await detectCodexInstallation();
  if (!installation.installed) throw new Error('Install Codex on this computer first.');
  if (!installation.compatible) throw new Error('Update Codex to a version that supports toolOutput.');
  const workspace = await prepareCodexWorkspace(config);
  const { configPath, launchArgs } = codexLaunchDetails(config);
  const child = spawn(installation.executable, launchArgs, {
    cwd: workspace.cwd,
    env: codexEnv(workspace.codexHome),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore']
  });
  const rpc = startRpc(child, { onNotification, onRequest, onFailure });
  try {
    const initialized = await rpc.request('initialize', {
      clientInfo: { name: 'open_watch_cinema', title: 'Open Watch Cinema', version: '1.0.0' },
      capabilities: { experimentalApi: true, explicitGatewayOauth: true }
    }, { signal: AbortSignal.timeout(10_000) });
    rpc.notify('initialized');
    return {
      ...rpc,
      capabilities: installation.capabilities,
      cwd: workspace.cwd,
      async workspaceForThread(threadId, signal) {
        const { legacyCwd } = workspacePaths(config);
        const legacyRealPath = await realpath(legacyCwd).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
        if (!legacyRealPath) return workspace.cwd;
        const { thread } = await rpc.request('thread/read', { threadId, includeTurns: false }, { signal });
        if (thread?.cwd !== legacyCwd && thread?.cwd !== legacyRealPath) return workspace.cwd;
        return (await prepareCodexWorkspace(config, { legacy: true })).cwd;
      },
      openDesktopOnce: config.mode === 'inherited' ? () => openCodexDesktopOnce(workspace.cwd, {
        launch: cwd => exec(installation.executable, ['app', cwd], {
          cwd, env: codexEnv(), windowsHide: true, timeout: 5000
        })
      }) : undefined,
      configPath: isAbsolute(initialized?.codexHome ?? '') ? join(initialized.codexHome, 'config.toml') : configPath,
      launchArgs
    };
  } catch (error) {
    await rpc.close();
    throw error;
  }
}
