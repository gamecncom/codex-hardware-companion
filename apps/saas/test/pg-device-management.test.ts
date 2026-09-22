import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PostgresStore } from '../src/pg-store.js';
import { PgBusinessRepository } from '../src/pg-repository.js';
import { getDeviceState } from '../src/pg-device-state.js';
import { listDevices, migrateDeviceManagement, renameDevice, revokeBinding } from '../src/pg-device-management.js';

test('PG device management authenticates owners and persists rename/revoke idempotency', async t => {
  const url = process.env.COMPANION_PG_TEST_URL;
  if (!url) return t.skip('COMPANION_PG_TEST_URL not set');
  const db = new PostgresStore(url);
  t.after(() => db.close());
  await new PgBusinessRepository(db).migrate();
  await migrateDeviceManagement(db);
  const h = (x: string) => createHash('sha256').update(x).digest('hex');
  const suffix = randomUUID();
  const email = `dm-${suffix}@example.test`, otherEmail = `dm-other-${suffix}@example.test`;
  const session = `session-${suffix}`, connectorToken = `connector-${suffix}`, deviceToken = `device-${suffix}`;
  const connector = `cn-${suffix}`, binding = `binding-${suffix}`, otherConnector = `cn-other-${suffix}`;
  await db.pool.query(`INSERT INTO hc_auth(email,session_hash,session_expires_at) VALUES($1,$2,now()+interval '1 hour'),($3,$4,now()+interval '1 hour')`, [email, h(session), otherEmail, h(`other-${suffix}`)]);
  await db.pool.query(`INSERT INTO hc_connectors(id,email,name,token_hash) VALUES($1,$2,'A',$3),($4,$5,'B',$6)`, [connector, email, h(connectorToken), otherConnector, otherEmail, h(`other-connector-${suffix}`)]);
  await db.pool.query(`INSERT INTO hc_bindings(id,user_id,device_id,connector_id,epoch,state,active_task_ref,device_token) VALUES($1,$2,$3,$4,4,'active',$5,$6)`, [binding, email, `device-${suffix}`, connector, JSON.stringify({ task: 'active' }), deviceToken]);

  const rows = await listDevices(db, session);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, `device-${suffix}`);
  await assert.rejects(() => renameDevice(db, `other-${suffix}`, `device-${suffix}`, 'blocked', '11111111111111111111111111111111'), /UNAUTHORIZED/);

  const renameId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const renamed = await renameDevice(db, session, `device-${suffix}`, '我的设备', renameId);
  assert.deepEqual(renamed, { deviceId: `device-${suffix}`, name: '我的设备' });
  assert.deepEqual(await renameDevice(db, connectorToken, `device-${suffix}`, '我的设备', renameId), renamed);
  assert.equal((await listDevices(db, connectorToken))[0].name, '我的设备');
  await assert.rejects(() => renameDevice(db, session, `device-${suffix}`, 'different', renameId), /IDEMPOTENCY_CONFLICT/);
  const concurrentRenameId = 'dddddddddddddddddddddddddddddddd';
  const concurrentRename = await Promise.all([
    renameDevice(db, session, `device-${suffix}`, '并发名称', concurrentRenameId),
    renameDevice(db, connectorToken, `device-${suffix}`, '并发名称', concurrentRenameId),
  ]);
  assert.deepEqual(concurrentRename[0], concurrentRename[1]);
  assert.equal((await listDevices(db, session))[0].name, '并发名称');

  const revokeId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  for (const state of ['available', 'claimed', 'waiting_turn', 'completed']) {
    const commandId = `${state}-${suffix}`, messageId = `message-${state}-${suffix}`;
    await db.pool.query(`INSERT INTO hc_messages(id,binding_id,target,recording_id,status,command_id)
      VALUES($1,$2,'{}',$3,$4,$5)`, [messageId, binding, `recording-${suffix}`, state, commandId]);
    await db.pool.query(`INSERT INTO hc_commands(command_id,message_id,binding_id,connector_id,binding_epoch,grants_version,target,text,state,execution_state,expires_at)
      VALUES($1,$2,$3,$4,4,1,'{}','fixture',$5,$5,now()+interval '10 minutes')`, [commandId, messageId, binding, connector, state]);
  }
  const concurrentRevoke = await Promise.all([
    revokeBinding(db, session, binding, revokeId),
    revokeBinding(db, connectorToken, binding, revokeId),
  ]);
  assert.deepEqual(concurrentRevoke[0], concurrentRevoke[1]);
  const revoked = concurrentRevoke[0];
  assert.deepEqual(revoked, { bindingId: binding, epoch: 5, state: 'revoked' });
  assert.deepEqual(await revokeBinding(db, connectorToken, binding, revokeId), revoked);
  const stored = await db.pool.query('SELECT state,epoch,active_task_ref FROM hc_bindings WHERE id=$1', [binding]);
  assert.deepEqual(stored.rows[0], { state: 'revoked', epoch: 5, active_task_ref: null });
  const commandsAfter = await db.pool.query('SELECT command_id,state FROM hc_commands WHERE binding_id=$1', [binding]);
  const states = Object.fromEntries(commandsAfter.rows.map(row => [row.command_id, row.state]));
  assert.equal(states[`available-${suffix}`], 'cancelled');
  assert.equal(states[`claimed-${suffix}`], 'uncertain');
  assert.equal(states[`waiting_turn-${suffix}`], 'uncertain');
  assert.equal(states[`completed-${suffix}`], 'completed');
  const pendingMessage = await db.pool.query('SELECT status FROM hc_messages WHERE id=$1', [`message-available-${suffix}`]);
  assert.equal(pendingMessage.rows[0].status, 'cancelled');
  await assert.rejects(() => revokeBinding(db, session, binding, 'cccccccccccccccccccccccccccccccc'), /UNAUTHORIZED/);
  await assert.rejects(() => getDeviceState(db, deviceToken), /UNAUTHORIZED/);
});

