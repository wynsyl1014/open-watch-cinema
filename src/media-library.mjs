import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

import { readSubtitleBundle } from './media-subtitles.mjs';

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
  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(absolutePath, results);
      continue;
    }
    if (!entry.isFile() || !VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    results.push(absolutePath);
  }
}

async function readAiPackage(aiPackagesRoot, mediaId) {
  if (!aiPackagesRoot) return null;
  try {
    const manifest = JSON.parse(await readFile(join(resolve(aiPackagesRoot), mediaId, 'manifest.json'), 'utf8'));
    if (manifest?.packageKind !== 'open-watch-cinema-ai-package') return null;
    return {
      status: manifest.status || 'unknown',
      progress: manifest.progress || null,
      visualTrack: manifest.visualTrack || null,
      dialogueTrack: manifest.dialogueTrack || null,
      audioTrack: manifest.audioTrack || { status: 'not_prepared' },
      aiReadiness: manifest.aiReadiness || null,
      packageRef: `ai-packages/${mediaId}`,
      updatedAt: manifest.updatedAt || null
    };
  } catch (error) {
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
      packageRef: `ai-packages/${mediaId}`,
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
    const id = createMediaId(relativePath);
    items.push({
      id,
      title: displayTitle(relativePath),
      relativePath,
      absolutePath,
      extension: extname(relativePath).toLowerCase(),
      size: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
      subtitleTracks: await readSubtitleBundle(absolutePath),
      aiPackage: await readAiPackage(aiPackagesRoot, id)
    });
  }

  items.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  return items;
}
