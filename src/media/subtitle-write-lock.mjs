import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { problem } from './library-files.mjs';

const execute = promisify(execFile);
let ownStart;

async function processStart(pid) {
  try {
    // Distinguish a previous owner from an unrelated process that reused its PID.
    const result = process.platform === 'win32'
      ? await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',
        '(Get-Process -Id '+pid+' -ErrorAction Stop).StartTime.ToUniversalTime().Ticks'],{windowsHide:true})
      : await execute('ps',['-p',String(pid),'-o','lstart='],{env:{...process.env,LC_ALL:'C',TZ:'UTC'}});
    const start = result.stdout.trim();
    return start ? createHash('sha256').update(start).digest('hex').slice(0,16) : 'unknown';
  } catch { return 'unknown'; }
}

async function isLive(pid, start) {
  try { process.kill(pid,0); }
  catch (error) { return error.code !== 'ESRCH'; }
  if (start === 'unknown') return true;
  const actual = await processStart(pid);
  return actual === 'unknown' || actual === start;
}

export async function withSubtitleWriteLock(bundlePath, operation) {
  const dir = dirname(bundlePath);
  const scope = createHash('sha256').update(basename(bundlePath).normalize('NFC').toLowerCase()).digest('hex').slice(0,20);
  const prefix = '.owc-subtitle-lock-'+scope+'-';
  ownStart ??= processStart(process.pid);
  const mine = prefix+process.pid+'-'+await ownStart+'-'+randomUUID();
  const lockPath = join(dir,mine);
  // Publish our unique claim before enumerating contenders. Simultaneous claims can
  // both yield, but two writers can never both finish this check while the other owns it.
  await writeFile(lockPath,'',{flag:'wx'});
  try {
    for (const entry of await readdir(dir,{withFileTypes:true})) {
      if (!entry.isFile() || entry.name === mine || !entry.name.startsWith(prefix)) continue;
      const owner = /^(\d+)-(unknown|[a-f0-9]{16})-[a-f0-9-]{36}$/.exec(entry.name.slice(prefix.length));
      if (!owner) continue;
      if (await isLive(Number(owner[1]),owner[2])) throw problem('另一个影院进程正在处理这部影片的字幕，请稍后重试。');
      await rm(join(dir,entry.name),{force:true});
    }
    return await operation();
  } finally { await rm(lockPath,{force:true}); }
}
