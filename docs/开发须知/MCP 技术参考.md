# Open Watch Cinema MCP

This folder contains the dependency-free stdio MCP adapter for Open Watch Cinema. The technical operating rules for a connected model are also published as the MCP resource `open-watch-cinema://skills/watch-together` and stored in `mcp/SKILL.md`.

See the [MCP client setup guide](../工具准备/MCP%20客户端接入.md) for the cinema controls. For automatic delivery to Codex, see the [Codex App Server viewer guide](../工具准备/Codex%20App%20Server.md).

## Requirements

- Node.js 24 or newer
- Open Watch Cinema running on the same computer
- A cinema API advertising `ai-window-v1`, `ai-tick-v1`, `ai-frame-v1`, and `ai-playback-state-v1`
- An MCP host that can start a local stdio server

The adapter ignores older cinema processes that do not advertise the required tick/window capabilities, even when they are otherwise healthy.

## Start command

Configure an MCP client to run:

```text
node <open-watch-cinema-project>/mcp/server.mjs
```

By default, the adapter exposes only the core viewing and interaction tools. Optional tool groups are enabled independently via CLI flags or environment variables:

- `--with-history` (or `OPEN_WATCH_CINEMA_ENABLE_HISTORY=1`): enables `cinema_read_window` for looking back at earlier dialogue and sound descriptions in the active room.
- `--with-control` (or `OPEN_WATCH_CINEMA_ENABLE_CONTROL=1`): enables `cinema_manage` and `cinema_control` for library management, preparation, opening/ending rooms, and local seek proposals.

The adapter discovers the supported loopback development ports automatically. For a custom port, set `OPEN_WATCH_CINEMA_URL` in the MCP client environment. Set `OPEN_WATCH_CINEMA_REQUIRE_URL=1` to require that URL and restrict discovery and reconnection to that address. You can also copy ready-to-use client configs (Codex, Claude Desktop, Claude Code, Antigravity, or generic stdio MCP) and a neutral viewing prompt template from **影院设置 → 连接 AI → MCP 客户端** in the cinema web UI.

Select a viewing AI in **影院设置 → 名字与档案** before connecting the host. Choose **添加 AI** at the end of the list to create a profile. The selection is stored in the cinema and reused after restarts. An adapter that connected before the first selection can pick it up on its next identity-dependent call.

## AI viewing skill resource

After initialization, a capable MCP host should list and read:

```text
open-watch-cinema://skills/watch-together
```

The same rules are included in `mcp/SKILL.md`. Initialization instructions explain the managed identity, cursor, frame, and spoiler boundaries so clients that do not automatically surface resources still receive the essential contract.

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

Default tools (watching and interaction, 4 tools):

- Watching: `open_watch_cinema_tick`, `cinema_inspect_frame`, `cinema_post_message`.
- Film notebook: `cinema_notebook` reads and writes a shared film notebook.

Optional tools (enabled independently):

- History lookup (`--with-history`): `cinema_read_window({ fromMs, toMs })` reads earlier dialogue and sound text from the active room up to the current playhead.
- Control (`--with-control`):
  - `cinema_control` with `request({ targetMs, reason })`, `status({ requestId })`, `cancel({ requestId })` against the active room.
  - `cinema_manage` with `status`, `rescan`, `list_media`, `prepare_ai`, `job_status`, `list_rooms`, `open_room`, `end_room`.

Grouped calls use `{ action, parameters }`. For example:
`cinema_manage({ action: "open_room", parameters: { mediaId } })`.
Schemas describe the parameters separately for each action. `cinema_read_window`, `cinema_control`, and `cinema_manage` `end_room` resolve the active room automatically without requiring a `roomId`.

Control requests bind the active room, seek version and exact target, expire after two minutes,
and stay private to one MCP process. They cannot be approved or executed through MCP.
The existing HTTP API has no trusted user-approval boundary. Until that integration
exists, ask the viewer to seek manually. Requests are not shown in the browser.

## Normal viewing loop

Follow the polling pace agreed with the viewer before starting (which can be copied from **影院设置 → 连接 AI → MCP 客户端**). During an active viewing turn, call `open_watch_cinema_tick({})` regularly. The host initiates each call.

