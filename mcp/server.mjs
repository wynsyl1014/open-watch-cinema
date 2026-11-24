// Composition root: assemble dependencies, then start the MCP transport.
import { createActivityReporter } from './runtime/activity.mjs';
import { readFile } from 'node:fs/promises';
import { createCinemaClient } from './runtime/cinema-client.mjs';
import { readRuntimeConfig, DEFAULT_TICK_LIMITS } from './runtime/configuration.mjs';
import { createViewingSession } from './viewing/viewing-session.mjs';
import { createToolRegistry } from './tools/index.mjs';
import { createMcpProtocol, startStdio } from './runtime/protocol.mjs';
import { requireObject, requireString, optionalString, requireInteger, cinemaError } from './runtime/validation.mjs';
import { describeViewingSettings, aiExperienceWarning } from './viewing/viewing-guidance.mjs';

const config = readRuntimeConfig();
const expectedRoomId = process.env.OPEN_WATCH_CINEMA_ROOM_ID;
const profileId = process.env.OPEN_WATCH_CINEMA_PROFILE_ID;
const resume = process.env.OPEN_WATCH_CINEMA_RESUME_CURSORS;
const cinema = createCinemaClient({ urls: config.urls, expectedRoomId });
const chatFeedToken = process.env.OPEN_WATCH_CINEMA_CHAT_FEED_TOKEN;
const session = createViewingSession({
  cinemaRequest: cinema.cinemaRequest, profileId, expectedRoomId, chatFeedToken,
  resumeCursors: resume ? JSON.parse(resume) : undefined
});
const toolRegistry = createToolRegistry({
  ...cinema, ...session, chatFeedToken,
  manualChat: process.env.OPEN_WATCH_CINEMA_CHAT_MANUAL === '1',
  requireObject, requireString, optionalString, requireInteger, cinemaError,
  describeViewingSettings, aiExperienceWarning, DEFAULT_TICK_LIMITS,
  CATCHUP_TIME_BUDGET_MS: config.CATCHUP_TIME_BUDGET_MS,
  IMAGE_BUDGET_BYTES: config.IMAGE_BUDGET_BYTES,
  TRACK_IMAGE_REFS: process.env.OPEN_WATCH_CINEMA_BRIDGE_FRAME_REFS === '1',
  enableHistory: config.enableHistory,
  enableControl: config.enableControl
});
const watchSkillText = await readFile(new URL('./SKILL.md', import.meta.url), 'utf8');
const activity = createActivityReporter({
  cinemaRequest: cinema.cinemaRequest, getProfileId: () => session.clientState.identity,
  connectionId: process.env.OPEN_WATCH_CINEMA_ACTIVITY_ID
});
const protocol = createMcpProtocol({ toolRegistry, watchSkillText,
  bindSelectedProfile: profileId ? () => session.bindSelectedProfile() : session.bindSelectedProfile, activity });
const input = startStdio(protocol);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    input.close();
    process.stdin.destroy();
    // Give a healthy local cinema time to receive the final close report.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

process.on('uncaughtException', (error) => {
  console.error('[open-watch-cinema-mcp] uncaught exception', error);
});
process.on('unhandledRejection', (error) => {
  console.error('[open-watch-cinema-mcp] unhandled rejection', error);
});
