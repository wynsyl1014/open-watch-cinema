# Open Watch Cinema

A local-first watch room for films stored on the viewer's own disk. Open Watch Cinema combines recursive media scanning, embedded SQLite, safe browser-compatibility preparation, HTTP Range streaming, timed room conversation, danmaku replay, precomputed AI dialogue/visual packages, spoiler-gated incremental MCP delivery, selected storyboard image retrieval, and read-only session archives.

The primary launch targets are Windows and macOS. The application binds only to `127.0.0.1`; it is not a LAN or public streaming server.

Human users should begin with [`FOR_USERS.md`](./FOR_USERS.md). MCP hosts and connected models should also read [`mcp/README.md`](./mcp/README.md) and [`mcp/SKILL.md`](./mcp/SKILL.md).

Optional [local audio descriptions](./docs/audio-descriptions.md) add possible speech, music, ambience, and sound-effect descriptions to the same prepared chunks and AI updates. Run `setup-audio.ps1` on Windows or `bash setup-audio.command` on macOS, then choose **Add audio descriptions** for an existing AI package. Audio inference runs locally; a historical Windows CPU validation prepared all 26 chunks of one test film and exercised companion playback. The scope and remaining limits are documented with the audio feature.

## Requirements

- Node.js 24 or newer.
- FFmpeg and FFprobe available on PATH.
- Chrome or another Chromium browser.
- Python 3 for **Prepare for AI viewing** and the visual observation worker.
- Optional but strongly recommended: headless OpenCV through the project-local observer environment, enabling richer motion analysis and storyboard image generation.

The Node runtime uses built-ins only and has no third-party npm dependencies.

## Quick start

### Windows

1. Put one or more videos inside `local-data/media`.
2. Double-click `start.bat`.
3. Open `http://127.0.0.1:4182` if the browser does not open automatically.
4. Optionally run `setup-observer.bat` before preparing films for AI viewing.

### macOS

1. Put one or more videos inside `local-data/media`.
2. Run `start.command`.
3. If macOS has not marked the launchers executable, run once:

```bash
chmod +x start.command setup-observer.command
```

4. Optionally run `setup-observer.command` to install the project-local OpenCV observer.
5. Open `http://127.0.0.1:4182` if the browser does not open automatically.

While the server is running, press **Rescan** after adding, removing, or renaming files. New films are now **direct-play first**: select the film and let the current browser try the original stream. Use **Check & prepare playback** only when that browser cannot load it.

Primary tested input is `.mp4`. The scanner also accepts `.m4v`, `.webm`, `.mov`, and `.mkv` as best-effort inputs; unusual subtitle, multi-audio, HDR, image-subtitle, or container layouts may need user-specific changes.

## Solo viewing and rooms

Playback is solo by default. Solo viewing does not create a room, store messages, connect an AI, or expose room-bound AI material.

Select a film and let the browser load the original file. Test both picture and sound; if the film works correctly in the current browser, press **Mark Ready** on its card. That confirmation is stored only for this browser and this exact file version. Then press **Open room** to create one active watch session. A room:

- is bound to one film;
- allows one unified viewer/AI message stream;
- stores every message with the current film time in milliseconds;
- makes spoiler-gated AI tick, window, and frame APIs eligible;
- prevents switching to another film until the room ends.

Only one room can be active at a time. Press **End room** to archive it. Archived rooms remain playable and retain timed messages, but message, playback-state, observation, and live AI-tick writes are rejected.

## Messages, danmaku, and archives

The quick input under the screen and the right sidebar write the same room-message type.

- The sidebar always shows the complete room history.
- Danmaku controls only the video overlay, not storage or sidebar visibility.
- Viewer and AI messages are both timestamped against the film.
- In an archived room, messages replay when playback crosses their saved time.
- The custom full-screen control expands the whole cinema container so danmaku and quick input remain available.

The MCP adapter posts into this same stream. The AI does not choose a separate “chat” versus “danmaku” channel; overlay visibility remains a viewer-side preference.

