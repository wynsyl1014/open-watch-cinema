// Coalesce nearby player events, retaining seeks, and send updates in order.
export function createPlaybackSync({ send, onError, delayMs = 250 }) {
  let pending = null;
  let timer = null;
  let delivery = Promise.resolve();

  function flush() {
    clearTimeout(timer);
    timer = null;
    const snapshot = pending;
    pending = null;
    const sent = delivery.then(() => send(snapshot));
    delivery = sent.catch(onError);
    return sent;
  }

  return function schedule(update, { immediate = false } = {}) {
    pending = {
      ...update,
      seeked: update.seeked === true || Boolean(
        pending?.roomId === update.roomId && pending.seeked
      )
    };
    if (immediate) return flush();
    if (timer !== null) return;
    timer = setTimeout(flush, delayMs);
  };
}
