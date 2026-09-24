# Codex Hardware Companion v0.3

硬件—SaaS—Codex 连接软件。Apple 芯片 Mac 当前公开版本为 v0.3.10（轻量安装）；云端已部署配套协议，完整新 Mac/真机演示仍待现场验收。

v0.3 交付材料见 [docs/v0.3](docs/v0.3/NEW-MAC-QUICKSTART.md)，当前公开包及 SHA-256 见 [v0.3.10 清单](docs/v0.3/RELEASE-MANIFEST-v0.3.10.md)；[v0.3.8 清单](docs/v0.3/RELEASE-MANIFEST.md)保留作历史记录。

## 本次交付范围（2026-09-18 用户确认）

内部演示 Demo，以正常条件下实际跑通为完成标准：初始化/登录 → 绑定设备 → 选择真实项目与已有任务 → 电脑/硬件双向续聊 → 完成提醒 → 正常解绑。具体演示步骤见 [v0.3 演示脚本](docs/v0.3/DEMO-RUNBOOK.md)。

不以完整异常分支、压力测试、量产可靠性、全部 U01—U17 或公开发行作为本次 Demo 完成门槛。已有有效实现保留，仅修阻碍正常演示的问题。真机演示未通过前不标记整个目标完成。

当前发布入口：[新 Mac 快速开始](docs/v0.3/NEW-MAC-QUICKSTART.md)，完整话术见 [演示操作手册](docs/v0.3/DEMO-OPERATIONS.md)。

## 所有权

| 组件 | 路径 | 负责人 |
|---|---|---|
| hc/1 协议与 SaaS | `packages/protocol`、`apps/saas` | SaaS 子 Agent |
| Codex Connector 与 Skill | `apps/connector`、`skills/hardware-companion` | Connector 子 Agent |
| 固件 | 独立固件 Git worktree，路径由交付记录登记 | 固件子 Agent |
| 根配置、跨端集成与状态 | 本仓库根目录、`tests/integration` | 主 Agent |

各子 Agent 使用用户指定的 GPT-5.6 Luna / medium。不要将独立模块测试视为真实设备闭环。

## 开发验证

需要 Node.js 22 或更高版本。模块准备好后执行 `npm install`、`npm run typecheck`、`npm test`；具体运行方式由各模块 README 提供。

核心验收：两个真实项目、三个已有任务；切换不改消息目标；后台完成不抢占当前页；电脑仍可继续输入。真实发送测试、云端部署、正式客户端安装与固件烧录分别记录，不能用模拟器结果代替。

## SaaS 语音配置

正式启动入口支持显式配置 `ASR_PROVIDER=qwen` 与服务器环境中的 `DASHSCOPE_API_KEY`；可选 `DASHSCOPE_ASR_MODEL`（默认 `qwen3-asr-flash-filetrans`）和 `DASHSCOPE_BASE_URL`。不要将密钥写入仓库或聊天记录。未配置供应商时其他接口仍可启动，录音上传返回 `CONFIG_MISSING`；生产入口不允许选择测试识别器。

当前 SaaS 已部署到演示服务；真实千问付费识别、Mac 新机和设备现场主流程仍需按操作手册单独验收。