test('PG device management isolates session and connector owners', async t => {
  const url = process.env.COMPANION_PG_TEST_URL;
  if (!url) return t.skip('COMPANION_PG_TEST_URL not set');
  const db = new PostgresStore(url); t.after(() => db.close());
  const h = (x: string) => createHash('sha256').update(x).digest('hex');
  const a = 'dm-a-' + randomUUID(), b = 'dm-b-' + randomUUID(), sa = 'sess-a-' + randomUUID(), sb = 'sess-b-' + randomUUID(), ca = 'cn-a-' + randomUUID(), cb = 'cn-b-' + randomUUID(), ba = 'bind-a-' + randomUUID(), bb = 'bind-b-' + randomUUID();
  await db.pool.query(`INSERT INTO hc_auth(email,session_hash,session_expires_at) VALUES($1,$2,now()+interval '1 hour'),($3,$4,now()+interval '1 hour')`, [a,h(sa),b,h(sb)]);
  await db.pool.query(`INSERT INTO hc_connectors(id,email,name,token_hash) VALUES($1,$2,'A',$3),($4,$5,'B',$6)`, [ca,a,h('tok-a'),cb,b,h('tok-b')]);
  await db.pool.query(`INSERT INTO hc_bindings(id,user_id,device_id,connector_id,epoch,state,device_token) VALUES($1,$2,$3,$4,1,'active','dev-a'),($5,$6,$7,$8,1,'active','dev-b')`, [ba,a,'device-a',ca,bb,b,'device-b',cb]);
  assert.equal((await listDevices(db, sa))[0].deviceId, 'device-a'); assert.equal((await listDevices(db, sb))[0].deviceId, 'device-b');
  assert.equal((await listDevices(db, 'tok-a'))[0].deviceId, 'device-a'); await assert.rejects(() => listDevices(db, 'dev-a'), /UNAUTHORIZED/);
});
