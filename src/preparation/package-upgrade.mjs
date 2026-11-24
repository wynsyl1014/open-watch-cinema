import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, readdir, realpath, rename, rmdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { hashFile, normalizePackageKey, runObservationPrecompute } from './observation-precompute-runner.mjs';
import { createObservationPrecomputeManifest, validateObservationPrecomputeManifest } from './observation-precompute-plan.mjs';
import { composeStoryboardBatch, preparedStoryboardViews } from './observation-manager.mjs';
import { validateAudioPayload } from './audio-descriptions.mjs';
import { imageEntry, orderEntries, viewingAudioPayload, viewingPreparationState, validateViewingChunk } from '../delivery/viewing-package.mjs';
import { normalizeImageSettings } from '../visuals/image-settings.mjs';
import { includedRanges } from '../media/skip-ranges.mjs';

const runFile = promisify(execFile);

const KIND = 'open-watch-cinema-package-upgrade';
function validPackageKey(key) {
  try { return typeof key === 'string' && normalizePackageKey(key) === key; } catch { return false; }
}
const idPattern = /^[a-f0-9-]{36}$/;

async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
async function saveJournal(path, value) {
  const temp = `${path}.tmp-${randomUUID()}`;
  await writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx' });
  await rename(temp, path);
}
async function releaseOwnedLock(packageDir, token) {
  const lock = join(packageDir, '.run-lock');
  try {
    const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
    if (owner.upgradeToken !== token) return;
    await unlink(join(lock, 'owner.json'));
    await rmdir(lock);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
// Recycling is best-effort housekeeping after publication, never part of cutover.
// Invoke only the OS trash service. There is deliberately no filesystem-delete fallback.
async function recycleOldPackage(backupPath, transaction) {
  if (resolve(backupPath) !== join(resolve(transaction), 'old-package')
      || await realpath(transaction) !== resolve(transaction)
      || await realpath(backupPath) !== resolve(backupPath)
      || !(await lstat(backupPath)).isDirectory()) {
    throw new Error('The old package backup path is redirected or invalid.');
  }
  if (process.platform === 'win32') {
    const command = `
$ErrorActionPreference = 'Stop'
$path = [IO.Path]::GetFullPath($env:OWC_RECYCLE_PACKAGE)
if ($path.StartsWith('\\\\')) { throw 'Network folders cannot be recycled safely.' }
$drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($path))
if ($drive.DriveType -ne [IO.DriveType]::Fixed) { throw 'Recycling requires a local fixed drive.' }
$policies = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer')
foreach ($policy in $policies) {
  if ((Get-ItemProperty -LiteralPath $policy -Name NoRecycleFiles -ErrorAction SilentlyContinue).NoRecycleFiles -eq 1) { throw 'The Recycle Bin is disabled by policy.' }
}
$bin = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket'
$settings = @(Get-ItemProperty -LiteralPath $bin -ErrorAction SilentlyContinue)
$settings += @(Get-ChildItem -LiteralPath ($bin + '\\Volume') -ErrorAction SilentlyContinue | Get-ItemProperty -ErrorAction SilentlyContinue)
if ($settings | Where-Object { $_.NukeOnDelete -eq 1 }) { throw 'A drive is configured to bypass the Recycle Bin; the backup will be retained.' }
Add-Type -AssemblyName Microsoft.VisualBasic
[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
  $path,
  [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
  [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,
  [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)
`;
    // Wait for a definite result: terminating an in-flight shell delete makes its outcome uncertain.
    await runFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
      windowsHide: true, env: { ...process.env, OWC_RECYCLE_PACKAGE: backupPath }, maxBuffer: 1024 * 1024
    });
  } else if (process.platform === 'darwin') {
    await runFile('/usr/bin/osascript', ['-e', 'on run argv\n tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)\nend run', backupPath]);
  } else {
    throw new Error('Automatic package recycling is not supported on this system.');
  }
  if (await exists(backupPath)) throw new Error('The operating system left the old package in place.');
}

async function containedFile(packageDir, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('chunks/') || ref.includes('\\') || ref.split('/').some(x => x === '..' || x === '.')) {
    throw new Error('Invalid upgraded package asset reference.');
  }
  const root = await realpath(packageDir);
  const file = await realpath(resolve(root, ref));
  if (!file.startsWith(root + sep)) throw new Error('Upgraded asset escapes its package.');
  const info = await stat(file);
  if (!info.isFile() || info.size === 0) throw new Error('An upgraded package asset is empty or missing.');
  return file;
}

