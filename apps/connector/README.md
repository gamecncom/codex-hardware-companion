# Connector

本地 Connector 仅通过公开 `codex app-server --stdio` 读取任务，发送时严格使用参数数组 `queue --thread <id> --message <text>`，并要求调用方显式提供原始 cwd。CLI 始终输出 `{ok,operation,data,error}` JSON；未确认的 queue 返回 `uncertain`，不伪报成功。

P0 兼容边界：已核实 `/Applications/ChatGPT.app/Contents/Resources/codex` 版本 `0.154.0-alpha.6.2` 可 initialize/thread/list，且 `queue --help` 存在。账号上下文只生成不可逆指纹，当前 `accountContextDetection=false`；未授权真实消息发送、resume/fork/start。

## macOS 打包

先构建 Connector，再在目标 macOS 架构上运行：

```text
npm run build --workspace=@companion/connector
npm run package:macos --workspace=@companion/connector
```

打包器会先确认 `apps/connector/dist/cli.js`、协议运行时和根目录 `skills/hardware-companion` 存在，然后生成当前运行架构对应的 `hardware-companion-macos-<arch>-v<version>.tar.gz` 及 `.sha256`。它不会交叉构建或宣称另一架构已构建；例如在 arm64 主机上只登记 arm64 包。发布包内的 `bin/companion` 使用包内 `runtime/node` 执行包内 `dist/cli.js`，因此不依赖全局 Node，并安全支持带空格的安装路径和参数。包内同时包含 `VERSION`、`compatibility.json`、`checksums.sha256`、`skills/hardware-companion` 和安装脚本。打包验证只覆盖本地 wrapper、文件完整性与只读 CLI 输出，不安装 LaunchAgent、不部署、不发送真实任务。

### 首次解压安装

解压 Release 后，在明确的目标目录执行以下命令。安装器只校验并复制文件，不联网、不初始化账号、不调用 `launchctl`：

```text
runtime/node scripts/install-package.mjs \
  --from "/path/to/hardware-companion-macos-arm64-v0.2.0" \
  --install-root "$HOME/Library/Application Support/HardwareCompanion/connector"
```

安装结果位于 `<installRoot>/current/`，可直接使用包内 wrapper：

```text
"$HOME/Library/Application Support/HardwareCompanion/connector/current/bin/companion" doctor --json
```

安装器会校验 `VERSION` 和 `checksums.sha256`，不会覆盖已有 `current` 或 `previous`，也不会改写目标目录中的用户配置。已有安装应使用 `companion update --from <release> --install-root <installRoot>`；首次安装和更新不是同一操作。LaunchAgent 仍由 service lifecycle 单独管理，本安装器不会自动常驻。
