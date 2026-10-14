# Visual evidence during companion viewing

Dialogue alone misses quiet action. Ticks now attach up to two selected storyboard images as MCP content blocks, so a companion can inspect the scene without issuing a separate frame call on every update. A short text label identifies each image and its timestamps. `tick.visualEvidence.images` reports attached and unavailable images explicitly.

## Selection and preparation

Selection retains the latest eligible view and prefers a distinct earlier composition spread across the window. Similar compositions can reduce the response to one image. The comparison uses perceptual hashes and colour measurements; it is a heuristic, not semantic scene recognition. Raw measurements remain server-side.

Prepared tracks add `visual_heartbeat` images after roughly 12 seconds without a selected visual, and context at each chunk ownership boundary. Real scene and motion events take priority and reset that deadline. Heartbeats do not suppress later events. They use the existing cursor and spoiler gate; actual delivery depends on host polling.

New storyboard strips contain three source-extracted 512 by 288 panels with letterboxing and gutters. Detection remains at 192 by 108. Selection favours sharp, exposed, stable samples, including a settled frame after a cut when available. Panel timestamps never exceed the strip's inspection timestamp. These heuristics do not guarantee the most meaningful shot.

`cinema_get_frame` can inspect another selected view. Optional `quality: "hd"` extracts a single source frame at the same selected timestamp, capped at 1920 by 1080 without upscaling. The same reference allowlist and playhead gate apply. Extraction is uncached, with a 12-second timeout and 8 MiB output limit.

## Upgrade and host requirements

Restart the server and adapter, reload the player, and refresh cached tool metadata to discover the optional frame quality field. The MCP adapter advertises version 0.6.0 for the expanded response; the cinema HTTP API remains 0.5.0.

Hosts must forward the image content blocks to a model that supports images, alongside the JSON text. A text-only host cannot inspect an attached image. Missing images are reported rather than treated as observed evidence. Each inline image is limited to 2 MiB of base64 data, and a response contains at most two images. Images and timestamps remain subject to room/playhead checks, including after rewinds; a seek during loading rejects the stale packet and requires a retry with the same input cursors.

Existing completed AI packages retain their old visual assets, and a normal retry reuses completed checkpoints. There is no automatic visual migration or one-click rebuild in this change. Use a newly prepared test film to try the new assets. For a separate development package, run `npm run observer:precompute -- --input path/to/test-film.mp4 --output-root path/to/fresh-test-packages`; this does not replace the indexed package used by an existing room. Replacing an existing room's package requires an explicit maintenance rebuild with the old package retained for recovery. Generating source-resolution panels adds preparation work. Ordinary playback does not start preparation or invoke a visual model.

The viewing skill asks a companion to keep polling while attached, including while paused, but permits selective replies and silence. Host cancellation and execution limits take precedence. Stopping an AI's chat does not end the shared room or provide background polling.

## Validation

Run `npm run check`, `npm test`, `npm run smoke:tick`, and `npm run smoke:frame` with the optional OpenCV observer installed. Tests cover source-resolution strips, post-cut selection, static footage across chunk boundaries, composition selection, image limits, missing-image reporting, paused no-replay behavior, and stale packets after a seek. Smoke checks exercise real HTTP and MCP frame delivery with temporary fixtures.

For an attended check, prepare a new test film, join its room, and watch both a quiet scene and a scene transition. Inspect image timestamps and confirm the latest view is represented, at most two images arrive per tick, acknowledged paused polls do not repeat them, and a rewind releases only destination context. Stop the chat and confirm the room remains available.

Historical Windows companion sessions in September 2026 reported improved scene continuity with images and dialogue. Those reports are qualitative viewing evidence, not a formal evaluation of semantic scene understanding or of heartbeat cadence across films. Automated static-footage fixtures validate heartbeat delivery; macOS and other MCP hosts still need attended validation.
