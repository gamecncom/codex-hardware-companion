import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createPgApp } from '../apps/saas/src/pg-app.js';
import { PostgresStore } from '../apps/saas/src/pg-store.js';
import { PgBusinessRepository } from '../apps/saas/src/pg-repository.js';
import { attachPgChannel, migratePgChannel } from '../apps/saas/src/pg-channel.js';
import { CatalogSync } from '../apps/connector/src/catalogSync.js';
import { WssTransport } from '../apps/connector/src/wssTransport.js';

test('actual Connector CatalogSync publishes task-shaped pages and results to PG', async t => {
  const url = process.env.COMPANION_PG_TEST_URL;
  assert.ok(url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname));
  const db = new PostgresStore(url);
  const repo = new PgBusinessRepository(db);
  await repo.migrate(); await migratePgChannel(db);
  const tag = randomUUID(), connector = 'connector-' + tag, token = 'token-' + tag;
  const project = 'project-' + tag, thread = 'thread-' + tag;
  await db.pool.query('INSERT INTO hc_connectors(id,email,name,token_hash) VALUES($1,$2,$3,$4)',
    [connector, tag + '@example.test', 'fixture', createHash('sha256').update(token).digest('hex')]);
  const binding = await repo.createBinding(tag, connector, 'device-' + tag, 'device-token-' + tag);
  await repo.setGrants(binding.id, [{ connectorId: connector, projectId: project, threadId: thread }], '0', randomUUID().replaceAll('-', ''));
  const server = createPgApp(db), wss = attachPgChannel(server, db);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const transport = new WssTransport({ url: `ws://127.0.0.1:${address.port}/v1/connectors/channel`, token, connectorId: connector });
  t.after(async () => {
    const clients = [...wss.clients];
    const closed = clients.map(ws => once(ws, 'close'));
    transport.close(); for (const ws of clients) ws.terminate();
    await Promise.all(closed);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
  });
  transport.on('error', () => {});
  let timer: ReturnType<typeof setTimeout>;
  const committed = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => reject(Error('catalog end was not acknowledged by PG channel')), 5000);
    transport.on('message', event => {
      if (event.type === 'catalog.ack' && event.payload?.type === 'catalog.snapshot.end') { clearTimeout(timer); resolve(); }
    });
  });
  t.after(() => clearTimeout(timer));
  const opened = once(transport, 'open'); transport.connect(); await opened;
  // Intentionally publish immediately: the transport's open event is the contract.
  const adapter = {
    listThreads: async () => ({ data: [{ threadId: thread, title: '真实格式任务', titleSource: 'codex',
      cwd: '/synthetic/project', status: 'completed', updatedAt: '2026-09-17T12:00:00Z' }] }),
    readThread: async () => ({ threadId: thread, cwd: '/synthetic/project', status: 'completed',
      turns: [{ id: 'turn-fixture', status: 'completed', items: [{ type: 'agentMessage', text: '合成结果用于接口验收' }] }], raw: {} }),
  };
  const sync = new CatalogSync(adapter as any, transport, [{ projectId: project, name: '真实格式项目', root: '/synthetic/project' }], () => true);
  await sync.sync(); await committed;
  const projects = await db.pool.query('SELECT name FROM projects WHERE connector_id=$1 AND project_id=$2', [connector, project]);
  assert.equal(projects.rows[0]?.name, '真实格式项目');
  const tasks = await db.pool.query('SELECT revision FROM tasks WHERE connector_id=$1 AND thread_id=$2', [connector, thread]);
  assert.match(String(tasks.rows[0]?.revision), /^\d+$/);
  const result = await db.pool.query('SELECT result_text FROM hc_task_results WHERE connector_id=$1 AND thread_id=$2', [connector, thread]);
  assert.equal(result.rows[0]?.result_text, '合成结果用于接口验收');
  const deviceHeaders = { authorization: `Bearer device-token-${tag}` };
  const stateUrl = `http://127.0.0.1:${address.port}/v1/device/state`;
  const baselineState = (await (await fetch(stateUrl, { headers: deviceHeaders })).json()).data;
  assert.equal(baselineState.unreadCount, 0, 'historical import must establish a silent baseline');
  transport.send({ protocol: 'hc/1', type: 'task.snapshot', payload: { projectId: project, threadId: thread,
    status: 'completed', lastTurnId: 'new-turn', resultRevision: 'new-source-hash', resultText: '新完成回复' } });
  let attentionState: any;
  for (let i = 0; i < 50; i++) {
    attentionState = (await (await fetch(stateUrl, { headers: deviceHeaders })).json()).data;
    if (attentionState.unreadCount === 1) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(attentionState.unreadCount, 1);
  assert.deepEqual(attentionState.activeTaskRef, baselineState.activeTaskRef, 'completion never changes the selected task');
  assert.notEqual(attentionState.revision, baselineState.revision);
  const alerts = await db.pool.query('SELECT * FROM hc_alerts WHERE binding_id=$1', [binding.id]);
  assert.equal(alerts.rowCount, 1);
  const taskPage = await fetch(`http://127.0.0.1:${address.port}/v1/device/tasks?projectId=${project}`, { headers: deviceHeaders });
  assert.equal((await taskPage.json()).data.items[0].unread, true);
  const deviceBase = `http://127.0.0.1:${address.port}/v1/device`;
  const alertResponse = await fetch(`${deviceBase}/alerts?cursor=0`, { headers: deviceHeaders });
  assert.equal(alertResponse.status, 200);
  const alertPage = (await alertResponse.json()).data;
  assert.equal(alertPage.items.length, 1);
  assert.match(alertPage.nextCursor, /^\d+$/);
  const alert = alertPage.items[0];
  const ackBody = JSON.stringify({ clientRequestId: randomUUID().replaceAll('-', '') });
  for (let repeat = 0; repeat < 2; repeat++) {
    const ack = await fetch(`${deviceBase}/alerts/${alert.alertId}/ack`, { method: 'POST', headers: deviceHeaders, body: ackBody });
    assert.equal(ack.status, 200);
    assert.equal((await ack.json()).data.acknowledged, true);
  }
  const afterAck = (await (await fetch(stateUrl, { headers: deviceHeaders })).json()).data;
  assert.equal(afterAck.unreadCount, 1, 'acknowledging sound is not reading the result');
  const restartedAlerts = (await (await fetch(`${deviceBase}/alerts?cursor=0`, { headers: deviceHeaders })).json()).data;
  assert.deepEqual(restartedAlerts.items, [], 'acknowledged notifications must not sound again after device restart');
  const markRead = await fetch(`${deviceBase}/read`, { method: 'POST', headers: deviceHeaders,
    body: JSON.stringify({ clientRequestId: randomUUID().replaceAll('-', ''), target: alert.target, resultRevision: alert.resultRevision }) });
  assert.equal(markRead.status, 200, await markRead.clone().text());
  const readState = (await (await fetch(stateUrl, { headers: deviceHeaders })).json()).data;
  assert.equal(readState.unreadCount, 0);
  const incremental = (await (await fetch(`${deviceBase}/alerts?cursor=${alertPage.nextCursor}`, { headers: deviceHeaders })).json()).data;
  assert.deepEqual(incremental.items, []);
  assert.equal(incremental.nextCursor, alertPage.nextCursor);
  const commandId = `cmd-${tag}`;
  await db.pool.query(`INSERT INTO hc_commands(command_id,message_id,binding_id,connector_id,binding_epoch,grants_version,target,text,state,expires_at)
    VALUES($1,$2,$3,$4,1,1,$5,'合成命令','available',now()+interval '10 minutes')`,
    [commandId, `msg-${tag}`, binding.id, connector, JSON.stringify({ connectorId: connector, projectId: project, threadId: thread })]);
  const available = new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('persisted command was not advertised')), 1500);
    t.after(() => clearTimeout(timeout));
    transport.on('message', event => {
      if (event.type === 'command.available' && event.payload?.commandId === commandId) {
        clearTimeout(timeout); resolve(event);
      }
    });
  });
  transport.send({ protocol: 'hc/1', type: 'heartbeat', payload: { seq: '1' } });
  assert.equal((await available).payload.commandId, commandId);
  const executionId = `exec-${tag}`;
  await db.pool.query("UPDATE hc_commands SET state='claimed',execution_state='claimed',execution_id=$2 WHERE command_id=$1", [commandId, executionId]);
  await db.pool.query(`INSERT INTO hc_messages(id,binding_id,target,recording_id,status,command_id)
    VALUES($1,$2,$3,$4,'dispatching',$5)`, [`msg-${tag}`, binding.id,
    JSON.stringify({ connectorId: connector, projectId: project, threadId: thread }), `recording-${tag}`, commandId]);
  transport.send({ protocol: 'hc/1', type: 'command.waiting_turn', payload: { commandId, executionId } });
  let waitingState: string | undefined;
  for (let i = 0; i < 50; i++) {
    waitingState = (await db.pool.query('SELECT status FROM hc_messages WHERE id=$1', [`msg-${tag}`])).rows[0]?.status;
    if (waitingState === 'waiting_turn') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(waitingState, 'waiting_turn', 'real channel must persist the waiting-for-current-turn receipt');
  const emptyThread = `empty-${tag}`;
  await db.pool.query('INSERT INTO tasks(connector_id,project_id,thread_id,title,status,revision,updated_at) VALUES($1,$2,$3,$4,$5,1,now())',
    [connector, project, emptyThread, '从未回复的新任务', 'idle']);
  await db.pool.query('INSERT INTO hc_grants(binding_id,connector_id,project_id,thread_id) VALUES($1,$2,$3,$4)', [binding.id, connector, project, emptyThread]);
  transport.send({ protocol: 'hc/1', type: 'task.snapshot', payload: { projectId: project,
    threadId: emptyThread, status: 'idle', resultRevision: 'empty-history' } });
  for (let i = 0; i < 50; i++) {
    if ((await db.pool.query('SELECT 1 FROM hc_task_results WHERE connector_id=$1 AND thread_id=$2', [connector, emptyThread])).rowCount) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  transport.send({ protocol: 'hc/1', type: 'task.snapshot', payload: { projectId: project,
    threadId: emptyThread, status: 'completed', lastTurnId: 'first-ever-turn', resultRevision: 'first-reply', resultText: '第一条回复' } });
  let firstReplyAlerts = 0;
  for (let i = 0; i < 50; i++) {
    firstReplyAlerts = (await db.pool.query('SELECT 1 FROM hc_alerts WHERE binding_id=$1 AND thread_id=$2', [binding.id, emptyThread])).rowCount ?? 0;
    if (firstReplyAlerts) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(firstReplyAlerts, 1, 'an initially empty task must notify on its first real reply');
});