The normal result is chronological text and image content. It starts with playback position/state, then movie-time sections containing full dialogue, sound ranges, short motion descriptions and actual JPEG blocks. Each image has a time-only caption. New Balanced and Full packages mark the matching region in the full scene and the detail during preparation. The first tick explains the convention for that room. Empty categories are omitted; a section can receive further entries on the next call. Internal IDs, paths, scores and private cursors remain inside the adapter.

For example, the layout may be:

```text
12:08–12:14
12:09 · 甲：“小心！”
12:09.5 · 12:10
[actual MCP image content]
12:10–12:20 · 声音：连续脚步声
12:12 · 乙：“快走！”
```

This is a layout example, not an analyzed film. A prepared sound description is delivered from the range's start and can summarize the next few seconds. Its full range can extend past the owning section and current playhead. Old end-gated records are interpreted with the same start policy in memory; picture and dialogue gates keep their own timing.

Prepared pictures are no longer reduced to two across an entire call. Image requests run in overlapping pairs and retain chronological output order. One image failure omits that image while keeping the other pictures and complete text. A caption is emitted only for an image actually attached. Current v3 viewing packages are recommended and store finished storyboard images only. `cinema_inspect_frame({atMs})` re-reads a delivered storyboard by its displayed film time in milliseconds; `quality:'hd'` is kept only for un-upgraded legacy v2 packages (a tick gives one timestamped HD hint when an older package supports it).

When preparation lags, the feed says **正在准备** and keeps its actual read cursor. Continue at the normal polling pace. When bounded catch-up or an explicitly configured image budget leaves content to deliver, **待续** asks the model to call again. Regular calls are the normal path; backlog continuation is a fallback.

Late audio ranges stay in the existing MCP process. Later calls request those ranges with `tracks=audio`, omit already delivered sound IDs, and place newly ready sounds in their original movie sections. A room change or seek resets this supplemental context. Sound captions remain fallible local analysis; missing audio is not evidence of silence.

The adapter performs one lightweight room/seek check after assembling the result. Only a successful check commits delivery state. Browser seeks rebase viewing context around the destination; room messages and live-observation cursors keep their existing role. Posting with `cinema_post_message({content})` binds the current room and authoritative playhead.

If the viewer continues a film from where the previous room ended, automatic tick delivery starts at that chosen time. A later manual seek follows the usual seek behavior. The Codex watch bridge puts the shared notebook before the first playback tick in this case. Other MCP clients can read it with `cinema_notebook`.

Settings are stored by the cinema. A managed tick carries one settings snapshot; a changed revision produces one brief notice after successful delivery, while `SKILL.md` stays stable. Storyboards come from the film’s prepared package. Choose its layout when preparing the film.

During an active viewing turn, paused or empty ticks do not themselves end watching. Respect Stop/cancellation and host execution limits; there is no background polling after a turn ends.

## Identity and multiple clients

The adapter has no fixed AI-seat count. Multiple MCP client processes can connect to the same loopback cinema, including different desktop hosts, development tools, or a custom API orchestrator.

They do not share process memory or cursor variables. Each MCP process automatically retains its active profile reference, room binding, cursor set and pending delivery state. The host maintains model conversation context.

They do share the cinema itself: one active room, one playback state, one message stream, and the same local media and AI packages. Opening or ending a room affects every connected client.

The adapter filters self-authored messages by the bound profile ID. To connect another AI, change the selection in the cinema settings before connecting its adapter. A rename updates the credits of the same profile, including its existing notes and messages.

### Connection activity in the player

Each adapter has its own connection ID. The player shows connections that have made tool calls. A successful tick in the active room marks the connection online for the viewer's chosen timeout, which defaults to 30 seconds. Paused ticks also renew this status. Ending the room or disconnecting clears it immediately. A completed tool call can report the exact model-facing text and images, including tool errors. The viewer can inspect results until the cinema service stops. Activity reporting runs independently of tool execution.

## Connecting an API model

A model API does not connect to stdio MCP by itself. Use a host or agent runtime that acts as both:

1. an MCP client, starting or connecting to `mcp/server.mjs`;
2. a model API client, sending tool schemas and context to the model;
3. a tool executor, forwarding requested calls to MCP and returning results;
4. a session store for identity, room ID, cursors, recent dialogue, and pending decisions.