## Responsive cinema layout

The browser UI is viewport- and height-aware. On sufficiently wide screens it switches between three stable arrangements:

- a film-library wing beside the screen while browsing;
- a room-message wing beside the screen while the sidebar is open;
- a centered focus screen when both wings are closed.

Narrower screens use the compact responsive layout. In the wide browsing layout, the film-library wing follows the cinema workspace height; individual cards keep their natural content height and overflow scrolls inside the library instead of clipping unfinished cards or stretching the page. Viewer name, danmaku preference, subtitle choice, library state, last film, and per-film progress are stored in browser local storage.

## Direct play and minimal playback repair

Playback is **direct-play first**. The original Range stream is offered to the current browser before any compatibility rewrite is required. The application deliberately avoids a browser-brand codec matrix: real playback support can vary with the browser build, operating system, hardware decoding, and the exact media layout. After testing picture and sound, the viewer explicitly presses **Mark Ready**. That confirmation is browser-local and file-fingerprint scoped; it is not written as a universal server compatibility claim. When the film has no existing WebVTT bundle, the server separately probes and extracts supported embedded text subtitles without transcoding the video.

If direct playback is not satisfactory, **Check & prepare playback** asks what actually went wrong and applies the smallest requested repair instead of immediately normalizing the whole film:

- **Picture works, no sound:** keep the current container and copy the video stream; convert only audio to AAC.
- **Sound works, no picture:** keep the current container and copy the audio stream; convert only video to H.264 `yuv420p` at source resolution.
- **The file will not load:** first try a light MP4 remux with both video and audio copied unchanged. This changes the container without recompressing the streams.
- **Not sure / safest fallback:** use MP4 and the conservative H.264/AAC profile, while still copying any stream that already matches it.

A targeted same-container repair can fail when that container cannot carry the requested replacement codec. The cinema reports the failure instead of silently escalating to a full transcode; the viewer can then choose the safer fallback explicitly. After any successful repair, the card shows **Retest playback** rather than claiming universal compatibility. The prepared file is loaded again, and the viewer presses **Mark Ready** only after picture and sound are confirmed in the current browser.

The current build keeps the first video stream and first audio stream. Extractable text subtitle streams are converted to WebVTT sidecars before source replacement; burned-in subtitles stay in the image, and image-based subtitle tracks may not be extractable as dialogue.

FFmpeg writes a temporary output beside the source. The temporary file must pass repair-specific FFprobe verification before replacement. If conversion or verification fails, the original source remains available.

## Screen subtitles versus AI dialogue subtitles

The screen subtitle selector and the AI dialogue source are deliberately independent.

- **CC** selects what the viewer sees, including discovered tracks, a generated bilingual Chinese/English option, or a temporary local SRT/VTT file.
- The first **Prepare for AI viewing** click opens a separate dialogue-track chooser. That selected discovered subtitle track becomes the timed dialogue source for the AI package.
- A viewer can display bilingual subtitles while the AI reads only one language.
- A browser-added local SRT/VTT file is screen-only in the current release and is not automatically promoted into the AI package.
- Once an AI package is ready, the film card remains in its completed state and does not expose a casual re-selection button.

Films with extractable embedded text subtitles provide the most complete experience. A missing dialogue source does not block visual preparation; the package reports `visual_only` rather than pretending dialogue is available.

## Local subtitle and AI asset layout

Runtime assets are local and use paths relative to `local-data`:

```text
local-data/
  media/
    My Film.mp4
    My Film.owc-subtitles/
      manifest.json
      01-zho-Simplified.vtt
      02-eng-English.vtt
  ai-packages/
    <mediaId>/
      manifest.json
      chunks/
        chunk-0000/
          visual.json
          dialogue.json
          storyboards/
        chunk-0001/
          visual.json
          dialogue.json
          storyboards/
```

The subtitle bundle stays beside its film as a discoverable lifecycle sidecar. The server resolves actual filesystem paths and publishes local subtitle URLs. The AI package lives under an opaque media ID so derived observations never clutter the media drop folder.

