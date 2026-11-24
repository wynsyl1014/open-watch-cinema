import { runCodexScreening } from './screening.mjs';

const controller = new AbortController();
let screening;
let pendingSave;

function emit(message) {
  if (process.connected) process.send(message, error => {
    if (error) controller.abort(error);
  });
}

async function persist(message) {
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]);
  signal.throwIfAborted();
  const result = Promise.withResolvers();
  const cancel = () => result.reject(signal.reason);
  const save = { message, resolve: result.resolve };
  pendingSave = save;
  signal.addEventListener('abort', cancel, { once: true });
  try {
    emit(message);
    await result.promise;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (pendingSave === save) pendingSave = undefined;
  }
}

process.on('message', message => {
  if (message?.type === 'stop') {
    controller.abort();
    return;
  }
  const save = pendingSave?.message;
  if (save && message?.type === save.type + '-saved'
    && message.roomId === save.roomId && message.threadId === save.threadId
    && message.batchId === save.batchId) {
    pendingSave.resolve();
    return;
  }
  if (screening || controller.signal.aborted || message?.type !== 'start') return;
  screening = runCodexScreening({
    ...message, signal: controller.signal, emit, persist
  }).catch(error => {
    if (!controller.signal.aborted) emit({ type: 'fault', roomId: message.roomId, code: error.code });
  }).finally(() => {
    if (process.connected) {
      process.send({ type: 'stopped', roomId: message.roomId }, () => {
        if (process.connected) process.disconnect();
      });
    }
  });
});

process.once('disconnect', () => controller.abort());
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
