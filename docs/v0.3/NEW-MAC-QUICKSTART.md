# v0.3 新 Mac 快速开始

适用范围：Apple 芯片 Mac、macOS、已登录 Codex；本期不支持 Intel Mac 和 Windows。

1. 从确定的 GitHub 仓库安装 `skills/hardware-companion`，使用对应 Release 的 arm64 bootstrap。
2. bootstrap 校验 `hardware-companion-macos-arm64-v0.3.0.tar.gz` 后安装到 `~/Library/Application Support/HardwareCompanion/connector`。
3. 完成 Skill 引导的 SaaS 连接码关联；不要复制另一台电脑的配置、凭证或数据库。
4. 检查 `status`、`doctor`，映射当前 Mac 的真实项目，读取并确认两个真实任务。
5. 用 `task authorize` 写入未来配对使用的授权集和首选任务。
6. Skill 显示客户端可用、云端在线、授权范围后，电脑生成 8 位配对码；设备按住语音键逐位说码，松开等待绑定。
7. 绑定后关闭安装终端和对话，检查 LaunchAgent、Connector 心跳和任务快照。

解绑必须先执行 `device unbind prepare`，向用户展示设备和影响，再由用户明确确认后执行 `device unbind confirm`。设备切换阶段再处理解绑和刷机；准备阶段不解除当前绑定。
