import { spawn } from 'node:child_process';
import { access, rename, rm } from 'node:fs/promises';
import { basename, extname, join, parse } from 'node:path';

import { readSubtitleBundle } from './media-subtitles.mjs';

const PLAYBACK_REPAIR_MODES = new Set(['remux', 'audio', 'video', 'safe']);

function runAndCapture(command, args, { maxChars = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxChars) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxChars) stderr += chunk;
    });
    child.once('error', rejectPromise);
    child.once('close', (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(`${command} exited with code ${code}: ${stderr.trim() || 'unknown error'}`));
    });
  });
}

export async function probeMedia(filePath) {
  const { stdout } = await runAndCapture('ffprobe', [
    '-v', 'error',
    '-show_entries',
    'format=format_name,duration,size:stream=index,codec_type,codec_name,profile,pix_fmt,width,height,channels,channel_layout',
    '-of', 'json',
    filePath
  ]);

  const payload = JSON.parse(stdout);
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  return {
    formatName: payload.format?.format_name || '',
    durationSeconds: Number(payload.format?.duration || 0),
    size: Number(payload.format?.size || 0),
    video: streams.find((stream) => stream.codec_type === 'video') || null,
    audio: streams.find((stream) => stream.codec_type === 'audio') || null
  };
}

export function assessSafePlaybackProfile(probe) {
  const containers = new Set(String(probe.formatName || '').split(',').filter(Boolean));
  const mp4Container = ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'].some((name) => containers.has(name));
  const videoReady = probe.video?.codec_name === 'h264'
    && ['yuv420p', 'yuvj420p'].includes(probe.video?.pix_fmt);
  const audioReady = !probe.audio || probe.audio.codec_name === 'aac';
  const ready = mp4Container && videoReady && audioReady;

  const reasons = [];
  if (!mp4Container) reasons.push('container would be remuxed to MP4 in the conservative fallback');
  if (!videoReady) reasons.push('video would need H.264 yuv420p for the conservative fallback');
  if (!audioReady) reasons.push(`audio would need AAC instead of ${probe.audio?.codec_name || 'unknown'}`);

  return {
    ready,
    mp4Container,
    videoReady,
    audioReady,
    note: ready ? 'Conservative fallback profile ready.' : reasons.join('; ')
  };
}

// Backwards-compatible export for older tests and integrations. The runtime no longer
// treats this conservative profile as a statement about one specific browser.
export function assessChromeCompatibility(probe) {
  return assessSafePlaybackProfile(probe);
}

export function normalizePlaybackRepairMode(value) {
  const mode = String(value || 'safe').toLowerCase();
  if (!PLAYBACK_REPAIR_MODES.has(mode)) {
    throw new Error(`Unknown playback repair mode: ${mode}`);
  }
  return mode;
}

export function buildPlaybackRepairPlan(inputPath, probe, repairMode = 'safe') {
  const mode = normalizePlaybackRepairMode(repairMode);
  const sourceExtension = extname(inputPath).toLowerCase() || '.mp4';
  const safeProfile = assessSafePlaybackProfile(probe);

  if (!probe.video) throw new Error('No video stream was found in this file.');
  if (mode === 'audio' && !probe.audio) {
    throw new Error('No audio stream was found, so there is no audio track to repair.');
  }

  if (mode === 'remux') {
    return {
      mode,
      targetExtension: '.mp4',
      videoAction: 'copy',
      audioAction: probe.audio ? 'copy' : 'none',
      note: 'Light repair: rewrap the existing video and audio streams into MP4 without re-encoding.'
    };
  }

  if (mode === 'audio') {
    return {
      mode,
      targetExtension: sourceExtension,
      videoAction: 'copy',
      audioAction: 'aac',
      note: 'Minimal repair: keep the working picture and current container, and convert only audio to AAC.'
    };
  }

  if (mode === 'video') {
    return {
      mode,
      targetExtension: sourceExtension,
      videoAction: 'h264',
      audioAction: probe.audio ? 'copy' : 'none',
      note: 'Minimal repair: keep the working audio and current container, and convert only video to H.264.'
    };
  }

  return {
    mode,
    targetExtension: '.mp4',
    videoAction: safeProfile.videoReady ? 'copy' : 'h264',
    audioAction: !probe.audio ? 'none' : safeProfile.audioReady ? 'copy' : 'aac',
    note: 'Safest fallback: use MP4 while copying any stream that already matches the conservative H.264/AAC profile.'
  };
}

