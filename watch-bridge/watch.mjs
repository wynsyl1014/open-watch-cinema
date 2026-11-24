import { parseArgs } from 'node:util';
import { watchCinema } from './session.mjs';

const { values } = parseArgs({ options: {
  'cinema-url': { type: 'string' },
  'cinema-root': { type: 'string' },
  help: { type: 'boolean' }
} });

if (values.help) {
  console.log('Usage: node watch.mjs [--cinema-url http://127.0.0.1:4182] [--cinema-root PATH]');
} else {
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => controller.abort());
  }
  try {
    await watchCinema({
      cinemaUrl: values['cinema-url'],
      cinemaRoot: values['cinema-root'],
      signal: controller.signal,
      onTick: result => new Promise((resolve, reject) => {
        process.stdout.write(JSON.stringify(result) + '\n', error => error ? reject(error) : resolve());
      })
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
