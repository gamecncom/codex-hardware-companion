import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresStore } from '../src/pg-store.js';
import { PgBusinessRepository } from '../src/pg-repository.js';
import { createPgApp } from '../src/pg-app.js';

test('PG device state exposes the active task result revision', async t => {
  const url = process.env.COMPANION_PG_TEST_URL;
  if (!url) return t.skip('COMPANION_PG_TEST_URL not set');
  const db = new PostgresStore(url), repo = new PgBusinessRepository(db);
  await repo.migrate();
  const token = `state-token-${Date.now()}`;
  await db.pool.query(`INSERT INTO hc_bindings(id,user_id,device_id,connector_id,epoch,state,selection_revision,grants_version,device_token)
    VALUES($1,'u','d','c',1,'active',0,0,$2)
    ON CONFLICT(id) DO UPDATE SET state='active',selection_revision=0,active_task_ref=NULL,device_token=$2`, ['state-bind', token]);
  await db.pool.query(`INSERT INTO projects VALUES('c','p-state','State','local') ON CONFLICT DO NOTHING`);
  await db.pool.query(`INSERT INTO tasks VALUES('c','t-state','p-state','State task','idle',1,now()) ON CONFLICT DO NOTHING`);
  await db.pool.query(`INSERT INTO hc_grants VALUES('state-bind','c','p-state','t-state') ON CONFLICT DO NOTHING`);
  const app = createPgApp(db as any);
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise<void>(resolve => app.close(() => resolve())); await db.close(); });
  const port = (app.address() as any).port;
  const get = () => fetch(`http://127.0.0.1:${port}/v1/device/state`, { headers: { authorization: `Bearer ${token}` } });
  const first = await get();
  assert.equal(first.status, 200);
  const a = (await first.json() as any).data;
  assert.equal(a.activeResultRevision, undefined);
  await repo.select(token, { connectorId: 'c', projectId: 'p-state', threadId: 't-state' }, '0', '0123456789abcdef0123456789abcdef');
  const second = await get();
  const b = (await second.json() as any).data;
  assert.equal(b.activeTaskRef.threadId, 't-state');
  assert.equal(b.activeResultRevision, '1');
  assert.notEqual(b.revision, a.revision);
});
