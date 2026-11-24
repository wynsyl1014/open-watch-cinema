// Only the environment activated by the user participates in automatic reuse.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function activePython() {
  const { VIRTUAL_ENV, CONDA_PREFIX } = process.env;
  const prefix = VIRTUAL_ENV || CONDA_PREFIX;
  if (!prefix) return null;
  const executable = process.platform === 'win32'
    ? join(prefix, VIRTUAL_ENV ? 'Scripts/python.exe' : 'python.exe')
    : join(prefix, 'bin/python');
  return existsSync(executable) ? executable : null;
}
