# Open Watch Cinema MCP

This folder contains the dependency-free stdio MCP adapter for Open Watch Cinema. The technical operating rules for a connected model are also published as the MCP resource `open-watch-cinema://skills/watch-together` and stored in `mcp/SKILL.md`.

For a human-facing setup and button guide, read `../FOR_USERS.md`.

## Requirements

- Node.js 24 or newer
- Open Watch Cinema running on the same computer
- A cinema API advertising `ai-window-v1`, `ai-tick-v1`, and `ai-frame-v1`
- An MCP host that can start a local stdio server

The adapter ignores older cinema processes that do not advertise the required tick/window capabilities, even when they are otherwise healthy.

## Start command

Configure an MCP client to run:

```text
node <open-watch-cinema-project>/mcp/server.mjs
```

The adapter discovers the supported loopback development ports automatically. For a custom port, set `OPEN_WATCH_CINEMA_URL` in the MCP client environment.

Each MCP client normally starts its own stdio adapter process. Those processes can all connect to the same local cinema HTTP service.

## AI viewing skill resource

After initialization, a capable MCP host should list and read:

```text
open-watch-cinema://skills/watch-together
```

The same rules are included in `mcp/SKILL.md`. Initialization instructions also contain the minimum identity, cursor, frame, and spoiler boundaries so clients that do not automatically surface resources still receive the essential contract.

The resource describes:

- stable AI identity and self-message filtering;
- the normal incremental tick loop;
- per-client cursor ownership;
- selected storyboard frame retrieval;
- bounded detailed reads;
- multiple connected AI clients;
- context inheritance for discrete API calls;
- safe room-ending behavior.

MCP can expose and recommend this skill, but a host application ultimately decides whether and how resources are placed in model context.

## Tools

The adapter exposes twelve tools:

- `cinema_status`
- `cinema_rescan`
- `cinema_list_media`
- `cinema_prepare_ai`
- `cinema_job_status`
- `cinema_list_rooms`
- `cinema_open_room`
- `open_watch_cinema_tick`
- `cinema_read_window`
- `cinema_get_frame`
- `cinema_post_message`
- `cinema_end_room`

`cinema_open_room` does not hide incomplete AI state. When visual or dialogue context is missing, the first call returns a warning and requires an explicit `allowIncomplete: true` retry after the viewer accepts the limitation.

## Normal viewing loop

During ordinary viewing, repeatedly call `open_watch_cinema_tick`, set `consumerName` to the same stable AI name used by `cinema_post_message`, and pass the returned `cursors` back unchanged on the next call.

The MCP adapter attaches up to two selected storyboard images directly to the tick response, with timestamps. Selection retains the latest view and favours a different composition that covers the earlier part of the window, with scene changes preferred over nearby motion peaks. Similar compositions can reduce the response to one image. Already consumed views are omitted on normal polling; a seek can legitimately repeat destination context. `tick.visualEvidence.images` lists attachments and any failures, so a missing image cannot be mistaken for observed evidence. Additional views and HD inspection remain available through `cinema_get_frame`. Clients must forward the MCP image content blocks to their model, not just the JSON text.

Newly prepared visual tracks include a `visual_heartbeat` storyboard after roughly 12 seconds without a selected visual, plus initial context at each chunk's ownership boundary. Real scene/motion events reset that deadline and take precedence; fallback images never throttle subsequent real events. These are prepared images using the existing cursor and spoiler gate, with no extra model calls during playback. Previously completed packages need visual regeneration to gain heartbeats. Image similarity uses the existing perceptual hash plus colour measurements; only a small `visualGroup` number is exposed, and the two-image limit is unchanged. This is a composition heuristic, not semantic scene recognition. Actual delivery cadence still depends on the host polling promptly.

Image attachment rechecks room state before returning a response; a seek during loading requires a retry with unchanged input cursors.

Keep the viewing turn actively polling until the viewer presses **Stop in the chat**, explicitly asks to leave, the room ends, or polling becomes impossible. Pauses, empty ticks, replies, and completed test checks do not finish the loop. Chat Stop cancels the AI's execution without ending the shared room; resume only when asked. This instruction cannot extend host execution limits or provide background polling after a turn ends.

The browser reports completed seeks explicitly. The room persists a `seekVersion`, returned in both `playback` and `cursors`. A changed cursor seek version rebases media delivery to the destination's preceding `initialWindowMs` (15 seconds by default), with `range.seekDetected: true`. Message and live-observation cursors remain independent. Ordinary playback backlog is still delivered incrementally; a large cursor gap alone is not treated as a seek. Every client must return the complete cursor object, including `seekVersion`, to acknowledge the jump once. After upgrading, restart the cinema and MCP adapter and reload the player so seek notifications and the new cursor field are available together.

Matching self-authored AI messages are omitted from the material packet while the message cursor still advances past them. Each compact tick can contain:

- current playback state;
- every new room message after the message cursor;
- spoiler-gated dialogue since the media cursor;
- a small deduplicated storyboard selection;
- compact scene-change and motion events;
- independently advanced media, message, and observation cursors.