The model may be invoked as separate API requests while the host and MCP process remain alive. It may also be fully discrete. In either case, the host must restore the model-facing context needed for continuity.

The cinema provides cursor-based material delivery and persistent room messages. It does not prescribe one universal memory implementation for every model provider or agent framework.

## Transport and isolation

This MCP is local stdio, not a public network MCP server. The adapter talks only to a loopback Open Watch Cinema instance. Different MCP clients can start different adapter processes without binding a second HTTP port or taking ownership of the cinema process.

No API key, model identity, or provider account is bound to the adapter. Provider authentication belongs to the host that calls the model API.

## Request lifecycle and recovery

- Confirmed service addresses and their health results are retained for this adapter process. Discovery is shared between simultaneous callers and retried after a connection failure or incompatible response. Cancelling one caller does not cancel another caller's shared discovery. `cinema_manage({ action: "status", parameters: { ... } })` refreshes `/api/health` at the confirmed address and returns the current `health` with `healthCheckedAt`; only a failed or incompatible check triggers fallback address discovery. Ordinary viewing requests continue to reuse the address without a new health probe.
- The paired cinema backend advertises `ai-playback-state-v1` and marks its HTTP responses with `x-open-watch-cinema: open-watch-cinema`. Restart both backend and adapter when installing this change; an older running backend is reported as incompatible.
- After assembling images and text, the adapter performs one `GET /api/rooms/<id>/playback-state` check. This endpoint returns only room ID, status, playback state, playhead and seek version. It never reads room messages. Both text-only and image packets use this check before committing private cursors.
- `notifications/cancelled` applies to ordinary tool calls. It stops that call's HTTP requests, next catch-up pages and image loading; no final reply is emitted for the cancelled request. Cancelling an in-flight write does not undo a server operation that has already completed. Writes are never automatically repeated.
- GET/HEAD and the explicitly read-only managed tick POST may rediscover and retry once after a connection-level failure. Other POST requests return `WRITE_OUTCOME_UNKNOWN` if their response was lost; check the resulting state before retrying.
- Failed individual pictures are omitted while retaining the other pictures and full text. Host cancellation aborts the entire call instead of becoming a missing-image fallback. The frame reader propagates cancellation to image reads and the remaining legacy FFmpeg path.
- Optional `OPEN_WATCH_CINEMA_CATCHUP_BUDGET_MS` limits the time spent reading catch-up pages. If completed pages exist, they are returned with the existing `pendingThroughMs` continuation; an unfinished page is retried from its previous cursor on the next call. If no page completed, the response is a normal waiting state. The default duration remains undecided, so an omitted setting preserves the existing page/text limits. Image assembly and the final state check keep their existing per-request timeout and are outside this page-reading budget.
- A concurrent second tick returns `{state:"waiting",reason:"tick_in_progress"}`. Tool failures use `error`, `message`, `status`, `retryable`, and `nextAction`; raw backend bodies and diagnostic paths are not echoed.

- Optional `OPEN_WATCH_CINEMA_IMAGE_BUDGET_BYTES` provides a total raw-JPEG byte budget for one reply. It has no new numeric default. The first permitted image can exceed this soft total to ensure progress; the per-image bound still applies. Remaining entries are queued as references in this MCP process, and the collected read cursor commits when that packet drains. A seek discards the old queued context.
- Each storyboard has a delivery limit of 1,572,864 raw bytes (2 MiB Base64). Encoding and quality reduction belong to preparation/the image backend; MCP checks the final result.

Preparation removes repeated views, crops local changes and places insets before saving the finished images. Each tick sends those files byte for byte in package order as playback reaches them. Polling cadence and the per-reply byte budget affect which call carries a file. Current v3 packages are recommended: Balanced shows the scene and changed regions at a common scale, Economy packs selected moments into small full-frame strips, and Full delivers separate scenes at up to 480p, 720p or 1080p with magnified source details in an inset or separate image. Un-upgraded legacy v2 packages keep serving their saved strips and can extract a source HD still on demand until upgraded to v3.

## Verification

```text
npm run smoke:mcp
npm test
```

