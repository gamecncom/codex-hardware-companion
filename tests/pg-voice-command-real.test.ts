import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPgApp } from '../apps/saas/src/pg-app.js';
import { PostgresStore } from '../apps/saas/src/pg-store.js';
import { PgBusinessRepository } from '../apps/saas/src/pg-repository.js';
import { attachPgChannel } from '../apps/saas/src/pg-channel.js';
import { CompanionHttpClient } from '../apps/connector/src/httpClient.js';
import { CompanionDaemon } from '../apps/connector/src/daemon.js';
import { ExecutionLedger } from '../apps/connector/src/ledger.js';
import { WssTransport } from '../apps/connector/src/wssTransport.js';

test('real PG voice recording to WSS command claim and one enqueue', async t => {
  const url = process.env.COMPANION_PG_TEST_URL;
  assert.ok(url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname));
  const db = new PostgresStore(url), repo = new PgBusinessRepository(db), tag = randomUUID();
  await repo.migrate();
  const connector = `voice-cn-${tag}`, connectorToken = `voice-connector-token-${tag}`, deviceToken = `voice-device-token-${tag}`;
  const target = { connectorId: connector, projectId: `voice-project-${tag}`, threadId: `voice-thread-${tag}` };
  await db.pool.query('INSERT INTO hc_connectors(id,email,name,token_hash) VALUES($1,$2,$3,$4)', [connector, `${tag}@example.test`, 'voice-fixture', createHash('sha256').update(connectorToken).digest('hex')]);
  const binding = await repo.createBinding('voice-user-' + tag, connector, `voice-device-${tag}`, deviceToken);
  await db.pool.query('UPDATE hc_bindings SET selection_revision=1,active_task_ref=$2 WHERE id=$1', [binding.id, JSON.stringify(target)]);
  await repo.setGrants(binding.id, [target], '0', randomUUID().replaceAll('-', '').slice(0, 32));
  await db.pool.query(`INSERT INTO projects(connector_id,project_id,name,source) VALUES($1,$2,'Voice project','local') ON CONFLICT DO NOTHING`, [connector, target.projectId]);
  await db.pool.query(`INSERT INTO tasks(connector_id,thread_id,project_id,title,status,revision,updated_at) VALUES($1,$2,$3,'Voice task','idle',1,now()) ON CONFLICT DO NOTHING`, [connector, target.threadId, target.projectId]);
  const app = createPgApp(db, { asr: { kind: 'real-pg-fixture-asr', transcribe: async () => ({ transcript: '请处理这个任务' }) } });
  const wss = attachPgChannel(app, db);
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const address = app.address(); assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const transport = new WssTransport({ url: `ws://127.0.0.1:${address.port}/v1/connectors/channel`, token: connectorToken, connectorId: connector });
  const ledgerDir = await fs.mkdtemp(join(tmpdir(), 'hc-voice-ledger-')), ledgerPath = join(ledgerDir, 'executions.json');
  let enqueues = 0;
  let snapshot: any = { threadId: target.threadId, cwd: '/synthetic/voice', status: 'running', turns: [], raw: {} };
  const commandEvents: any[] = [];
  const adapter: any = {
    detect: async () => ({ list: true, read: true, enqueue: true, accountContextDetection: true, nativeApproval: false, version: 'synthetic', binary: '/synthetic/private/binary' }),
    readIdentity: async () => ({ available: true, fingerprint: 'voice-fixture-identity', source: 'fixture' }),
    readThread: async () => snapshot,
    enqueue: async (threadId: string, text: string, cwd: string) => { enqueues++; assert.equal(threadId, target.threadId); assert.equal(text, '请处理这个任务'); assert.equal(cwd, '/synthetic/voice'); return { accepted: true, status: 'queued', queueId: `queue-${tag}`, raw: 'fixture' }; },
    close: async () => {},
  };
  const daemon = new CompanionDaemon({ transport, connectionEpoch: '1', pollMs: 20, catalogPollMs: 999999, client: new CompanionHttpClient({ baseUrl, token: connectorToken, connectorId: connector }), adapter, ledger: new ExecutionLedger(ledgerPath) });
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
    const clients = [...wss.clients], closed = clients.map(ws => once(ws, 'close').catch(() => undefined));
    for (const ws of clients) ws.terminate(); await Promise.all(closed);
    app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve()));
    await fs.rm(ledgerDir, { recursive: true, force: true }); await db.close();
  });
  const uploadForm = new FormData();
  uploadForm.append('audio', new Blob([Buffer.from('voice-fixture-m4a')], { type: 'audio/mp4' }), 'recording.m4a');
  uploadForm.append('metadata', JSON.stringify({ clientRequestId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', target, bindingEpoch: binding.epoch, selectionRevision: '1' }));
  const upload = await fetch(`${baseUrl}/v1/device/recordings`, { method: 'POST', headers: { authorization: `Bearer ${deviceToken}` }, body: uploadForm });
  assert.equal(upload.status, 202); const recording = (await upload.json() as any).data;
  let recordingState: any; for (let i = 0; i < 50; i++) { const r = await fetch(`${baseUrl}/v1/device/recordings/${recording.recordingId}`, { headers: { authorization: `Bearer ${deviceToken}` } }); recordingState = (await r.json() as any).data; if (recordingState.status !== 'processing') break; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(recordingState.status, 'ready');
  const submit = await fetch(`${baseUrl}/v1/device/messages`, { method: 'POST', headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ clientRequestId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', bindingEpoch: binding.epoch, target, selectionRevision: '1', recordingId: recording.recordingId }) });
  // The Connector has not connected yet: acceptance must not imply execution.
  assert.equal(submit.status, 202); assert.equal((await submit.json() as any).data.status, 'waiting_connector');
  const deviceMessage = async () => { const r = await fetch(`${baseUrl}/v1/device/messages/${(await db.pool.query('SELECT id FROM hc_messages WHERE recording_id=$1', [recording.recordingId])).rows[0].id}`, { headers: { authorization: `Bearer ${deviceToken}` } }); return (await r.json() as any).data; };
  const commandId = (await deviceMessage()).commandId;
  transport.on('message', event => { if (event.type === 'command.completed' || event.type === 'task.snapshot') commandEvents.push(event); });
  let availableTimer: ReturnType<typeof setTimeout>;
  const available = new Promise<void>((resolve, reject) => { availableTimer = setTimeout(() => reject(Error('command.available not received')), 5000); transport.on('message', event => { if (event.type === 'command.available' && event.payload?.commandId === commandId) { clearTimeout(availableTimer); resolve(); } }); });
  t.after(() => clearTimeout(availableTimer));
  daemon.start(); await once(transport, 'open'); await available;
  let capabilities: any;
  for (let i = 0; i < 50; i++) {
    const response = await fetch(`${baseUrl}/v1/device/task?threadId=${encodeURIComponent(target.threadId)}&projectId=${encodeURIComponent(target.projectId)}`, { headers: { authorization: `Bearer ${deviceToken}` } });
    capabilities = (await response.json() as any).data?.capabilities;
    if (capabilities?.canSend === true) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(capabilities?.canSend, true, 'daemon-detected capabilities must reach the actual device HTTP route');
  const serverWs = [...wss.clients][0]; assert.ok(serverWs); serverWs.on('message', raw => { try { commandEvents.push(JSON.parse(raw.toString())); } catch {} });
  let waiting: any;
  for (let i = 0; i < 100; i++) {
    waiting = await deviceMessage();
    if (waiting.status === 'waiting_turn') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(waiting.status, 'waiting_turn');
  assert.equal(enqueues, 0, 'the desktop turn must finish before hardware dispatch');
  snapshot = { ...snapshot, status: 'idle' };
  for (let i = 0; i < 100 && enqueues === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(enqueues, 1, JSON.stringify({ command: (await db.pool.query('SELECT state,execution_id,execution_state FROM hc_commands WHERE command_id=$1', [commandId])).rows[0], ledger: await new ExecutionLedger(ledgerPath).list() }));
  let message: any; for (let i = 0; i < 100; i++) { message = await deviceMessage(); if (message.status === 'queued') break; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(message.status, 'queued');
  for (const ws of wss.clients) ws.send(JSON.stringify({ protocol: 'hc/1', type: 'command.available', payload: { commandId } }));
  await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(enqueues, 1);
  snapshot = { threadId: target.threadId, cwd: '/synthetic/voice', status: 'completed', turns: [{ id: 'turn-voice-result', status: 'completed', items: [{ type: 'userMessage', text: '请处理这个任务' }, { type: 'agentMessage', text: '合成回复已完成' }] }], raw: {} };
  let completed: any; for (let i = 0; i < 100; i++) { completed = await deviceMessage(); if (completed.status === 'completed') break; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(completed.status, 'completed'); assert.deepEqual(completed.target, target);
  assert.ok(commandEvents.some(event => event.type === 'command.completed' && event.payload?.commandId === commandId));
  assert.ok(commandEvents.some(event => event.type === 'task.snapshot' && event.payload?.threadId === target.threadId && event.payload?.resultText === '合成回复已完成'));
  assert.equal(completed.text, '请处理这个任务');
  let detail: any;
  for (let i = 0; i < 100; i++) { const response = await fetch(`${baseUrl}/v1/device/view?screen=detail&projectId=${encodeURIComponent(target.projectId)}&threadId=${encodeURIComponent(target.threadId)}`, { headers: { authorization: `Bearer ${deviceToken}` } }); detail = (await response.json() as any).data; if (detail?.textLines?.some((line: string) => line.includes('合成回复已完成'))) break; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.ok(detail.textLines.some((line: string) => line.includes('合成回复已完成')));
  assert.deepEqual(detail.target, target);
});
