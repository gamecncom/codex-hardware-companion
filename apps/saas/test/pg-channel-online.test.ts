import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPgApp } from '../src/pg-app.js';
import { attachPgChannel, migratePgChannel } from '../src/pg-channel.js';
import { PostgresStore } from '../src/pg-store.js';
import { PgBusinessRepository } from '../src/pg-repository.js';
import WebSocket from 'ws';

test('PG channel online state follows current epoch and expires after 45 seconds', async (t) => {
  const url = process.env.COMPANION_PG_TEST_URL;
  if (!url) return t.skip('COMPANION_PG_TEST_URL not set');
  const db = new PostgresStore(url), repo = new PgBusinessRepository(db);
  await repo.migrate(); await migratePgChannel(db);
  const suffix = Date.now().toString(36), connector = `online-${suffix}`, token = `online-token-${suffix}`;
  await db.pool.query('INSERT INTO hc_connectors(id,email,name,token_hash) VALUES($1,$2,$3,$4)', [connector, `${suffix}@test.invalid`, 'online', createHash('sha256').update(token).digest('hex')]);
  const deviceToken = `online-device-${suffix}`;
  await db.pool.query("INSERT INTO hc_bindings(id,user_id,device_id,connector_id,epoch,state,device_token) VALUES($1,$2,$3,$4,1,'active',$5)", [`online-binding-${suffix}`, `online-user-${suffix}`, `online-device-${suffix}`, connector, deviceToken]);
  const app = createPgApp(db); attachPgChannel(app, db); await new Promise<void>(r => app.listen(0, '127.0.0.1', r));
  t.after(async () => { await new Promise<void>(r => app.close(() => r())); await db.close(); });
  const port = (app.address() as any).port;
  const state = async () => (await (await fetch(`http://127.0.0.1:${port}/v1/device/state`, { headers: { authorization: `Bearer ${deviceToken}` } })).json() as any).data;
  const connect = () => new WebSocket(`ws://127.0.0.1:${port}/v1/connectors/channel`, { headers: { authorization: `Bearer ${token}`, 'x-connector-id': connector } });
  const first = connect(); await new Promise<void>(r => first.once('open', () => r())); await new Promise(r => setTimeout(r, 30)); assert.equal((await state()).linkStatus, 'online');
  await db.pool.query("UPDATE hc_connector_channel_state SET connected=true,last_seen_at=now()-interval '46 seconds' WHERE connector_id=$1", [connector]); assert.equal((await state()).linkStatus, 'offline');
  const second = connect(); await new Promise<void>(r => second.once('open', () => r())); await new Promise(r => setTimeout(r, 30)); first.close(); await new Promise(r => setTimeout(r, 40)); assert.equal((await state()).linkStatus, 'online');
  second.close(); await new Promise(r => setTimeout(r, 50)); assert.equal((await state()).linkStatus, 'offline');
});
