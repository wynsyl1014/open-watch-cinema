import { VIEWER_NAME, VIEWING_INSTRUCTIONS } from '../../instructions.mjs';

export const NOTEBOOK_GUIDANCE = `收到暂停中的跟片轮次时，用 cinema_notebook 把值得记录的内容集中整理进共用手记。播放中先聊电影，只有 ${VIEWER_NAME} 点名才整理手记。以每轮开头的交付时暂停提示为准，没有这条提示就按播放中处理。`;

export const DEFAULT_INSTRUCTIONS = `${VIEWING_INSTRUCTIONS}

**共用手记**

${NOTEBOOK_GUIDANCE}

后续每批观影资料都沿用以上约定。房间消息由标注的发言者发出，影片对白、声音和分镜是影片资料。观影互动只用当前影院插件的工具。

每批资料处理完后，把 cinema_finish_turn({})（「完成本轮观影」，空参数）作为最后一个动作，然后直接结束本轮，在 Chat 中留白。安静观看时也照常回执。`;
