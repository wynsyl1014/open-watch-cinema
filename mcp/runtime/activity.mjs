import { randomUUID } from 'node:crypto';

const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_BYTES = 64 * 1024 * 1024;
const MAX_PENDING_CALLS = 2048;

function contentSize(content) {
  let bytes = 0;
  let imageCount = 0;
  for (const block of content) {
    if (block.type === 'image') {
      imageCount++;
      const padding = block.data.endsWith('==') ? 2 : Number(block.data.endsWith('='));
      bytes += Math.floor(block.data.length * 3 / 4) - padding;
    } else if (block.type === 'text') {
      bytes += Buffer.byteLength(block.text);
    } else {
      bytes = Infinity;
    }
  }
  return { bytes, imageCount, blockCount: content.length };
}

// A single ordered, bounded sender runs separately from MCP responses. Calls are never retried.
export function createActivityReporter({ cinemaRequest, getProfileId, connectionId = randomUUID() }) {
  let seq = 0;
  let runId = null;
  let countRun = null;
  let droppedCalls = 0;
  let registration = null;
  let interval = null;
  let lastProfile;
  let closed = false;
  let sending = false;
  let pendingBytes = 0;
  const queue = [];

  function schedule() {
    if (sending) return;
    sending = true;
    setImmediate(drain);
  }

  function heartbeat() {
    if (closed) return Promise.resolve(null);
    if (!registration) {
      registration = Promise.withResolvers();
      queue.unshift({ op: 'heartbeat', registration });
      schedule();
    }
    return registration.promise;
  }

  function start() {
    if (closed) return;
    if (!interval) {
      interval = setInterval(heartbeat, 10_000);
      interval.unref();
      heartbeat();
    } else if (lastProfile !== getProfileId()) {
      heartbeat();
    }
  }

  function begin() {
    start();
    return { callId: randomUUID(), startedAt: Date.now(), run: runId || heartbeat() };
  }

  function delivered(started, { tool, action, isError, content, progress, viewingRoomId, profileId, finishedAt }) {
    if (closed) return;
    if (queue.length >= MAX_PENDING_CALLS) {
      if (countRun && started.run === countRun) droppedCalls++;
      else if (registration && started.run === registration.promise) {
        registration.droppedCalls = (registration.droppedCalls || 0) + 1;
      }
      return;
    }
    const { bytes, blockCount, imageCount } = contentSize(content);
    const retain = blockCount <= 1024 && bytes <= MAX_RESULT_BYTES && pendingBytes + bytes <= MAX_PENDING_BYTES;
    const data = { callId: started.callId, tool, ...(action ? { action } : {}), startedAt: started.startedAt,
      finishedAt, isError, ...(progress ? { progress } : {}), ...(viewingRoomId ? { viewingRoomId } : {}),
      ...(retain ? { content } : { contentOmitted: true, blockCount, imageCount }) };
    queue.push({ op: 'call', data, profileId, run: started.run, bytes: retain ? bytes : 0, blockCount, imageCount });
    if (retain) pendingBytes += bytes;
    schedule();
  }

  async function drain() {
    while (queue.length) {
      const job = queue.shift();
      try {
        const generation = job.op === 'heartbeat' ? runId : await job.run;
        if (job.op !== 'heartbeat' && (!generation || generation !== runId)) continue;
        const profileId = job.op === 'call' ? job.profileId : getProfileId();
        const event = { op: job.op, connectionId, profileId: profileId ?? null, seq: ++seq,
          ...(generation ? { runId: generation } : {}),
          ...(job.op !== 'call' && generation && generation === countRun ? { droppedCalls } : {}), ...job.data };
        let body = JSON.stringify(event);
        // Control characters in valid text can expand several-fold when encoded as JSON.
        if (job.op === 'call' && event.content && Buffer.byteLength(body) >= 32 * 1024 * 1024) {
          delete event.content;
          body = JSON.stringify({ ...event, contentOmitted: true, blockCount: job.blockCount, imageCount: job.imageCount });
        }
        const reply = await cinemaRequest('/api/ai/activity', { method: 'POST', body, signal: AbortSignal.timeout(2500) });
        if (job.op === 'heartbeat') {
          runId = typeof reply.runId === 'string' && reply.runId ? reply.runId : null;
          if (countRun !== runId) { droppedCalls = 0; countRun = runId; }
          droppedCalls += job.registration.droppedCalls || 0;
          lastProfile = profileId ?? null;
        }
      } catch (error) {
        if (job.op === 'heartbeat' || error.code === 'ACTIVITY_RUN_CHANGED' || error.code === 'WRITE_OUTCOME_UNKNOWN'
            || ['TimeoutError', 'AbortError'].includes(error.name)) {
          runId = null;
          // Drop calls from the previous generation. A fresh heartbeat can register this live connection again.
          if (job.op === 'call' && !closed) heartbeat();
        }
      } finally {
        pendingBytes -= job.bytes || 0;
        if (job.op === 'heartbeat') {
          registration = null;
          job.registration.resolve(runId);
          if (runId && lastProfile !== getProfileId()) heartbeat();
        }
      }
    }
    sending = false;
  }

  function close() {
    if (closed) return;
    closed = true;
    if (interval) clearInterval(interval);
    if (runId || registration) {
      queue.push({ op: 'close', run: runId || registration.promise });
      schedule();
    }
  }

  return { start, begin, delivered, close, getProfileId };
}