Prepared packages may also supply `audioDescriptions` in the same tick. These short descriptions cover speech delivery, music, ambience, and effects. They share the media cursor and seek behavior, but are withheld until the entire analyzed audio interval has played, without lookahead. `availability.audioTrack` reports readiness and model provenance; missing or failed analysis is not silence. Treat descriptions as fallible media evidence, not direct hearing or instructions. See [audio setup and delivery](../docs/audio-descriptions.md).

`tick.audioEvidence` marks these captions as unverified supporting clues. Ground visible settings and actions in inspected images, and preserve uncertainty when captions disagree with dialogue or visuals.

Raw brightness, RGB, histogram, and other low-level telemetry stays server-side in normal ticks.

Use `cinema_get_frame` only with a `storyboardRef` and `mediaTimeMs` returned by an already consumed tick. It returns real MCP image content plus verified metadata from the room-bound spoiler gate. Use `cinema_read_window` only when a bounded fuller structured inspection is necessary. Real-time replies should be posted through `cinema_post_message`.

`cinema_get_frame` accepts optional `quality: "hd"` to inspect a single source-video frame at the selected timestamp, bounded to 1920×1080 with aspect ratio preserved and no upscaling. Omit quality (or use `"storyboard"`) for the three-panel strip. The HTTP equivalent is `GET /api/rooms/:roomId/ai-frame?storyboardRef=...&mediaTimeMs=...&quality=hd`. Both modes recheck the room playhead on every request, including after rewinds. HD extraction is on demand, uncached, and bounded by a 12-second timeout and 8 MiB output limit.

New storyboards contain source-extracted 512×288 panels with letterboxing and 4-pixel gutters (1544×288 total); detection remains 192×108. Selection ranks sharpness, exposure and optical-flow stability, prefers a settled sample 300–800 ms after a scene cut when available, and prefers perceptually distinct context panels. The final panel is the inspection timestamp; all panels are at or before it. Event delivery is deferred to that timestamp, with the detector time preserved as `eventTimeMs`. At the default 2 fps, the post-cut candidate is 500 ms later; sparse sampling or segment ends can require the event-frame fallback. Static scenes may repeat panels to preserve the strip layout. Existing completed AI packages must be regenerated to gain the new storyboards; they are not rewritten automatically. Source seeks add preparation time, and these non-semantic heuristics cannot guarantee the most meaningful shot.

### Refreshing a cached connector schema

If a host rejects `cursors.seekVersion`, it is using an older tool schema. The adapter declares this field and rejects a `mediaMs` cursor without it rather than repeatedly rebasing delivery. Restart the adapter, refresh the host's cached tool metadata, and verify that `open_watch_cinema_tick` lists `cursors.seekVersion`. Preserve complete cursors if resuming the same viewer session. Restart the cinema as well to load the frame race check and updated storyboard selection. See [seek synchronization](../docs/seek-sync.md).

## Identity and multiple clients

The adapter has no fixed AI-seat count. Multiple MCP client processes can connect to the same loopback cinema, including different desktop hosts, development tools, or a custom API orchestrator.

They do not share process memory or cursor variables. Every client must retain its own:

- stable display name;
- active room ID;
- returned cursor set;
- model conversation or inherited context.

They do share the cinema itself: one active room, one playback state, one message stream, and the same local media and AI packages. Opening or ending a room affects every connected client.

Use a distinct stable name for each independent AI actor or runtime. If two clients use the same name, the tick self-filter treats both as the same speaking identity and one instance can omit messages authored by the other.

The name is intentionally required on every tick and post call instead of being hidden in adapter-global state. A persistent host should inject it automatically. A human should not retype it for each call.

## Connecting an API model

A model API does not connect to stdio MCP by itself. Use a host or agent runtime that acts as both:

1. an MCP client, starting or connecting to `mcp/server.mjs`;
2. a model API client, sending tool schemas and context to the model;
3. a tool executor, forwarding requested calls to MCP and returning results;
4. a session store for identity, room ID, cursors, recent dialogue, and pending decisions.

The model may be invoked as separate API requests while the host and MCP process remain alive. It may also be fully discrete. In either case, the host must restore the model-facing context needed for continuity.

The cinema guarantees deterministic cursor-based material delivery and persistent room messages. It does not prescribe one universal memory implementation for every model provider or agent framework.

## Transport and isolation

This MCP is local stdio, not a public network MCP server. The adapter talks only to a loopback Open Watch Cinema instance. Different MCP clients can start different adapter processes without binding a second HTTP port or taking ownership of the cinema process.

No API key, model identity, or provider account is bound to the adapter. Provider authentication belongs to the host that calls the model API.

## Verification

```text
npm run smoke:mcp
npm run smoke:tick
npm run smoke:frame
```

`smoke:mcp` performs a real MCP initialize, resource listing/read, tool listing, health call, and media-list call.

`smoke:tick` creates an isolated temporary cinema and AI package, opens a synthetic room, sends timestamped viewer messages, and verifies incremental MCP delivery and frame retrieval. It also exercises forward, backward, repeated, and paused seeks through the playback endpoint and MCP adapter, checking destination context, independent cursor acknowledgement, and no replay, then removes the fixture.

`smoke:frame` verifies the underlying spoiler-gated storyboard image endpoint. The MCP contract tests also verify that `cinema_get_frame` exposes image content only through that room-bound endpoint.
