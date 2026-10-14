# AI cursor synchronization after seeks

A forward seek could leave an AI consuming the skipped interval as backlog. The player now reports completed browser seeks explicitly, and the server rebases media delivery to the destination. Ordinary slow polling still drains its backlog rather than being mistaken for a seek.

## Contract

- `POST /api/rooms/:roomId/playback` accepts `seeked: true` on a completed seek. Pause, resume, and time updates alone do not increment the room's `seekVersion`.
- The player retains a pending seek across coalesced events and sends playback requests in order. A pending seek cannot transfer to another room.
- Ticks return `seekVersion` in both `playback` and `cursors`. A changed version supplies the destination's preceding `initialWindowMs` of context (15 seconds by default), with `range.seekDetected: true`.
- Return the entire cursor object unchanged on the next tick. The MCP adapter rejects a `mediaMs` cursor without `seekVersion` instead of repeatedly replaying destination context.
- Message and live-observation cursors remain independent of media rebasing. A rewind may legitimately replay destination media context; ordinary acknowledged polling does not.

The database adds `watch_sessions.seek_version` with a default of zero when the server opens it. Existing rooms and messages are retained. No AI package regeneration is required for this cursor change.

## Upgrade

Restart the cinema server and MCP adapter, then reload the player. Hosts that cache tool schemas must refresh the adapter's tool metadata before resuming with saved cursors. If `seekVersion` is rejected, preserve those cursors and refresh the schema; do not remove the field or reset to the current playhead.

## Validation

Run `npm run check`, `npm test`, and `npm run smoke:tick`. The isolated smoke test exercises the playback endpoint and MCP adapter with forward, backward, repeated, and paused seeks, along with destination acknowledgement and independent cursors. Fixtures are temporary; these checks do not use the viewer's films or rooms.

For an attended check, join a test room, play briefly, and test a forward seek and a backward seek separately with a tick between them. Verify each changed version supplies destination context once. Pause, seek while paused, and resume; confirm that ordinary pause/resume does not report an additional seek. Deliberately let polling fall behind without seeking and verify that backlog remains available.

Historical Windows viewing checks on September 15, 2026 observed delivery at the latest seek destination and pause/resume behavior. Two seek changes occurred between polls in one check, so that observation alone did not independently validate both landings. Automated tests cover the individual cases.
