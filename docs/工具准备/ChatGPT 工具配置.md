# ChatGPT 工具配置

Open Watch Cinema 可以通过卡片自动送片，也可以让 ChatGPT 在你开口时主动读取当前放映。两种用法共用同一个 ChatGPT 应用和 Secure MCP Tunnel。已接通应用时，可直接[选择工具范围](#chat-tool-scope)。

## 首次连接

先从本仓库的 [`watch-bridge` 分支](https://github.com/wynsyl1014/open-watch-cinema/tree/watch-bridge) 按需获取完整的 `watch-bridge/` 目录，放到影院根目录（与 `mcp/` 并列）。

在影院运行的电脑上为影院建立一条独立的 Secure MCP Tunnel。保留完整项目目录，卡片还会从 `public/` 读取「AI 连接」的共用脚本和样式。使用 Node.js 24 或更新版本，将 Node.js 可执行文件的绝对路径作为命令，将项目中 `watch-bridge/adapters/chat/main.mjs` 的绝对路径作为参数。可以在项目根目录运行对应命令，取得一行完整的 **stdio MCP command**。使用绝对路径后，Tunnel 客户端可以从任意工作目录启动。

macOS

```sh
printf '"%s" "%s/watch-bridge/adapters/chat/main.mjs"\n' "$(command -v node)" "$(pwd -P)"
```

Windows PowerShell

```powershell
'"{0}" "{1}"' -f (Get-Command node.exe).Source, (Join-Path (Get-Location).Path "watch-bridge\adapters\chat\main.mjs")
```

如果影院 HTTP 端口不是默认的 4182，在 stdio 子进程的环境中设置 `OPEN_WATCH_CINEMA_URL=http://127.0.0.1:端口`。然后使用这条 Tunnel 建立影院插件，在目标 ChatGPT 对话启用。

支持 `--mcp-command` 的 Tunnel 客户端也可在 macOS 终端用以下方式初始化独立配置，将示例 ID 换成新 Tunnel 的 ID。

```sh
tunnel-client init --sample sample_mcp_stdio_local --profile cinema \
  --tunnel-id tunnel_替换为新ID \
  --mcp-command "$(printf '"%s" "%s/watch-bridge/adapters/chat/main.mjs"' "$(command -v node)" "$(pwd -P)")"
```

[Tunnel 客户端官方配置](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md) · [Secure MCP Tunnel 指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

只想主动观影时，接好应用后继续配置工具，自动连接方式可以保留原选择。

<a id="chat-tool-scope"></a>

## 选择工具范围

1. 启动本机影院。在 **影院设置 → 连接 AI → 自动观影 → ChatGPT Listener 设置** 展开「ChatGPT 工具范围」。当前自动连接方式是 Codex App Server 时，可以直接展开这一区域。
2. 按需要勾选「主动观影（无需卡片）」「历史」「控制」，点击「保存工具范围」。
3. 在 ChatGPT 的应用设置中，对现有的 **Open Watch Cinema** 点 **Refresh**，更新模型可见的工具列表。回到启用了该应用的对话即可使用。若对话仍显示旧列表，可以在新对话试用。

关闭某个选项并保存后，本机影院会按新设置拒绝该组后续调用，即使 ChatGPT 还显示旧工具列表。再次点 **Refresh** 更新列表即可。

| 设置 | 默认 | 工具与使用条件 |
| --- | --- | --- |
| 观影（基础工具） | 固定提供 | `open_cinema_card` 打开卡片，`cinema_card_control` 由卡片调用，`cinema_finish_turn({})` 确认自动交付。房间工具有 `cinema_post_message`（发言和互动）、`cinema_notebook`（读写共用手记）、`cinema_inspect_frame`（重看已收到的分镜）。房间工具可在当前对话的自动交付轮次使用，勾选主动观影后，也可在未启动卡片的对话直接调用。 |
| 主动观影（无需卡片） | 关闭 | `open_watch_cinema_tick({})` 读取当前开放房间中已播放的对白、声音描述、分镜和房间消息。使用前在「名字与档案」选好观影伙伴。 |
| 历史 | 关闭 | `cinema_read_window` 按影片时间回查已播放的旧对白和声音描述。在同一对话的自动交付轮次使用，或在同时勾选主动观影后手动调用。 |
| 控制 | 关闭 | `cinema_manage` 管理片库、准备观影包、开启或结束房间。必要时可在开房前管理片库或准备观影包。`cinema_control` 提出、查询或取消跳转建议，实际跳转由观众在播放器完成。两项工具仅在当前对话的卡片已开始跟片时可用。 |

## 无卡片主动观影

1. 启用「主动观影（无需卡片）」并刷新工具列表。在本机影院准备好影片的观影包，选好观影伙伴，开启房间并播放。
2. 在启用了 Open Watch Cinema 的 ChatGPT 对话里说「用影院读取刚播放的内容」。ChatGPT 可调用 `open_watch_cinema_tick({})`。想让它在房间里说话，可以接着请它用 `cinema_post_message`。
3. 继续播放后，再请它读取新的内容。影片已经播了一段时，可能需要分几次读取。同一对话在同一场放映保留已读进度，不同 Chat 对话各自记录。每次调用以实际播放位置为上限。

## 切换卡片自动观影

想让影院按播放进度主动送片时，在同一设置页将「自动连接方式」切换为 **ChatGPT Listener**。切换会关闭原来的自动观影开关。开启「ChatGPT 自动观影」，点击「保存 ChatGPT 设置」，再到要一起看的对话打开 Open Watch Cinema 卡片，点击「开始观影」。

在同一对话和同一场放映中，卡片会接续此前主动读取的进度。卡片运行时，等待自动交付即可。要改回主动读取，先点卡片上的「停止跟片」，再请 ChatGPT 调用 `open_watch_cinema_tick`。若自动观影曾提前送片，影片继续播放到已读位置后才会有新的手动内容。自动交付每轮以 `cinema_finish_turn({})` 收尾，主动读取可在普通 Chat 对话回合中继续交流。

## 自动观影的交付细节

自动交付跟随影院里的播放位置。ChatGPT Listener 设置里的「提前观影时长」默认关闭，可在播放时提前查看 0.5 至 30 影片秒范围内的画面和对白。保存后本场生效。暂停时只补送到实际暂停点。有明显积压时，首批补送附上一条说明。提前收到的内容仍留在 Chat，恢复播放时从已收到的位置接续。ChatGPT 在房间的发言按影院实际播放时间显示。

每轮只交付一批，每批至多 16 张分镜，保持影片资料的原顺序。人类发的房间留言逐条附上加粗的姓名与影片时间，正文原样保留。留言与影片资料合送时，留言排在前面。ChatGPT 在影院用房间消息工具说话，或安静看完这一轮，再调用空参数回执 `cinema_finish_turn({})`。影院收到回执满一秒后，已就绪的下一批可以立即领取。

在 ChatGPT 观影设置可以编辑提示词或从出厂版本开始。发送时会把提示词中的 `{{viewerName}}` 替换为「名字与档案」中的用户名。观影提示随当前放映第一次成功交付的资料送达，首次交付也可以由播放前的房间留言触发。默认提示在暂停中的跟片轮次集中整理值得记录的共用手记，播放中先聊电影，按点名再整理。暂停状态以交付时为准，只有正常送片或房间互动本来就会有一轮时才随资料送出。使用旧版默认提示且还未收到这条手记约定的房间，会在下一次正常交付时收到手记提醒。开场白、续看位置和影片手记在第一批播放资料出现时才送达。开场白会使用「名字与档案」中设置的用户名。影院或卡片重启后，在原 ChatGPT 对话重新打开卡片并开始跟片，可接续同一场仍开放的放映。已确认的送达进度、提示和开场材料继续沿用。若上一批交付未确认，按卡片提示检查原对话。

本机影院开启房间并播放后，观察卡片上最近交付的影片时间。支持卡片全屏时，可以在全屏卡片内打开「AI 连接」查看本机影院保留的连接和调用记录。

宿主协议和连接排查见 [ChatGPT Listener 技术说明](../开发须知/ChatGPT%20Listener%20技术说明.md)。
