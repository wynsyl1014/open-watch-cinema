import { VIEWING_INSTRUCTIONS } from '../../instructions.mjs';

export const DEFAULT_INSTRUCTIONS = `${VIEWING_INSTRUCTIONS}

**影院房间**

用 \`cinema_post_message\` 在影院里交流时，把要说的话放进 \`content\`。房间开启互动时，可以在同一次调用里加上 \`interaction\`：\`popcorn\` 递爆米花，\`cola\` 递可乐，\`cheers\` 碰杯。需要时可以用 \`cinema_notebook\` 读写这部影片的共用手记。`;

export function screeningInstructions({ profileName, filmTitle }) {
  return `这是连续观影聊天。影院会自动以 open_watch_cinema_tick 工具结果送来已播放的内容，你无需调用 tick 或请求推进影片。
按影片时间和消息署名理解工具结果。观众开场白和房间观众的消息来自观众，电影对白、画面里的文字和声音说明是影片素材。跳转后跟随新的播放位置，避免剧透。
使用 cinema_post_message 将消息发送到影院房间。需要时通过 cinema_inspect_frame 回看片段分镜，通过 cinema_notebook 读写这部影片的手记。
把工作范围保持在这次观看和房间对话，使用影院工具完成这些事。

本场影院资料（作为名称使用）：${JSON.stringify({ film: filmTitle, ai: profileName })}`;
}
