import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildViewingFeed } from './viewing-feed.mjs';

const MCP_ROOT = dirname(fileURLToPath(import.meta.url));
const WATCH_SKILL_URI = 'open-watch-cinema://skills/watch-together';
const WATCH_SKILL_TEXT = await readFile(resolve(MCP_ROOT, 'SKILL.md'), 'utf8');
const WATCH_SKILL_RESOURCE = {
  uri: WATCH_SKILL_URI,
  name: 'Open Watch Cinema AI Viewing Skill',
  description: 'Operational identity, cursor, polling, frame-inspection, multi-AI, and discrete-context rules for watching through this MCP.',
  mimeType: 'text/markdown'
};
const SERVER_INFO = { name: 'open-watch-cinema', version: '0.6.0' };
const DEFAULT_URLS = [
  process.env.OPEN_WATCH_CINEMA_URL,
  'http://127.0.0.1:4182',
  'http://127.0.0.1:4183',
  'http://127.0.0.1:4184',
  'http://127.0.0.1:4185',
  'http://127.0.0.1:4186',
  'http://127.0.0.1:4187'
].filter((value, index, values) => value && values.indexOf(value) === index);

let cachedBaseUrl = null;
let cacheExpiresAt = 0;

function textResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {})
  };
}

function requireObject(value, label = 'arguments') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function requireString(value, label, { min = 1, max = 4000 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new TypeError(`${label} must be a string between ${min} and ${max} characters.`);
  }
  return value;
}

function optionalString(value, label, options) {
  return value === undefined || value === null ? undefined : requireString(value, label, options);
}

function requireInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

