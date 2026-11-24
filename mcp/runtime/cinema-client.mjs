import { cinemaError } from './validation.mjs';

const REQUIRED_CAPABILITIES = ['ai-window-v1', 'ai-tick-v1', 'ai-frame-v1', 'ai-playback-state-v1'];

function decodeFrameMetadata(value) {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// Caches belong to this client instance, never to an imported module singleton.
export function createCinemaClient({ urls, fetchImpl = globalThis.fetch, expectedRoomId }) {
  const DEFAULT_URLS = [...urls];
  let cachedCinema = null;
  let discoveryInFlight = null;
  // One cancelled caller stops waiting; other callers keep their shared discovery.
  function waitForDiscovery(promise, signal) {
    if (!signal) return promise;
    signal.throwIfAborted();
    return new Promise((resolvePromise, reject) => {
      const onAbort = () => { cleanup(); reject(signal.reason); };
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => { cleanup(); resolvePromise(value); },
        (error) => { cleanup(); reject(error); }
      );
    });
  }

  async function fetchCinema(baseUrl, path, options = {}, image = false) {
    const { signal, timeoutMs = 15_000, retryRead: _retryRead, ...requestOptions } = options;
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(new URL(path, baseUrl), {
        ...requestOptions,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
          ...(requestOptions.body ? { 'content-type': 'application/json' } : {}),
          ...(requestOptions.headers || {}),
          ...(expectedRoomId ? { 'x-owc-expected-room': expectedRoomId } : {})
        }
      });
      if (response.headers.get('x-open-watch-cinema') !== 'open-watch-cinema') {
        await response.body?.cancel();
        throw cinemaError('CINEMA_INCOMPATIBLE', 'The address no longer serves a compatible cinema. Restart or update the cinema.');
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const fallback = response.status === 400 ? 'INVALID_ARGUMENT'
          : response.status === 404 ? 'RESOURCE_UNAVAILABLE'
          : response.status === 409 ? 'REQUEST_CONFLICT'
          : 'CINEMA_REQUEST_FAILED';
        throw cinemaError(typeof payload.code === 'string' ? payload.code : fallback,
          typeof payload.error === 'string' ? payload.error : `Cinema request failed with ${response.status}.`,
          { status: response.status,
            ...(path === '/api/ai/notebook' && Number.isSafeInteger(payload.line) && payload.line >= 1
              ? { notebookLine: payload.line } : {}) });
      }
      if (image) {
        const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim();
        if (mimeType !== 'image/jpeg') {
          await response.body?.cancel();
          throw cinemaError('INVALID_VIEWING_RESPONSE', 'The cinema returned an unexpected image format.');
        }
        const data = Buffer.from(await response.arrayBuffer()).toString('base64');
        return { data, mimeType, metadata: decodeFrameMetadata(response.headers.get('x-open-watch-frame-metadata')) };
      }
      let payload;
      try { payload = await response.json(); } catch {
        throw cinemaError('INVALID_VIEWING_RESPONSE', 'The cinema returned invalid JSON.');
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw cinemaError('INVALID_VIEWING_RESPONSE', 'The cinema returned an invalid response object.');
      }
      return payload;
    } catch (error) {
      signal?.throwIfAborted();
      if (timeout.aborted) throw cinemaError('REQUEST_TIMEOUT', 'The cinema request timed out.');
      if (error.code) throw error;
      throw cinemaError('CONNECTION_FAILED', 'The connection to the local cinema was interrupted.');
    }
  }

  function compatibleHealth(health) {
    return health?.ok === true && Array.isArray(health.capabilities)
      && REQUIRED_CAPABILITIES.every((capability) => health.capabilities.includes(capability));
  }

  async function discoverCinema({ signal, refresh = false } = {}) {
    signal?.throwIfAborted();
    if (cachedCinema && !refresh) return cachedCinema;
    if (!discoveryInFlight) {
      const previousCinema = cachedCinema;
      const candidates = previousCinema
        ? [previousCinema.baseUrl, ...DEFAULT_URLS.filter((url) => url.replace(/\/$/, '') !== previousCinema.baseUrl)]
        : DEFAULT_URLS;
      discoveryInFlight = (async () => {
        let incompatible = false;
        for (const candidate of candidates) {
          const baseUrl = candidate.replace(/\/$/, '');
          try {
            // This short shared probe is independent of any individual tool call.
            const health = await fetchCinema(baseUrl, '/api/health', { timeoutMs: 1_500 });
            if (compatibleHealth(health)) {
              cachedCinema = { baseUrl, health, checkedAt: Date.now() };
              return cachedCinema;
            }
            incompatible = true;
          } catch (error) {
            if (['CINEMA_INCOMPATIBLE', 'INVALID_VIEWING_RESPONSE'].includes(error.code)) incompatible = true;
          }
          if (previousCinema?.baseUrl === baseUrl) invalidateCinema(previousCinema);
        }
        throw cinemaError(incompatible ? 'CINEMA_INCOMPATIBLE' : 'CINEMA_UNREACHABLE', incompatible
          ? 'No compatible cinema was found. Update or restart the local cinema.'
          : 'The local cinema is unavailable. Start it and try again.');
      })().finally(() => { discoveryInFlight = null; });
    }
    return waitForDiscovery(discoveryInFlight, signal);
  }

  function invalidateCinema(endpoint) {
    // A late failure from an old request must not clear a newly discovered address.
    if (cachedCinema === endpoint) cachedCinema = null;
  }

  async function cinemaRequest(path, options = {}, image = false) {
    const method = (options.method || 'GET').toUpperCase();
    const readOnly = options.retryRead === true || method === 'GET' || method === 'HEAD';
    let endpoint = await discoverCinema({ signal: options.signal });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await fetchCinema(endpoint.baseUrl, path, options, image);
      } catch (error) {
        options.signal?.throwIfAborted();
        const connectionProblem = ['CONNECTION_FAILED', 'REQUEST_TIMEOUT', 'CINEMA_INCOMPATIBLE', 'INVALID_VIEWING_RESPONSE'].includes(error.code);
        if (!connectionProblem) throw error;
        invalidateCinema(endpoint);
        if (!readOnly) {
          throw cinemaError('WRITE_OUTCOME_UNKNOWN', 'The response was lost. Check whether the operation completed before repeating it.');
        }
        if (attempt > 0) throw error;
        endpoint = await discoverCinema({ signal: options.signal });
      }
    }
  }

  return { discoverCinema, cinemaRequest };
}
