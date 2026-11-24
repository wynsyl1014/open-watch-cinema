import { resolveActiveRoom } from './active-room.mjs';

export function createRoomActions({ clientState, requireString, requireInteger, cinemaError, aiExperienceWarning }) {
  return [
    {
      order: 7,
      definition: {
        name: 'cinema_list_rooms',
        description: 'See the active viewing room and previous room archives.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      },
      async handler(args, { signal, request }) {
        return request('/api/rooms');
      }
    },
    {
      order: 8,
      definition: {
        name: 'cinema_open_room',
        description: 'Open a shared room for a selected film. For partially prepared films, use allowIncomplete=true when the viewer chooses to continue with available material.',
        inputSchema: {
          type: 'object',
          properties: {
            mediaId: { type: 'string', minLength: 24, maxLength: 24 },
            allowIncomplete: { type: 'boolean', default: false }
          },
          required: ['mediaId'],
          additionalProperties: false
        }
      },
      async handler(args, { signal, request }) {
        const mediaId = requireString(args.mediaId, 'mediaId', { min: 24, max: 24 });
        const mediaPayload = await request('/api/media');
        const item = (mediaPayload.items || []).find((candidate) => candidate.id === mediaId);
        if (!item) throw cinemaError('MEDIA_NOT_FOUND', 'Media was not found in the current cinema library.');
        const warning = aiExperienceWarning(item);
        if (warning && args.allowIncomplete !== true) {
          throw cinemaError('AI_PACKAGE_INCOMPLETE', `${warning} If the viewer would like to start with the available material, call cinema_manage with action open_room again with allowIncomplete=true.`);
        }
        const opened = await request('/api/rooms/open', {
          method: 'POST',
          body: JSON.stringify({ mediaId })
        });
        return { ...opened, warning, incompleteAccepted: Boolean(warning) };
      }
    },
    {
      order: 15,
      definition: {
        name: 'cinema_end_room',
        description: 'Close the active shared screening and preserve its timestamped room archive.',
        inputSchema: {
          type: 'object',
          properties: {
            mediaTimeMs: { type: 'integer', minimum: 0 }
          },
          additionalProperties: false
        }
      },
      async handler(args, { signal, request }) {
        const room = await resolveActiveRoom({ request, clientState, cinemaError, signal });
        const mediaTimeMs = args.mediaTimeMs !== undefined
          ? requireInteger(args.mediaTimeMs, 'mediaTimeMs')
          : (Number.isSafeInteger(room.lastPositionMs) && room.lastPositionMs >= 0 ? room.lastPositionMs : 0);
        return request(`/api/rooms/${encodeURIComponent(room.id)}/end`, {
          method: 'POST',
          body: JSON.stringify({ mediaTimeMs })
        });
      }
    }
  ];
}