// Check the completed manifest, chunk contracts and every image reference before publication.
async function validateUpgrade(packageDir) {
  const manifest = JSON.parse(await readFile(join(packageDir, 'manifest.json'), 'utf8'));
  validateObservationPrecomputeManifest(manifest);
  if (manifest.packageVersion !== 3 || manifest.status !== 'ready' || manifest.chunks.some(c => c.status !== 'complete')) {
    throw new Error('The upgraded viewing package is not complete.');
  }
  for (const chunk of manifest.chunks) {
    const payload = JSON.parse(await readFile(await containedFile(packageDir, chunk.viewingRef), 'utf8'));
    validateViewingChunk(payload, manifest, chunk);
    if (['ready', 'source_missing'].includes(chunk.audioStatus)) {
      validateAudioPayload(viewingAudioPayload(payload), chunk,
        includedRanges(chunk.logicalStartMs, chunk.logicalEndMs, manifest.skipRanges ?? []));
    }
    normalizeImageSettings(manifest.imageSettings);
    if (await exists(join(packageDir, 'chunks', chunk.chunkId, 'storyboards', 'masters'))) {
      throw new Error('Upgraded viewing packages cannot retain a master directory.');
    }
    for (const segment of payload.segments) for (const entry of segment.entries) {
      if (entry.type !== 'image') continue;
      await containedFile(packageDir, entry.storyboardRef);
      for (const part of entry.parts || []) await containedFile(packageDir, part.ref);
      if (entry.hdFrame || entry.panels?.some(panel => panel.ref)) {
        throw new Error('Upgraded viewing packages cannot retain master images.');
      }
    }
  }
  return manifest;
}

function storyboardSelections(payload) {
  const selections = payload.segments.flatMap(segment => segment.entries
    .filter(entry => entry.type === 'image')
    .map(entry => ({ ...entry, filename: basename(entry.storyboardRef), mediaTimeMs: entry.fromMs })));
  const names = new Set(selections.map(selection => selection.filename));
  let legacyGroup = 0;
  for (const group of payload.omittedGroups || []) {
    let filename = group.filename;
    if (!filename || names.has(filename)) {
      do { filename = `group-${group.mediaTimeMs}-${String(++legacyGroup).padStart(4, '0')}.jpg`; }
      while (names.has(filename));
    }
    names.add(filename);
    selections.push({ ...group, filename });
  }
  return selections.sort((left, right) => left.mediaTimeMs - right.mediaTimeMs
    || left.filename.localeCompare(right.filename));
}

