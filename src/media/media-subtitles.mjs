import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { withSubtitleWriteLock } from './subtitle-write-lock.mjs';
import { info, writeJson, problem } from './library-files.mjs';
import { basename, dirname, extname, join, parse, resolve } from 'node:path';

export const SIDECAR_EXTENSIONS = new Set(['.vtt','.srt','.ass','.ssa']);

const TEXT_SUBTITLE_CODECS = new Set([
  'ass', 'ssa', 'eia_608', 'jacosub', 'microdvd', 'mov_text', 'mpl2', 'pjs',
  'realtext', 'sami', 'stl', 'subrip', 'srt', 'subviewer', 'subviewer1', 'text',
  'vplayer', 'webvtt'
]);

function runAndCapture(command, args, { maxChars = 8 * 1024 * 1024, onOutput } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      onOutput?.(chunk);
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

function normalizeTags(tags = {}) {
  return Object.fromEntries(
    Object.entries(tags).map(([key, value]) => [key.toLowerCase(), String(value)])
  );
}

function subtitleLabel(stream, ordinal) {
  return stream.tags.title
    || stream.tags.language
    || `Subtitle ${ordinal + 1}`;
}

export function subtitleBundleDirectory(mediaPath) {
  const parsed = parse(mediaPath);
  if (existsSync(join(parsed.dir, '.cinema.json'))) return join(parsed.dir, '字幕');
  return join(parsed.dir, `${parsed.name}.owc-subtitles`);
}

export function isTextSubtitleStream(stream) {
  return TEXT_SUBTITLE_CODECS.has(String(stream?.codecName || '').toLowerCase());
}

async function probeSubtitles(filePath) {
  const { stdout } = await runAndCapture('ffprobe', [
    '-v', 'error',
    '-select_streams', 's',
    '-show_entries', 'format=duration:stream=index,codec_name,codec_long_name:stream_tags=language,title,handler_name:stream_disposition=default,forced,hearing_impaired',
    '-of', 'json',
    filePath
  ]);

  const payload = JSON.parse(stdout || '{}');
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const subtitles = streams.map((stream) => ({
    index: Number(stream.index),
    codecName: stream.codec_name || '',
    codecLongName: stream.codec_long_name || '',
    tags: normalizeTags(stream.tags),
    disposition: {
      default: Boolean(stream.disposition?.default),
      forced: Boolean(stream.disposition?.forced),
      hearingImpaired: Boolean(stream.disposition?.hearing_impaired)
    }
  }));
  return {duration: Number(payload.format?.duration), streams: subtitles};
}

export async function probeSubtitleStreams(path) {
  return (await probeSubtitles(path)).streams;
}

export function describeDialogueSource(subtitleStreams = []) {
  const textStreams = subtitleStreams.filter(isTextSubtitleStream);
  if (textStreams.length > 0) {
    return {
      mode: 'embedded_subtitle_stream',
      extractable: true,
      subtitleStreams,
      textStreams,
      note: 'Timed subtitle text can be extracted without reading it from storyboard pixels.'
    };
  }

  if (subtitleStreams.length > 0) {
    return {
      mode: 'image_subtitle_stream_only',
      extractable: false,
      subtitleStreams,
      textStreams: [],
      note: 'Subtitle streams exist, but they are image-based and cannot become timed text without recognition.'
    };
  }

  return {
    mode: 'no_embedded_subtitle_stream',
    extractable: false,
    subtitleStreams: [],
    textStreams: [],
    note: 'No separate subtitle stream is present. Visible subtitles, if any, are likely burned into the video image and need another dialogue source such as sidecar subtitles, audio transcription, or subtitle-region OCR.'
  };
}

export function createDialogueTrackState(assessment) {
  if (!assessment) {
    return {
      status: 'unassessed',
      sourceMode: 'unknown',
      extractable: false,
      subtitleStreams: [],
      resultRef: null,
      note: 'Dialogue source has not been inspected yet.'
    };
  }

  return {
    status: assessment.extractable ? 'source_detected' : 'source_missing',
    sourceMode: assessment.mode,
    extractable: assessment.extractable,
    subtitleStreams: assessment.subtitleStreams,
    resultRef: null,
    note: assessment.note
  };
}

export async function assessDialogueSource(filePath) {
  return describeDialogueSource(await probeSubtitleStreams(filePath));
}

async function readManifestTracks(bundleDirectory) {
  let manifest;
  try {
    const path = join(bundleDirectory, 'manifest.json');
    if (!(await lstat(path)).isFile()) throw new Error('字幕清单应为普通文件。');
    manifest = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  if (manifest?.kind !== 'open-watch-cinema-subtitle-bundle' || !Array.isArray(manifest.tracks)) {
    return [];
  }

  const tracks = [];
  for (const track of manifest.tracks) {
    const fileName = String(track.fileName || '');
    if (!fileName || basename(fileName) !== fileName || !fileName.toLowerCase().endsWith('.vtt')) continue;
    const absolutePath = resolve(bundleDirectory, fileName);
    if (dirname(absolutePath) !== resolve(bundleDirectory) || !(await lstat(absolutePath).catch(() => null))?.isFile()) continue;
    tracks.push({
      id: String(track.id || ''),
      streamIndex: Number(track.streamIndex),
      sourceCodec: String(track.sourceCodec || ''),
      language: String(track.language || 'und'),
      title: track.title ? String(track.title) : null,
      label: String(track.label || track.title || track.language || 'Subtitle'),
      default: Boolean(track.default),
      forced: Boolean(track.forced),
      hearingImpaired: Boolean(track.hearingImpaired),
      format: 'webvtt',
      fileName,
      absolutePath
    });
  }
  return tracks;
}

const activeWrites = new Map();
const sidecarReads = new Map();
const STAGING = '.owc-subtitle-batch';

function serialize(mediaPath, fn, queue = activeWrites) {
  const key = resolve(subtitleBundleDirectory(mediaPath));
  const run = queue === activeWrites ? () => withSubtitleWriteLock(key,fn) : fn;
  const operation = (queue.get(key) || Promise.resolve()).catch(() => {}).then(run);
  queue.set(key, operation);
  return operation.finally(() => {
    if (queue.get(key) === operation) queue.delete(key);
  });
}

async function checkDirectory(path, create = false) {
  let entry = await info(path);
  if (!entry && create) {
    await mkdir(path, { recursive: true });
    entry = await lstat(path);
  }
  if (entry && !entry.isDirectory()) throw problem('字幕目录无效：' + basename(path));
  return Boolean(entry);
}

function locations(mediaPath) {
  const root = subtitleBundleDirectory(mediaPath);
  const managed = basename(root) === '字幕';
  return { root, managed, embedded: managed ? join(root, '.embedded') : root };
}

export function subtitleLanguageGroup(tags = {}) {
  const language = String(tags.language || '').trim().toLowerCase().replaceAll('_','-');
  const title = [tags.title, tags.handler_name].filter(Boolean).join(' ').toLowerCase();
  const chinese = /^(?:zho|chi|zh|cmn|yue)(?:-|$)/.test(language);
  const english = /^(?:eng|en)(?:-|$)/.test(language);
  if (english) return 'en';
  if (!chinese && language && !['und','mul'].includes(language)) return 'other';
  if (/(?:^|-)(?:hans|chs|cn|sg)(?:-|$)/.test(language)) return 'zh-Hans';
  if (/(?:^|-)(?:hant|cht|tw|hk|mo)(?:-|$)/.test(language)) return 'zh-Hant';
  const mainland = (chinese || /中文|\bchinese\b/.test(title)) && /\bmainland\b/.test(title);
  const simplified = mainland || /简体|簡體|简中|簡中|简字|simplified|mainland china|zh[-_]hans|zh[-_]cn|chs\b/.test(title);
  const traditional = /繁體|繁体|繁中|繁字|traditional|hong kong|taiwan|香港|台灣|台湾|zh[-_]hant|zh[-_]tw|cht\b/.test(title);
  if (simplified !== traditional) return simplified ? 'zh-Hans' : 'zh-Hant';
  if (chinese || simplified || /中文|chinese/.test(title)) return 'zh';
  return /\benglish\b/.test(title) ? 'en' : 'other';
}

function describeStream(stream, ordinal) {
  return { id: 'stream-' + stream.index, streamIndex: stream.index,
    language: stream.tags.language || 'und', title: stream.tags.title || null,
    label: subtitleLabel(stream, ordinal), sourceCodec: stream.codecName,
    extractable: isTextSubtitleStream(stream), languageGroup: subtitleLanguageGroup(stream.tags),
    ...stream.disposition, format: 'webvtt' };
}

async function savedTracks(mediaPath) {
  const { root, managed, embedded } = locations(mediaPath);
  if (!await checkDirectory(root)) return { embedded: [], external: [] };
  const current = await checkDirectory(embedded) ? await readManifestTracks(embedded) : [];
  const legacy = managed ? await readManifestTracks(root) : [];
  const owned = new Set(legacy.map(track => track.fileName));
  const external = [];
  if (managed) for (const entry of await readdir(root,{withFileTypes:true})) {
    const name = entry.name;
    const ext = extname(name).toLowerCase();
    if (!entry.isFile() || name.startsWith('.') || owned.has(name) || !SIDECAR_EXTENSIONS.has(ext)) continue;
    const id = 'sidecar-' + createHash('sha256').update(name).digest('hex').slice(0,24);
    external.push({id,streamIndex:null,sourceCodec:ext.slice(1),language:'und',title:name,label:name,
      default:false,forced:false,format:'webvtt',fileName:name,absolutePath:join(root,name)});
  }
  return { embedded: [...current,...legacy], external };
}

function distinctTracks(tracks) {
  const seen = new Set();
  return tracks.filter(track => {
    if (seen.has(track.id)) return false;
    seen.add(track.id);
    return true;
  });
}

function cachePaths(track, version) {
  const hash = createHash('sha256').update([track.fileName,version.size,version.mtimeMs,version.ctimeMs].join('/')).digest('hex');
  const dir = join(dirname(track.absolutePath),'.webvtt');
  return {dir, current:join(dir,track.id+'-'+hash+'.vtt'),legacy:join(dir,hash+'.vtt')};
}

export function readSubtitleBundle(mediaPath) {
  return serialize(mediaPath, () => readPlayableTracks(mediaPath), sidecarReads);
}

async function readPlayableTracks(mediaPath) {
  const saved = await savedTracks(mediaPath);
  const tracks = distinctTracks(saved.embedded);
  for (const track of saved.external) {
    if (track.sourceCodec === 'vtt') {
      tracks.push(track);
      continue;
    }
    const cache = cachePaths(track, await lstat(track.absolutePath));
    await checkDirectory(cache.dir, true);
    const target = (await info(cache.legacy))?.isFile() ? cache.legacy : cache.current;
    const cached = await info(target);
    if (!cached) {
      const temp = join(dirname(target),randomUUID()+'.vtt');
      try {
        await runAndCapture('ffmpeg',['-nostdin','-v','error','-i',track.absolutePath,'-f','webvtt',temp]);
        await rename(temp,target);
      } catch { continue; }
      finally { await rm(temp,{force:true}); }
    } else if (!cached.isFile()) continue;
    tracks.push({...track,absolutePath:target});
  }
  return tracks;
}

export async function readSavedEmbeddedSubtitles(mediaPath) {
  return distinctTracks((await savedTracks(mediaPath)).embedded);
}

export async function inspectFilmSubtitles(mediaPath) {
  let probeError = null;
  const [streams, saved] = await Promise.all([
    probeSubtitleStreams(mediaPath).catch(error => {
      probeError = '无法读取片源内嵌轨道：' + error.message;
      return [];
    }),
    savedTracks(mediaPath)
  ]);
  const savedIds = new Set(saved.embedded.map(track => track.id));
  const embedded = streams.map((stream, i) => {
    const track = describeStream(stream,i);
    return {...track, saved:savedIds.has(track.id)};
  });
  for (const {absolutePath, ...track} of distinctTracks(saved.embedded)) {
    if (!embedded.some(row => row.id === track.id)) {
      embedded.push({...track,saved:true,extractable:false,languageGroup:subtitleLanguageGroup(track)});
    }
  }
  return {embedded,probeError,external:saved.external.map(({absolutePath,...track}) => ({...track, saved:true, extractable:false}))};
}

async function recoverBatch(mediaPath) {
  const {root,embedded} = locations(mediaPath);
  if (!await checkDirectory(root) || !await checkDirectory(embedded)) return false;
  const staging = join(embedded,STAGING);
  if (!await checkDirectory(staging)) return false;
  const published = new Set((await readManifestTracks(embedded)).map(track => track.fileName));
  const journal = join(staging,'install.json');
  const files = (await info(journal))?.isFile() ? JSON.parse(await readFile(journal,'utf8')) : [];
  let committed = false;
  for (const {fileName, dev, ino} of files) {
    if (!/^track-[a-f0-9-]{36}\.vtt$/.test(fileName)) throw problem('字幕批次文件名无效。');
    const candidate = join(embedded,fileName);
    if (!await info(candidate)) continue;
    const installed = await lstat(candidate,{bigint:true});
    if (!installed.isFile() || String(installed.dev) !== dev || String(installed.ino) !== ino) continue;
    if (published.has(fileName)) committed = true;
    else await rm(candidate);
  }
  await rm(staging,{recursive:true});
  return !committed;
}

export function recoverSubtitleExtraction(mediaPath) {
  return serialize(mediaPath, () => recoverBatch(mediaPath));
}

export function extractSubtitleStreams(inputPath, {outputMediaPath=inputPath,trackIds,languages,onProgress,onSelected} = {}) {
  return serialize(outputMediaPath,async () => {
    await recoverBatch(outputMediaPath);
    const {duration,streams} = await probeSubtitles(inputPath);
    const rows = streams.map(describeStream);
    const saved = await savedTracks(outputMediaPath);
    if (trackIds?.some(id => !rows.some(row => row.id === id && row.extractable))) throw problem('所选内嵌轨道已改变，请重新读取。');
    const selected = rows.filter(row => {
      if (!row.extractable || saved.embedded.some(track => track.id === row.id)) return false;
      if (trackIds) return trackIds.includes(row.id);
      if (!languages) return true;
      if (row.languageGroup === 'zh') return languages.includes('zh-Hans') && languages.includes('zh-Hant');
      return languages.includes(row.languageGroup);
    });
    const {root,embedded} = locations(outputMediaPath);
    await onSelected?.(selected.map(track => track.id));
    if (selected.length) {
      await checkDirectory(root,true);
      await checkDirectory(embedded,true);
      const staging = join(embedded,STAGING);
      await mkdir(staging);
      try {
        const tracks = selected.map(({extractable,languageGroup,...track}) => ({...track,fileName:'track-'+randomUUID()+'.vtt'}));
        const args = ['-nostdin','-hide_banner','-v','error','-progress','pipe:1','-nostats','-i',inputPath];
        for (const track of tracks) args.push('-map','0:'+track.streamIndex,'-c:s','webvtt',join(staging,track.fileName));
        let buffer = '';
        await runAndCapture('ffmpeg',args,{onOutput(chunk) {
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop();
          for (const line of lines) {
            if (line.startsWith('out_time_us=') && duration > 0) {
              const us = Number(line.slice(12));
              if (Number.isFinite(us)) onProgress?.({percent:Math.max(0,Math.min(99,Math.floor(us/10000/duration)))});
            }
          }
        }});
        const files = [];
        for (const {fileName} of tracks) {
          const handle = await open(join(staging,fileName),'r+');
          try {
            await handle.sync();
            const identity = await handle.stat({bigint:true});
            files.push({fileName,dev:String(identity.dev),ino:String(identity.ino)});
          } finally { await handle.close(); }
        }
        // On restart, roll back only unpublished files still bearing their original identity.
        await writeJson(join(staging,'install.json'),files);
        for (const {fileName} of files) {
          if (await info(join(embedded,fileName))) throw problem('字幕文件名冲突，请重试。');
          await rename(join(staging,fileName),join(embedded,fileName));
        }
        const existing = await readManifestTracks(embedded);
        const nextManifest = join(staging,'manifest.json');
        await writeJson(nextManifest,{
          version:1,kind:'open-watch-cinema-subtitle-bundle',sourceFileName:basename(inputPath),
          targetMediaFileName:basename(outputMediaPath),createdAt:new Date().toISOString(),
          tracks:[...existing.map(({absolutePath,...track}) => track),...tracks]
        });
        await rename(nextManifest,join(embedded,'manifest.json'));
      } finally { await recoverBatch(outputMediaPath); }
    }
    const result = distinctTracks((await savedTracks(outputMediaPath)).embedded);
    onProgress?.({percent:100});
    return {status:result.length?'ready':streams.length?'no_selected_tracks':'no_subtitles',
      tracks:result,subtitleStreams:streams,bundleDirectory:result.length?embedded:null};
  });
}

export function deleteFilmSubtitles(mediaPath, trackIds) {
  return serialize(mediaPath, () => serialize(mediaPath, () => removeSelectedTracks(mediaPath,trackIds), sidecarReads));
}

async function removeSelectedTracks(mediaPath,trackIds) {
  const saved = await savedTracks(mediaPath);
  const selected = new Set(trackIds);
  const all = [...saved.embedded,...saved.external];
  if ([...selected].some(id => !all.some(track => track.id === id))) throw problem('字幕清单已改变，请重新读取。');
  const paths = new Set();
  const cacheIds = new Set();
  let cacheDirectory;
  for (const track of all.filter(row => selected.has(row.id))) {
    if (all.some(other => !selected.has(other.id) && other.absolutePath === track.absolutePath)) continue;
    paths.add(track.absolutePath);
    if (saved.external.includes(track) && track.sourceCodec !== 'vtt') {
      const cache = cachePaths(track,await lstat(track.absolutePath));
      cacheIds.add(track.id);
      cacheDirectory = cache.dir;
      paths.add(cache.legacy);
    }
  }
  if (cacheDirectory && await checkDirectory(cacheDirectory)) {
    for (const entry of await readdir(cacheDirectory,{withFileTypes:true})) {
      const owned = /^(sidecar-[a-f0-9]{24})-[a-f0-9]{64}\.vtt$/.exec(entry.name);
      if (entry.isFile() && owned && cacheIds.has(owned[1])) paths.add(join(cacheDirectory,entry.name));
    }
  }
  for (const path of paths) if ((await info(path))?.isFile()) await rm(path,{force:true});
  for (const dir of new Set(saved.embedded.filter(row => selected.has(row.id)).map(row => dirname(row.absolutePath)))) {
    const manifestPath = join(dir,'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath,'utf8'));
    manifest.tracks = manifest.tracks.filter(track => !selected.has(track.id));
    await writeJson(manifestPath,manifest);
  }
}
