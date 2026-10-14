// Coalesce nearby player events, retaining seeks, and send updates in order.
export function createPlaybackSync({ send, onError, delayMs = 250 }) {
  let pending = null;
  let timer = null;
  let delivery = Promise.resolve();

  return function schedule(update) {
    pending = {
      ...update,
      seeked: update.seeked === true || Boolean(
        pending?.roomId === update.roomId && pending.seeked
      )
    };
    clearTimeout(timer);
    timer = setTimeout(() => {
      const snapshot = pending;
      pending = null;
      delivery = delivery.then(() => send(snapshot)).catch(onError);
    }, delayMs);
  };
}
