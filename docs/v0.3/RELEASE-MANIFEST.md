# RELEASE MANIFEST v0.3.7

- 版本：`0.3.7`（公开发布）；目标 Apple silicon macOS / `arm64`；协议 `hc/1`。
- 安装包：`apps/connector/artifacts/hardware-companion-macos-arm64-v0.3.7.tar.gz`。
- SHA-256：`7b20886ac1f92eca5334efffc3568536473e5a17e2eda0469f764316f76f5c91`；同名 `.sha256` 独立校验。
- GitHub 仓库：用户确认继续使用公开的 `gamecncom/codex-hardware-companion`；入口 `https://github.com/gamecncom/codex-hardware-companion/releases/tag/v0.3.7`。v0.3.6 和更早版本保留为历史 Release。
- 本版修复：app-server 子进程忽略 SIGTERM 时的启动卡住、WSS 断线时的后台异常退出、LaunchAgent 停止/启动的异步状态检查；bootstrap 用新候选包的升级器处理已有安装。
- 当前 Mac：v0.3.7 从 v0.3.6 安全升级成功，`config.json` SHA-256 前后均为 `ba7b939ac24bc3a881d2d754b6acdcd1724a99a74a989333defa9a1776d8db90`，`demo-usb-01` 保持同一 active 绑定。15:20—15:21 CST 云端 channel `connected=true`、epoch `23`、同一 Connector PID，心跳持续更新。
- 固件：当前设备的 companion profile 已构建并刷入，应用镜像 SHA-256 `01fd9e3d6fd78a114be44652673d7af0cee8d0c348bad4b40d3db5dd777d9526`；本版没有解绑或刷机。
- SaaS：演示服务仍使用已部署的 v0.3 契约，本版仅更新 Connector/Skill 安装入口，无需更换云端服务。
- 验收边界：设备画面的“失败”来自 Codex app-server 所读最新 turn `interrupted`；Codex 桌面任务同期为 `inProgress`，实时状态仍有来源差异。双向真实消息、解绑/重新绑定、全新 Mac 安装尚未验收，不能以当前 Mac 测试代替。
