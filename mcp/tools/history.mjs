import { resolveActiveRoom } from './active-room.mjs';

export function createHistoryTools({ clientState, requireInteger, cinemaError }) {
  return [
    {
      order: 12,
      definition: {
        name: 'cinema_read_window',
        description: 'Explore an earlier movie-time range in the active room for additional dialogue and sound details up to the current playback position.',
        inputSchema: {
          type: 'object',
          properties: {
            fromMs: { type: 'integer', minimum: 0 },
            toMs: { type: 'integer', minimum: 0 },
            lookaheadMs: { type: 'integer', minimum: 0, maximum: 30000, default: 1000 },
            maxItems: { type: 'integer', minimum: 1, maximum: 100, default: 24 },
            maxDialogueItems: { type: 'integer', minimum: 1, maximum: 300, default: 80 },
            maxAudioItems: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
          },
          required: ['fromMs', 'toMs'],
          additionalProperties: false
        }
      },
      async handler(args, { signal, request }) {
        const fromMs = requireInteger(args.fromMs, 'fromMs');
        const toMs = requireInteger(args.toMs, 'toMs');
        const room = await resolveActiveRoom({ request, clientState, cinemaError, signal });
        const playheadMs = Number.isSafeInteger(room.lastPositionMs) && room.lastPositionMs >= 0
          ? room.lastPositionMs : 0;
        const query = new URLSearchParams({
          tracks: 'dialogue,audio',
          fromMs: String(fromMs),
          toMs: String(toMs),
          playheadMs: String(playheadMs),
          lookaheadMs: String(requireInteger(args.lookaheadMs ?? 1000, 'lookaheadMs', { max: 30_000 })),
          maxItems: String(requireInteger(args.maxItems ?? 24, 'maxItems', { min: 1, max: 100 })),
          maxDialogueItems: String(requireInteger(args.maxDialogueItems ?? 80, 'maxDialogueItems', { min: 1, max: 300 })),
          maxAudioItems: String(requireInteger(args.maxAudioItems ?? 20, 'maxAudioItems', { min: 1, max: 100 }))
        });
        const payload = await request(`/api/rooms/${encodeURIComponent(room.id)}/ai-window?${query}`);
        const window = payload.window;
        if (!window) throw new Error('The cinema has no viewing material for this interval.');
        return {
          dialogue: (window.dialogue || []).map(({ fromMs: start, toMs: end, text, speaker }) => ({
            fromMs: start, toMs: end, text, ...(speaker ? { speaker } : {})
          })),
          sounds: (window.audioDescriptions || []).map(({ fromMs: start, toMs: end, text }) => ({
            fromMs: start, toMs: end, text
          })),
          ...(window.dialogueHasMore || window.audioHasMore ? { pending: true } : {})
        };
      }
    }
  ];
}
