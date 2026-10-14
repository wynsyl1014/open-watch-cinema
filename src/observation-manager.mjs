import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

function runProcess(command, args, { cwd, timeoutMs = 45_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      reject(new Error(`Observer timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8').trim();
      const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
      let payload;
      try {
        payload = output ? JSON.parse(output) : null;
      } catch {
        reject(new Error(`Observer returned invalid JSON.${errorOutput ? ` ${errorOutput}` : ''}`));
        return;
      }
      if (code !== 0 || !payload?.ok) {
        reject(new Error(payload?.error || errorOutput || `Observer exited with code ${code}.`));
        return;
      }
      resolvePromise(payload);
    });
  });
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveObserverPython(projectRoot) {
  if (process.env.OWC_OBSERVER_PYTHON) return process.env.OWC_OBSERVER_PYTHON;
  const localPython = process.platform === 'win32'
    ? resolve(projectRoot, 'observer', '.venv', 'Scripts', 'python.exe')
    : resolve(projectRoot, 'observer', '.venv', 'bin', 'python');
  if (await pathExists(localPython)) return localPython;
  return process.platform === 'win32' ? 'python' : 'python3';
}

export async function getObserverStatus(projectRoot) {
  const python = await resolveObserverPython(projectRoot);
  try {
    const payload = await runProcess(
      python,
      [resolve(projectRoot, 'observer', 'worker.py'), 'health'],
      { cwd: projectRoot, timeoutMs: 15_000 }
    );
    return {
      available: true,
      python,
      ...payload
    };
  } catch (error) {
    return {
      available: false,
      python,
      baselineAvailable: false,
      opencvAvailable: false,
      error: error.message
    };
  }
}

export async function analyzeObservationSegment(projectRoot, {
  inputPath,
  startMs = 0,
  durationMs = 10_000,
  sampleFps = 2,
  outputDir = null,
  storyboardPrefix = 'segment',
  visualStartMs = startMs,
  timeoutMs = 120_000
}) {
  const python = await resolveObserverPython(projectRoot);
  const args = [
    resolve(projectRoot, 'observer', 'worker.py'),
    'analyze',
    '--input', inputPath,
    '--start-ms', String(Math.max(0, Math.round(startMs))),
    '--duration-ms', String(Math.max(500, Math.min(300_000, Math.round(durationMs)))),
    '--sample-fps', String(Math.max(0.5, Math.min(4, Number(sampleFps) || 2)))
  ];
  if (outputDir) args.push('--output-dir', outputDir);
  if (storyboardPrefix) args.push('--storyboard-prefix', String(storyboardPrefix).slice(0, 80));
  args.push('--visual-start-ms', String(Math.max(0, Math.round(visualStartMs))));
  return runProcess(python, args, { cwd: projectRoot, timeoutMs });
}
