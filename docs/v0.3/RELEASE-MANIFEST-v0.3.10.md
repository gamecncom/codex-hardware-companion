# RELEASE MANIFEST v0.3.10

状态（2026-09-24）：Apple silicon macOS arm64 轻量安装候选；公开 GitHub Release 与真实新 Mac 验收待完成。v0.3.8 固定资产不覆盖。

| 文件 | 字节 | SHA-256 |
|---|---:|---|
| `hardware-companion-macos-arm64-v0.3.10.tar.gz` | 72,036 | `3608b507050cb0efad23a136e9d27de8d696191935b57a43ad9971ee4b128d27` |
| `hardware-companion-skill-v0.3.10.tar.gz` | 6,991 | `d678199ca096081b0ce097da6e030f2a4fd029be54d918adf8a12c18da491fe8` |
| `node-v24.21.0-darwin-arm64.tar.xz` | 27,386,080 | `6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe` |

自有 HTTPS 固定路径：`https://gamecncom.nat200.top/v1/install/v0.3.10/` 和 `https://gamecncom.nat200.top/v1/install/runtime/`。每个归档有同名 `.sha256`；GitHub `gamecncom/codex-hardware-companion` 同版 Release 是回退源。Node 包来自 Node.js 官方 v24.21.0 macOS arm64 发行文件，内含 `LICENSE`，只安装在用户目录独立缓存，不全局安装。

基线 v0.3.8 业务包 77,993,175 字节；v0.3.10 业务包 72,036 字节。已有兼容 Node 时只下载业务包；没有时首装归档合计 27,458,116 字节。上述为文件字节数，不是网络传输时长。

已完成：隔离路径中的兼容/无 Node、同版复用、带空格路径、旧版升级、SHA 校验、GitHub 回退、后台服务路径及全量软件测试。云端静态下载入口已部署，原业务路由、当前设备绑定与 SaaS 健康状态保持。真实新 Mac 首装、真实设备端双向消息和解绑/重新绑定仍须单独现场验收；本机测试不替代。

当前 Mac 已从 v0.3.8 升至 v0.3.10：LaunchAgent 运行，云端连接恢复；配置文件 SHA-256 前后相同，原设备绑定仍 active。同版重跑返回 `reused=true`、`downloaded=false`，LaunchAgent PID 未变。自有 HTTPS 从本机完整下载 Node 归档的一次实测为 27,386,080 字节、103.87 秒、平均 263,654 字节/秒，SHA-256 与官方值一致；这只是当次网络测量，不保证其他网络速度。
