# RELEASE MANIFEST v0.3.8

- 版本：`0.3.8`（公开发布）；目标 Apple silicon macOS / `arm64`；协议 `hc/1`。
- 安装包：`apps/connector/artifacts/hardware-companion-macos-arm64-v0.3.8.tar.gz`。
- SHA-256：`fb32ff72c40edb0b96b2b831a07a1ef5678fd4450152adf266081b5417dd9c45`；同名 `.sha256` 独立校验。
- GitHub 仓库：用户确认继续使用公开的 `gamecncom/codex-hardware-companion`；入口 `https://github.com/gamecncom/codex-hardware-companion/releases/tag/v0.3.8`。v0.3.7 和更早版本保留为历史 Release。
- 本版修复：Codex app-server 的 `notLoaded` 快照可暂时显示最新 turn 为 `interrupted`，但桌面任务仍在运行；Connector 只在明确失败时显示 failed，暂态返回 unknown，避免设备误报失败。保留 v0.3.7 的启动、重连与安全升级修复。
- 当前 Mac：v0.3.8 从 v0.3.7 安全升级成功，`config.json` SHA-256 前后均为 `ba7b939ac24bc3a881d2d754b6acdcd1724a99a74a989333defa9a1776d8db90`，`demo-usb-01` 保持同一 active 绑定。16:48 CST 云端 channel `connected=true`、epoch `24`；当前运行中 turn 的结果由错误的 failed 变为 unknown。
- 固件：当前设备的 companion profile 已构建并刷入，应用镜像 SHA-256 `01fd9e3d6fd78a114be44652673d7af0cee8d0c348bad4b40d3db5dd777d9526`；本版没有解绑或刷机。
- SaaS：演示服务仍使用已部署的 v0.3 契约，本版仅更新 Connector/Skill 安装入口，无需更换云端服务。
- 验收边界：用户确认上一轮结束后设备显示“完成”，Codex 对应 turn 确为 completed。v0.3.8 设备侧暂态画面尚待用户反馈；双向真实消息、解绑/重新绑定、全新 Mac 安装尚未验收，不能以当前 Mac 测试代替。
