import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { openBrowser } from '../../src/media/browser-launcher.mjs';

const url = 'http://127.0.0.1:4182/';
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const custom = 'D:\\Browser Apps\\My Browser\\browser.exe';
const quark = 'E:\\My Browsers\\夸克\\quark.exe';

async function windowsLaunch(answer, overrides = {}) {
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  let prompt = '';
  output.on('data', (chunk) => { prompt += chunk; });
  const launches = [];
  const checked = [];
  const resultPromise = openBrowser(url, {
    platform: 'win32',
    chooseBrowser: true,
    input,
    output,
    env: { ProgramFiles: 'C:\\Program Files' },
    exists: async (file) => {
      checked.push(file);
      return [chrome, custom, quark].includes(file);
    },
    launch: async (file, args) => {
      launches.push({ file, args });
      return true;
    },
    ...overrides
  });
  input.end(answer);
  const result = await resultPromise;
  return { result, prompt, checked, launches };
}

test('Windows prompts before opening the selected browser and only checks its executable', async () => {
  const { result, prompt, checked, launches } = await windowsLaunch('bad input\n2\n');
  assert.match(prompt, /Google Chrome/);
  assert.match(prompt, /Enter a number/);
  assert.deepEqual(result, { opened: true, browser: 'chrome' });
  assert.deepEqual(checked, [chrome]);
  assert.deepEqual(launches, [{ file: chrome, args: [url] }]);
});

test('Windows opens Quark from its local path file only when Quark is selected', async (t) => {
  const localDataRoot = await mkdtemp(join(tmpdir(), 'cinema-browser-'));
  t.after(() => rm(localDataRoot, { recursive: true, force: true }));
  await writeFile(join(localDataRoot, 'quark-path.txt'), `\uFEFF"${quark}"\r\n`);
  const selected = await windowsLaunch('1\n', { localDataRoot });
  assert.match(selected.prompt, /1\. Quark/);
  assert.deepEqual(selected.result, { opened: true, browser: 'quark' });
  assert.deepEqual(selected.checked, [quark]);
  assert.deepEqual(selected.launches, [{ file: quark, args: [url] }]);

  const unselected = await windowsLaunch('\n', { localDataRoot });
  assert.deepEqual(unselected.checked, []);
  assert.deepEqual(unselected.launches, []);
});

test('a fresh Windows installation finds Quark in a standard location without a saved path', async () => {
  const installed = 'C:\\Program Files\\Quark\\Application\\quark.exe';
  const selected = await windowsLaunch('1\n', { exists: async (file) => file === installed });
  assert.deepEqual(selected.launches, [{ file: installed, args: [url] }]);
  assert.doesNotMatch(selected.prompt, /Quark was not found/);
});

test('Windows asks for a custom Quark path and saves it after launch', async (t) => {
  const localDataRoot = await mkdtemp(join(tmpdir(), 'cinema-browser-'));
  t.after(() => rm(localDataRoot, { recursive: true, force: true }));
  const configPath = join(localDataRoot, 'quark-path.txt');
  const failed = await windowsLaunch(`1\n"${quark}"\n`, { localDataRoot, launch: async () => false });
  assert.equal(failed.result.reason, 'unavailable');
  await assert.rejects(readFile(configPath, 'utf8'), { code: 'ENOENT' });

  const firstRun = await windowsLaunch(`1\n${custom}\n"${quark}"\n`, { localDataRoot });
  assert.match(firstRun.prompt, /Quark was not found/);
  assert.match(firstRun.prompt, /does not point to a quark\.exe file/);
  assert.deepEqual(firstRun.launches, [{ file: quark, args: [url] }]);
  assert.equal(await readFile(configPath, 'utf8'), `${quark}\n`);

  const nextRun = await windowsLaunch('1\n', { localDataRoot });
  assert.doesNotMatch(nextRun.prompt, /Quark was not found/);
  assert.deepEqual(nextRun.launches, [{ file: quark, args: [url] }]);

  await writeFile(configPath, 'Z:\\Removed\\quark.exe\n');
  const cancelled = await windowsLaunch('1\n\n', { localDataRoot });
  assert.match(cancelled.prompt, /Quark was not found/);
  assert.deepEqual(cancelled.result, { opened: false, reason: 'manual' });
  assert.deepEqual(cancelled.launches, []);
  assert.equal(await readFile(configPath, 'utf8'), 'Z:\\Removed\\quark.exe\n');
});

test('Windows accepts a quoted custom path and only uses the system default when selected', async () => {
  const selected = await windowsLaunch(`6\n"${custom}"\n`);
  assert.deepEqual(selected.launches, [{ file: custom, args: [url] }]);
  const systemDefault = await windowsLaunch('5\n');
  assert.deepEqual(systemDefault.checked, []);
  assert.deepEqual(systemDefault.launches, [{
    file: 'C:\\Windows\\System32\\rundll32.exe', args: ['url.dll,FileProtocolHandler', url]
  }]);
  const missing = await windowsLaunch('3\n');
  assert.deepEqual(missing.result, { opened: false, browser: 'edge', reason: 'unavailable' });
  assert.deepEqual(missing.launches, []);
});

test('Windows skips browser discovery and launch in manual or unattended mode', async () => {
  for (const [answer, overrides] of [
    ['\n', {}], ['6\n\n', {}], ['1\n', { chooseBrowser: false }],
    ['1\n', { input: new PassThrough() }], ['1\n', { env: { OPEN_BROWSER: '0' } }]
  ]) {
    const { result, checked, launches } = await windowsLaunch(answer, overrides);
    assert.equal(result.opened, false);
    assert.deepEqual(checked, []);
    assert.deepEqual(launches, []);
  }
});

test('macOS double-click uses system default; background and plain start stay manual', async () => {
  for (const [tty, flag, expected] of [[true,true,1],[false,true,0],[true,false,0]]) {
    const launches = [];
    const result = await openBrowser(url, { platform:'darwin', input:{isTTY:tty}, defaultBrowser:flag,
      env:{QUARK_PATH:'/Applications/Quark.app'}, launch:async(file,args)=>{launches.push({file,args});return true;} });
    assert.equal(launches.length,expected);
    if(expected) assert.deepEqual(launches,[{file:'/usr/bin/open',args:[url]}]);
    else assert.equal(result.reason,'manual');
  }
});

test('Windows double-click default mode opens only the system default; background stays manual', async () => {
  const selected = await windowsLaunch('', { chooseBrowser: false, defaultBrowser: true });
  assert.deepEqual(selected.checked, []);
  assert.equal(selected.result.browser, 'default');
  assert.equal(selected.launches.length, 1);
  assert.match(selected.launches[0].file, /rundll32.exe$/);
  const background = await windowsLaunch('', { chooseBrowser: false, defaultBrowser: true, input: new PassThrough() });
  assert.deepEqual(background.launches, []);
  assert.equal(background.result.reason, 'manual');
});