`smoke:mcp` performs a real MCP initialize, resource listing/read, tool listing, health call, and media-list call. `npm test` covers live ticks, seek cursors, spoiler-gated storyboard inspection, and MCP tool contracts.

## Tool source layout

Tools are grouped around the viewing experience, not one file per command:

- `tools/viewing.mjs`: ticks, selected images, time windows and room messages. The connection’s profile binding belongs to `viewing/viewing-session.mjs`.
- `tools/preparation.mjs`: cinema discovery, library listing/rescanning, AI preparation, and job progress.
- `tools/index.mjs`: combines the groups, preserves the public tool order, validates the call envelope, and passes cancellation and HTTP requests to handlers.

Each entry keeps its public definition beside its handler. The internal `order` value preserves the existing `tools/list` order and is not sent to clients. Add a new entry to the appropriate group and update the public-contract fixture intentionally when changing the interface.

`server.mjs` is the composition root: it loads configuration and the skill resource, creates the cinema client and viewing session, registers the two tool groups, and starts stdio. It contains no tool, HTTP, image-access or protocol implementation.

- `cinema-client.mjs`: compatible cinema discovery, per-client connection cache, HTTP/JSON/image responses, timeouts, read-only retries, and uncertain-write protection. `fetchImpl` can be injected for deterministic tests.
- `protocol.mjs`: MCP handshake/resources/tools, in-flight request cancellation, result envelopes, and stdio framing. The protocol factory and transport startup are separate so importing modules starts no process or input listener.
- `viewing-session.mjs`: creates one private session, its bounded image history, and gated frame inspection. Each factory call receives its own Maps, Sets and cursors.
- `configuration.mjs`: existing environment-derived options and default tick limits.
- `validation.mjs` / `results.mjs`: shared argument checks, error construction, and public result/error formatting.
- `viewing-guidance.mjs`: viewing preference descriptions, instructions and preparation warnings, without I/O.

Dependencies are passed explicitly to tool factories. The tick flow remains together in the viewing group and continues using `catchup-feed.mjs` and `viewing-feed.mjs`. Backend HTTP routes and database/film processing remain outside the MCP adapter. New modules should be assembled in the entry point rather than adding their implementation there.

Regression coverage: `tests/mcp/mcp-tools.test.mjs` checks the public schemas and tool order, group membership, routing, cancellation and connection identity handling. Existing smoke tests exercise the adapter over stdio and a temporary cinema backend.

`tests/mcp/mcp-runtime.test.mjs` additionally checks connection retry policy, isolated discovery cancellation, protocol request cancellation/duplicates, frame access boundaries, and independent sessions. These are preservation tests, not a new viewing-product specification.

## Source layout

- `server.mjs`: stable startup entry; assembles dependencies and starts stdio.
- `README.md` and `SKILL.md`: human documentation and AI viewing guidance.
- `runtime/`: cinema HTTP connection, MCP protocol, configuration, validation and result formatting.
- `viewing/`: private viewing session, chronological feed, catch-up and viewing guidance.
- `tools/`: public watching tools and grouped control, management and settings actions.

The public tool names and startup command are unchanged by this directory organization.


## Film notebook

Use `cinema_notebook({action:"write",text})` for a batch and `cinema_notebook({action:"read"})` for the current formatted text. The [viewing skill](../../mcp/SKILL.md#a-small-film-notebook) gives the line format. Optional read filters are `section`, `character`, `fromMs`, `toMs` and `unresolved`. The original single-entry `save` and `delete` actions are also available.

The active room selects the film. Each film has one notebook shared by viewers and AI participants across screenings. Browser edits and text writes commit to the same SQLite revisions. Text reads resolve current author names for the entry and its individual fields. A human correction produces a separate event delivered through each adapter's notebook-event cursor. Opening the book can also produce the existing book-peek interaction when room interactions are enabled.

Each adapter has its own cursors. The cinema settings control display names for the viewer and each AI profile. An empty viewer name is displayed as `user`.

Animation candidate analysis is an explicit per-film browser setting. Candidate scores are not identity decisions; no names or embeddings are returned by that endpoint. Only already-played regions and strictly earlier comparisons are available. Missing models leave ordinary viewing and notes operational.
