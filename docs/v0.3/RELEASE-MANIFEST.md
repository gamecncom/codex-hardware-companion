# RELEASE MANIFEST v0.3.6

- 版本：`0.3.6`（公开发布）
- 目标：Apple silicon macOS / `arm64`
- 协议：`hc/1`
- 候选包：`apps/connector/artifacts/hardware-companion-macos-arm64-v0.3.6.tar.gz`
- 候选包 SHA-256：`0055caa42780264314e4924b06c66f2edf2e172c94475ac5bbf9dbb4b3cd0055`
- 工作树状态：用户已确认继续使用公开仓库 `gamecncom/codex-hardware-companion`；`v0.3.6` 为当前发布 tag，公开安装入口为 `https://github.com/gamecncom/codex-hardware-companion/releases/tag/v0.3.6`。
- 固件：独立 worktree 的 companion profile 已构建并刷入当前 `demo-usb-01`；应用镜像 SHA-256 为 `01fd9e3d6fd78a114be44652673d7af0cee8d0c348bad4b40d3db5dd777d9526`，factory 镜像 SHA-256 为 `1e07e30ab205b7475edf56bc8492fec7ff99d40be172565e8fc9b78f402f9b79`。本轮修复上传后状态转换及重启恢复既有绑定；没有解绑或切换设备。候选包 SHA-256 不随固件刷入改变。
- SaaS：v0.3 契约已部署到演示服务；本地 PG 顺序验证 33/33，通过独立 release 验证 healthz 和新增路由鉴权。
- GitHub：`v0.3.0`—`v0.3.5` 保留为历史公开 Release；v0.3.6 包地址为 `https://github.com/gamecncom/codex-hardware-companion/releases/download/v0.3.6/hardware-companion-macos-arm64-v0.3.6.tar.gz`，校验文件为同地址追加 `.sha256`。
