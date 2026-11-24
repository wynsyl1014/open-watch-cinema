const KEY = 'mcp_resume_prompt';
const DEFAULT_TEMPLATE = [
  '我们正在 Open Watch Cinema 续看《{{片名}}》，房间已打开，影片从 {{续看时间}} 接着看。',
  '先调用 cinema_notebook({ action: "read" }) 读我们共用的小本本，接上之前的人物、剧情和疑问。',
  '在观影期间，按影院当前的节奏每 {{检查间隔秒数}} 秒调用一次 open_watch_cinema_tick({})。间隔更新时跟随 tick 提示，收到「待续」就继续领取，收到「正在准备」时保持正常间隔。',
  '等观众按播放，从这次续看位置跟着看。只讨论已播放的内容，有话就在影院房间里用 cinema_post_message 说。'
].join('\n');

export function getMcpResumePromptSettings(db) {
  const template = db.prepare('select value from settings where key = ?').get(KEY)?.value ?? DEFAULT_TEMPLATE;
  return { template, defaultTemplate: DEFAULT_TEMPLATE };
}

export function setMcpResumePromptSettings(db, body) {
  const template = body?.template;
  if (typeof template !== 'string' || !template.trim() || template.length > 12000) {
    throw new TypeError('续看提示词须为 1 至 12000 字符的文本。');
  }
  if (template === DEFAULT_TEMPLATE) {
    db.prepare('delete from settings where key = ?').run(KEY);
  } else {
    db.prepare(`insert into settings (key, value, updated_at) values (?, ?, ?)
      on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`)
      .run(KEY, template, new Date().toISOString());
  }
  return getMcpResumePromptSettings(db);
}
