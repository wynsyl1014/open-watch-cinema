// Shared by the Windows and macOS full and component installers.
import { migrateModels } from '../../src/storage/local-layout.mjs';
import { activePython } from '../../src/preparation/active-python.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline/promises';

const root = resolve(import.meta.dirname, '../..');
process.chdir(root);
const windows = process.platform === 'win32';
const mac = process.platform === 'darwin';
const env = process.env;
const dataRoot = resolve(env.LOCAL_DATA_ROOT || 'local-data');
const [component = 'all', ...flags] = process.argv.slice(2);
const full = component === 'all';
const selected = name => full || component === name;
const onlyPlan = flags.includes('--plan');
const useUv = flags.includes('--uv');
const visualDir = resolve('observer/.venv');
const audioDir = resolve('observer/.conette-venv');
const venvPython = dir => join(dir, windows ? 'Scripts/python.exe' : 'bin/python');
const audioRequirements = 'observer/audio-requirements.txt';
const visualRequirements = 'observer/requirements.txt';

function output(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', windowsHide: true, env: { ...env, PYTHONIOENCODING: 'utf-8' }
  });
  return result.status === 0 ? result.stdout.trim() : null;
}
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw Error(`${command} ${args[0]} failed (${result.error?.message || result.status}).`);
}
function interpreter(command, audio, args = []) {
  const check = audio ? "sys.version_info[:2] == (3,10) and struct.calcsize('P') == 8" : 'sys.version_info >= (3,11)';
  return output(command, [...args, '-B', '-c', `import sys, struct; assert ${check}; print(sys.executable)`]);
}
function findBase(audio) {
  const candidates = audio ? ['python3.10', windows ? 'python' : 'python3'] : [windows ? 'python' : 'python3'];
  for (const command of candidates) {
    const found = interpreter(command, audio);
    if (found) return found;
  }
  if (windows) {
    const found = interpreter('py', audio, [audio ? '-3.10' : '-3']);
    if (found) return found;
  }
  // Discover interpreters already managed by uv without fetching one.
  const managed = output('uv', ['python','find','--no-python-downloads', audio ? '3.10' : '>=3.11']);
  return managed && interpreter(managed, audio);
}
function pythonPlan(audio) {
  const dir = audio ? audioDir : visualDir;
  const external = audio ? env.OWC_AUDIO_PYTHON : env.OWC_OBSERVER_PYTHON || env.OBSERVER_PYTHON;
  const base = audio ? env.OWC_AUDIO_BASE_PYTHON : env.OWC_OBSERVER_BASE_PYTHON;
  const local = venvPython(dir);
  if (external || existsSync(dir)) {
    const path = external || local;
    if (!interpreter(path, audio)) throw Error(`Check the existing interpreter ${path}. Expected ${audio ? '64-bit Python 3.10.x' : 'Python 3.11+'}. See docs/工具准备/安装与排错.md to choose another environment.`);
    if (external) return { python: path, external: true, dir };
    const prefix = output(path, ['-B', '-c', 'import sys; assert sys.prefix != sys.base_prefix; print(sys.prefix)']);
    if (!prefix || realpathSync(prefix) !== realpathSync(dir)) {
      throw Error(`The project path does not identify a private virtual environment: ${dir}. Select your own environment explicitly.`);
    }
    // A linked environment belongs to its owner; reuse it without installing packages.
    return { python: path, dir, external: realpathSync(dir) !== resolve(realpathSync(root), 'observer', audio ? '.conette-venv' : '.venv') };
  }
  let source;
  if (base) {
    source = interpreter(base, audio);
    if (!source) throw Error(`Incompatible base Python: ${base}`);
  } else {
    const active = activePython();
    const ready = audio ? "import importlib.util; assert all(importlib.util.find_spec(m) for m in ('conette','torch','torchaudio','en_core_web_sm','nltk','huggingface_hub'))" : cvCheck;
    if (active && interpreter(active,audio) && output(active,['-B','-c',ready]) !== null) {
      return { python: active, external: true, dir };
    }
    source = findBase(audio);
  }
  return { python: local, dir, source, audio };
}
const cvCheck = "import cv2,numpy; v=tuple(map(int,cv2.__version__.split('.')[:2])); assert (4,10)<=v<(5,0) and hasattr(cv2,'FaceDetectorYN') and hasattr(cv2,'FaceRecognizerSF')";
function prepareEnvironment(plan) {
  if (plan.external || existsSync(plan.python)) return;
  let source = plan.source;
  if (!source && useUv) {
    run('uv', ['python', 'install', plan.audio ? '3.10' : '3.13']);
    source = output('uv', ['python', 'find', plan.audio ? '3.10' : '3.13']);
  }
  if (!source) source = findBase(plan.audio);
  if (!source) throw Error('Compatible Python missing. Select a base interpreter or use --uv.');
  run(source, ['-m', 'venv', plan.dir]);
}
function pip(python, args) {
  if (output(python, ['-m','pip','--version']) === null) run(python, ['-m','ensurepip']);
  run(python, ['-m','pip', ...args]);
}
function visualSetup(plan) {
  prepareEnvironment(plan);
  if (output(plan.python, ['-B','-c', cvCheck]) === null) {
    if (plan.external) throw Error('Selected visual environment needs OpenCV 4.10–4.x and NumPy. Supply a compatible environment or select a base Python for a private installation.');
    pip(plan.python, ['install','--only-binary=:all:', '-r',visualRequirements]);
  }
  run(plan.python, ['-B','-c',cvCheck]);
  run(plan.python, ['observer/worker.py','health']);
}
function checkAudioDependencies(python) {
  const result = spawnSync(python, ['-m', 'pip', 'check'], { encoding: 'utf8' });
  if (result.status === 0) return;
  const report = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  // The official 1.13.1 arm64 wheel ships an x86_64 tag inside WHEEL.
  // Accept only that single diagnostic, after exercising both native libraries.
  if (mac && result.status === 1 && report === 'torch 1.13.1 is not supported on this platform') {
    run(python, ['-c', "import platform,torch,torchaudio; assert platform.machine()=='arm64' and torch.__version__=='1.13.1'; assert torchaudio.functional.resample(torch.ones(16),16,8).numel()==8"]);
    console.log('Verified native arm64 Torch/TorchAudio execution despite the legacy wheel tag.');
    return;
  }
  throw Error(report || 'Audio dependency check failed.');
}
function audioSetup(plan) {
  prepareEnvironment(plan);
  const verify = ['scripts/preparation/verify-audio-setup.py','--data-root',dataRoot];
  if (existsSync(join(dataRoot,'模型','声音描述','audio-model.json')) && output(plan.python, verify) !== null) {
    console.log('Reused existing audio model: offline inference passed.');
    return;
  }
  if (!plan.external) {
    if (windows) {
      run(plan.python,['scripts/preparation/normalize-audio-venv.py']);
      pip(plan.python,['install','torch==1.13.1','torchaudio==0.13.1','--index-url','https://download.pytorch.org/whl/cpu']);
    }
    pip(plan.python,['install','-r',audioRequirements,'torch==1.13.1','torchaudio==0.13.1']);
    checkAudioDependencies(plan.python);
  } else {
    run(plan.python,['-c','import torch,torchaudio,conette,en_core_web_sm,huggingface_hub,nltk']);
  }
  run(plan.python,['scripts/preparation/download-audio-model.py','--data-root',dataRoot]);
}

