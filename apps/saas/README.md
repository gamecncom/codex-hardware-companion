# SaaS v0.2

正式启动入口为 `src/main.ts`，使用 `createPgApp()`、PostgreSQL 和 `attachPgChannel()`；启动前等待 `PgBusinessRepository.migrate()` 完成统一迁移。`CompanionService` / `createApp()` 是保留的内存测试入口，不能替代 PG 验收。systemd 与配置样例位于 `deploy/`，尚未实际部署。

## 本地验证

```sh
npm install --ignore-scripts
npm run typecheck --workspace=@companion/protocol
npm run test --workspace=@companion/protocol
npm run typecheck --workspace=@companion/saas
npm run test --workspace=@companion/saas
```

开发服务：配置 `DATABASE_URL` 后运行 `npm run start --workspace=@companion/saas`。语音使用 `ASR_PROVIDER=qwen` 和环境中的 `DASHSCOPE_API_KEY`，默认模型 `qwen3-asr-flash-filetrans`。未配置供应商时录音上传返回 `CONFIG_MISSING`，其他接口可启动；指定 qwen 却缺密钥时启动失败。正式入口强制 production，不允许测试识别器。

根 `test:pg` 使用显式本地 `COMPANION_PG_TEST_URL` 验证 PG、HTTP、实际 WSS 与 Connector；录音和 Codex 执行数据仍为合成 fixture。真实邮箱、阿里云 ASR 调用、云部署和真机闭环仍待验收。

邮件登录支持 SMTP：环境配置 `HC_SMTP_HOST`、`HC_SMTP_PORT`、`HC_SMTP_SECURE`（`true` 或 `false`）、`HC_SMTP_USER`、`HC_SMTP_PASSWORD`、`HC_SMTP_FROM` 后，正式入口注入 Nodemailer 邮件供应商。没有配置时邮件发送接口明确返回 `CONFIG_MISSING`。本地 SMTP→HTTP 验证码登录联合测试已通过；尚未配置或验证真实邮箱投递。
