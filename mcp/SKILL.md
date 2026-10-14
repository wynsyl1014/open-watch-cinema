# Open Watch Cinema — AI Viewing Skill

Use this skill whenever you are connected to Open Watch Cinema through its MCP server.

## Purpose

Join a viewer inside one local watch room, follow the current playhead without reading ahead, receive new room messages and timed dialogue, inspect selected storyboard frames, and post reactions back beside the moment where they belong.

## Stable identity

Choose one stable cinema display name before the first tool call, or use the name the viewer gives you.

- Pass the exact same name as `consumerName` on every `open_watch_cinema_tick` call.
- Pass the exact same name as `senderName` on every `cinema_post_message` call.
- Keep that name in client configuration or session state; the human should not need to type it again for every call.
- Independent AI actors or runtimes should use distinct names. Two clients using the same name are treated as one speaking identity for self-message filtering.

## Before the film starts

1. Call `cinema_status` and confirm the local cinema is reachable.
2. Call `cinema_list_media` and inspect compatibility, subtitle tracks, and `aiPackage` readiness.
3. Call `cinema_list_rooms`.
4. Reuse the active room when it is the viewer's intended screening. Otherwise ask before opening or ending a room.
5. If opening a room through MCP, call `cinema_open_room`. Never set `allowIncomplete: true` until the viewer has accepted the warning.
6. Keep the returned `roomId`, your stable name, and your own cursor set together as one client session.

## Normal viewing loop

Call `open_watch_cinema_tick` repeatedly while the screening is active.

- On the first call, omit cursors unless intentionally resuming saved cursors.
- After every successful call, store the returned cursors and pass them back unchanged on the next call.
- Maintain cursors separately for each `{cinema instance, roomId, AI identity}`. Another AI's cursors must not replace yours.
- Treat the returned playback state and playhead as authoritative.
- Read only the dialogue, messages, observations, and storyboard selections returned by the spoiler gate. Do not infer future plot or unseen material.
- Respond selectively. Silence is allowed when there is nothing worth saying.
- Post a reaction with `cinema_post_message`, using the current returned playhead as `mediaTimeMs` and your stable name as `senderName`.
- Continue polling at a cadence chosen by the host application. Poll promptly after a viewer message, seek, pause/resume, or meaningful scene change; avoid wasteful tight loops.

A tick is incremental delivery, not a complete transcript. Resetting cursors can replay old material. Losing cursors can skip the continuity your host intended to preserve.

The returned cursors include `seekVersion`. Pass every cursor field back unchanged. When `range.seekDetected` is true, use the destination context rather than treating skipped footage as current viewing. Message and live-observation cursors remain independent. If the host rejects `seekVersion`, stop and refresh its cached tool metadata; dropping the field can replay destination context.

## Seeing a selected frame

A tick may return one or more selected storyboard entries. To actually inspect one:

1. Choose only a storyboard entry returned by the current or an already consumed tick.
2. Call `cinema_get_frame` with its `storyboardRef`, `mediaTimeMs`, and the same `roomId`.
3. Use the returned image as visual evidence for that moment.
4. Fetch frames sparingly: important reactions, visual clues, scene transitions, or moments where dialogue alone is insufficient.

Never invent what a frame contains from its filename or metadata. `cinema_read_window` returns bounded structured context; it is not a substitute for fetching an image when visual detail matters.

## Fuller bounded inspection

Use `cinema_read_window` only when the compact tick is insufficient. Keep the requested range close to the current playhead. The server enforces spoiler gating, but you should still request the smallest useful window.

## Discrete API model calls

The MCP server is not a universal model-memory service. When the host invokes the model as separate API calls, the host must restore at least:

- this skill or its operational rules;
- the stable AI display name;
- the active `roomId`;
- the latest returned cursors;
- enough recent conversation or a faithful running context to preserve the AI's own continuity;
- any pending decision, such as waiting for the viewer to press play.

The host should inject `consumerName` and `senderName` automatically on tool calls. A new model invocation does not require the human to re-enter the name, but a stateless host that forgets its configuration will lose that identity.

## Multiple connected AIs

Open Watch Cinema does not impose a fixed AI-seat count in the MCP adapter. Multiple MCP client processes can connect to the same loopback cinema, but they share:

- one active room at a time;
- the same playback state;
- the same room message stream;
- the same local media and AI packages.

Each client must keep its own identity, cursors, and model context. Coordinate room-opening and room-ending actions, because those affect everyone. Do not end the room merely because your own client is leaving.

## Ending

Only call `cinema_end_room` when the viewer explicitly ends the screening or clearly delegates that action. Ending archives the room as read-only. A client that merely disconnects should stop polling without ending the shared room.
