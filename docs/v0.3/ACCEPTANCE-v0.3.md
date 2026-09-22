# ACCEPTANCE v0.3

状态：开发候选，未完成新 Mac 现场验收。

| 项目 | 当前状态 | 证据边界 |
|---|---|---|
| P01 arm64 GitHub 新机安装 | 待发布/待现场 | 公开仓库目标已确定为 `gamecncom/codex-hardware-companion`；候选包和固定 Release 地址已准备，尚未完成 GitHub 发布和新机验收 |
| P02 账号与两个任务 | 待现场 | CLI/Connector 代码已保留真实目录与 threadId 约束 |
| P03 语音配对 | 开发候选 | SaaS 8 位码、ASR 精确规范化、固件状态机和音频 multipart 上传已实现；未真机 |
| P04 重启保留绑定 | 待现场 | 既有 NVS 绑定实现保留；未以 v0.3 固件验收 |
| P05–P07 双向消息 | 复用待定向验证 | 既有 queue、任务快照、目标冻结实现保留；未发送新真实任务 |
| P08–P09 解绑/再绑定 | 开发中 | prepare/confirm 和旧状态隔离已实现；未真机 |
| P10 后台运行 | 开发候选 | LaunchAgent 使用包内 runtime、显式 config、日志和 KeepAlive；未新机验收 |
| P11 离线解绑 | 待现场 | 云端 `deviceAppliedState=pending` 契约已实现；未设备离线现场 |
