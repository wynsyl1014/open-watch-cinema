// Library discovery and background preparation. No viewing-session state is owned here.
export function createPreparationTools({ discoverCinema, requireString, optionalString }) {
  return [
    {
      order: 0,
      definition: {
        name: 'cinema_status',
        description: 'Check whether the local cinema is running and find its current address.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      },
      async handler(args, { signal, request }) {
        const endpoint = await discoverCinema({ signal, refresh: true });
        return { baseUrl: endpoint.baseUrl, health: endpoint.health, healthCheckedAt: endpoint.checkedAt };
      }
    },
    {
      order: 3,
      definition: {
        name: 'cinema_rescan',
        description: 'Refresh the film library after adding or removing movie files.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      },
      async handler(args, { signal, request }) {
        return request('/api/media/rescan', { method: 'POST' });
      }
    },
    {
      order: 4,
      definition: {
        name: 'cinema_list_media',
        description: 'Browse available films, subtitles, and their readiness for AI viewing.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      },
      async handler(args, { signal, request }) {
        return request('/api/media');
      }
    },
    {
      order: 5,
      definition: {
        name: 'cinema_prepare_ai',
        description: 'Prepare a film\'s visual and dialogue timelines for AI viewing.',
        inputSchema: {
          type: 'object',
          properties: {
            mediaId: { type: 'string', minLength: 24, maxLength: 24 },
            storyboardProfile: {
              type: 'object', properties: { mode: { type: 'string', enum: ['balanced', 'economy', 'full'] },
                height: { type: 'integer', enum: [480, 720, 1080] } },
              required: ['mode'], additionalProperties: false,
              description: 'Per-film layout. Omit to keep its prepared layout; new films default to balanced. Height applies to full.'
            },
            dialogueTrackId: { type: 'string', minLength: 1, maxLength: 160 }
          },
          required: ['mediaId'],
          additionalProperties: false
        }
      },
      async handler(args, { signal, request }) {
        const mediaId = requireString(args.mediaId, 'mediaId', { min: 24, max: 24 });
        const dialogueTrackId = optionalString(args.dialogueTrackId, 'dialogueTrackId', { max: 160 });
        return request(`/api/media/${encodeURIComponent(mediaId)}/prepare-ai`, {
          method: 'POST',
          body: JSON.stringify({ ...(dialogueTrackId ? { dialogueTrackId } : {}),
            ...(args.storyboardProfile === undefined ? {} : { storyboardProfile: args.storyboardProfile }) })
        });
      }
    },
    {
      order: 6,
      definition: {
        name: 'cinema_job_status',
        description: 'Check the progress of a film compatibility or AI preparation job using its job ID.',
        inputSchema: {
          type: 'object',
          properties: { jobId: { type: 'string', format: 'uuid' } },
          required: ['jobId'],
          additionalProperties: false
        }
      },
      async handler(args, { signal, request }) {
        const jobId = requireString(args.jobId, 'jobId', { max: 80 });
        return request(`/api/jobs/${encodeURIComponent(jobId)}`);
      }
    }
  ];
}
