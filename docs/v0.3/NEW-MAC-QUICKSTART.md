# v0.3 新 Mac 快速开始

适用范围：Apple 芯片 Mac、macOS、已登录 Codex；本期不支持 Intel Mac 和 Windows。

1. 在 Codex 新任务粘贴 `docs/v0.3/DEMO-OPERATIONS.md` 中的“第一句话”，从公开 GitHub `v0.3.8` tag 的 Skill 目录安装。
2. 执行 Skill 中的 arm64 bootstrap；它固定下载 `hardware-companion-macos-arm64-v0.3.8.tar.gz` 及同名 `.sha256`，并安装或升级 `~/Library/Application Support/HardwareCompanion/connector`，保留既有本机配置。
3. 不需要手填 SaaS 地址、邮箱验证码、演示码或浏览器登录。全新 Mac 首次执行 `companion init --json` 时生成并持久化本机 `clientId`，自动向 `https://gamecncom.nat200.top` 注册独立 connector 凭证；已有安装则展示现有身份，不冒充新注册。不复制另一台电脑的配置、凭证或数据库。
4. 分别检查 `status`、`doctor`、`service status` 和 SaaS 心跳；安装 Skill 不等于已完成任务授权或设备绑定。
5. 映射当前 Mac 的真实项目，读取并确认真实任务，再用 `task authorize` 写入授权集和首选任务。
6. 用户确认真实 TaskRef 后，电脑生成配对码并在 Codex 中显示；设备按住语音键逐位说码，松开等待绑定。
7. 绑定后关闭安装终端，重新检查 LaunchAgent、Connector 心跳和任务快照；不要提前解绑或刷机。

完整可照读话术、现场步骤和验收表见 [DEMO-OPERATIONS.md](DEMO-OPERATIONS.md)。

解绑必须先执行 `device unbind prepare`，向用户展示设备和影响，再由用户明确确认后执行 `device unbind confirm`。设备切换阶段再处理解绑和刷机；准备阶段不解除当前绑定。
