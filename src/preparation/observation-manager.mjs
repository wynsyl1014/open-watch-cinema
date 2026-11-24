import { activePython } from './active-python.mjs';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const PROGRESS_PREFIX = 'OWC_PROGRESS ';

function runProcess(command, args, { cwd, timeoutMs = 45_000, onProgress = null, stdin = null } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    }
    const stdout = [];
    const errorLines = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      reject(new Error(`Observer timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    const stderrLines = createInterface({ input: child.stderr });
    stderrLines.on('line', (line) => {
      if (line.startsWith(PROGRESS_PREFIX)) {
        if (!onProgress) return;
        try {
          onProgress(JSON.parse(line.slice(PROGRESS_PREFIX.length)));
        } catch {
          // Ignore malformed progress telemetry so work never fails over display updates.
        }
        return;
      }
      if (line.trim()) errorLines.push(line);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stderrLines.close();
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stderrLines.close();
      const output = Buffer.concat(stdout).toString('utf8').trim();
      const errorOutput = errorLines.join('\n').trim();
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
  const selected = process.env.OWC_OBSERVER_PYTHON || process.env.OBSERVER_PYTHON;
  if (selected) return selected;
  const localPython = process.platform === 'win32'
    ? resolve(projectRoot, 'observer', '.venv', 'Scripts', 'python.exe')
    : resolve(projectRoot, 'observer', '.venv', 'bin', 'python');
  if (await pathExists(localPython)) return localPython;
  return activePython() || (process.platform === 'win32' ? 'python' : 'python3');
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
  visualEndMs = null,
  decodeEndMs = null,
  previousViews = [],
  imageSettings = null,
  timeoutMs = 120_000,
  onProgress = null
}) {
  const python = await resolveObserverPython(projectRoot);
  const args = [
    resolve(projectRoot, 'observer', 'worker.py'),
    'analyze',
    '--input', inputPath,
    '--start-ms', String(Math.max(0, Math.round(startMs))),
    '--duration-ms', String(Math.max(decodeEndMs === null ? 500 : 1, Math.min(300_000, Math.round(durationMs)))),
    '--sample-fps', String(Math.max(0.5, Math.min(4, Number(sampleFps) || 2)))
  ];
  if (outputDir) args.push('--output-dir', outputDir);
  if (storyboardPrefix) args.push('--storyboard-prefix', String(storyboardPrefix).slice(0, 80));
  args.push('--visual-start-ms', String(Math.max(0, Math.round(visualStartMs))));
  if (visualEndMs !== null) args.push('--visual-end-ms', String(Math.max(0, Math.round(visualEndMs))));
  if (decodeEndMs !== null) args.push('--decode-end-ms', String(decodeEndMs));
  if (previousViews.length) args.push('--previous-views-stdin');
  if (imageSettings !== null) args.push('--image-settings-json', JSON.stringify(imageSettings));
  return runProcess(python, args, { cwd: projectRoot, timeoutMs, onProgress,
    stdin: previousViews.length ? JSON.stringify(previousViews) : null });
}

export function preparedStoryboardViews(group) {
  const images = group.parts ? group.parts.map(part => part.image) : [group.image];
  const views = [];
  for (const image of images) {
    if (!Array.isArray(image?.views)) continue;
    for (const view of image.views) {
      if (!view) continue;
      const { type, sourceBox, anchorTimeMs } = view;
      const mediaTimeMs = view.mediaTimeMs ?? group.panelTimesMs?.[view.sourceIndex];
      if (!Number.isSafeInteger(mediaTimeMs) || mediaTimeMs < 0) continue;
      if (type === 'full') {
        views.push({ type, mediaTimeMs });
      } else if (type === 'crop' && Array.isArray(sourceBox) && sourceBox.length === 4
          && sourceBox.every(value => Number.isFinite(value) && value >= 0 && value <= 1)
          && sourceBox[0] < sourceBox[2] && sourceBox[1] < sourceBox[3]) {
        views.push({ type, mediaTimeMs, sourceBox,
          ...(Number.isSafeInteger(anchorTimeMs) && anchorTimeMs >= 0 && anchorTimeMs <= mediaTimeMs
            ? { anchorTimeMs } : {}) });
      }
    }
  }
  return views;
}

export async function composeStoryboardBatch(projectRoot, requestPath, {
  timeoutMs = 600_000,
  onProgress = null
} = {}) {
  const python = await resolveObserverPython(projectRoot);
  return runProcess(
    python,
    [resolve(projectRoot, 'observer', 'worker.py'), 'compose-source-batch', '--request', requestPath],
    { cwd: projectRoot, timeoutMs, onProgress }
  );
}
