import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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
  assert.ok(nowPlayingIndex > sidebarIndex, 'bottom playback row follows the player and drawer markup');
  assert.match(css, /\.cinema-workspace\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s+0;/);
  assert.match(css, /\.cinema-workspace\.sidebar-open\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s+min\(var\(--drawer-width\),\s*34%\);/);
  assert.match(css, /\.now-playing-row\s*\{[\s\S]*?grid-column:\s*1;/);
  assert.match(css, /\.room-sidebar\s*\{[^}]*grid-row:\s*1\s*\/\s*-1;/);
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

test('cinema settings connect viewer names and AI profiles alongside cadence while each film owns its image options', async () => {
  const [html, app] = await Promise.all([
    read('public/index.html'),
    read('public/app.js')
  ]);
  assert.match(html, /id="viewingSettingsDialog"[^>]*lang="zh-CN"/);
  assert.match(html, /<h2 id="viewingSettingsTitle">影院设置<\/h2>/);
  assert.match(html, /data-settings-page="names"[^>]*>名字与档案/);
  assert.match(html, /data-settings-page="viewing"[^>]*>观影准备/);
  assert.match(html, /id="viewerNameForm"/);
  assert.match(html, /id="aiProfileSelect"/);
  assert.match(html, /已连接的 AI 继续使用各自的档案/);
  assert.match(html, /<span>AI 查看间隔<\/span>/);
  assert.match(html, /默认 2 秒，可设为 0\.5 至 30 秒/);
  assert.match(html, /id="viewingIntervalInput"[^>]*type="number"[^>]*min="0\.5"[^>]*max="30"/);
  assert.match(html, /id="viewingSettingsSave"[^>]*>保存设置<\/button>/);
  assert.match(app, /openViewingSettings\('names'\)/);
  assert.match(app, /已保存 · 每/);
  assert.match(html, /id="initialBufferSelect"/);
  assert.doesNotMatch(html, /id="storyboardHeightSelect"/);
  assert.match(html, /id="filmProfile"/);
  assert.match(html, /id="filmHeightLabel" hidden/);
  assert.match(html, /全景高度/);
  assert.match(html, /id="viewingSettingsFields"[^>]*disabled/);
  assert.match(html, /id="viewingSettingsRetry"/);
  assert.match(html, /data-connect-mode="bridge"[^>]*>自动观影<\/button>/);
  assert.match(html, /id="watchBridgeHeading">自动连接方式<\/span>/);
  assert.match(html, /<select id="watchBridgeMode"[^>]*>[\s\S]*<option value="codex">Codex App Server<\/option>[\s\S]*<option value="chat"[^>]*>ChatGPT Listener<\/option>/);
  assert.match(html, /id="chatScreeningEnabled"[^>]*role="switch"/);
  assert.match(html, /for="chatLookaheadMode">\s*<span>提前观影时长<\/span>\s*<select id="chatLookaheadMode"[^>]*>\s*<option value="off">关闭<\/option>\s*<option value="custom">自定义<\/option>/);
  assert.match(html, /id="chatLookaheadSeconds"[^>]*type="number"[^>]*min="0\.5"[^>]*max="30"[^>]*step="0\.001"/);
  assert.match(html, /id="chatLookaheadHelp">播放中，AI 可以看到比影院当前进度提前指定秒数的画面和对白/);
  assert.match(html, /id="chatScreeningInstructions"[^>]*aria-describedby="chatPromptHelp"/);
  assert.match(html, /id="chatScreeningInstructions"[\s\S]*?<details id="chatToolSettings"[^>]*>\s*<summary>ChatGPT 工具范围<\/summary>/);
  assert.match(html, /<form id="chatToolSettingsForm"[\s\S]*?id="chatEnableManual"[^>]*>[\s\S]*?<strong>主动观影（无需卡片）<\/strong>/);
  assert.match(html, /id="chatToolSettingsSave"[^>]*>保存工具范围<\/button>/);
  assert.match(html, /id="chatEnableHistory"[^>]*>[\s\S]*?<strong>历史<\/strong>/);
  assert.match(html, /id="chatEnableControl"[^>]*>[\s\S]*?<strong>控制<\/strong>/);
  assert.match(html, /id="chatToolsHelp">[^<]*同一个 Open Watch Cinema 插件点 Refresh/);
  assert.match(html, /data-connect-mode="mcp"[^>]*>MCP 客户端<\/button>/);
  assert.match(html, /<section[^>]*aria-labelledby="codexPromptHeading">\s*<h5 id="codexPromptHeading">观影项目提示词<\/h5>/);
  assert.match(html, /项目指令（AGENTS\.md）<\/span>\s*<textarea id="codexScreeningInstructions"[^>]*aria-describedby="codexPromptHelp"/);
  assert.match(html, /<label[^>]*for="codexScreeningEnabled">\s*<span>Codex 观影模式<\/span>\s*<input[^>]*type="checkbox" role="switch"/);
  assert.doesNotMatch(html, /id="codexScreeningOpening"/);
  assert.doesNotMatch(html, /连续观影实验/);
  assert.doesNotMatch(html, /Set the viewing rhythm|Default 2 seconds/);
});

test('automatic opening words are collected per room after reading the saved mode', async () => {
  const [html, app, settings] = await Promise.all([
    read('public/index.html'),
    read('public/app.js'),
    read('public/codex-screening-settings.js')
  ]);
  assert.match(html, /<dialog[^>]*id="roomOpeningDialog"[^>]*>\s*<form method="dialog"/);
  assert.match(html, /<label for="roomOpeningMessage">本场开场白（选填）<\/label>/);
  assert.match(html, /id="roomOpeningSubmit"[^>]*type="submit" value="open">开房/);
  assert.match(html, /id="roomOpeningRestart"[^>]*type="submit" value="restart" hidden>从头看/);
  assert.match(html, /type="submit" value="cancel">取消/);
  assert.match(app, /roomOpeningMessage\.value = ''/);
  assert.match(app, /roomOpeningMessage\.hidden = !automaticMode/);
  assert.match(app, /从 \$\{formatFilmTime\(resume\.lastPositionMs\)\} 继续/);
  assert.match(app, /resolve\(\['open', 'resume', 'restart'\]\.includes\(choice\) \? \{\s*openingMessage: roomOpeningMessage\.value\.trim\(\),\s*resume: choice === 'resume' \? resume : null\s*\} : null\)/);
  assert.match(app, /roomOpeningSubmit\.textContent = roomOpeningMessage\.value\.trim\(\) \? '保存并开房' : '开房'/);
  assert.match(app, /readEnabledViewingMode\(fetchJson\)[\s\S]*fetchJson\('\/api\/rooms\/resume\?mediaId=' \+ encodeURIComponent\(item\.id\)\)[\s\S]*if \(automaticMode \|\| resume\)[\s\S]*await askRoomOpening\(\{ automaticMode, warning, resume \}\)[\s\S]*if \(!opening \|\|[\s\S]*fetchJson\('\/api\/rooms\/open'[\s\S]*\.\.\.\(openingMessage \? \{ openingMessage \} : \{\}\)/);
  assert.match(app, /includeMcpResumePrompt: !automaticMode/);
  assert.match(app, /const destination = automaticMode === 'chat' \? 'ChatGPT' : 'Codex'/);
  assert.doesNotMatch(settings, /openingPrompt/);
});

test('viewer-adjustable cadence uses a small screen setting and real server API', async () => {
  const [html, app, css, server, mcp] = await Promise.all([
    read('public/index.html'),
    read('public/app.js'),
    read('public/styles.css'),
    read('server.mjs'),
    readMcpSources()
  ]);
  assert.match(html, /id="viewingSettingsButton"/);
  assert.match(html, /id="viewingSettingsDialog"/);
  assert.match(html, /id="viewingIntervalInput"[^>]*type="number"[^>]*min="0\.5"[^>]*max="30"/);
  assert.match(css, /\.screen-action-button\.viewing-settings-button/);
  assert.match(app, /installPlaybackHeartbeat/);
  assert.match(app, /setInterval\(\(\) => \{[\s\S]*?schedulePlaybackSync\(\);[\s\S]*?\}, viewingIntervalMs\)/);
  assert.match(app, /fetchJson\('\/api\/viewing-settings'/);
  assert.match(server, /\/api\/viewing-settings/);
  assert.match(html, /id="aiOnlineTimeoutInput"[^>]*type="number"[^>]*value="30"/);
  assert.match(app, /JSON\.stringify\(\{\s*intervalSeconds: seconds, initialBufferMinutes, includeAudio: includeAudioInput\.checked,\s*skipIntroOutroPrompt: skipIntroOutroPromptInput\.checked,\s*aiOnlineTimeoutSeconds: aiOnlineTimeoutInput\.valueAsNumber\s*\}\)/);
  assert.match(server, /recommendedNextPollMs/);
  assert.doesNotMatch(mcp, /publicTick\.recommendedNextPollMs/);
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
  assert.match(css, /body::before\s*\{[\s\S]*?linear-gradient\(90deg,\s*rgba\(0,\s*0,\s*0,/);
  assert.match(css, /body::after\s*\{[\s\S]*?repeating-linear-gradient\(to bottom/);
  assert.match(css, /left clamp\(16px, 2vw, 34px\)/);
  assert.match(css, /right clamp\(16px, 2vw, 34px\)/);
  assert.doesNotMatch(css, /radial-gradient\(circle at 4\.5% 38%/);
  assert.doesNotMatch(css, /radial-gradient\(circle at 95\.5% 63%/);
  assert.match(css, /\.library-section\.collapsed \.library-body/);
  assert.match(html, /id="toggleOrganize"/);
  assert.match(css, /\.library-section:not\(\.is-organizing\) \.shelf-card-tools\s*\{\s*display:\s*none;\s*\}/);
});

test('viewer identity uses the cinema directory while playback and subtitles keep browser preferences', async () => {
  const [html, app, subtitleUtils, server] = await Promise.all([
    read('public/index.html'),
    read('public/app.js'),
    read('public/subtitle-utils.js'),
    read('server.mjs')
  ]);

  assert.match(app, /fetchJson\('\/api\/participants\/viewer'/);
  assert.match(app, /initializeOnly: true/);
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
  assert.match(app, /双语 · 中文 \+ English/);
  assert.match(app, /data-owc-subtitle/);
  assert.match(app, /line:-1 position:50% size:96% align:center/);
  assert.match(app, /letterboxed = height - pictureHeight > 2/);
  assert.match(subtitleUtils, /line:-1 position:50% size:96% align:center/);
  assert.match(server, /\['\/subtitle-utils\.js', \['subtitle-utils\.js', 'text\/javascript; charset=utf-8'\]\]/);
  assert.match(html, /id="subtitleSelect"/);
  assert.match(html, /id="subtitleFileInput"[^>]+accept="\.srt,\.vtt/);
  assert.match(app, /cinemaWorkspace\.requestFullscreen\(\)/);
});

test('film cards expose AI preparation and scope-specific cleanup with preview confirmation', async () => {
  const [app, css, server] = await Promise.all([
    read('public/app.js'),
    read('public/styles.css'),
    read('server.mjs')
  ]);

  assert.match(app, /准备观影包/);
  assert.match(app, /\/prepare-ai/);
  const cleanup = await read('public/cleanup-dialog.js');
  assert.match(cleanup, /\/api\/library\/cleanup-preview/);
  assert.match(cleanup, /\/api\/library\/cleanup'/);
  assert.match(cleanup, /'records', '观影记录（历史房间和小本本）'/);
  assert.match(cleanup, /input\.type = 'checkbox'/);
  assert.doesNotMatch(cleanup, /input\.checked = true/);
  assert.match(app, /method:\s*'DELETE'/);
  assert.match(cleanup, /body\.selected = selected/);
  assert.match(cleanup, /token: preview\.token/);
  assert.doesNotMatch(app, /window\.confirm\(deletePreviewText/);
  assert.match(app, /target: \{ mediaId: item\.id \}/);
  assert.match(app, /className = 'media-delete-button'/);
  assert.match(app, /let activeMediaPlayable = false;/);
  assert.match(app, /playbackReadyForCurrentBrowser\(item\)/);
  assert.match(app, /if \(playbackReadyForCurrentBrowser\(item\)\) return '可播放';/);
  assert.match(app, /if \(!playbackReadyForCurrentBrowser\(item\)\)/);
  assert.match(app, /function canConfirmDirectPlay\(item\)/);
  assert.match(app, /function confirmDirectPlayReady\(item\)/);
  assert.match(app, /readyButton\.textContent = '确认可播放'/);
  assert.match(app, /确认此浏览器的画面和声音都能正常播放。/);
  assert.match(app, /确认画面和声音后，点「确认可播放」/);
  assert.doesNotMatch(app, /webkitAudioDecodedByteCount|playbackProbeForItem|\/api\/media\/\$\{item\.id\}\/probe/);
  assert.match(app, /openRoomButton\.disabled = !playbackReady \|\| Boolean\(activeRoom\)/);
  assert.match(app, /className = 'media-action-buttons'/);
  assert.match(css, /\.media-action-buttons\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/);
  assert.match(app, /header\.append\(playButton, tools\)/);
  assert.match(app, /playButton\.disabled = lockedByRoom \|\| preparationActive;/);
  assert.doesNotMatch(app, /if \(item\.compatibilityStatus !== 'ready'\) return;/);
  assert.match(app, /此浏览器无法播放原文件，可在片库点「检查播放」检查兼容性。/);
  assert.doesNotMatch(server, /playbackProbeForItem|playbackProbeMatch|mediaProbeCache/);
  assert.doesNotMatch(server, /Prepare this film for Chrome before opening a room/);
  assert.match(app, /function aiExperienceWarning\(item\)/);
  assert.match(app, /已有画面，缺少对白字幕/);
  assert.match(app, /已有对白，缺少画面/);
  assert.match(app, /现在打开房间吗？/);
  assert.match(app, /const warning = aiExperienceWarning\(item\);[\s\S]*await askRoomOpening\(\{ automaticMode, warning, resume \}\)[\s\S]*else if \(warning && !window\.confirm/);
  assert.match(css, /\.ai-prepare-button/);
  assert.match(app, /自己看可直接试播，和 AI 一起看请先准备观影包。/);
  assert.doesNotMatch(app, /note\.classList\.toggle\('warning'/);
  assert.match(css, /\.media-delete-button/);
  assert.match(server, /runObservationPrecompute/);
  assert.match(server, /AI_PACKAGES_ROOT = resolve\(LOCAL_DATA_ROOT, 'ai-packages'\)/);
  assert.match(app, /confirmRoomId: room.id/);
  assert.match(app, /只读|回看房间/);
});

test('film preparation status keeps normal guidance neutral and displays saved failure details', async () => {
  const app = await read('public/app.js');
  const functions = ['formatProgressPercent', 'aiExperienceWarning', 'aiPackageLabel', 'updateAiPreparationCard'].map(name =>
    app.match(new RegExp('function ' + name + '\\([^]*?\\n\\}'))[0]).join('\n');
  const evaluate = new Function('item', 'mediaGrid', 'aiPreparationPollErrors', 'aiPreparationStarting',
    'aiPreparationButtonState', 'viewingSettings', 'aiUpgradeSummary', 'aiBufferSummary', 'aiAudioStatus',
    functions + '\nupdateAiPreparationCard(item);');
  function display(pkg) {
    let error;
    const note = { classList: { toggle(cls, value) { if (cls === 'error') error = value; } } };
    const card = { dataset: { mediaId: 'film' }, querySelector: cls => cls === '.ai-package-note' ? note : {} };
    evaluate({ id: 'film', aiPackage: pkg }, { children: [card] }, new Map(), new Set(),
      () => ({ text: '', disabled: false }), {}, () => null, () => null, () => '');
    return { text: note.textContent, error };
  }
  assert.deepEqual(display(null), { text: '自己看可直接试播，和 AI 一起看请先准备观影包。', error: false });
  const reading = display({ status: 'running', progress: { percent: 37.4 } });
  assert.match(reading.text, /37\.4%/);
  assert.equal(reading.error, false);
  const failure = display({ status: 'error', canStartViewing: true, error: '第 3 段无法读取' });
  assert.match(failure.text, /第 3 段无法读取/);
  assert.match(failure.text, /观影包准备失败/);
  assert.match(failure.text, /已准备的部分仍可观看/);
  assert.doesNotMatch(failure.text, /正在准备/);
  assert.equal(failure.error, true);

  const upgradeFns = ['formatProgressPercent', 'aiUpgradeNotice', 'aiUpgradeSummary'].map(name =>
    app.match(new RegExp('function ' + name + '\\([^]*?\\n\\}'))[0]).join('\n');
  const checkUpgrade = new Function('item', 'formatFilmTime', upgradeFns + '\nreturn { summary: aiUpgradeSummary(item), notice: aiUpgradeNotice(item) };');
  const doneRecycled = checkUpgrade({ aiUpgradeJob: { status: 'done', oldPackageDisposition: 'recycled' } }, () => '00:00');
  assert.equal(doneRecycled.summary, null);
  assert.equal(doneRecycled.notice, null);
  const doneRetained = checkUpgrade({ aiUpgradeJob: { status: 'done', oldPackageDisposition: 'retained' } }, () => '00:00');
  assert.equal(doneRetained.summary, null);
  assert.match(doneRetained.notice, /升级备份/);
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
  assert.match(app, /case 'prepared': return '请重新试播';/);
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
  assert.match(app, /storyboardProfile \? \{ storyboardProfile \} : \{\}/);
  const buttonStateSource = app.match(/function aiPreparationButtonState\(item, includeAudio = true\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(buttonStateSource, 'AI preparation action state is present');
  const buttonState = new Function('item', 'aiPackageLabel', 'includeAudio = true', buttonStateSource);
  for (const status of ['not_prepared', 'unavailable', 'failed', 'running']) {
    assert.equal(buttonState({ aiPackage: { status: 'ready', audioTrack: { status } } }, () => '').disabled, false);
  }
  for (const status of ['ready', 'source_missing']) {
    assert.equal(buttonState({ aiPackage: { status: 'ready', audioTrack: { status, model: 'Labbeti/conette' } } }, () => '').disabled, false);
  }
  assert.equal(buttonState({ aiPackage: { status: 'ready', audioTrack: { status: 'ready', model: 'Qwen/Qwen2.5-Omni-3B' } } }, () => '').disabled, false);
  assert.equal(buttonState({ aiPackage: { status: 'ready', audioTrack: { status: 'unavailable' } } }, () => '', false).disabled, false);
  assert.equal(buttonState({ aiPackage: { status: 'running' } }, () => '').disabled, true);
  assert.equal(buttonState({ aiPreparationJobId: 'job-1', aiPackage: { status: 'ready' } }, () => '').disabled, true);
  assert.match(server, /preferredDialogueTrackId:\s*body\.dialogueTrackId/);
});

test('an existing AI connection keeps its profile when the default selection changes', async () => {
  const { createViewingSession } = await import('../../mcp/viewing/viewing-session.mjs');
  const profiles = [{id:'a', name:'映月'}, {id:'b', name:'寒星'}];
  let selectedId = 'a';
  const cinemaRequest = async () => ({profiles, selectedId});
  const first = createViewingSession({cinemaRequest});
  assert.equal(await first.bindSelectedProfile(), 'a');
  selectedId = 'b';
  assert.equal(await first.bindSelectedProfile(), 'a');
  const next = createViewingSession({cinemaRequest});
  assert.equal(await next.bindSelectedProfile(), 'b');
});

test('MCP publishes an AI viewing skill and a spoiler-gated image tool', async () => {
  const [mcp, skill, smoke] = await Promise.all([
    readMcpSources(),
    read('mcp/SKILL.md'),
    read('scripts/mcp/mcp-smoke.mjs')
  ]);

  assert.match(mcp, /open-watch-cinema:\/\/skills\/watch-together/);
  assert.match(mcp, /resources:\s*\{\s*subscribe:\s*false,\s*listChanged:\s*false\s*\}/);
  assert.match(mcp, /method === 'resources\/list'/);
  assert.match(mcp, /method === 'resources\/read'/);
  assert.match(mcp, /type: 'image', data, mimeType/);
  assert.match(mcp, /\/ai-frame\?\$\{query\}/);
  assert.match(skill, /## Normal viewing/);
  assert.match(skill, /Each connection keeps the AI profile selected in cinema settings when it joins/);
  assert.match(skill, /`cinema_inspect_frame\(/);
  assert.match(skill, /For separate API model invocations/);
  assert.match(smoke, /AI viewing skill resource/);
  assert.match(smoke, /'cinema_inspect_frame'/);
});

test('human guide explains local launch, subtitles, MCP, API continuity, and tests', async () => {
  const [guide, setup, mcpSetup, development] = await Promise.all([
    read('docs/观影须知/观影指南.md'),
    read('docs/工具准备/安装与排错.md'),
    read('docs/工具准备/MCP 客户端接入.md'),
    read('docs/开发须知/接入与测试.md')
  ]);

  assert.match(guide, /http:\/\/127\.0\.0\.1:4182/);
  assert.match(setup, /macOS\/setup-all\.command/);
  assert.match(guide, /检查播放/);
  assert.match(guide, /准备观影包/);
  assert.match(guide, /选屏幕字幕/);
  assert.match(guide, /AI 的对白轨会在准备观影包时单独选择/);
  assert.match(guide, /多位 AI 一起观影/);
  assert.match(development, /API 模型接入/);
  assert.match(development, /宿主需要保留的上下文/);
  assert.match(development, /源码包含哪些测试/);
  assert.match(mcpSetup, /mcp\/SKILL\.md/);
});

test('macOS has launch and optional observer setup entries', async () => {
  const [start, setup, readme, installGuide] = await Promise.all([
    read('macOS/start.command'),
    read('macOS/setup-observer.command'),
    read('README.md'),
    read('docs/工具准备/安装与排错.md')
  ]);

  assert.match(start, /^#!\/bin\/bash/);
  assert.match(start, /command -v node/);
  assert.match(start, /command -v ffprobe/);
  assert.match(start, /command -v ffmpeg/);
  assert.match(start, /node server\.mjs/);
  assert.match(setup, /scripts\/preparation\/setup\.mjs observer/);
  assert.match(await read('scripts/preparation/setup.mjs'), /observer\/requirements\.txt/);
  assert.match(readme, /\[安装与排错\]\(docs\/工具准备\/安装与排错\.md\)/);
  assert.match(readme, /macOS\/start\.command/);
  assert.match(installGuide, /### macOS 安装/);
  assert.match(installGuide, /bash macOS\/setup-all\.command --plan\nbash macOS\/setup-all\.command/);
  assert.match(installGuide, /bash macOS\/setup-observer\.command/);
});

test('wide screens switch between a library wing, a room wing, and a centered focus screen', async () => {
  const [css, activityCss, app] = await Promise.all([
    read('public/styles.css'),
    read('public/ai-activity.css'),
    read('public/app.js')
  ]);

  assert.match(css, /@media \(min-width: 1480px\) and \(min-height: 700px\)/);
  assert.match(css, /--browse-wing-width:\s*clamp\(340px, 22vw, 410px\);/);
  assert.match(css, /\.cinema-page\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:/);
  assert.match(css, /\.cinema-page:has\(\.cinema-workspace\.sidebar-open\) \.cinema-workspace,\s*\.cinema-page:has\(\.cinema-workspace\.sidebar-open\) \.library-section\s*\{[\s\S]*?max-width:\s*min\(/);
  assert.match(activityCss, /\.cinema-page:has\(\.cinema-workspace\.sidebar-open\) #aiActivityPanel\s*\{[\s\S]*?max-width:\s*min\(/);
  assert.match(css, /@media \(min-width: 1480px\) and \(min-height: 700px\)[\s\S]*?\.cinema-workspace\s*\{[^}]*transition:\s*none;/);
  assert.match(css, /@media \(min-width: 1480px\) and \(min-height: 700px\)[\s\S]*?\.room-sidebar\s*\{[\s\S]*?will-change:\s*transform, opacity;[\s\S]*?transform 190ms/);
  assert.match(css, /\.cinema-page:not\(:has\(\.room-state\.active, \.room-state\.archived\)\):not\(:has\(\.cinema-workspace\.sidebar-open\)\) \.library-section\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?grid-column:\s*2;[\s\S]*?grid-row:\s*2;[\s\S]*?height:\s*var\(--cinema-workspace-height, auto\);[\s\S]*?max-height:\s*var\(--cinema-workspace-height, none\);/);
  assert.match(css, /\.cinema-page:not\(:has\(\.room-state\.active, \.room-state\.archived\)\):not\(:has\(\.cinema-workspace\.sidebar-open\)\) \.media-strip\s*\{[\s\S]*?grid-auto-flow:\s*row;[\s\S]*?grid-auto-rows:\s*max-content;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(css, /\.cinema-page:not\(:has\(\.room-state\.active, \.room-state\.archived\)\):not\(:has\(\.cinema-workspace\.sidebar-open\)\) \.media-card\s*\{[\s\S]*?height:\s*auto;[\s\S]*?align-self:\s*start;/);
  assert.match(app, /ResizeObserver/);
  assert.match(app, /--cinema-workspace-height/);
});

test('cinema presentation uses a unified low-glare moonlight film palette and dark notebook', async () => {
  const [css, notebookCss, activityCss] = await Promise.all([
    read('public/styles.css'),
    read('public/notebook.css'),
    read('public/ai-activity.css')
  ]);

  assert.match(css, /Unified Low-Glare Moonlight Film Design System/);
  assert.match(css, /--ink:\s*#c6d2de;/);
  assert.match(css, /--silver:\s*#bfcdd9;/);
  assert.match(css, /--mint:\s*#5396a8;/);
  assert.match(css, /--violet:\s*#9a91bd;/);
  assert.match(css, /--amber:\s*#c78b5c;/);
  assert.match(css, /--radius-shell:\s*28px 10px 28px 10px;/);
  assert.match(css, /--radius-card:\s*20px 7px 20px 7px;/);
  assert.match(css, /--radius-control:\s*11px 4px 11px 4px;/);
  assert.match(css, /body\s*\{[\s\S]*?radial-gradient\(ellipse at 15% 8%, rgba\(129, 178, 214, 0\.14\)/);
  assert.match(css, /#messageList \.message-item > p,\s*\.danmaku-item/);
  assert.match(css, /#messageList \.message-item\.sender-ai strong\s*\{\s*color:\s*#85abc7;/);
  assert.doesNotMatch(css, /#messageList \.message-item\.sender-ai > p/);
  assert.match(activityCss, /border-radius:\s*var\(--radius-shell\);/);
  assert.match(notebookCss, /color-scheme:\s*dark;/);
  assert.match(notebookCss, /--nb-paper:\s*linear-gradient\(148deg, #9cb4c6 0%, #5c758c 28%, #819eb4 52%, #4c6780 76%, #334e68 100%\);/);
});

// Source contracts span the adapter's responsibility modules after extraction.
async function readMcpSources() {
  return (await Promise.all([
    'mcp/server.mjs', 'mcp/runtime/protocol.mjs', 'mcp/viewing/viewing-session.mjs',
    'mcp/runtime/cinema-client.mjs', 'mcp/tools/viewing.mjs'
  ].map(read))).join('\n');
}

test('the settings guide reads the repository guide from a single offline route', async () => {
  const [html, client, server, guide] = await Promise.all([
    read('public/index.html'), read('public/app.js'), read('server.mjs'), read('docs/观影须知/观影指南.md')
  ]);
  assert.match(html, /data-settings-page="guide" aria-controls="settingsGuide"/);
  assert.match(client, /fetch\('\/viewing-guide\.md'\)/);
  assert.match(server, /\['\/viewing-guide\.md', \['\.\.\/docs\/观影须知\/观影指南\.md', 'text\/markdown; charset=utf-8'\]\]/);
  for (const task of ['导入影片', '改片名', '确认可播放', '检查播放', '准备观影包', '字幕', '导出这部片的手记']) {
    assert.ok(guide.includes(task), task);
  }
});

test('room interaction actions tuck into composer gift triggers with a shared popover', async () => {
  const [html, css, app] = await Promise.all([
    read('public/index.html'),
    read('public/styles.css'),
    read('public/app.js')
  ]);

  assert.match(html, /class="quick-input-shell"[\s\S]*?id="quickInteractionTrigger"[^>]*popovertarget="interactionPopover"[\s\S]*?id="quickMessageInput"/);
  assert.match(html, /id="sidebarComposeFoot"[\s\S]*?id="sidebarInteractionTrigger"[^>]*popovertarget="interactionPopover"[\s\S]*?<button type="submit">发送<\/button>/);
  assert.match(html, /id="interactionPopover"[^>]*popover/);
  assert.ok(html.indexOf('id="interactionPopover"') < html.indexOf('id="aiActivityPanel"'), 'interaction popover stays inside cinemaWorkspace for fullscreen top-layer support');
  assert.match(css, /\.quick-composer button\[type="submit"\]/);
  assert.doesNotMatch(css, /\.quick-composer button,/);
  assert.match(css, /#interactionPopover\s*\{[\s\S]*?position:\s*fixed;/);
  assert.match(css, /#interactionPopover \.interaction-buttons\s*\{[\s\S]*?display:\s*grid;/);
  assert.match(app, /interactionPopover\.append\(bar\)/);
  assert.match(app, /closeInteractionPopover\(\)/);
});