async function setup() {
  if (!['all','observer','audio'].includes(component) || flags.some(f => !['--plan','--yes','--uv'].includes(f))) {
    throw Error('Usage: setup [all|observer|audio] [--plan] [--yes] [--uv]');
  }
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Install Node.js 24 or newer.');
  const visual = selected('observer') ? pythonPlan(false) : null;
  const audio = selected('audio') ? pythonPlan(true) : null;
  const missing = new Map();
  if (full || audio) {
    for (const cmd of ['ffmpeg','ffprobe']) {
      if (output(cmd,['-version']) === null) missing.set('ffmpeg','Gyan.FFmpeg');
    }
  }
  console.log(`Node ${process.version} (${process.execPath})\nSetup: ${component}; project: ${root}`);
  if (full || audio) console.log(missing.has('ffmpeg') ? 'FFmpeg/FFprobe: missing' : 'FFmpeg/FFprobe: found');
  for (const [label, plan] of [['OpenCV',visual],['CoNeTTE',audio]]) {
    if (!plan) continue;
    console.log(`${label}: ${plan.external ? 'use external environment without installing packages' : 'project environment'} ${plan.python}`);
    if (plan.source) console.log(`  Base interpreter: ${plan.source}`);
    if (plan.external || existsSync(plan.python) || plan.source) continue;
    if (useUv) {
      if (output('uv',['--version']) === null) missing.set('uv','astral-sh.uv');
      console.log(`  uv will supply Python ${plan.audio ? '3.10' : '3.13'}.`);
    } else {
      missing.set(plan.audio ? 'python@3.10' : 'python', plan.audio ? 'Python.Python.3.10' : 'Python.Python.3.13');
    }
  }
  if (visual) {
    const installed = existsSync(visual.python) && output(visual.python, ['-B', '-c', cvCheck]) !== null;
    const action = installed ? 'reuse OpenCV and NumPy' : visual.external ? 'selected environment needs compatible OpenCV and NumPy' : 'install OpenCV 4.x and NumPy';
    console.log(`Visual: ${action}; verify observer.`);
  }
  if (audio) {
    const configured = existsSync(join(dataRoot, '模型', '声音描述', 'audio-model.json'));
    console.log(`Sound: ${configured ? 'check existing CoNeTTE model and repair if needed' : 'prepare CoNeTTE weights and language resources'} -> ${dataRoot}; offline 10-second inference check.`);
  }
  if (audio) await migrateModels(dataRoot);
  if (missing.size) {
    console.log(mac ? 'Missing tools: brew install ' + [...missing.keys()].join(' ') :
      [...missing.values()].map(id => 'Missing tool: winget install --id ' + id + ' -e').join('\n'));
  }
  console.log('Own environments: set OWC_OBSERVER_PYTHON / OWC_AUDIO_PYTHON before setup and launch. See docs/工具准备/安装与排错.md for base Python selection and individual features.');
  if (onlyPlan) return;
  if (!flags.includes('--yes')) {
    if (!process.stdin.isTTY) throw Error('Review --plan, then use --yes to install non-interactively.');
    const terminal = createInterface({input:process.stdin, output:process.stdout});
    let answer;
    try { answer = await terminal.question('Install the items above? [y/N] '); } finally { terminal.close(); }
    if (!/^y(es)?$/i.test(answer.trim())) return;
  }
  if (audio) await migrateModels(dataRoot);
  if (missing.size) {
    if (windows && output('winget',['--version']) !== null) {
      for (const id of missing.values()) run('winget',['install','--id',id,'-e']);
      // Keep the caller's PATH and append entries registered by the installers.
      const registered = output('powershell.exe',['-NoProfile','-NonInteractive','-Command',
        "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"]);
      if (registered) env.PATH += ';' + registered;
    } else if (mac && output('brew', ['--version']) !== null) {
      try {
        run('brew', ['install', ...missing.keys()]);
      } catch (error) {
        throw Error(error.message + ' Rerun --plan to see remaining tools. For a missing Python, select a compatible base interpreter or rerun with --uv. See docs/工具准备/安装与排错.md → macOS 安装.');
      }
    } else {
      throw Error('Install the missing tools listed above, reopen the terminal and rerun setup. You may use your preferred package manager.');
    }
  }
  if ((full || audio) && ['ffmpeg','ffprobe'].some(cmd => output(cmd,['-version']) === null)) {
    throw Error('FFmpeg/FFprobe are not yet on PATH. Open a new terminal and rerun setup.');
  }
  if (visual) visualSetup(visual);
  if (audio) audioSetup(audio);
  console.log('Setup completed. Use the start launcher when ready.');
}
setup().catch(error => { console.error(error.message); process.exitCode = 1; });
