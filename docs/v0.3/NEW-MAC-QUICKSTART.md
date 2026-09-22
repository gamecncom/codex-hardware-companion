# v0.3.2 新 Mac 快速开始

适用范围：Apple 芯片 Mac、macOS、已登录 Codex；本期不支持 Intel Mac 和 Windows。

1. 在 Codex 新任务粘贴 `docs/v0.3/DEMO-OPERATIONS.md` 中的“第一句话”，从公开 GitHub Skill 目录安装。
2. 执行 v0.3.2 bootstrap；它固定下载 `hardware-companion-macos-arm64-v0.3.2.tar.gz`，使用同名 `.sha256` 校验，并安装到 `~/Library/Application Support/HardwareCompanion/connector`。
3. 不需要手填 SaaS 地址；Connector 默认连接 `https://gamecncom.nat200.top`。完成 Skill 引导的 SaaS 身份关联，不复制另一台电脑的配置、凭证或数据库。
4. 分别检查 `status`、`doctor`、`service status` 和 SaaS 心跳；安装 Skill 不等于已登录、已授权或已绑定。
5. 映射当前 Mac 的真实项目，读取并确认真实任务，再用 `task authorize` 写入授权集和首选任务。
6. 电脑生成 8 位配对码；设备按住语音键逐位说码，松开等待绑定。
7. 绑定后关闭安装终端，重新检查 LaunchAgent、Connector 心跳和任务快照；不要提前解绑或刷机。

完整可照读话术、现场步骤和验收表见 [DEMO-OPERATIONS.md](DEMO-OPERATIONS.md)。

解绑必须先执行 `device unbind prepare`，向用户展示设备和影响，再由用户明确确认后执行 `device unbind confirm`。设备切换阶段再处理解绑和刷机；准备阶段不解除当前绑定。
