import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '../..');
const root = await mkdtemp(join(tmpdir(), 'owc-ai-pipeline-smoke-'));
const mediaRoot = join(root, 'media');
const mediaPath = join(root, 'fixture.mp4');
const subtitlePath = join(root, 'fixture.srt');
const port = 4600 + Math.floor(Math.random() * 250);
const baseUrl = `http://127.0.0.1:${port}`;
let server;
let serverError = '';

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForHealth() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { cache: 'no-store' });
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  throw new Error('Temporary cinema server did not become healthy.');
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${path} returned ${response.status}`);
  return payload;
}

async function waitForJob(jobId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let job;
  do {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    job = (await fetchJson(`/api/jobs/${jobId}`)).job;
    if (job.status === 'error') throw new Error(job.error || 'Preparation job failed.');
  } while (job.status !== 'done' && Date.now() < deadline);
  if (job?.status !== 'done') throw new Error('Preparation job timed out.');
  return job;
}

try {
  await mkdir(mediaRoot, { recursive: true });
  await writeFile(subtitlePath, [
    '1',
    '00:00:00,150 --> 00:00:00,850',
    'A tiny dialogue fixture.',
    ''
  ].join('\n'), 'utf8');

  const generated = spawnSync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'color=c=black:s=320x180:r=24:d=1.2',
    '-f', 'lavfi',
    '-i', 'sine=frequency=440:duration=1.2',
    '-f', 'srt',
    '-i', subtitlePath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-map', '2:s:0',
    '-shortest',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-c:s', 'mov_text',
    '-metadata:s:s:0', 'language=eng',
    '-metadata:s:s:0', 'title=English',
    '-disposition:s:0', 'default',
    mediaPath
  ], { windowsHide: true, encoding: 'utf8' });
  if (generated.status !== 0) throw new Error(generated.stderr || 'FFmpeg fixture generation failed.');

  server = spawn(process.execPath, ['server.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      LOCAL_DATA_ROOT: root,
      PORT: String(port),
      OPEN_BROWSER: '0'
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.setEncoding('utf8');
  server.stderr.on('data', (chunk) => { serverError += chunk; });
  await waitForHealth();

  const mediaPayload = await fetchJson('/api/library/import?name=fixture.mp4', {
    method: 'POST', body: await readFile(mediaPath), headers: { 'content-type': 'application/octet-stream' }
  });
  const item = mediaPayload.items.find((candidate) => candidate.title === 'fixture');
  if (!item) throw new Error('Fixture media was not indexed.');

  const compatibilityStarted = await fetchJson(`/api/media/${item.id}/prepare`, {
    method: 'POST'
  });
  await waitForJob(compatibilityStarted.job.id);

  await fetchJson('/api/viewing-settings', { method: 'POST', body: JSON.stringify({ includeAudio: false }) });
  const started = await fetchJson(`/api/media/${item.id}/prepare-ai`, {
    method: 'POST',
    body: JSON.stringify({})
  });
  const job = await waitForJob(started.job.id);

  const refreshed = await fetchJson('/api/media');
  const readyItem = refreshed.items.find((candidate) => candidate.id === item.id);
  if (readyItem?.aiPackage?.status !== 'ready') throw new Error('AI package was not indexed as ready.');
  const sourcePath = join(mediaRoot, readyItem.relativePath);
  const packageDir = join(dirname(sourcePath), '观影包');
  const manifest = JSON.parse(await readFile(join(packageDir, 'manifest.json'), 'utf8'));
  const chunk = manifest.chunks[0];
  if (manifest.imageSettings?.mode !== 'balanced' || !chunk?.viewingRef || !chunk?.storyboardRootRef) {
    throw new Error('Chunk-local visual/dialogue/storyboard references are incomplete.');
  }
  const viewing = JSON.parse(await readFile(join(packageDir, chunk.viewingRef), 'utf8'));
  const cues = viewing.segments.flatMap(section => section.entries).filter(entry => entry.type === 'dialogue');
  if (!cues.some((cue) => cue.text.includes('tiny dialogue fixture'))) {
    throw new Error('Timed dialogue did not reach the chunk package.');
  }

  const opened = await fetchJson('/api/rooms/open', {
    method: 'POST',
    body: JSON.stringify({ mediaId: item.id })
  });
  await fetchJson(`/api/rooms/${opened.room.id}/playback`, {
    method: 'POST', body: JSON.stringify({ mediaTimeMs: 900, playbackState: 'paused' })
  });
  const windowPayload = await fetchJson(
    `/api/rooms/${opened.room.id}/ai-window?fromMs=0&toMs=1200&playheadMs=900&lookaheadMs=300&maxItems=24&maxDialogueItems=80`
  );
  if (!windowPayload.window.dialogue.some((cue) => cue.text.includes('tiny dialogue fixture'))) {
    throw new Error('Room AI window did not expose the spoiler-gated dialogue track.');
  }
  if (!Array.isArray(windowPayload.window.observations)) {
    throw new Error('Room AI window did not expose the visual observation track.');
  }
  await fetchJson(`/api/rooms/${opened.room.id}/end`, {
    method: 'POST',
    body: JSON.stringify({ mediaTimeMs: 900 })
  });

  const filmUrl = `/api/media/${item.id}`;
  const roomUrl = `/api/rooms/${opened.room.id}`;
  const preview = (await fetchJson(filmUrl + '/delete-preview')).preview;
  if (!preview.usage.videoBytes || !preview.usage.subtitleBytes || !preview.usage.packageBytes) {
    throw new Error('Space preview must count all linked files.');
  }
  const release = (scope, token) => fetchJson(filmUrl, {
    method: 'DELETE', body: JSON.stringify({scope, confirmMediaId: item.id, token})
  });
  await release('package', preview.token);
  if (!await exists(sourcePath) || await exists(packageDir)) throw new Error('Wrong files released for package scope.');
  const next = (await fetchJson(filmUrl + '/delete-preview')).preview;
  await release('media', next.token);
  if (await exists(sourcePath)) throw new Error('Media release left the original behind.');
  const archive = await fetchJson(roomUrl);
  if (archive.room.mediaAvailable || !archive.messages) throw new Error('Missing-source archive is unavailable.');
  if (!(await fetchJson(roomUrl + '/notebook')).readOnly) throw new Error('Expected archived notebook.');
  await fetchJson(filmUrl + '/relink?name=restored.mp4', {
    method: 'POST', body: await readFile(mediaPath), headers: {'content-type':'application/octet-stream'}
  });
  if (!(await fetchJson(roomUrl)).room.mediaAvailable) throw new Error('Archived film did not reconnect.');
  const {preview: roomPreview} = await fetchJson(roomUrl + '/delete-preview');
  await fetchJson(roomUrl, { method:'DELETE', body:JSON.stringify({confirmRoomId: opened.room.id, revision: roomPreview.revision}) });
  if ((await fetchJson('/api/rooms')).rooms.some(r=>r.id===opened.room.id)) throw new Error('Room still present.');
  if (!(await fetchJson('/api/media')).items.some(f=>f.id===item.id)) throw new Error('Deleting an archive removed its film.');

  console.log(JSON.stringify({
    ok: true,
    mediaId: item.id,
    jobStatus: job.status,
    experienceMode: job.experienceMode,
    chunkLayout: {
      viewingRef: chunk.viewingRef,
      storyboardRootRef: chunk.storyboardRootRef
    },
    dialogueCueCount: cues.length,
    roomWindow: {
      observationCount: windowPayload.window.observations.length,
      dialogueCount: windowPayload.window.dialogue.length,
      revealThroughMs: windowPayload.window.revealThroughMs
    },
    deletePreview: {
      subtitleBytes: preview.usage.subtitleBytes,
      packageBytes: preview.usage.packageBytes,
      sessionCount: preview.records.sessionCount
    },
    archiveRelinkVerified: true
  }, null, 2));
} catch (error) {
  if (server && !server.killed) server.kill();
  throw new Error(`${error.message}${serverError ? `\nServer stderr:\n${serverError}` : ''}`);
} finally {
  if (server && !server.killed) {
    server.kill();
    await new Promise((resolvePromise) => server.once('exit', resolvePromise));
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
