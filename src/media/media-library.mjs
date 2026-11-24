import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

import { META, PACKAGE, SUBS, info, json } from './library-files.mjs';
import { readSubtitleBundle } from './media-subtitles.mjs';
import { needsStoryboardUpgrade } from '../visuals/image-settings.mjs';
import { normalizeSkipRanges } from './skip-ranges.mjs';

export const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.webm', '.mov', '.mkv']);

function toPortableRelativePath(root, absolutePath) {
  return relative(root, absolutePath).split(sep).join('/');
}

export function createMediaId(relativePath) {
  return createHash('sha256').update(relativePath.toLowerCase()).digest('hex').slice(0, 24);
}

function displayTitle(relativePath) {
  const fileName = relativePath.split('/').at(-1) || relativePath;
  const extension = extname(fileName);
  return fileName.slice(0, extension ? -extension.length : undefined).replace(/[._-]+/g, ' ').trim();
}

async function walkDirectory(directory, results) {
  const entries = await readdir(directory, { withFileTypes: true });
  const managed = entries.some(entry => entry.name === META && entry.isFile());
  for (const entry of entries) {
    if (entry.name.startsWith('.') || /\.owc-(?:subtitles|processing.*|backup.*)$/i.test(entry.name)) continue;
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!managed && ![SUBS, PACKAGE].includes(entry.name)) await walkDirectory(absolutePath, results);
      continue;
    }
    if (!entry.isFile() || !VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    results.push(absolutePath);
  }
}

export async function readAiPackage(aiPackagesRoot, mediaId, { signal, packagePath = null } = {}) {
  if (!aiPackagesRoot && !packagePath) return null;
  try {
    signal?.throwIfAborted();
    const manifestPath = join(packagePath || join(resolve(aiPackagesRoot), mediaId), 'manifest.json');
    const manifestFile = await info(manifestPath);
    if (!manifestFile) return null;
    if (!manifestFile.isFile()) throw new Error('观影包清单应为普通文件。');
    const manifest = JSON.parse(await readFile(manifestPath, { encoding: 'utf8', signal }));
    signal?.throwIfAborted();
    if (manifest?.packageKind !== 'open-watch-cinema-ai-package') return null;
    const packageVersion = manifest.packageVersion ?? 1;
    const viewingTrack = packageVersion === 3 ? manifest.viewingTrack || null : null;
    const visualThroughMs = viewingTrack?.visualPreparedThroughMs || 0;
    const initialTargetMs = Math.min(viewingTrack?.initialBufferMs ?? manifest.durationMs, manifest.durationMs);
    const reducedAudio = ['unavailable', 'failed'].includes(manifest.audioTrack?.status);
    const canStartViewing = manifest.packageVersion === 3
      ? Boolean(viewingTrack?.initialBufferReady || viewingTrack?.status === 'ready'
        || (reducedAudio && visualThroughMs >= initialTargetMs))
      : manifest.status === 'ready';
    return {
      packageVersion,
      needsStoryboardUpgrade: needsStoryboardUpgrade(packageVersion),
      durationMs: manifest.durationMs || null,
      ...(Array.isArray(manifest.skipRanges) && { skipRanges: normalizeSkipRanges(manifest.skipRanges, manifest.durationMs) }),
      viewingIntervalMs: manifest.viewingIntervalMs || null,
      viewingTrack,
      imageSettings: manifest.imageSettings || null,
      canStartViewing,
      readable: manifest.packageVersion === 3 ? visualThroughMs > 0 : manifest.status === 'ready',
      status: manifest.status || 'unknown',
      progress: manifest.progress || null,
      visualTrack: manifest.visualTrack || null,
      dialogueTrack: manifest.dialogueTrack || null,
      audioTrack: manifest.audioTrack || { status: 'not_prepared' },
      aiReadiness: manifest.aiReadiness || null,
      packageRef: packagePath ? '观影包' : `ai-packages/${mediaId}`,
      updatedAt: manifest.updatedAt || null
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'ENOENT') return null;
    return {
      status: 'error',
      progress: null,
      visualTrack: null,
      dialogueTrack: null,
      audioTrack: { status: 'unavailable' },
      aiReadiness: {
        status: 'incomplete',
        ready: false,
        experienceMode: 'raw',
        blockers: ['package_manifest_unreadable']
      },
      packageRef: packagePath ? '观影包' : `ai-packages/${mediaId}`,
      error: error.message
    };
  }
}

export async function scanMediaDirectory(mediaRoot, { aiPackagesRoot = null } = {}) {
  const absoluteRoot = resolve(mediaRoot);
  const files = [];
  await walkDirectory(absoluteRoot, files);

  const items = [];
  for (const absolutePath of files) {
    const fileStat = await stat(absolutePath);
    const relativePath = toPortableRelativePath(absoluteRoot, absolutePath);
    const dir = dirname(absolutePath);
    const metaPath = join(dir,META);
    const meta = (await info(metaPath))?.isFile() ? await json(metaPath) : null;
    const id = meta?.id || createMediaId(relativePath);
    items.push({
      id,
      title: meta ? basename(dir) : displayTitle(relativePath),
      relativePath,
      absolutePath,
      extension: extname(relativePath).toLowerCase(),
      size: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
      subtitleTracks: await readSubtitleBundle(absolutePath),
      aiPackage: await readAiPackage(aiPackagesRoot, id, { packagePath: meta ? join(dir,PACKAGE) : null })
    });
  }

  items.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  return items;
}
