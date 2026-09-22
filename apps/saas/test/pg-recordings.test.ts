import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { PostgresStore } from '../src/pg-store.js';
import { PgBusinessRepository } from '../src/pg-repository.js';
import { migrateRecordings, handleRecordingRequest, PgRecordings } from '../src/pg-recordings.js';
import type { AsrAdapter } from '../src/asr.js';

test('PG recordings upload asynchronously, freeze target, isolate bindings, and cancel drafts', async t => {
  const url = process.env.COMPANION_PG_TEST_URL;
  if (!url) return t.skip('COMPANION_PG_TEST_URL not set');
  const db = new PostgresStore(url); t.after(() => db.close());
  await new PgBusinessRepository(db).migrate(); await migrateRecordings(db);
  const suffix = randomUUID(), connector = `rec-cn-${suffix}`, otherConnector = `rec-cn-b-${suffix}`;
  const binding = `rec-binding-${suffix}`, otherBinding = `rec-binding-b-${suffix}`;
  const token = `rec-device-token-${suffix}`, otherToken = `rec-device-token-b-${suffix}`;
  const target = { connectorId: connector, projectId: `project-${suffix}`, threadId: `thread-${suffix}` };
  const otherTarget = { connectorId: otherConnector, projectId: `project-b-${suffix}`, threadId: `thread-b-${suffix}` };
  await db.pool.query(`INSERT INTO hc_connectors(id,email,name,token_hash) VALUES($1,$2,'A','hash-a'),($3,$4,'B','hash-b')`, [connector, `rec-a-${suffix}@example.test`, otherConnector, `rec-b-${suffix}@example.test`]);
  await db.pool.query(`INSERT INTO hc_bindings(id,user_id,device_id,connector_id,epoch,state,selection_revision,active_task_ref,device_token) VALUES($1,'u',$2,$3,7,'active',3,$4,$5),($6,'u2',$7,$8,2,'active',1,$9,$10)`, [binding, `device-${suffix}`, connector, JSON.stringify(target), token, otherBinding, `device-b-${suffix}`, otherConnector, JSON.stringify(otherTarget), otherToken]);
  await db.pool.query(`INSERT INTO hc_grants(binding_id,connector_id,project_id,thread_id) VALUES($1,$2,$3,$4),($5,$6,$7,$8)`, [binding, target.connectorId, target.projectId, target.threadId, otherBinding, otherTarget.connectorId, otherTarget.projectId, otherTarget.threadId]);
  let calls = 0; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const adapter: AsrAdapter = { kind: 'fixture', async transcribe(path) { calls++; const data = await fs.readFile(path); assert.deepEqual(data, Buffer.from('m4a-fixture')); await gate; return { transcript: '已识别内容', providerTaskId: 'provider-1' }; } };
  const recordings = new PgRecordings(db, adapter);
  const metadata = { clientRequestId: '0123456789abcdef0123456789abcdef', target, bindingEpoch: 7, selectionRevision: '3' };
  const first = await recordings.upload(token, Buffer.from('m4a-fixture'), metadata);
  assert.equal(first.status, 'processing'); assert.equal(first.target.threadId, target.threadId);
  const retry = await recordings.upload(token, Buffer.from('m4a-fixture'), { selectionRevision: '3', bindingEpoch: 7, target: { threadId: target.threadId, projectId: target.projectId, connectorId: target.connectorId }, clientRequestId: metadata.clientRequestId }); assert.deepEqual(retry, first);
  await assert.rejects(() => recordings.upload(token, Buffer.from('other'), { ...metadata, clientRequestId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', bindingEpoch: '7' as unknown as number }), /INVALID_REQUEST/);
  await assert.rejects(() => recordings.upload(token, Buffer.from('other'), { ...metadata, clientRequestId: 'ffffffffffffffffffffffffffffffff', selectionRevision: '1'.repeat(21) }), /INVALID_REQUEST/);
  await new Promise(r => setTimeout(r, 20)); assert.equal(calls, 1); release();
  await assert.rejects(() => recordings.upload(token, Buffer.from('different'), metadata), /IDEMPOTENCY_CONFLICT/);
  await assert.rejects(() => recordings.upload(otherToken, Buffer.from('m4a-fixture'), { ...metadata, clientRequestId: 'fedcba9876543210fedcba9876543210' }), /TARGET_MOVED|TARGET_NOT_GRANTED/);
  let ready: any; for (let i = 0; i < 30; i++) { ready = await recordings.get(token, first.recordingId); if (ready.status !== 'processing') break; await new Promise(r => setTimeout(r, 20)); }
  assert.equal(ready.status, 'ready'); assert.equal(ready.transcript, '已识别内容'); assert.deepEqual(ready.target, target);
  const cancelled = await recordings.cancel(token, first.recordingId); assert.equal(cancelled.status, 'cancelled'); assert.equal((await recordings.get(token, first.recordingId)).status, 'cancelled');
});

test('PG recordings HTTP multipart returns 202 and GET reaches ready', async t => {
  const url = process.env.COMPANION_PG_TEST_URL;
  if (!url) return t.skip('COMPANION_PG_TEST_URL not set');
  const db = new PostgresStore(url); t.after(() => db.close()); await new PgBusinessRepository(db).migrate(); await migrateRecordings(db);
  const suffix = randomUUID(), connector = `http-cn-${suffix}`, binding = `http-binding-${suffix}`, token = `http-token-${suffix}`;
  const target = { connectorId: connector, projectId: `http-project-${suffix}`, threadId: `http-thread-${suffix}` };
  await db.pool.query(`INSERT INTO hc_connectors(id,email,name,token_hash) VALUES($1,$2,'HTTP','hash')`, [connector, `http-${suffix}@example.test`]);
  await db.pool.query(`INSERT INTO hc_bindings(id,user_id,device_id,connector_id,epoch,state,selection_revision,active_task_ref,device_token) VALUES($1,'u',$2,$3,1,'active',0,$4,$5)`, [binding, `http-device-${suffix}`, connector, JSON.stringify(target), token]);
  await db.pool.query(`INSERT INTO hc_grants(binding_id,connector_id,project_id,thread_id) VALUES($1,$2,$3,$4)`, [binding, target.connectorId, target.projectId, target.threadId]);
  const adapter: AsrAdapter = { kind: 'http-fixture', async transcribe() { return { transcript: 'HTTP ready' }; } };
  const server = createServer((req, res) => { void handleRecordingRequest(db, adapter, req, res, token, new URL(req.url ?? '/', 'http://localhost').pathname); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve())); t.after(() => server.close());
  const port = (server.address() as any).port, boundary = 'recording-boundary';
  const metadataJson = JSON.stringify({ clientRequestId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', target, bindingEpoch: 1, selectionRevision: '0' });
  const multipartBody = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="recording.m4a"\r\nContent-Type: audio/mp4\r\n\r\nm4a-http-${boundary}-inside\r\n--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${metadataJson}\r\n--${boundary}--\r\n`);
  const response = await fetch(`http://127.0.0.1:${port}/v1/device/recordings`, { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(multipartBody.length) }, body: multipartBody });
  const responseText = await response.text(); assert.equal(response.status, 202, responseText); const createdEnvelope = JSON.parse(responseText) as any; const created = createdEnvelope.data; assert.equal(created.status, 'processing');
  let currentEnvelope: any; for (let i = 0; i < 30; i++) { const r = await fetch(`http://127.0.0.1:${port}/v1/device/recordings/${created.recordingId}`, { headers: { authorization: `Bearer ${token}` } }); currentEnvelope = await r.json(); if (currentEnvelope.data.status !== 'processing') break; await new Promise(r => setTimeout(r, 20)); }
  const current = currentEnvelope.data; assert.equal(current.status, 'ready'); assert.equal(current.transcript, 'HTTP ready'); assert.deepEqual(current.target, target);
});