Every AI-package chunk owns one time range and keeps visual observations, dialogue cues, and storyboard images together. `manifest.json` contains portable relative references. Preparation is manually requested, resumable, lock-protected, and never starts merely because ordinary playback begins.

Incomplete AI experiences are visible before room opening. No package, visual-only, dialogue-only, and other incomplete states explain the missing context. The viewer may explicitly continue with reduced capability.

## Cascade deletion

The film-card delete action first requests a preview, then requires exact confirmation before removing:

- the media file;
- its adjacent extracted subtitle bundle;
- its AI package;
- linked watch rooms, messages, and observations.

Active preparation jobs and active rooms block deletion. The database layer exposes separate `deleteSessions` and `deleteMediaIndex` policy switches for forks that want a different retention policy.

## MCP adapter

The repository includes a dependency-free stdio MCP server at `mcp/server.mjs`. It discovers a compatible loopback cinema and exposes twelve tools:

- health, rescan, media listing, AI preparation, and job status;
- room listing and explicit incomplete-room opening;
- compact cursor-based ticks;
- bounded detailed window reads;
- spoiler-gated selected storyboard image retrieval;
- timed AI messages;
- room ending.

Configure an MCP host to run:

```text
node <project-folder>/mcp/server.mjs
```

Set `OPEN_WATCH_CINEMA_URL` only for a custom port. The default discovery range covers normal local development ports.

The MCP advertises an AI viewing skill resource:

```text
open-watch-cinema://skills/watch-together
```

Its source is `mcp/SKILL.md`. It defines stable identity, cursor retention, normal polling, selected-frame reads, multiple-client behavior, discrete API continuity, spoiler boundaries, and room-ending policy. Minimal mandatory instructions are also sent during MCP initialization.

### Incremental viewing

During ordinary viewing, a model repeatedly calls `open_watch_cinema_tick`, supplies one stable `consumerName`, and preserves the returned media/message/observation cursors unchanged for the next call. It receives:

- authoritative playback state;
- every new non-self room message after its own message cursor;
- spoiler-gated dialogue;
- a deduplicated storyboard selection;
- compact scene and motion events;
- independently advanced cursors.

Matching self-authored messages are omitted while the cursor still advances. Raw brightness, RGB, histogram, and other low-level telemetry remains server-side.

When a selected storyboard matters, the model calls `cinema_get_frame` with the `storyboardRef` and `mediaTimeMs` delivered by a consumed tick. The tool returns actual MCP image content through the room-bound spoiler gate. `cinema_read_window` remains available for the smallest useful bounded structured inspection.

Completed browser seeks rebase the AI media cursor to destination context while retaining independent message and observation cursors. After upgrading, restart the server and MCP adapter, reload the player, and refresh cached tool metadata if needed. See [seek synchronization](./docs/seek-sync.md).

Ticks now attach up to two selected storyboard images directly as MCP image content, including sparse prepared snapshots during quiet scenes. New preparation also produces clearer storyboard strips and supports bounded HD inspection. See [visual viewing evidence](./docs/visual-evidence.md) for host support, regeneration, and validation.

### Stable names and multiple AIs

The MCP adapter has no fixed AI-seat count and no provider/account binding. Multiple stdio adapter processes can connect to the same local cinema. Each independent client retains its own stable name, room ID, cursors, and model context.

All clients still share one active room, one playback state, one message stream, and the same local assets. Opening or ending a room affects everyone. Independent AI actors should use distinct names; two clients using the same name are treated as one identity for self-message filtering.

`consumerName` and `senderName` are required on every relevant tool call. A persistent client should inject them automatically rather than asking the human repeatedly.

### API models

An API model can use this MCP through a host or agent runtime that acts as both MCP client and model API client. The host starts the stdio adapter, supplies tool schemas and skill context to the model, executes requested MCP calls, and returns results.

For discrete model invocations, the host must restore at least the stable name, active room ID, latest cursors, recent conversation or a faithful running context, and pending decisions. The cinema persists room facts and delivers deterministic cursor increments, but it does not impose one universal model-memory layer.

