# Open Watch Cinema — Watch Bridge

本分支单独存放 Open Watch Cinema 的可选 **Watch Bridge** 模块，用于 **ChatGPT 影院卡片（Listener）** 和 **Codex App Server** 两种自动跟片方式。如果你只一个人看片或只使用普通本地 stdio MCP 客户端，不需要下载本分支。

## 怎么使用

1. 先从 [`main` 分支](https://github.com/wynsyl1014/open-watch-cinema/tree/main) 获取并安装 Open Watch Cinema 本体。
2. 下载本分支，将里面的整个 `watch-bridge/` 文件夹放到影院根目录（与 `mcp/`、`public/`、`server.mjs` 并列）。
3. 重启影院后，按对应的配置指南启用自动跟片：
   - [ChatGPT 工具配置](https://github.com/wynsyl1014/open-watch-cinema/blob/main/docs/%E5%B7%A5%E5%85%B7%E5%87%86%E5%A4%87/ChatGPT%20%E5%B7%A5%E5%85%B7%E9%85%8D%E7%BD%AE.md)
   - [Codex App Server 指南](https://github.com/wynsyl1014/open-watch-cinema/blob/main/docs/%E5%B7%A5%E5%85%B7%E5%87%86%E5%A4%87/Codex%20App%20Server.md)
   - [Watch Bridge 技术说明](https://github.com/wynsyl1014/open-watch-cinema/blob/main/docs/%E5%BC%80%E5%8F%91%E9%A1%BB%E7%9F%A5/Watch%20Bridge.md)

如需在影院根目录内运行 Watch Bridge 单元测试，可一并复制 `tests/watch-bridge/`，然后在影院根目录执行 `node --test "tests/watch-bridge/*.test.mjs"`。
