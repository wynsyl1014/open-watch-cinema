import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function read(relativePath) {
  return readFile(resolve(ROOT, relativePath), 'utf8');
}

test('cinema shell keeps the screen full-width when the internal drawer is closed', async () => {
  const [html, css] = await Promise.all([
    read('public/index.html'),
    read('public/styles.css')
  ]);

  const playerIndex = html.indexOf('class="player-shell"');
  const sidebarIndex = html.indexOf('class="room-sidebar"');
  const nowPlayingIndex = html.indexOf('class="now-playing-row"');

  assert.ok(playerIndex >= 0, 'player shell exists');
  assert.ok(sidebarIndex > playerIndex, 'drawer sits beside the player inside the playback card');
  assert.ok(nowPlayingIndex > sidebarIndex, 'bottom playback row spans beneath screen and drawer');
  assert.match(css, /\.cinema-workspace\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s+0;/);
  assert.match(css, /\.cinema-workspace\.sidebar-open\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s+min\(var\(--drawer-width\),\s*34%\);/);
  assert.match(css, /\.now-playing-row\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1;/);
  assert.match(css, /\.room-sidebar\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*0;[\s\S]*?bottom:\s*0;/);
  assert.match(css, /\.message-list\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/);
});

test('cinema controls and copy follow the quiet screening-room presentation', async () => {
  const [html, css, app] = await Promise.all([
    read('public/index.html'),
    read('public/styles.css'),
    read('public/app.js')
  ]);

  assert.doesNotMatch(html, /WINDOWS-FIRST|LOCAL ONLY|Local films\. Your disk\. Your room\./);
  assert.match(html, /class="cinema-whisper" id="cinemaTitle">Let the room disappear\. Keep the story\.<\/p>/);
  assert.doesNotMatch(html, /One screen\. One room\. Every word held beside its frame\./);
  assert.match(css, /\.screen-actions\s*\{[\s\S]*?opacity:\s*0;/);
  assert.match(css, /\.controls-visible \.screen-actions/);
  assert.doesNotMatch(css, /\.sidebar-open \.screen-actions/);
  assert.match(app, /screenActions\.matches\(':focus-within'\)/);
  assert.doesNotMatch(app, /screenFrame\.matches\(':hover'\)/);
  assert.match(app, /pointerenter', \(\) => showScreenActions\(\)/);
  assert.match(css, /\.cinema-workspace:fullscreen \.now-playing-row\s*\{[\s\S]*?display:\s*none;/);
});

test('film library owns rescan, search, collapse, and responsive sizing', async () => {
  const [html, css, app] = await Promise.all([
    read('public/index.html'),
    read('public/styles.css'),
    read('public/app.js')
  ]);

  assert.doesNotMatch(html, /class="topbar"/);
  assert.ok(html.indexOf('id="rescanButton"') > html.indexOf('id="librarySection"'));
  assert.match(html, /id="librarySearch"/);
  assert.match(html, /id="libraryToggle"/);
  assert.match(app, /owc-library-collapsed/);
  assert.match(app, /dataset\.searchText/);
  assert.match(css, /--page-gutter:\s*clamp\(/);
  assert.match(css, /--cinema-max-width:/);
  assert.doesNotMatch(css, /--card-width:/);
  assert.match(css, /body::before\s*\{[\s\S]*?repeating-linear-gradient\(0deg/);
  assert.match(css, /body::before\s*\{[\s\S]*?repeating-linear-gradient\(90deg/);
  assert.match(css, /body::after\s*\{[\s\S]*?repeating-linear-gradient\(to bottom/);
  assert.match(css, /left clamp\(10px, 1\.8vw, 30px\)/);
  assert.match(css, /right clamp\(10px, 1\.8vw, 30px\)/);
  assert.match(css, /linear-gradient\(103deg/);
  assert.match(css, /linear-gradient\(77deg/);
  assert.doesNotMatch(css, /radial-gradient\(circle at 4\.5% 38%/);
  assert.doesNotMatch(css, /radial-gradient\(circle at 95\.5% 63%/);
  assert.match(css, /\.library-section\.collapsed \.library-body/);
});

test('viewer identity, danmaku preference, subtitles, and per-film progress stay in browser storage', async () => {
  const [html, app, subtitleUtils, server] = await Promise.all([
    read('public/index.html'),
    read('public/app.js'),
    read('public/subtitle-utils.js'),
    read('server.mjs')
  ]);

  assert.match(app, /owc-sender-name/);
  assert.match(app, /owc-danmaku-enabled/);
  assert.match(app, /owc-playback-progress-v1/);
  assert.match(app, /owc-subtitle-choices-v1/);
  assert.match(app, /owc-last-media-id/);
  assert.match(app, /owc-direct-play-ready-v3/);
  assert.match(app, /mediaPlaybackFingerprint/);
  assert.match(app, /markBrowserDirectPlayReady/);
  assert.match(app, /srtToWebVtt/);
  assert.match(app, /mergeBilingualWebVtt/);
  assert.doesNotMatch(app, /from '\.\/subtitle-utils\.js'/);
  assert.match(app, /双语 · 简中 \+ English/);
  assert.match(app, /data-owc-subtitle/);
  assert.match(subtitleUtils, /line:96%,end position:50%,center size:96% align:center/);
  assert.match(server, /\['\/subtitle-utils\.js', \['subtitle-utils\.js', 'text\/javascript; charset=utf-8'\]\]/);
  assert.match(html, /id="subtitleSelect"/);
  assert.match(html, /id="subtitleFileInput"[^>]+accept="\.srt,\.vtt/);
  assert.match(app, /cinemaWorkspace\.requestFullscreen\(\)/);
});

test('film cards expose one-click AI preparation and confirmed cascade deletion', async () => {
  const [app, css, server] = await Promise.all([
    read('public/app.js'),
    read('public/styles.css'),
    read('server.mjs')
  ]);

  assert.match(app, /Prepare for AI viewing/);
  assert.match(app, /\/prepare-ai/);
  assert.match(app, /\/delete-preview/);
  assert.match(app, /method:\s*'DELETE'/);
  assert.match(app, /cascade:\s*true/);
  assert.match(app, /confirmMediaId:\s*item\.id/);
  assert.match(app, /className = 'media-delete-button'/);
  assert.match(app, /let activeMediaPlayable = false;/);
  assert.match(app, /playbackReadyForCurrentBrowser\(item\)/);
  assert.match(app, /if \(playbackReadyForCurrentBrowser\(item\)\) return 'Ready';/);
  assert.match(app, /if \(!playbackReadyForCurrentBrowser\(item\)\)/);
  assert.match(app, /function canConfirmDirectPlay\(item\)/);
  assert.match(app, /function confirmDirectPlayReady\(item\)/);
  assert.match(app, /readyButton\.textContent = 'Mark Ready'/);
  assert.match(app, /Confirm that picture and sound both work in this browser\./);
  assert.match(app, /test picture & sound, then Mark Ready/);
  assert.doesNotMatch(app, /webkitAudioDecodedByteCount|playbackProbeForItem|\/api\/media\/\$\{item\.id\}\/probe/);
  assert.match(app, /openRoomButton\.disabled = !playbackReady \|\| Boolean\(activeRoom\)/);
  assert.match(app, /className = 'media-action-buttons'/);
  assert.match(css, /\.media-action-buttons\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.media-action-buttons \.ai-prepare-button\s*\{[\s\S]*?grid-column:\s*1 \/ -1;/);
  assert.match(app, /extracting embedded subtitles…/);
  assert.match(app, /subtitle tracks ready/);
  assert.match(app, /playButton\.disabled = lockedByRoom \|\| preparationActive;/);
  assert.doesNotMatch(app, /if \(item\.compatibilityStatus !== 'ready'\) return;/);
  assert.match(app, /This browser could not play the original file\. Use Check & prepare playback below\./);
  assert.match(app, /\/subtitles\/prepare/);
  assert.doesNotMatch(server, /playbackProbeForItem|playbackProbeMatch|mediaProbeCache/);
  assert.match(server, /extractSubtitleStreams/);
  assert.match(server, /subtitlePrepareMatch/);
  assert.doesNotMatch(server, /Prepare this film for Chrome before opening a room/);
  assert.match(app, /function aiExperienceWarning\(item\)/);
  assert.match(app, /Visual analysis is ready, but timed dialogue is missing/);
  assert.match(app, /Timed dialogue is ready, but visual analysis is missing/);
  assert.match(app, /Open the room anyway\?/);
  assert.match(app, /!confirmAiExperience\(item\)/);
  assert.match(css, /\.ai-prepare-button/);
  assert.match(css, /\.ai-package-note\.warning/);
  assert.match(css, /\.media-delete-button/);
  assert.match(server, /runObservationPrecompute/);
  assert.match(server, /AI_PACKAGES_ROOT = resolve\(LOCAL_DATA_ROOT, 'ai-packages'\)/);
  assert.match(server, /deleteMediaCascadeRecords/);
});

test('playback repair is symptom-guided instead of browser-profile guessing', async () => {
  const [html, css, app, server] = await Promise.all([
    read('public/index.html'),
    read('public/styles.css'),
    read('public/app.js'),
    read('server.mjs')
  ]);

  assert.match(html, /id="playbackRepairDialog"/);
  assert.match(html, /name="playbackRepair" value="audio"/);
  assert.match(html, /name="playbackRepair" value="video"/);
  assert.match(html, /name="playbackRepair" value="remux"/);
  assert.match(html, /name="playbackRepair" value="safe"/);
  assert.match(app, /function choosePlaybackRepair\(item\)/);
  assert.match(app, /JSON\.stringify\(\{ repairMode \}\)/);
  assert.match(app, /case 'prepared': return 'Retest playback';/);
  assert.match(app, /job\.replacementMediaId \|\| job\.mediaId/);
  assert.match(server, /repairMode:\s*body\.repairMode/);
  assert.match(server, /status:\s*'prepared'/);
  assert.match(server, /prepareMediaPlayback/);
  assert.match(css, /\.compatibility-badge\.status-prepared/);
});

test('first-time AI preparation asks which discovered dialogue track to use', async () => {
  const [html, css, app, server] = await Promise.all([
    read('public/index.html'),
    read('public/styles.css'),
    read('public/app.js'),
    read('server.mjs')
  ]);

  assert.match(html, /id="aiSubtitleDialog"/);
  assert.match(html, /id="aiSubtitleOptions"/);
  assert.match(css, /\.ai-subtitle-dialog\s*\{[\s\S]*?max-height:\s*calc\(100dvh - 28px\);[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.ai-subtitle-form\s*\{[\s\S]*?grid-template-rows:\s*auto auto auto minmax\(0, 1fr\) auto;[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.ai-subtitle-options\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(css, /\.ai-subtitle-actions\s*\{[\s\S]*?flex:\s*0 0 auto;/);
  assert.match(app, /function chooseAiDialogueTrack\(item\)/);
  assert.match(app, /await chooseAiDialogueTrack\(item\)/);
  assert.match(app, /JSON\.stringify\(dialogueTrackId \? \{ dialogueTrackId \} : \{\}\)/);
  const audioButtonState = app.match(/const audioReady = [\s\S]*?aiButton\.disabled = [\s\S]*?;/)?.[0];
  assert.ok(audioButtonState, 'audio preparation button state is present');
  const buttonDisabled = new Function('item', 'aiPackageLabel', `const aiButton = {}; ${audioButtonState} return aiButton.disabled;`);
  for (const status of ['not_prepared', 'unavailable', 'failed', 'running']) {
    assert.equal(buttonDisabled({ aiPackage: { status: 'ready', audioTrack: { status } } }, () => ''), false);
  }
  for (const status of ['ready', 'source_missing']) {
    assert.equal(buttonDisabled({ aiPackage: { status: 'ready', audioTrack: { status, model: 'Labbeti/conette' } } }, () => ''), true);
  }
  assert.equal(buttonDisabled({ aiPackage: { status: 'ready', audioTrack: { status: 'ready', model: 'Qwen/Qwen2.5-Omni-3B' } } }, () => ''), false);
  assert.equal(buttonDisabled({ aiPackage: { status: 'running' } }, () => ''), true);
  assert.match(server, /preferredDialogueTrackId:\s*body\.dialogueTrackId/);
});

test('connected AIs bring their own stable display name through MCP', async () => {
  const mcp = await read('mcp/server.mjs');

  assert.match(mcp, /senderName:[\s\S]*?description: 'The connected AI’s own stable display name/);
  assert.match(mcp, /required: \['roomId', 'content', 'mediaTimeMs', 'senderName'\]/);
  assert.match(mcp, /required: \['roomId', 'consumerName'\]/);
  assert.match(mcp, /const senderName = requireString\(args\.senderName, 'senderName'/);
  assert.doesNotMatch(mcp, /senderName \?\? 'Elias'|default: 'Elias'/);
  assert.match(mcp, /Choose one stable display name for yourself in this cinema/);
});

test('MCP publishes an AI viewing skill and a spoiler-gated image tool', async () => {
  const [mcp, skill, smoke] = await Promise.all([
    read('mcp/server.mjs'),
    read('mcp/SKILL.md'),
    read('scripts/mcp-smoke.mjs')
  ]);

  assert.match(mcp, /open-watch-cinema:\/\/skills\/watch-together/);
  assert.match(mcp, /resources:\s*\{\s*subscribe:\s*false,\s*listChanged:\s*false\s*\}/);
  assert.match(mcp, /method === 'resources\/list'/);
  assert.match(mcp, /method === 'resources\/read'/);
  assert.match(mcp, /name: 'cinema_get_frame'/);
  assert.match(mcp, /type: 'image', data, mimeType/);
  assert.match(mcp, /\/ai-frame\?\$\{query\}/);
  assert.match(skill, /## Normal viewing loop/);
  assert.match(skill, /Maintain cursors separately for each/);
  assert.match(skill, /Call `cinema_get_frame`/);
  assert.match(skill, /## Discrete API model calls/);
  assert.match(smoke, /AI viewing skill resource/);
  assert.match(smoke, /'cinema_get_frame'/);
});

test('human guide explains local launch, subtitles, MCP, API continuity, and tests', async () => {
  const guide = await read('FOR_USERS.md');

  assert.match(guide, /http:\/\/127\.0\.0\.1:4182/);
  assert.match(guide, /Check & prepare playback/);
  assert.match(guide, /Prepare for AI viewing/);
  assert.match(guide, /屏幕字幕与 AI 字幕不是同一个开关/);
  assert.match(guide, /API 模型能不能接 MCP/);
  assert.match(guide, /能不能同时接多个 AI/);
  assert.match(guide, /离散 API 调用必须保存什么/);
  assert.match(guide, /测试文件为什么也在 GitHub/);
  assert.match(guide, /mcp\/SKILL\.md/);
});

test('macOS has launch and optional observer setup entries', async () => {
  const [start, setup, server, readme] = await Promise.all([
    read('start.command'),
    read('setup-observer.command'),
    read('server.mjs'),
    read('README.md')
  ]);

  assert.match(start, /^#!\/bin\/bash/);
  assert.match(start, /command -v node/);
  assert.match(start, /command -v ffprobe/);
  assert.match(start, /command -v ffmpeg/);
  assert.match(start, /node server\.mjs/);
  assert.match(setup, /python3 -m venv observer\/\.venv/);
  assert.match(setup, /observer\/requirements\.txt/);
  assert.match(server, /process\.platform === 'darwin'/);
  assert.match(server, /command = 'open'/);
  assert.match(readme, /### macOS/);
  assert.match(readme, /start\.command/);
});

test('wide screens switch between a library wing, a room wing, and a centered focus screen', async () => {
  const [css, app] = await Promise.all([
    read('public/styles.css'),
    read('public/app.js')
  ]);

  assert.match(css, /@media \(min-width: 1480px\) and \(min-height: 700px\)/);
  assert.match(css, /--browse-wing-width:\s*clamp\(304px, 19vw, 352px\);/);
  assert.match(css, /\.cinema-page\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:/);
  assert.match(css, /\.cinema-page:has\(\.cinema-workspace\.sidebar-open\) \.cinema-workspace,\s*\.cinema-page:has\(\.cinema-workspace\.sidebar-open\) \.library-section\s*\{[\s\S]*?max-width:\s*min\(/);
  assert.match(css, /@media \(min-width: 1480px\) and \(min-height: 700px\)[\s\S]*?\.cinema-workspace\s*\{\s*transition:\s*none;/);
  assert.match(css, /@media \(min-width: 1480px\) and \(min-height: 700px\)[\s\S]*?\.room-sidebar\s*\{[\s\S]*?will-change:\s*transform, opacity;[\s\S]*?transform 190ms/);
  assert.match(css, /\.cinema-page:not\(:has\(\.room-state\.active, \.room-state\.archived\)\):not\(:has\(\.cinema-workspace\.sidebar-open\)\) \.library-section\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?grid-column:\s*2;[\s\S]*?grid-row:\s*2;[\s\S]*?height:\s*var\(--cinema-workspace-height, auto\);[\s\S]*?max-height:\s*var\(--cinema-workspace-height, none\);/);
  assert.match(css, /\.cinema-page:not\(:has\(\.room-state\.active, \.room-state\.archived\)\):not\(:has\(\.cinema-workspace\.sidebar-open\)\) \.media-strip\s*\{[\s\S]*?grid-auto-flow:\s*row;[\s\S]*?grid-auto-rows:\s*max-content;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(css, /\.cinema-page:not\(:has\(\.room-state\.active, \.room-state\.archived\)\):not\(:has\(\.cinema-workspace\.sidebar-open\)\) \.media-card\s*\{[\s\S]*?height:\s*auto;[\s\S]*?align-self:\s*start;/);
  assert.match(app, /ResizeObserver/);
  assert.match(app, /--cinema-workspace-height/);
});

test('cinema presentation uses a low-glare moonlight film palette', async () => {
  const css = await read('public/styles.css');

  assert.match(css, /\/\* Film-light refinement — atmosphere over ornament \*\//);
  assert.match(css, /\/\* Low-glare text pass — keep the moonlight, lose the glare \*\//);
  assert.match(css, /--ink:\s*#cbd6e2;/);
  assert.match(css, /--silver:\s*#c3cfdb;/);
  assert.match(css, /--mint:\s*#7fb4a1;/);
  assert.match(css, /--violet:\s*#9a91bd;/);
  assert.match(css, /--amber:\s*#a6683d;/);
  assert.match(css, /body\s*\{[\s\S]*?radial-gradient\(ellipse at 15% 8%, rgba\(129, 178, 214, 0\.15\)/);
  assert.match(css, /\.message-item\.sender-ai p\s*\{[\s\S]*?color:\s*#8fb2cc;/);
  assert.match(css, /\.media-card strong\s*\{[\s\S]*?background:\s*linear-gradient\(90deg, #aebcca 0%, #8ca9bd 56%, #8f8aa3 100%\)/);
});