// Reuse timed selections and tracks, then compose their new pictures from the original film.
async function restylePackage(projectRoot, source, staged, old, {
  inputPath, imageSettings, initialBufferMs, includeAudio, onPreparationProgress, sourceRelativePath, sourceMediaId
}) {
  const plan = createObservationPrecomputeManifest({ ...old, imageSettings });
  const manifest = { ...old, planHash: plan.planHash, planId: plan.planId, imageSettings: plan.imageSettings,
    sourceRelativePath: sourceRelativePath ?? old.sourceRelativePath, sourceMediaId: sourceMediaId ?? old.sourceMediaId };
  await mkdir(staged, { recursive: true });
  async function readChunk(chunk) {
    const payload = JSON.parse(await readFile(await containedFile(source, chunk.viewingRef), 'utf8'));
    return validateViewingChunk(payload, old, chunk);
  }
  let previousViews = [];
  for (const chunk of manifest.chunks) {
    previousViews = previousViews.filter(view => view.mediaTimeMs >= chunk.analysisStartMs);
    const payload = await readChunk(chunk);
    const rootRef = `chunks/${chunk.chunkId}/storyboards`;
    const outputDir = join(staged, rootRef);
    await mkdir(outputDir, { recursive: true });
    const groups = storyboardSelections(payload);
    for (const segment of payload.segments) {
      segment.entries = segment.entries.filter(entry => entry.type !== 'image');
    }
    delete payload.omittedGroups;
    for (const span of includedRanges(chunk.analysisStartMs, chunk.acceptToMs, old.skipRanges ?? [])) {
      const selections = groups.filter(group => group.mediaTimeMs >= span.fromMs && group.mediaTimeMs < span.toMs);
      if (!selections.length) continue;
      const requestPath = join(staged, '.compose-request.json');
      const items = selections.map(({ filename, panelTimesMs, frameReason }) => ({ filename, panelTimesMs, frameReason }));
      await writeFile(requestPath, JSON.stringify({
        input: inputPath, outputDir, settings: imageSettings, items,
        previousViews: previousViews.filter(view => view.mediaTimeMs >= span.fromMs),
        ...(old.skipRanges?.length && { decodeEndMs: span.toMs })
      }), { flag: 'wx' });
      try {
        const chunkSpan = Math.max(0, chunk.logicalEndMs - chunk.logicalStartMs);
        const result = await composeStoryboardBatch(projectRoot, requestPath, {
          timeoutMs: 600_000,
          onProgress(event) {
            if (!event || event.phase !== 'compose') return;
            const ratio = event.total > 0 ? Math.max(0, Math.min(1, event.completed / event.total)) : 1;
            const liveThroughMs = Math.round(chunk.logicalStartMs + chunkSpan * ratio);
            const percent = manifest.durationMs > 0
              ? Math.min(98.9, (liveThroughMs / manifest.durationMs) * 99) : 0;
            void Promise.resolve(onPreparationProgress?.({
              preparedThroughMs: liveThroughMs,
              durationMs: manifest.durationMs,
              percent,
              live: true
            })).catch(() => {});
          }
        });
        if (!result.ok || result.items?.length !== items.length) throw new Error('Storyboard composition did not finish.');
        for (const [index, composed] of result.items.entries()) {
          const { filename, panelTimesMs, mediaTimeMs, frameReason, perceptualHash, averageRgb } = selections[index];
          if (!composed.parts.length) {
            (payload.omittedGroups ??= []).push({ filename, mediaTimeMs, panelTimesMs, frameReason });
            continue;
          }
          const entry = imageEntry({ filename, mediaTimeMs, panelTimesMs, frameReason, perceptualHash, averageRgb,
            ...composed }, rootRef);
          const segment = payload.segments.find(s => s.fromMs <= mediaTimeMs && mediaTimeMs < s.toMs);
          segment.entries.push(entry);
          previousViews.push(...preparedStoryboardViews(entry));
        }
      } finally { await unlink(requestPath); }
    }
    for (const segment of payload.segments) segment.entries.sort(orderEntries);
    const count = payload.segments.reduce((n, s) => n + s.entries.filter(e => e.type === 'image').length, 0);
    chunk.storyboardCount = payload.tracks.visual.storyboardCount = count;
    payload.tracks.visual.assetProfile = imageSettings;
    payload.planId = manifest.planId;
    validateViewingChunk(payload, manifest, chunk);
    const file = join(staged, chunk.viewingRef);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(payload));
    const percent = manifest.durationMs > 0 ? Math.min(99, (chunk.logicalEndMs / manifest.durationMs) * 99) : 0;
    await onPreparationProgress?.({ preparedThroughMs: chunk.logicalEndMs, durationMs: manifest.durationMs, percent });
  }
  manifest.viewingTrack = viewingPreparationState(manifest, { initialBufferMs, audioRequested: includeAudio });
  manifest.updatedAt = new Date().toISOString();
  await writeFile(join(staged, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

async function removeIfEmptyWithBenign(dir) {
  if (!await exists(dir)) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && ['.DS_Store', 'Thumbs.db'].includes(entry.name)) {
      await unlink(join(dir, entry.name)).catch(() => {});
    }
  }
  const remaining = await readdir(dir);
  if (!remaining.length) await rmdir(dir);
}

async function pruneEmptyUpgradeShell(transaction, upgradesDir) {
  if (await exists(join(transaction, 'old-package'))) return;
  const stagingRoot = join(transaction, 'new');
  if (await exists(stagingRoot)) await removeIfEmptyWithBenign(stagingRoot).catch(() => {});
  const journal = join(transaction, 'upgrade.json');
  if (await exists(journal)) await unlink(journal).catch(() => {});
  await removeIfEmptyWithBenign(transaction).catch(() => {});
  await removeIfEmptyWithBenign(upgradesDir).catch(() => {});
}

