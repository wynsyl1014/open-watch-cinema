import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getObserverStatus
} from '../../src/preparation/index.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const status = await getObserverStatus(projectRoot);
console.log(JSON.stringify(status, null, 2));
if (!status.available || !status.opencvAvailable) process.exitCode = 1;
