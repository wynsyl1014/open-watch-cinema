import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

export const AUDIO_NOT_PREPARED = Object.freeze({ status: 'not_prepared', descriptionCount: 0 });

export function validateAudioPayload(payload, chunk) {
  if (!payload || !['ready', 'source_missing'].includes(payload.status) || !Array.isArray(payload.descriptions)) {
    throw new Error('Invalid audio description result.');
  }
  let throughMs = chunk.logicalStartMs;
  const ids = new Set();
  for (const item of payload.descriptions) {
    if (!item || !Number.isSafeInteger(item.fromMs) || !Number.isSafeInteger(item.toMs)
        || item.fromMs !== throughMs || item.toMs <= item.fromMs || item.toMs > chunk.logicalEndMs
        || item.availableAtMs !== item.toMs || typeof item.text !== 'string'
        || !item.text.trim() || item.text.length > 700 || typeof item.id !== 'string' || ids.has(item.id)
        || !['local_audio_model', 'acoustic_measurement'].includes(item.source)) {
      throw new Error('Audio descriptions must cover their chunk in order with complete, bounded evidence ranges.');
    }
    ids.add(item.id);
    throughMs = item.toMs;
  }
  if (payload.status === 'ready' && throughMs !== chunk.logicalEndMs) {
    throw new Error('Audio descriptions do not cover the complete chunk.');
  }
  if (payload.status === 'source_missing' && payload.descriptions.length) {
    throw new Error('Missing audio cannot contain descriptions.');
  }
  return payload;
}

export function audioTrackState(chunks, metadata = {}) {
  const completed = chunks.filter((chunk) => ['ready', 'source_missing'].includes(chunk.audioStatus));
  const failed = chunks.some((chunk) => chunk.audioStatus === 'failed');
  const allMissing = completed.length === chunks.length && completed.every((chunk) => chunk.audioStatus === 'source_missing');
  return {
    ...metadata,
    status: failed ? 'failed' : allMissing ? 'source_missing' : completed.length === chunks.length ? 'ready' : 'pending',
    completeChunks: completed.length,
    totalChunks: chunks.length,
    descriptionCount: chunks.reduce((sum, chunk) => sum + (chunk.audioDescriptionCount || 0), 0),
    resultKind: 'chunked_audio_descriptions',
  };
}

function audioPython(projectRoot) {
  return process.env.OWC_AUDIO_PYTHON || resolve(projectRoot, 'observer', '.conette-venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
}

export async function getAudioDescriptionStatus(projectRoot, dataRoot) {
  const python = audioPython(projectRoot);
  try { await access(python); } catch {
    return { status: 'unavailable', note: 'Audio descriptions need the optional local audio setup.' };
  }
  return new Promise((resolveStatus) => {
    const child = spawn(python, [resolve(projectRoot, 'observer/audio_worker.py'), 'status'], {
      cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LOCAL_DATA_ROOT: dataRoot },
    });
    let output = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 15_000);
    child.stdout.on('data', (bytes) => { output += bytes; });
    child.stderr.on('data', (bytes) => { stderr = (stderr + bytes).slice(-1500); });
    child.on('error', (error) => { clearTimeout(timer); resolveStatus({ status: 'unavailable', note: error.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try { resolveStatus(JSON.parse(output)); } catch {
        resolveStatus({ status: 'unavailable', note: timedOut
          ? 'Audio setup check timed out.'
          : `Audio Python could not start (exit ${code}). ${stderr.trim()}` });
      }
    });
  });
}

// Lazily launch one worker per preparation job; it retains the model between chunks.
export function createAudioDescriber(projectRoot, { dataRoot, onProgress = null, timeoutMs = 900_000 } = {}) {
  let child = null;
  let lines = null;
  let pending = null;
  let timer = null;
  let stderr = '';
  function finish(error, value) {
    clearTimeout(timer);
    const waiter = pending;
    pending = null;
    if (error) waiter?.reject(error); else waiter?.resolve(value);
  }
  function armTimeout() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      finish(new Error('Local audio analysis timed out. Completed audio chunks can be resumed.'));
      child?.kill();
    }, timeoutMs);
  }
  function start() {
    child = spawn(audioPython(projectRoot), [resolve(projectRoot, 'observer/audio_worker.py')], {
      cwd: projectRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LOCAL_DATA_ROOT: dataRoot, PYTHONUNBUFFERED: '1' },
    });
    lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        const value = JSON.parse(line);
        if (value.type === 'progress') {
          armTimeout();
          onProgress?.(value);
        } else if (value.type === 'result') {
          finish(value.ok ? null : new Error(value.error || 'Audio analysis failed.'), value);
        }
      } catch (error) { finish(error); child.kill(); }
    });
    child.stderr.on('data', (bytes) => { stderr = (stderr + bytes).slice(-3000); });
    child.stdin.on('error', (error) => finish(error));
    child.on('error', (error) => finish(error));
    child.on('close', () => {
      finish(new Error(`Audio worker stopped. ${stderr}`));
      child = null;
    });
  }
  return {
    describeChunk({ inputPath, chunk }) {
      if (pending) return Promise.reject(new Error('Audio chunks must be processed sequentially.'));
      if (!child) start();
      return new Promise((resolveResult, reject) => {
        pending = { resolve: resolveResult, reject };
        armTimeout();
        child.stdin.write(`${JSON.stringify({ inputPath, fromMs: chunk.logicalStartMs, toMs: chunk.logicalEndMs })}\n`);
      });
    },
    close() {
      finish(new Error('Audio worker closed.'));
      lines?.close();
      child?.stdin.end();
      child?.kill();
    },
  };
}