// Startup recovery is conservative: never replace an existing canonical package.
// A stopped process between the two renames leaves its original package in old-package.
export async function recoverPackageUpgrades(outputRoot) {
  if (!await exists(resolve(outputRoot))) return [];
  const root = await realpath(resolve(outputRoot));
  const upgrades = join(root, '.upgrades');
  if (!await exists(upgrades)) return [];
  if (await realpath(upgrades) !== upgrades) throw new Error('Upgrade recovery directory is redirected.');
  const results = [];
  for (const entry of await readdir(upgrades, { withFileTypes: true })) {
    if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
    const transaction = join(upgrades, entry.name);
    const path = join(transaction, 'upgrade.json');
    let journal;
    try { journal = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
    if (journal.kind !== KIND || journal.token !== entry.name || !validPackageKey(journal.packageKey)) continue;
    if (journal.status === 'complete' && journal.oldPackageDisposition === 'recycled'
        && !await exists(join(transaction, 'old-package'))) {
      if (await realpath(transaction) === transaction) await pruneEmptyUpgradeShell(transaction, upgrades);
      continue;
    }
    if (['complete', 'failed', 'recovered'].includes(journal.status) || alive(journal.pid)) continue;
    const canonical = join(root, journal.packageKey);
    const backup = join(transaction, 'old-package');
    // Reject redirected transaction paths before doing recovery filesystem operations.
    if (await realpath(transaction) !== transaction) throw new Error('Upgrade recovery directory is redirected.');
    if (!await exists(canonical) && await exists(backup)) await rename(backup, canonical);
    await releaseOwnedLock(canonical, journal.token);
    await releaseOwnedLock(backup, journal.token);
    await saveJournal(path, { ...journal, status: 'recovered', recoveredAt: new Date().toISOString() });
    results.push({ packageKey: journal.packageKey, transaction });
  }
  return results;
}

export async function upgradeViewingPackage(projectRoot, {
  inputPath, outputRoot, packageKey, viewingIntervalMs, initialBufferMs, imageSettings,
  sourceMediaId = packageKey, sourceRelativePath = null, preferredDialogueTrackId = null,
  includeAudio = true, onPreparationProgress, onUpgradeStage,
  recycleOldPackage: shouldRecycleOldPackage = true, beforeSwitch = async () => {}
}) {
  if (!validPackageKey(packageKey || '')) throw new TypeError('Invalid package key.');
  if (!Number.isSafeInteger(viewingIntervalMs) || viewingIntervalMs <= 0 || !initialBufferMs || !imageSettings) {
    throw new Error('Choose viewing settings before upgrading this package.');
  }
  imageSettings = normalizeImageSettings(imageSettings);
  const root = await realpath(resolve(outputRoot));
  const canonical = join(root, packageKey);
  if (await realpath(canonical) !== canonical) throw new Error('The existing package directory is redirected.');
  const original = await readFile(join(canonical, 'manifest.json'), 'utf8');
  const legacy = JSON.parse(original);
  validateObservationPrecomputeManifest(legacy);
  if (legacy.packageKind !== 'open-watch-cinema-ai-package' || ![1, 2, 3].includes(legacy.packageVersion || 1)) {
    throw new Error('Unknown viewing package format.');
  }
  preferredDialogueTrackId ??= legacy.dialogueTrack?.sourceTrack?.id ?? null;
  await stat(inputPath); // Missing source cannot initiate an upgrade.
  const token = randomUUID();
  const upgrades = join(root, '.upgrades');
  await mkdir(upgrades, { recursive: true });
  if (await realpath(upgrades) !== upgrades) throw new Error('Upgrade staging directory is redirected.');
  const transaction = join(upgrades, token);
  await mkdir(transaction);
  if (await realpath(transaction) !== transaction) throw new Error('Upgrade staging directory is redirected.');
  const journalPath = join(transaction, 'upgrade.json');
  const backupPath = join(transaction, 'old-package');
  const stagingRoot = join(transaction, 'new');
  const journal = { kind: KIND, token, packageKey, pid: process.pid, status: 'building', startedAt: new Date().toISOString() };
  await saveJournal(journalPath, journal);
  const lock = join(canonical, '.run-lock');
  try { await mkdir(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('This AI package is already being prepared or upgraded.');
    throw error;
  }
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, upgradeToken: token, acquiredAt: journal.startedAt }));
  const heartbeat = setInterval(() => { const now = new Date(); utimes(lock, now, now).catch(() => {}); }, 30_000);
  heartbeat.unref();
  let movedOld = false;
  let published = false;
  let oldLockReleased = false;
  const reportStage = async (phase, stage) => {
    // Progress observers cannot change an already completed filesystem operation.
    try { await onUpgradeStage?.({ phase, stage }); } catch {}
  };
  try {
    const staged = join(stagingRoot, packageKey);
    const canReuse = legacy.packageVersion === 3 && legacy.imageSettings && legacy.status === 'ready'
      && legacy.viewingIntervalMs === viewingIntervalMs
      && (!preferredDialogueTrackId || preferredDialogueTrackId === legacy.dialogueTrack?.sourceTrack?.id)
      && (!includeAudio || ['ready', 'source_missing'].includes(legacy.audioTrack?.status))
      && legacy.mediaIdentity === 'sha256:' + await hashFile(inputPath);
    if (canReuse) {
      await restylePackage(projectRoot, canonical, staged, legacy, {
        inputPath, imageSettings, initialBufferMs, includeAudio, onPreparationProgress, sourceRelativePath, sourceMediaId
      });
    } else await runObservationPrecompute(projectRoot, {
      inputPath, outputRoot: stagingRoot, packageKey, sourceMediaId, sourceRelativePath,
      viewingIntervalMs, initialBufferMs, imageSettings, preferredDialogueTrackId,
      skipRanges: legacy.skipRanges ?? [],
      includeAudio, onPreparationProgress
    });
    await reportStage('validation', 'Validating the upgraded viewing package');
    const manifest = await validateUpgrade(staged);
    if (includeAudio && !['ready', 'source_missing'].includes(manifest.audioTrack?.status)) {
      throw new Error('Requested sound descriptions are not ready; the original package remains active.');
    }
    // Do not downgrade previously available tracks when the new environment cannot recreate them.
    if (legacy.audioTrack?.status === 'ready' && manifest.audioTrack?.status !== 'ready') {
      throw new Error('The upgraded sound track is not ready; the original package remains active.');
    }
    if (legacy.dialogueTrack?.status === 'ready' && manifest.dialogueTrack?.status !== 'ready') {
      throw new Error('The upgraded dialogue track is not ready; the original package remains active.');
    }
    if (await readFile(join(canonical, 'manifest.json'), 'utf8') !== original) throw new Error('The original package changed during upgrade.');
    await beforeSwitch();
    await reportStage('switch', 'Switching to the upgraded viewing package');
    await saveJournal(journalPath, { ...journal, status: 'switching' });
    await rename(canonical, backupPath);
    movedOld = true;
    try { await rename(staged, canonical); published = true; }
    catch (error) { await rename(backupPath, canonical); movedOld = false; throw error; }
    await saveJournal(journalPath, { ...journal, status: 'complete', completedAt: new Date().toISOString() });
    let oldPackageDisposition = 'retained';
    let message = 'The viewing package was upgraded. Its previous version is retained in the upgrade backup.';
    if (shouldRecycleOldPackage) {
      await reportStage('recycle', 'Moving the previous viewing package to the system trash');
      try {
        // The old lock belongs to the backup now. Release it before asking the OS to recycle.
        await releaseOwnedLock(backupPath, token);
        oldLockReleased = true;
        await recycleOldPackage(backupPath, transaction);
        oldPackageDisposition = 'recycled';
        message = 'The viewing package was upgraded. Its previous version was moved to the system trash.';
      } catch (error) {
        if (!await exists(backupPath)) {
          oldPackageDisposition = 'unknown';
          message = `The new viewing package is active. The system recycling operation reported an error after the backup left its original path; check the system trash: ${error.message}`;
        } else message = `The viewing package was upgraded. Its previous version is retained because recycling could not complete: ${error.message}`;
      }
    }
    // A journal write failure must not turn a successful publication/recycle into a failed upgrade.
    await saveJournal(journalPath, { ...journal, status: 'complete', completedAt: new Date().toISOString(), oldPackageDisposition, message }).catch(() => {});
    if (oldPackageDisposition === 'recycled') {
      await pruneEmptyUpgradeShell(transaction, upgrades).catch(() => {});
    }
    return { manifest, packageDir: canonical, oldPackageDisposition, message,
      ...(oldPackageDisposition === 'retained' ? { backupPath } : {}) };

  } catch (error) {
    // If publication itself succeeded, retain both copies and let recovery reconcile the journal.
    if (!published && !movedOld) await saveJournal(journalPath, { ...journal, status: 'failed', error: error.message }).catch(() => {});
    throw error;
  } finally {
    clearInterval(heartbeat);
    if (!oldLockReleased) {
      try { await releaseOwnedLock(movedOld ? backupPath : canonical, token); }
      catch (error) { if (!published) throw error; }
    }
  }
}
