export async function resolveActiveRoom({ request, clientState, cinemaError, signal }) {
  if (clientState?.roomId) {
    try {
      const payload = await request('/api/rooms/' + encodeURIComponent(clientState.roomId) + '/playback-state');
      signal?.throwIfAborted();
      if (payload?.room?.status === 'active') return payload.room;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  const roomsPayload = await request('/api/rooms');
  signal?.throwIfAborted();
  const active = roomsPayload?.activeRoom || roomsPayload?.rooms?.find((room) => room.status === 'active');
  if (!active || active.status !== 'active') {
    throw cinemaError('ROOM_UNAVAILABLE', '当前没有进行中的观影房间。');
  }
  if (clientState) clientState.roomId = active.id;
  return active;
}
