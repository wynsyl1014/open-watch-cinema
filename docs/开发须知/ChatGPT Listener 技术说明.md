# ChatGPT Listener 技术说明

安装、工具配置和观影操作见[ChatGPT 工具配置](../工具准备/ChatGPT%20工具配置.md)。

## 连接验证

升级后，在 ChatGPT 的应用设置里对 Open Watch Cinema 点 **Refresh**，再到新对话用 `open_cinema_card` 打开卡片。卡片会在同一次 `cinema_card_control` 调用里查询并领取已就绪的资料。回到卡片时会同步这张卡的状态。若停留太久后看到「开始观影」，可以在同一对话重新开始跟片。

本地测试用一套模拟 MCP Apps 宿主执行卡片逻辑，可运行 `node --test tests/watch-bridge/chat-mcp.test.mjs`。接入独立 Tunnel 后，使用目标 ChatGPT 界面核对打开卡片、点击开始、完整图文、回执和停止。宿主需转交工具调用的 `_meta["openai/session"]`，并支持 MCP Apps 的 `ui/message` 图文提交。宿主拒收或中断时，先检查该 ChatGPT 对话是否收到这一批，再按卡片提示处理。

[ChatGPT 工具元数据](https://developers.openai.com/plugins/reference) · [MCP Apps 消息请求](https://apps.extensions.modelcontextprotocol.io/api/interfaces/app.McpUiMessageRequest.html)

这个 stdio 入口支持 MCP `2026-07-28`。宿主可直接用 `server/discover` 或调用工具，每次请求都在 `params._meta` 声明协议版本和客户端能力。开卡和卡片操作需要宿主声明 MCP Apps 的 HTML 支持，同时仍需要 ChatGPT 提供当前对话身份。旧宿主继续使用两步初始化。 [MCP stdio 规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)

若插件刷新显示 `409 MCP server is not initialized`（`mcp_initialization_required`），先确认这条隧道依次收到 `initialize` 和 `notifications/initialized`。如果宿主省略或延后通知，仅在这条隧道的客户端运行环境设置 `MCP_STDIO_SEND_INITIALIZED_NOTIFICATION=true`，重启该客户端后刷新 ChatGPT 中的插件。如果连 `initialize` 都没收到，仍需由宿主重新握手。 [官方 stdio 配置](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md#stdio-mcp-command)
