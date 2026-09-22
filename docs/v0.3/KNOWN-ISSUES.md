# v0.3 已知问题

- 没有新 Apple 芯片 Mac 时，P01、P02、P04、P08–P11 只能标记待现场，开发机不能代替验收。
- 语音配对的云端接口与固件音频 multipart 上传链路已完成代码接入、host 合约和 ESP-IDF 构建；仍需现场设备实际录音、上传、ASR 和绑定验收。
- LaunchAgent 的 `loaded`、`running`、云端心跳和任务快照是三个独立状态，不能只看 `launchctl`。
- 休眠期间不承诺同步；唤醒后依赖 Connector 自动重连。
- 本期解绑保留 Codex 原任务和云端历史，不等同于完整二手转让清理或遗失恢复。
