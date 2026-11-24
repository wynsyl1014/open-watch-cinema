import { setTimeout as delay } from 'node:timers/promises';

const STATE_EVENTS = new Set(['watch-bridge-playback', 'room', 'messages', 'watch-bridge-settings']);

async function fetchCinema(cinemaUrl, path, signal) {
  const response = await fetch(new URL(path, cinemaUrl), { signal, redirect: 'error' });
  if (!response.ok || response.headers.get('x-open-watch-cinema') !== 'open-watch-cinema') {
    await response.body?.cancel();
    throw new Error(`Open Watch Cinema did not provide ${path} (HTTP ${response.status}).`);
  }
  return response;
}

async function readState(cinemaUrl, signal) {
  const response = await fetchCinema(cinemaUrl, '/api/watch-bridge/state',
    AbortSignal.any([signal, AbortSignal.timeout(5000)]));
  const state = await response.json();
  if (!Number.isFinite(state?.intervalMs) || state.intervalMs <= 0
    || (state.roomId !== null && (typeof state.roomId !== 'string'
      || !Number.isFinite(state.playheadMs) || !Number.isSafeInteger(state.seekVersion)))) {
    throw new Error('Open Watch Cinema returned invalid watch-bridge state.');
  }
  return state;
}

async function* invalidations(body) {
  let buffer = '';
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (event.startsWith(':')) continue;
      const data = event.split('\n').find(line => line.startsWith('data: '));
      if (data && STATE_EVENTS.has(JSON.parse(data.slice(6)).type)) yield;
    }
  }
}

// Subscribe before each snapshot so changes during the read are also observed.
export async function followCinemaState({ cinemaUrl, signal, onState }) {
  let connected = false;
  while (!signal.aborted) {
    try {
      const response = await fetchCinema(cinemaUrl, '/api/events', signal);
      try {
        onState(await readState(cinemaUrl, signal));
        connected = true;
        for await (const _ of invalidations(response.body)) {
          onState(await readState(cinemaUrl, signal));
        }
      } finally {
        if (!response.body.locked) await response.body.cancel().catch(() => {});
      }
    } catch (error) {
      if (signal.aborted) return;
      if (!connected || !(error instanceof TypeError || error.name === 'TimeoutError')) throw error;
    }
    await delay(1000, undefined, { signal });
  }
}
