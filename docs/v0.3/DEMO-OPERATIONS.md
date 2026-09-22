# v0.3 Apple Silicon 演示操作手册

适用范围：Apple 芯片 Mac、macOS、已登录 Codex；设备使用已配套的 v0.3 固件和 4G 网络。本手册只覆盖正常演示主流程。

## 先给新 Mac 的第一句话

在 Codex 新任务中粘贴：

> 请从公开仓库 https://github.com/gamecncom/codex-hardware-companion 的 `skills/hardware-companion` 安装 Hardware Companion Skill；本机是 Apple Silicon Mac。安装后执行该 Skill 的固定 v0.3.3 bootstrap，使用 https://github.com/gamecncom/codex-hardware-companion/releases/download/v0.3.3/hardware-companion-macos-arm64-v0.3.3.tar.gz 及同地址追加 `.sha256` 的校验文件；不要使用其他平台包、另一台电脑的配置或设备凭据。安装完成后请检查 Skill 是否可用；如果当前任务没有发现它，请新开一个 Codex 任务再继续。

Skill 的公开目录：[skills/hardware-companion](https://github.com/gamecncom/codex-hardware-companion/tree/main/skills/hardware-companion)。bootstrap 已内置演示 SaaS 地址 `https://gamecncom.nat200.top`，新 Mac 不需要手填云端地址或组装 JSON。

## 安装后第一次使用的一句话

> 请使用 Hardware Companion：先分别检查 Connector CLI、Codex 只读能力、后台服务和演示 SaaS 连通性；然后引导我完成账号关联，但先不要配对、授权任务、解绑或刷机。

通过标准：Skill、Connector、SaaS、Codex 读取能力分别报告结果；安装成功不等于已登录、已授权或已绑定。

## 日常话术与实际动作

| 用户对 Codex 说 | Skill/Connector 动作 | 用户看到的通过结果 |
|---|---|---|
| “检查硬件助手连接状态，并告诉我哪一项还没完成。” | `companion status --json`、`companion doctor --json`、`companion service status --json` | 分开显示 CLI、Codex read/list/queue、LaunchAgent、SaaS/Connector 状态 |
| “关联当前演示账号；如果需要浏览器确认，告诉我去浏览器完成，不要伪造审批。” | `companion init --json`，必要时 `auth start/poll` | 当前 Mac 获得独立 connector 身份；待审批只在电脑端完成 |
| “读取当前 Mac 的真实项目和任务，只展示候选，不发送消息。” | `project add`、`catalog sync`、`task discover`、`task read` | 显示真实项目根目录、精确 `projectId`、`threadId` 和任务状态 |
| “我确认授权项目 X 的任务 Y，以及任务 Z；请写入授权集并说明首选任务。” | `task authorize --refs ... --preferred ...` | 返回已保存的精确 TaskRef；未确认任务不进入授权集 |
| “生成一个新的八位设备配对码。” | `device pair --json` | 电脑显示 8 位码和过期时间；此时不解除当前设备绑定 |
| “列出已绑定设备，并使用设备 `<exact deviceId>`。” | `device list`、`device use --device ...` | 显示精确设备/绑定、授权集和选择版本 |
| “把任务 X 切换为当前设备目标。” | `task select --ref ...` | 设备显示任务 X；选择使用精确 TaskRef，不按列表位置猜测 |
| “查看任务 X 的最新回复。” | `task read --thread <exact threadId>` | 返回对应原对话的最新内容；不创建新任务 |
| “准备解绑当前设备，先展示设备和影响，等我确认。” | `device unbind prepare --json` | 只生成待确认操作，不解绑 |
| “我确认解绑刚才展示的设备和影响。” | `device unbind confirm --operation <operationId> --json` | 旧绑定被撤销；设备在线时回到待绑定，离线时显示待联网同步 |
| “用新配对码重新绑定当前设备。” | 再执行 `device pair`，设备按语音完成配对，再 `device list/use` | 新绑定获得新的状态；旧绑定消息和提醒不迁移 |

## 现场主流程

1. 用户在新 Mac 确认 Apple Silicon、Codex 已登录且电脑联网。
2. Codex 安装 Skill；Skill 下载安装 Connector，随后执行 `service install` 和 `service start`。关闭安装终端后，重新执行 `service status`，确认 LaunchAgent 仍 loaded/running。
3. 用户说“关联当前演示账号”，完成浏览器或已配置的演示账号流程。Skill 单独报告 SaaS 登录成功和 Connector ID。
4. 用户说“读取并展示当前真实项目和任务”，确认至少两个项目和两个指定任务；Skill 只读，不发送内容。
5. 用户明确说出要授权的项目、任务和首选任务。Skill 写入 grant preset，并逐项回显精确 TaskRef。
6. 用户说“生成八位设备配对码”。电脑显示码；设备进入等待语音配对。
7. 用户按住设备语音键，逐位说出 8 位码，松开；设备显示识别中/上传中/匹配中/绑定成功。设备绑定成功后，电脑执行 `device list`、`device use`。
8. 用户选择任务 A。电脑输入一条演示消息；设备收到同一任务的新回复和提示音。
9. 设备按住语音键说一句话，松开后等待 ASR；按当前设备确认提示确认发送。语音文字进入同一 `threadId`，电脑继续生成回复，设备收到回复。
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
