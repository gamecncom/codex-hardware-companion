# v0.3 固件现场切换单

当前设备仍保持原绑定和原固件。本单只在用户明确进入“设备切换阶段”后执行。

## 待刷产物

- 来源：独立 firmware worktree 的 `firmware/build/ai_picture_book_v1_product.bin`
- 版本：Codex Hardware Companion v0.3 voice-pairing build
- SHA-256：`b0633d10b68f4b57bc91a4f0206a15b89f28e662f03082a768475d856415567d`
- ESP-IDF product build：已通过
- 当前状态：未刷入当前设备；未验证新设备

## 现场顺序

1. 先在新 Mac 完成 v0.3.1 Skill、Connector、SaaS 关联和真实任务授权验收。
2. 用户确认当前设备已进入切换阶段，并确认接受解绑影响；此前不执行解绑。
3. 记录设备标识、现有绑定状态和刷前电源/网络条件；不公开 bootstrap 或设备密钥。
4. 按硬件工程流程刷入上述 bin，校验写后哈希；不把构建通过当作刷机通过。
5. 设备启动后先验证 4G、TLS、SaaS health/配对接口和绑定状态，再生成新 8 位配对码。
6. 按 [DEMO-OPERATIONS.md](DEMO-OPERATIONS.md) 完成语音配对、任务切换、电脑输入、设备语音、提醒、解绑和重新绑定。
7. 每个现场结论记录时间、设备标识、版本/哈希和结果；缺少真实证据的项目保持“待现场”。

## 禁止提前执行

- 不在开发机上解绑当前绑定。
- 不在没有现场安排时刷写当前设备。
- 不上传包含 bootstrap、设备 token 或私有服务配置的固件。