See `mcp/README.md` for the exact technical contract and `FOR_USERS.md` for a copyable human-to-AI setup prompt.

## Scene observer

Python plus FFmpeg provides a baseline low-resolution visual analysis layer. It emits timestamped brightness, colour, frame-difference, scene-change, motion-change, and heartbeat observations.

The optional OpenCV layer adds richer histogram, edge, optical-flow, perceptual-hash, deduplication, and storyboard-image behavior. Create the project-local environment with:

- Windows: `setup-observer.bat`
- macOS: `setup-observer.command`

`GET /api/observer/status` reports baseline and OpenCV availability. The environment is ignored by Git and does not affect ordinary playback.

The bounded development endpoint is:

```text
POST /api/rooms/<room-id>/observations/analyze
GET  /api/rooms/<room-id>/observations?after=<sequence>
```

The production viewing path uses precomputed AI packages rather than continuously decoding the source during ordinary playback.

## Local files, privacy, and Git

The repository keeps `local-data/media/README.md` so the media drop folder exists after cloning. `.gitignore` excludes actual videos, extracted subtitle bundles, SQLite files, AI packages, storyboards, temporary conversions, observer virtual environments, caches, and logs.

No video is uploaded by the application. The server and MCP discover only the local loopback instance.

## Current scope

Included:

- Windows and macOS launch entries;
- automatic local directory and SQLite initialization;
- recursive media scanning and opaque media IDs;
- safe FFprobe/FFmpeg browser compatibility preparation;
- responsive three-state desktop cinema layout;
- browser-persisted viewer preferences and film progress;
- HTTP Range streaming and native media controls;
- one active room with timed viewer/AI messages;
- danmaku, collapsible room sidebar, and archived timed replay;
- extracted WebVTT tracks, bilingual display subtitles, and local screen-only SRT/VTT loading;
- first-time independent AI dialogue-track selection;
- resumable chunk-local visual, dialogue, and storyboard packages;
- explicit incomplete-experience warnings;
- spoiler-gated AI tick, detailed window, and storyboard image APIs;
- stdio MCP tools, embedded AI viewing skill, and multi-client identity/cursor rules;
- previewed cascade deletion;
- automated unit, integration, UI-contract, protocol, and end-to-end smoke tests.

Not included:

- completed multi-viewer playback synchronization and conflict handling;
- LAN or public-network access;
- public/network MCP transport;
- built-in diarization, character naming, face/voice binding, or full-film OCR;
- a universal persistent-memory implementation for every model API host;
- packaged native installers or automatic dependency installation.

## Development and verification

```text
npm run check
npm test
npm run smoke:room
npm run smoke:ai
npm run smoke:mcp
npm run smoke:tick
npm run smoke:frame
npm start
```

- `npm run check` performs syntax validation across the server, core modules, scripts, MCP adapter, and browser JavaScript.
- `npm test` runs deterministic unit, integration, UI-contract, subtitle, room, observer, deletion, tick, and frame tests.
- `smoke:room` creates an isolated short film, checks compatibility, opens a room, posts a timed message, archives it, verifies write rejection, and removes the fixture.
- `smoke:ai` builds an isolated visual-and-dialogue package from a generated film with an embedded subtitle, performs spoiler-gated reads and deletion, then removes every fixture.
- `smoke:mcp` completes a real MCP initialize/resource/tool handshake against an isolated cinema.
- `smoke:tick` verifies incremental message/dialogue/storyboard/motion delivery, cursor advancement, self filtering, and no replay.
- `smoke:frame` verifies room-bound spoiler-gated storyboard image retrieval.

The `tests/` directory is not required during ordinary playback, but it belongs in the public source repository: it documents executable contracts, protects media replacement and deletion safety, verifies spoiler/cursor behavior, and lets contributors prove that changes did not silently break the cinema. A future end-user binary bundle may omit tests while the GitHub source keeps them.
