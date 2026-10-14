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

The browser reports completed seeks explicitly. The room persists a `seekVersion`, returned in both `playback` and `cursors`. A changed cursor seek version rebases media delivery to the destination's preceding `initialWindowMs` (15 seconds by default), with `range.seekDetected: true`. Message and live-observation cursors remain independent. Ordinary playback backlog is still delivered incrementally; a large cursor gap alone is not treated as a seek. Every client must return the complete cursor object, including `seekVersion`, to acknowledge the jump once. After upgrading, restart the cinema and MCP adapter and reload the player so seek notifications and the new cursor field are available together.

If a host rejects `cursors.seekVersion`, refresh its cached tool metadata after restarting the adapter. The adapter rejects `mediaMs` without `seekVersion` to prevent repeated destination replay. Preserve the complete returned cursors instead of stripping fields or resetting them. See [seek synchronization](../docs/seek-sync.md) for migration and validation.

Matching self-authored AI messages are omitted from the material packet while the message cursor still advances past them. Each compact tick can contain:

- current playback state;
- every new room message after the message cursor;
- spoiler-gated dialogue since the media cursor;
- a small deduplicated storyboard selection;
- compact scene-change and motion events;
- independently advanced media, message, and observation cursors.

Raw brightness, RGB, histogram, and other low-level telemetry stays server-side in normal ticks.

Use `cinema_get_frame` only with a `storyboardRef` and `mediaTimeMs` returned by an already consumed tick. It returns real MCP image content plus verified metadata from the room-bound spoiler gate. Use `cinema_read_window` only when a bounded fuller structured inspection is necessary. Real-time replies should be posted through `cinema_post_message`.

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

`smoke:tick` creates an isolated temporary cinema and AI package, opens a synthetic room, sends timestamped viewer messages, exercises forward, backward, repeated, and paused seeks through the playback endpoint and MCP adapter, verifies independent cursor advancement, destination context, and no replay, then removes the fixture.

`smoke:frame` verifies the underlying spoiler-gated storyboard image endpoint. The MCP contract tests also verify that `cinema_get_frame` exposes image content only through that room-bound endpoint.
