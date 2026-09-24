import { createPgApp } from './pg-app.js';
import { PostgresStore } from './pg-store.js';
import { PgBusinessRepository } from './pg-repository.js';
import { attachPgChannel } from './pg-channel.js';
import { createAsrAdapter } from './asr.js';
import { createSmtpMailProvider } from './smtp-mail.js';
if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required in production; refusing in-memory SaaS startup');
process.env.NODE_ENV='production';
const db=new PostgresStore();const repo=new PgBusinessRepository(db);await repo.migrate();if(!await repo.health())throw new Error('PostgreSQL health check failed');
const deviceBootstraps = JSON.parse(process.env.HC_DEVICE_BOOTSTRAPS_JSON ?? '{}');
if (!deviceBootstraps || Array.isArray(deviceBootstraps) || typeof deviceBootstraps !== 'object' ||
    Object.values(deviceBootstraps).some(value => typeof value !== 'string' || !value)) {
  throw new Error('HC_DEVICE_BOOTSTRAPS_JSON must map device IDs to nonempty bootstrap credentials');
}
const port=Number(process.env.PORT??3020);
const asr=process.env.ASR_PROVIDER ? createAsrAdapter() : undefined;
const mailProvider=process.env.HC_SMTP_HOST ? createSmtpMailProvider() : undefined;
const server=createPgApp(db, { publicBaseUrl: process.env.HC_PUBLIC_BASE_URL, deviceBootstraps, asr, mailProvider, installAssetRoot: process.env.HC_INSTALL_ASSET_ROOT });
server.on('close', () => mailProvider?.close());
attachPgChannel(server, db);
server.listen(port,'127.0.0.1',()=>console.log(`codex-hardware-companion SaaS listening on ${port}`));
