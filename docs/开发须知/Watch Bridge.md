# Watch Bridge

从影院设置使用自动跟片，请看观众版 [Codex App Server](../工具准备/Codex%20App%20Server.md) 或 [ChatGPT Listener](../工具准备/ChatGPT%20工具配置.md)。下面是命令行和宿主接入说明。

连续观影桥接使用影院现有的 `open_watch_cinema_tick`。一次运行跟随一场放映，保留自己的 MCP 连接、AI 档案和读取进度。接入宿主时可直接调用共享入口。

## 启动

需要 Node.js 24+ 和正在本机运行的配套影院。先在 **影院设置 → 名字与档案** 选好 AI 档案，再在 **影院设置 → 连接 AI → 自动观影** 调整影片时间间隔。默认 6 秒，保存后用于这次放映的下一次调度判断。

在影院目录运行：

```sh
node watch-bridge/watch.mjs
```

可以单独下载整个 `watch-bridge/`，再指向本机影院安装目录。如果影院使用默认端口，可省略 `--cinema-url`。

```sh
node watch.mjs --cinema-root "/path/to/open-watch-cinema" --cinema-url http://127.0.0.1:4182
```

命令向标准输出写入逐行 JSON，每行是一次交付的 MCP 结果，包含完整有序的文字和图片块。接到房间结束事件或按 Ctrl+C 后退出。宿主接入参考 [Codex 适配器](Codex%20适配器.md) 和 [ChatGPT Listener 适配器](ChatGPT%20Listener%20技术说明.md)。

## 共享入口

```js
import { watchCinema } from './watch-bridge/session.mjs';

await watchCinema({
  cinemaUrl: 'http://127.0.0.1:4182',
  cinemaRoot: '/path/to/open-watch-cinema',
  signal: controller.signal,
  async onTick(result, { state, reason, results, signal, includesPlayback }) {
    await consume(result, { state, reason, results, signal, includesPlayback });
  }
});
```

- 第一次交付以桥接开始时的位置为起点，累计到设定的影片时间间隔后触发。房间消息可提前触发。回调收到触发时的影院状态 `state`，`reason` 为 `interval` 或 `chat`。
- 当桥接已经观测到当前位置开始播放，且结果包含一次正常交付时，`includesPlayback` 为真。暂停在起点时的观众消息仍可交付。
- 桥接等待当前回调完成，期间继续接收最新播放状态。暂停可以补取一次尚未交付的片尾，随下一条房间消息或恢复后的定时结果一起交付。`result.content` 按获取顺序保留所有内容块，`results` 包含原始工具结果。
- 影片跳转后从新位置重新计算间隔，之前暂存的旧位置结果随之结束。暂停跳转时继续等待观众消息或播放进度。
- 房间结束或外部信号取消会终止桥接，并通知运行中的回调。连接故障或回调失败由 `watchCinema` 抛出。
