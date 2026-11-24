// Notifications invalidate browser snapshots; durable message history remains in SQLite.
export function createRoomEvents() {
  const clients = new Set();
  function write(response, text) {
    if (response.destroyed || response.writableEnded) { clients.delete(response); return; }
    try { if (!response.write(text)) response.destroy(); } catch { response.destroy(); }
  }
  const heartbeat = setInterval(() => {
    for (const response of clients) write(response, ': keepalive\n\n');
  }, 15000);
  heartbeat.unref();
  return {
    subscribe(request, response) {
      if (clients.size >= 128) { response.writeHead(503); response.end(); return; }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no'
      });
      response.flushHeaders();
      clients.add(response);
      response.once('close', () => clients.delete(response));
      write(response, 'retry: 1500\nevent: ready\ndata: {}\n\n');
    },
    publish(type, roomId = null, detail = {}) {
      const frame = 'data: ' + JSON.stringify({ ...detail, type, roomId }) + '\n\n';
      for (const response of clients) write(response, frame);
    },
    close() {
      clearInterval(heartbeat);
      for (const response of clients) response.end();
      clients.clear();
    }
  };
}