async function fetchJson(baseUrl, path, options = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    ...options,
    signal: options.signal || AbortSignal.timeout(15_000),
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Cinema request failed with ${response.status}.`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function discoverCinema({ force = false } = {}) {
  if (!force && cachedBaseUrl && cacheExpiresAt > Date.now()) {
    return cachedBaseUrl;
  }

  const failures = [];
  for (const baseUrl of DEFAULT_URLS) {
    try {
      const health = await fetchJson(baseUrl, '/api/health', {
        signal: AbortSignal.timeout(1_500)
      });
      if (
        health?.ok === true
        && Array.isArray(health.capabilities)
        && health.capabilities.includes('ai-window-v1')
        && health.capabilities.includes('ai-tick-v1')
        && health.capabilities.includes('ai-frame-v1')
      ) {
        cachedBaseUrl = baseUrl.replace(/\/$/, '');
        cacheExpiresAt = Date.now() + 5_000;
        return cachedBaseUrl;
      }
      failures.push(`${baseUrl}: health response was not ready`);
    } catch (error) {
      failures.push(`${baseUrl}: ${error.message}`);
    }
  }
  throw new Error(`Open Watch Cinema was not found. Start it first. ${failures.join(' | ')}`);
}

async function cinemaRequest(path, options = {}) {
  const baseUrl = await discoverCinema();
  try {
    return await fetchJson(baseUrl, path, options);
  } catch (error) {
    if (error.status === undefined) {
      const refreshed = await discoverCinema({ force: true });
      return fetchJson(refreshed, path, options);
    }
    throw error;
  }
}

function decodeFrameMetadata(value) {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

async function cinemaFrameResult(roomId, storyboardRef, mediaTimeMs, quality = 'storyboard') {
  const baseUrl = await discoverCinema();
  const query = new URLSearchParams({
    storyboardRef,
    quality,
    mediaTimeMs: String(mediaTimeMs)
  });
  const response = await fetch(new URL(
    `/api/rooms/${encodeURIComponent(roomId)}/ai-frame?${query}`,
    baseUrl
  ), { signal: AbortSignal.timeout(15_000) });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.error || `Cinema frame request failed with ${response.status}.`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  const mimeType = response.headers.get('content-type') || 'image/jpeg';
  const metadata = decodeFrameMetadata(response.headers.get('x-open-watch-frame-metadata'));
  const data = Buffer.from(await response.arrayBuffer()).toString('base64');
  return {
    mcpContent: [
      { type: 'image', data, mimeType },
      { type: 'text', text: JSON.stringify(metadata || { roomId, storyboardRef, mediaTimeMs }, null, 2) }
    ]
  };
}

function aiExperienceWarning(item) {
  const aiPackage = item?.aiPackage || null;
  if (!aiPackage) {
    return 'AI preparation has not been run. AI will not receive an indexed visual or dialogue track.';
  }
  if (aiPackage.status !== 'ready') {
    return 'The AI package is not complete. AI context may be missing or unavailable.';
  }
  const mode = aiPackage.aiReadiness?.experienceMode || 'raw';
  if (mode === 'visual_only') {
    return 'Visual analysis is ready, but timed dialogue is missing. AI may misunderstand names, relationships, and plot.';
  }
  if (mode === 'dialogue_only') {
    return 'Timed dialogue is ready, but visual analysis is missing. AI cannot follow actions, framing, or visual clues.';
  }
  if (mode !== 'complete') return 'This AI package is incomplete, so the viewing experience may be limited.';
  return null;
}

const TOOLS = [
  {
    name: 'cinema_status',
    description: 'Discover the loopback Open Watch Cinema instance and return its current health.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'cinema_rescan',
    description: 'Rescan the local media folder after a film has been added or removed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'cinema_list_media',
    description: 'List local films, subtitle tracks, compatibility state, and AI-package readiness.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'cinema_prepare_ai',
    description: 'Start the manual AI preparation pipeline for one film. This never runs during ordinary playback.',
    inputSchema: {
      type: 'object',
      properties: {
        mediaId: { type: 'string', minLength: 24, maxLength: 24 },
        dialogueTrackId: { type: 'string', minLength: 1, maxLength: 160 }
      },
      required: ['mediaId'],
      additionalProperties: false
    }
  },
  {
    name: 'cinema_job_status',
    description: 'Read one compatibility or AI-preparation job by UUID.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string', format: 'uuid' } },
      required: ['jobId'],
      additionalProperties: false
    }
  },
  {
    name: 'cinema_list_rooms',
    description: 'List the active room and retained read-only room archives.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'cinema_open_room',
    description: 'Open a room for one film. Incomplete AI packages require allowIncomplete=true so the limitation is explicit.',
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
  {
    name: 'open_watch_cinema_tick',
    description: 'Poll one compact, spoiler-gated viewing increment containing playback state, new room messages, dialogue, selected storyboards, motion events, and prepared audio descriptions including speech delivery. Audio descriptions are fallible local-model interpretations, not direct audio input. Inspect the up to two attached storyboard images alongside dialogue; audio captions are supporting clues, not scene facts. Preserve and pass back every returned cursor field, including seekVersion. If the connector rejects seekVersion, refresh its cached tools rather than dropping the field. Set consumerName to the same AI name used when posting so self-authored messages are skipped without stalling the cursor. Use cinema_read_window only when a fuller inspection is needed.',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', format: 'uuid' },
        consumerName: {
          type: 'string',
          minLength: 1,
          maxLength: 60,
          description: 'The connected AI’s stable display name in this cinema. Use the same name in cinema_post_message so self-authored echoes are omitted while the cursor still advances.'
        },
        cursors: {
          type: 'object',
          properties: {
            mediaMs: { type: 'integer', minimum: 0 },
            seekVersion: { type: 'integer', minimum: 0, description: 'Required whenever mediaMs is provided. Return the value from the previous tick unchanged.' },
            messageId: { type: 'integer', minimum: 0, default: 0 },
            observationSequence: { type: 'integer', minimum: 0, default: 0 }
          },
          additionalProperties: false
        },
        limits: {
          type: 'object',
          properties: {
            initialWindowMs: { type: 'integer', minimum: 1000, maximum: 60000, default: 15000 },
            maxAdvanceMs: { type: 'integer', minimum: 1000, maximum: 60000, default: 20000 },
            maxMessages: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            maxLiveObservations: { type: 'integer', minimum: 1, maximum: 200, default: 40 },
            maxStoryboards: { type: 'integer', minimum: 1, maximum: 12, default: 5 },
            maxMotionEvents: { type: 'integer', minimum: 1, maximum: 30, default: 8 }
          },
          additionalProperties: false
        }
      },
      required: ['roomId', 'consumerName'],
      additionalProperties: false
    }
  },
  {
    name: 'cinema_read_window',
    description: 'Read spoiler-gated visual observations, timed dialogue, and prepared audio descriptions around the current playhead. Audio descriptions wait for their full analyzed clip to finish and never use lookahead.',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', format: 'uuid' },
        fromMs: { type: 'integer', minimum: 0 },
        toMs: { type: 'integer', minimum: 0 },
        playheadMs: { type: 'integer', minimum: 0 },
        lookaheadMs: { type: 'integer', minimum: 0, maximum: 30000, default: 1000 },
        maxItems: { type: 'integer', minimum: 1, maximum: 100, default: 24 },
        maxDialogueItems: { type: 'integer', minimum: 1, maximum: 300, default: 80 }
      },
      required: ['roomId', 'fromMs', 'toMs', 'playheadMs'],
      additionalProperties: false
    }
  },
  {
    name: 'cinema_get_frame',
    description: 'Fetch a spoiler-gated storyboard selected by open_watch_cinema_tick, or use quality hd to inspect its final frame from the source video at up to 1920x1080. Use only a storyboardRef and mediaTimeMs returned by a consumed tick.',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', format: 'uuid' },
        storyboardRef: { type: 'string', minLength: 1, maxLength: 500 },
        quality: { type: 'string', enum: ['storyboard', 'hd'], default: 'storyboard' },
        mediaTimeMs: { type: 'integer', minimum: 0 }
      },
      required: ['roomId', 'storyboardRef', 'mediaTimeMs'],
      additionalProperties: false
    }
  },
  {
    name: 'cinema_post_message',
    description: 'Post one timestamped AI message into the room message stream.',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', format: 'uuid' },
        content: { type: 'string', minLength: 1, maxLength: 800 },
        mediaTimeMs: { type: 'integer', minimum: 0 },
        senderName: {
          type: 'string',
          minLength: 1,
          maxLength: 60,
          description: 'The connected AI’s own stable display name, or the name the viewer asked it to use in this cinema.'
        }
      },
      required: ['roomId', 'content', 'mediaTimeMs', 'senderName'],
      additionalProperties: false
    }
  },
  {
    name: 'cinema_end_room',
    description: 'End the active room and preserve it as a read-only timed archive.',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', format: 'uuid' },
        mediaTimeMs: { type: 'integer', minimum: 0 }
      },
      required: ['roomId', 'mediaTimeMs'],
      additionalProperties: false
    }
  }
];

async function callTool(name, rawArguments) {
  const args = requireObject(rawArguments || {});
  switch (name) {
    case 'cinema_status': {
      const baseUrl = await discoverCinema({ force: true });
      return { baseUrl, health: await fetchJson(baseUrl, '/api/health') };
    }
    case 'cinema_rescan':
      return cinemaRequest('/api/media/rescan', { method: 'POST' });
    case 'cinema_list_media':
      return cinemaRequest('/api/media');
    case 'cinema_prepare_ai': {
      const mediaId = requireString(args.mediaId, 'mediaId', { min: 24, max: 24 });
      const dialogueTrackId = optionalString(args.dialogueTrackId, 'dialogueTrackId', { max: 160 });
      return cinemaRequest(`/api/media/${encodeURIComponent(mediaId)}/prepare-ai`, {
        method: 'POST',
        body: JSON.stringify(dialogueTrackId ? { dialogueTrackId } : {})
      });
    }
    case 'cinema_job_status': {
      const jobId = requireString(args.jobId, 'jobId', { max: 80 });
      return cinemaRequest(`/api/jobs/${encodeURIComponent(jobId)}`);
    }
    case 'cinema_list_rooms':
      return cinemaRequest('/api/rooms');
    case 'cinema_open_room': {
      const mediaId = requireString(args.mediaId, 'mediaId', { min: 24, max: 24 });
      const mediaPayload = await cinemaRequest('/api/media');
      const item = (mediaPayload.items || []).find((candidate) => candidate.id === mediaId);
      if (!item) throw new Error('Media was not found in the current cinema library.');
      const warning = aiExperienceWarning(item);
      if (warning && args.allowIncomplete !== true) {
        throw new Error(`${warning} Call cinema_open_room again with allowIncomplete=true only after the viewer accepts this limitation.`);
      }
      const opened = await cinemaRequest('/api/rooms/open', {
        method: 'POST',
        body: JSON.stringify({ mediaId })
      });
      return { ...opened, warning, incompleteAccepted: Boolean(warning) };
    }
    case 'open_watch_cinema_tick': {
      const roomId = requireString(args.roomId, 'roomId', { max: 80 });
      const consumerName = requireString(args.consumerName, 'consumerName', { max: 60 });
      const cursors = args.cursors === undefined ? {} : requireObject(args.cursors, 'cursors');
      const limits = args.limits === undefined ? {} : requireObject(args.limits, 'limits');
      const normalizedCursors = {};
      if (Object.hasOwn(cursors, 'mediaMs')) {
        if (!Object.hasOwn(cursors, 'seekVersion')) {
          throw new Error('Cursor schema is out of date: mediaMs requires seekVersion. Refresh the Open Watch Cinema connector tools, then retry with the complete last returned cursors. Do not drop seekVersion or reset cursors to work around this error.');
        }
        normalizedCursors.mediaMs = requireInteger(cursors.mediaMs, 'cursors.mediaMs');
      }
      if (Object.hasOwn(cursors, 'seekVersion')) {
        normalizedCursors.seekVersion = requireInteger(cursors.seekVersion, 'cursors.seekVersion');
      }
      if (Object.hasOwn(cursors, 'messageId')) {
        normalizedCursors.messageId = requireInteger(cursors.messageId, 'cursors.messageId');
      }
      if (Object.hasOwn(cursors, 'observationSequence')) {
        normalizedCursors.observationSequence = requireInteger(
          cursors.observationSequence,
          'cursors.observationSequence'
        );
      }
      const limitRules = {
        initialWindowMs: { min: 1_000, max: 60_000 },
        maxAdvanceMs: { min: 1_000, max: 60_000 },
        maxMessages: { min: 1, max: 100 },
        maxLiveObservations: { min: 1, max: 200 },
        maxStoryboards: { min: 1, max: 12 },
        maxMotionEvents: { min: 1, max: 30 }
      };
      const normalizedLimits = {};
      for (const [key, rule] of Object.entries(limitRules)) {
        if (Object.hasOwn(limits, key)) {
          normalizedLimits[key] = requireInteger(limits[key], `limits.${key}`, rule);
        }
      }
      const payload = await cinemaRequest(`/api/rooms/${encodeURIComponent(roomId)}/ai-tick`, {
        method: 'POST',
        body: JSON.stringify({
          consumerName,
          cursors: normalizedCursors,
          limits: normalizedLimits
        })
      });
      return buildViewingFeed(payload, {
        fetchFrame: (frame) => cinemaFrameResult(roomId, frame.storyboardRef, frame.mediaTimeMs),
        readRoom: async () => (await cinemaRequest(`/api/rooms/${encodeURIComponent(roomId)}`)).room
      });
    }
    case 'cinema_read_window': {
      const roomId = requireString(args.roomId, 'roomId', { max: 80 });
      const query = new URLSearchParams({
        fromMs: String(requireInteger(args.fromMs, 'fromMs')),
        toMs: String(requireInteger(args.toMs, 'toMs')),
        playheadMs: String(requireInteger(args.playheadMs, 'playheadMs')),
        lookaheadMs: String(requireInteger(args.lookaheadMs ?? 1000, 'lookaheadMs', { max: 30_000 })),
        maxItems: String(requireInteger(args.maxItems ?? 24, 'maxItems', { min: 1, max: 100 })),
        maxDialogueItems: String(requireInteger(args.maxDialogueItems ?? 80, 'maxDialogueItems', { min: 1, max: 300 }))
      });
      return cinemaRequest(`/api/rooms/${encodeURIComponent(roomId)}/ai-window?${query}`);
    }
    case 'cinema_get_frame': {
      const roomId = requireString(args.roomId, 'roomId', { max: 80 });
      const storyboardRef = requireString(args.storyboardRef, 'storyboardRef', { max: 500 });
      const mediaTimeMs = requireInteger(args.mediaTimeMs, 'mediaTimeMs');
      const quality = args.quality ?? 'storyboard';
      if (!['storyboard', 'hd'].includes(quality)) throw new Error('quality must be storyboard or hd.');
      return cinemaFrameResult(roomId, storyboardRef, mediaTimeMs, quality);
    }
    case 'cinema_post_message': {
      const roomId = requireString(args.roomId, 'roomId', { max: 80 });
      const content = requireString(args.content, 'content', { max: 800 });
      const mediaTimeMs = requireInteger(args.mediaTimeMs, 'mediaTimeMs');
      const senderName = requireString(args.senderName, 'senderName', { max: 60 });
      return cinemaRequest(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ senderName, senderKind: 'ai', content, mediaTimeMs })
      });
    }
    case 'cinema_end_room': {
      const roomId = requireString(args.roomId, 'roomId', { max: 80 });
      const mediaTimeMs = requireInteger(args.mediaTimeMs, 'mediaTimeMs');
      return cinemaRequest(`/api/rooms/${encodeURIComponent(roomId)}/end`, {
        method: 'POST',
        body: JSON.stringify({ mediaTimeMs })
      });
    }
    default:
      throw new Error(`Unknown cinema tool: ${name}`);
  }
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false }
        },
        serverInfo: SERVER_INFO,
        instructions: `Read the AI viewing skill at ${WATCH_SKILL_URI}. Choose one stable display name for yourself in this cinema, or use the name the viewer gives you. Pass that exact name as consumerName on every open_watch_cinema_tick call and as senderName on every cinema_post_message call. Preserve returned cursors separately for this room and AI identity, then pass them back unchanged including seekVersion. If that field is rejected, refresh the connector schema; never strip it. Inspect the storyboard images attached to ticks alongside dialogue. Treat audio captions as supporting clues, not proof of location, speaker identity, or emotion. Use cinema_get_frame only for storyboard entries returned by a consumed tick. Reply through cinema_post_message. Keep the viewing turn polling until the viewer presses Stop in the chat, explicitly asks to leave, the room ends, or polling becomes impossible. Pauses, empty ticks, replies, and completed checks do not end the loop. Respect host cancellation and execution limits; do not claim background polling or end the shared room when the chat stops. Use cinema_read_window only for a bounded fuller inspection. Never infer dialogue, frames, or future plot beyond spoiler-gated responses.`
      }
    };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'resources/list') {
    return { jsonrpc: '2.0', id, result: { resources: [WATCH_SKILL_RESOURCE] } };
  }
  if (method === 'resources/read') {
    if (params?.uri !== WATCH_SKILL_URI) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32002, message: `Unknown resource: ${params?.uri || ''}` }
      };
    }
    return {
      jsonrpc: '2.0',
      id,
      result: {
        contents: [{ uri: WATCH_SKILL_URI, mimeType: 'text/markdown', text: WATCH_SKILL_TEXT }]
      }
    };
  }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    try {
      const result = await callTool(params?.name, params?.arguments || {});
      return {
        jsonrpc: '2.0',
        id,
        result: result?.mcpContent ? { content: result.mcpContent } : textResult(result)
      };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        result: textResult({
          error: 'cinema_request_failed',
          message: error instanceof Error ? error.message : String(error),
          status: error?.status || null,
          detail: error?.payload || null
        }, true)
      };
    }
  }
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` }
  };
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: error.message }
    })}\n`);
    return;
  }
  if (!Object.hasOwn(message, 'id')) return;
  const response = await handleRequest(message);
  process.stdout.write(`${JSON.stringify(response)}\n`);
});

process.on('uncaughtException', (error) => {
  console.error('[open-watch-cinema-mcp] uncaught exception', error);
});
process.on('unhandledRejection', (error) => {
  console.error('[open-watch-cinema-mcp] unhandled rejection', error);
});
