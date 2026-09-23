# v0.3 Apple Silicon 演示操作手册

适用范围：Apple 芯片 Mac、macOS、已登录 Codex；设备使用已配套的 v0.3 固件和 4G 网络。本手册只覆盖正常演示主流程。

## 先给新 Mac 的第一句话

在 Codex 新任务中粘贴：

> 请使用 Codex 的 Skill 安装能力，从公开 GitHub 仓库 `gamecncom/codex-hardware-companion` 的 `v0.3.7` tag 安装 `skills/hardware-companion`。本机是 Apple Silicon Mac。安装后执行这个 Skill 自带的 `scripts/bootstrap-macos-arm64.sh`，只从同一 `v0.3.7` Release 下载 arm64 Connector 和 `.sha256` 并校验；若已有 Connector，请安全升级并保留现有配置与设备绑定，不复制别的电脑凭据，也不要解绑、配对或发消息。完成后检查 Skill 和 Connector 是否可用；若当前任务尚未发现新 Skill，请新开一个 Codex 任务再使用。

Skill 的固定目录：[v0.3.7 skills/hardware-companion](https://github.com/gamecncom/codex-hardware-companion/tree/v0.3.7/skills/hardware-companion)。Connector 已内置演示 SaaS 地址 `https://gamecncom.nat200.top`，新 Mac 不需要手填云端地址或组装 JSON。

## 安装后第一次使用的一句话

> 请使用 Hardware Companion：先分别检查 Connector CLI、Codex 只读能力、后台服务和演示 SaaS 连通性；执行默认身份初始化，再列出当前已绑定设备和授权任务。若这台 Mac 已有 Connector 或设备绑定，请展示现有身份与状态，不要冒充全新注册，也不要生成配对码、解绑、刷机或发送消息。若没有旧配置，才报告新生成的 clientId 和 connectorId。

通过标准：Skill、Connector、SaaS、Codex 读取能力及已有绑定分别报告结果；安装成功不等于已授权或已绑定。本机当前已有 Connector 和绑定，首次使用应如实展示。

## 日常话术与实际动作

| 用户对 Codex 说 | Skill/Connector 动作 | 用户看到的通过结果 |
|---|---|---|
| “检查硬件助手连接状态，并告诉我哪一项还没完成。” | `companion status --json`、`companion doctor --json`、`companion service status --json` | 分开显示 CLI、Codex read/list/queue、LaunchAgent、SaaS/Connector 状态 |
| “初始化或检查当前 Mac 的演示连接，不要邮箱、演示码或浏览器登录。” | `companion init --json`、`device list` | 新 Mac 获得持久化 clientId；已有 Mac 复用 connector 身份并展示现有绑定 |
| “读取当前 Mac 的真实项目和任务，只展示候选，不发送消息。” | `project add`、`catalog sync`、`task discover`、`task read` | 显示真实项目根目录、精确 `projectId`、`threadId` 和任务状态 |
| “我确认授权项目 X 的任务 Y，以及任务 Z；请写入授权集并说明首选任务。” | `task authorize --refs ... --preferred ...` | 返回已保存的精确 TaskRef；未确认任务不进入授权集 |
| “生成一个新的八位设备配对码。” | 先 `device list`；确认无当前绑定后 `device pair --json` | 电脑显示 8 位码和过期时间；有当前绑定时不提前生成或解除 |
| “列出已绑定设备，并使用设备 `<exact deviceId>`。” | `device list`、`device use --device ...` | 显示精确设备/绑定、授权集和选择版本 |
| “把任务 X 切换为当前设备目标。” | `task select --ref ...` | 设备显示任务 X；选择使用精确 TaskRef，不按列表位置猜测 |
| “查看任务 X 的最新回复。” | `task read --thread <exact threadId>` | 返回对应原对话的最新内容；不创建新任务 |
| “准备解绑当前设备，先展示设备和影响，等我确认。” | `device unbind prepare --json` | 只生成待确认操作，不解绑 |
| “我确认解绑刚才展示的设备和影响。” | `device unbind confirm --operation <operationId> --json` | 旧绑定被撤销；设备在线时回到待绑定，离线时显示待联网同步 |
| “用新配对码重新绑定当前设备。” | 再执行 `device pair`，设备按语音完成配对，再 `device list/use` | 新绑定获得新的状态；旧绑定消息和提醒不迁移 |

## 现场主流程

1. 用户在新 Mac 确认 Apple Silicon、Codex 已登录且电脑联网。
2. Codex 安装 Skill；Skill 下载安装 Connector，随后执行 `service install` 和 `service start`。关闭安装终端后，重新执行 `service status`，确认 LaunchAgent 仍 loaded/running。
3. 用户说“初始化当前演示连接”。Skill 单独报告持久化 clientId、SaaS 注册成功和 Connector ID。
4. 用户说“读取并展示当前真实项目和任务”，确认至少两个项目和两个指定任务；Skill 只读，不发送内容。
5. 用户明确说出要授权的项目、任务和首选任务。Skill 写入 grant preset，并逐项回显精确 TaskRef。
6. 用户说“生成八位设备配对码”。电脑显示码；设备进入等待语音配对。
7. 用户按住设备语音键，逐位说出 8 位码，松开；设备显示识别中/上传中/匹配中/绑定成功。设备绑定成功后，电脑执行 `device list`、`device use`。
8. 用户选择任务 A。电脑输入一条演示消息；设备收到同一任务的新回复和提示音。
9. 设备按住语音键说一句话，松开后等待 ASR；识别到有效文本后自动发送到录音开始时冻结的同一 `threadId`。设备短暂显示识别文本和发送状态，不再等待第二次短按确认；电脑继续生成回复，设备收到回复。
10. 在任务 A 忙或录音期间，不切换目标。让任务 B 产生新回复；设备空闲时显示任务 B 提醒，确认后再切回任务 A。
11. 用户说“准备解绑当前设备”。Skill 展示精确设备、绑定和影响；用户取消时不执行 confirm。
12. 用户明确确认后执行解绑。在线设备回到待绑定；再生成新码并重复步骤 6–7 完成重新绑定。

## 运行条件与限制

- Mac 必须保持开机、联网、Codex 登录、Connector LaunchAgent 运行；关闭安装终端不应停止服务。
- 合盖休眠期间不承诺同步；唤醒后只验证 Connector 自动重连，不把休眠期间的消息当作实时保证。
- 电脑端审批必须由用户在 Codex 完成；Skill 不伪造原生审批。
- 解绑和刷机属于设备切换阶段动作；新 Mac/新固件现场准备前不解除当前绑定。
- 真实 ASR、真实设备语音发送、重新绑定和离线解绑必须记录现场证据，不能用 host 测试代替。

## 一页验收表

| 阶段 | 通过证据 | 当前状态 |
|---|---|---|
| Skill 安装 | 新任务可发现 Skill，bootstrap 公开下载并校验通过 | 主机入口已发布，待新 Mac |
| Connector 安装 | bundled Node、wrapper、默认安装目录和 LaunchAgent 可检查 | 主机验证通过，待新 Mac |
| SaaS 关联 | 独立 connectorId、SaaS healthz、Connector 心跳 | 云端已部署，待新 Mac 账号现场 |
| Codex 读取 | account/read、thread/list、thread/read 通过 | 开发机验证通过，待新 Mac |
| 任务授权 | 用户确认后的精确 TaskRef 写入 preset | PG/Connector 验证通过，待真实任务 |
| 语音配对 | 8 位码、设备录音上传、ASR、绑定成功 | 代码/构建通过，待真机 |
| 双向消息 | 电脑输入和设备语音进入同一 threadId | 软件契约通过，待真机 |
| 提醒/切换 | 跨任务提醒、目标冻结、切换后仍隔离 | 软件契约通过，待真机 |
| 解绑/重绑 | prepare/confirm、旧绑定失效、新码重新绑定 | 软件契约通过，待真机 |