function makePaths(inputPath, targetExtension) {
  const parsed = parse(inputPath);
  const stamp = `${Date.now()}-${process.pid}`;
  const normalizedExtension = targetExtension.startsWith('.') ? targetExtension : `.${targetExtension}`;
  const outputPath = extname(inputPath).toLowerCase() === normalizedExtension
    ? inputPath
    : join(parsed.dir, `${parsed.name}${normalizedExtension}`);
  const tempPath = join(parsed.dir, `.${parsed.name}.owc-processing-${stamp}${normalizedExtension}`);
  const backupPath = join(parsed.dir, `.${basename(inputPath)}.owc-backup-${stamp}`);
  return { outputPath, tempPath, backupPath };
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function runFfmpeg(inputPath, tempPath, probe, plan, onProgress) {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-i', inputPath,
      '-map', '0:v:0',
      '-map', '0:a:0?'
    ];

    if (plan.videoAction === 'copy') {
      args.push('-c:v', 'copy');
    } else {
      args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p');
    }

    if (plan.audioAction === 'none') {
      args.push('-an');
    } else if (plan.audioAction === 'copy') {
      args.push('-c:a', 'copy');
    } else {
      const audioBitrate = Number(probe.audio?.channels || 2) > 2 ? '384k' : '192k';
      args.push('-c:a', 'aac', '-b:a', audioBitrate);
    }

    args.push('-map_metadata', '0', '-map_chapters', '0');
    if (['.mp4', '.m4v', '.mov'].includes(plan.targetExtension)) {
      args.push('-movflags', '+faststart');
    }
    args.push('-progress', 'pipe:1', '-nostats', tempPath);

    const child = spawn('ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdoutBuffer = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        const separator = line.indexOf('=');
        if (separator === -1) continue;
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1);
        if (key === 'out_time_us' && probe.durationSeconds > 0) {
          const percent = Math.max(0, Math.min(99, Number(value) / 1_000_000 / probe.durationSeconds * 100));
          onProgress?.({ percent: Number(percent.toFixed(1)) });
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 2 * 1024 * 1024) stderr += chunk;
    });
    child.once('error', rejectPromise);
    child.once('close', (code) => {
      if (code === 0) {
        onProgress?.({ percent: 99 });
        resolvePromise();
      } else {
        rejectPromise(new Error(`FFmpeg exited with code ${code}: ${stderr.trim() || 'unknown error'}`));
      }
    });
  });
}

function sameCodec(left, right) {
  return String(left || '') === String(right || '');
}

function verifyPlaybackRepair(initialProbe, outputProbe, plan) {
  if (!outputProbe.video) throw new Error('Prepared file lost its video stream.');

  if (plan.mode === 'safe') {
    const safeProfile = assessSafePlaybackProfile(outputProbe);
    if (!safeProfile.ready) {
      throw new Error(`Prepared file did not pass the conservative fallback verification: ${safeProfile.note}`);
    }
    return;
  }

  if (plan.mode === 'remux') {
    const containers = new Set(String(outputProbe.formatName || '').split(',').filter(Boolean));
    if (!['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'].some((name) => containers.has(name))) {
      throw new Error('Remuxed file was not recognized as an MP4-family container.');
    }
    if (!sameCodec(initialProbe.video?.codec_name, outputProbe.video?.codec_name)) {
      throw new Error('Remux unexpectedly changed the video codec.');
    }
    if (initialProbe.audio && !sameCodec(initialProbe.audio.codec_name, outputProbe.audio?.codec_name)) {
      throw new Error('Remux unexpectedly changed the audio codec.');
    }
    return;
  }

  if (plan.mode === 'audio') {
    if (outputProbe.audio?.codec_name !== 'aac') {
      throw new Error('Audio-only repair did not produce AAC audio.');
    }
    if (!sameCodec(initialProbe.video?.codec_name, outputProbe.video?.codec_name)) {
      throw new Error('Audio-only repair unexpectedly changed the video codec.');
    }
    return;
  }

  if (plan.mode === 'video') {
    if (outputProbe.video?.codec_name !== 'h264' || !['yuv420p', 'yuvj420p'].includes(outputProbe.video?.pix_fmt)) {
      throw new Error('Video-only repair did not produce H.264 yuv420p video.');
    }
    if (initialProbe.audio && !sameCodec(initialProbe.audio.codec_name, outputProbe.audio?.codec_name)) {
      throw new Error('Video-only repair unexpectedly changed the audio codec.');
    }
  }
}

async function replaceOriginal({ inputPath, outputPath, tempPath, backupPath }) {
  if (outputPath !== inputPath && await pathExists(outputPath)) {
    throw new Error(`Cannot replace the source because ${basename(outputPath)} already exists.`);
  }

  await rename(inputPath, backupPath);
  try {
    await rename(tempPath, outputPath);
    await rm(backupPath, { force: true });
  } catch (error) {
    if (await pathExists(outputPath)) await rm(outputPath, { force: true });
    await rename(backupPath, inputPath);
    throw error;
  }
}

export async function prepareMediaPlayback(inputPath, { repairMode = 'safe', onProgress } = {}) {
  const initialProbe = await probeMedia(inputPath);
  const plan = buildPlaybackRepairPlan(inputPath, initialProbe, repairMode);
  const paths = makePaths(inputPath, plan.targetExtension);
  await rm(paths.tempPath, { force: true });

  try {
    await runFfmpeg(inputPath, paths.tempPath, initialProbe, plan, onProgress);
    const outputProbe = await probeMedia(paths.tempPath);
    verifyPlaybackRepair(initialProbe, outputProbe, plan);

    const subtitleTracks = await readSubtitleBundle(inputPath);
    await replaceOriginal({ inputPath, ...paths });
    onProgress?.({ percent: 100 });

    return {
      changed: true,
      repairMode: plan.mode,
      repairPlan: plan,
      outputPath: paths.outputPath,
      probe: outputProbe,
      assessment: assessSafePlaybackProfile(outputProbe),
      subtitleTracks,
      subtitleStatus: subtitleTracks.length ? 'ready' : 'no_saved_subtitles'
    };
  } catch (error) {
    await rm(paths.tempPath, { force: true });
    throw error;
  }
}

// Backwards-compatible entry point. New callers should use prepareMediaPlayback and
// pass an explicit symptom-guided repairMode.
export async function prepareMediaForChrome(inputPath, options = {}) {
  return prepareMediaPlayback(inputPath, {
    ...options,
    repairMode: options.repairMode || 'safe'
  });
}
