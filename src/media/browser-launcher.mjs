import { spawn } from 'node:child_process';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { createInterface } from 'node:readline';

const exists = async (file) => { try { await access(file); return true; } catch { return false; } };

const windowsBrowsers = {
  quark: { label: 'Quark (夸克)', executables: ['Quark\\Application\\quark.exe', 'Quark\\quark.exe'] },
  chrome: { label: 'Google Chrome', executables: ['Google\\Chrome\\Application\\chrome.exe'] },
  edge: { label: 'Microsoft Edge', executables: ['Microsoft\\Edge\\Application\\msedge.exe'] },
  firefox: { label: 'Mozilla Firefox', executables: ['Mozilla Firefox\\firefox.exe'] }
};

const unquotePath = (value) => value?.trim().replace(/^"(.*)"$/, '$1');

async function chooseWindowsBrowser(lines, output) {
  const entries = Object.entries(windowsBrowsers);
  const defaultNumber = entries.length + 1;
  const customNumber = defaultNumber + 1;
  const prompt = `Choose a browser to open the cinema\n${entries.map(([, browser], index) => `  ${index + 1}. ${browser.label}`).join('\n')}\n  ${defaultNumber}. Windows default browser\n  ${customNumber}. Specify a browser executable\n  Enter. Open the address manually\nSelection: `;
  output.write(prompt);
  while (true) {
    const { value } = await lines.next();
    const selection = value?.trim();
    if (!selection) return null;
    if (selection === String(defaultNumber)) return { browser: 'default' };
    if (selection === String(customNumber)) {
      output.write('Full path to the browser .exe (Enter to open manually): ');
      const { value } = await lines.next();
      const file = unquotePath(value);
      return file ? { browser: 'custom', file } : null;
    }
    const entry = entries.find((_, index) => selection === String(index + 1));
    if (entry) return { browser: entry[0] };
    output.write(`Enter a number from 1 to ${customNumber}, or press Enter to open manually: `);
  }
}

async function openWindowsBrowser(url, { input, output, env, localDataRoot, present, tryLaunch }) {
  const terminal = createInterface({ input, terminal: false });
  const lines = terminal[Symbol.asyncIterator]();
  const manual = { opened: false, reason: 'manual' };
  try {
    const selection = await chooseWindowsBrowser(lines, output);
    if (!selection) return manual;
    const { browser, file } = selection;
    let opened = false;
    if (browser === 'default') {
      const opener = win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe');
      opened = await tryLaunch(opener, ['url.dll,FileProtocolHandler', url]);
    } else {
      const roots = [env.LOCALAPPDATA, env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
      const candidates = browser === 'custom' ? [file] : roots.flatMap(root => (
        windowsBrowsers[browser].executables.map(executable => win32.join(root, executable))
      ));
      const quark = browser === 'quark';
      const configPath = quark && localDataRoot ? join(localDataRoot, 'quark-path.txt') : null;
      if (quark) {
        const saved = configPath ? await readFile(configPath, 'utf8').catch(() => '') : '';
        candidates.unshift(unquotePath(env.QUARK_PATH), unquotePath(saved));
      }
      const isExecutable = (candidate) => Boolean(candidate && win32.isAbsolute(candidate) && win32.parse(candidate).root.length > 1
        && (quark ? win32.basename(candidate).toLowerCase() === 'quark.exe' : /\.exe$/i.test(candidate)));
      let found = false;
      for (const candidate of new Set(candidates)) {
        if (isExecutable(candidate) && await present(candidate)) {
          found = true;
          opened = await tryLaunch(candidate, [url]);
          if (opened) break;
        }
      }
      if (quark && !found) {
        output.write('Quark was not found. Use the Quark shortcut’s Open file location to find quark.exe.\n');
        while (true) {
          output.write('Full path to quark.exe (Enter to open manually): ');
          const { value } = await lines.next();
          const candidate = unquotePath(value);
          if (!candidate) return manual;
          if (isExecutable(candidate) && await present(candidate)) {
            opened = await tryLaunch(candidate, [url]);
            if (opened && configPath) {
              await writeFile(configPath, `${candidate}\n`, 'utf8').catch(() => {
                output.write('Could not save the Quark path. You can enter it again next time.\n');
              });
            }
            break;
          }
          output.write('That path does not point to a quark.exe file.\n');
        }
      }
    }
    return opened ? { opened, browser } : { opened, browser, reason: 'unavailable' };
  } finally {
    terminal.close();
  }
}

// A browser may remain running or hand off to an existing instance and exit zero.
// Detect missing executables and immediate startup failures, without waiting for its lifetime.
export function launchBrowserProcess(command, args) {
  return new Promise((resolve) => {
    let timer;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref();
      resolve(ok);
    };
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0));
    child.once('spawn', () => { timer = setTimeout(() => finish(true), 1200); });
  });
}

export async function openBrowser(url, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (env.OPEN_BROWSER === '0') return { opened: false, reason: 'disabled' };
  const address = new URL(url);
  if (address.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname) || address.username || address.password) throw new Error('Browser launch requires a local HTTP cinema URL');
  const localUrl = address.href;
  const launch = options.launch ?? launchBrowserProcess;
  const tryLaunch = async (command, args) => {
    try { return await launch(command, args) === true; } catch { return false; }
  };
  if (platform === 'win32') {
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stdout;
    if (!input.isTTY) return { opened: false, reason: 'manual' };
    if (options.defaultBrowser) {
      const opener = win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe');
      return { opened: await tryLaunch(opener, ['url.dll,FileProtocolHandler', localUrl]), browser: 'default' };
    }
    if (!options.chooseBrowser) return { opened: false, reason: 'manual' };
    const isFile = options.exists ?? (async (file) => (await stat(file).catch(() => null))?.isFile() ?? false);
    return openWindowsBrowser(localUrl, { input, output, env, localDataRoot: options.localDataRoot, present: isFile, tryLaunch });
  }
  if (platform === 'darwin') {
    const input = options.input ?? process.stdin;
    if (!input.isTTY || !options.defaultBrowser) return { opened: false, reason: 'manual' };
    return { opened: await tryLaunch('/usr/bin/open', [localUrl]), browser: 'default' };
  }
  return { opened: await tryLaunch('xdg-open', [localUrl]), browser: 'default' };
}
