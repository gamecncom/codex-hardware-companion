import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { PostgresStore } from '../apps/saas/src/pg-store.js';
import { PgBusinessRepository } from '../apps/saas/src/pg-repository.js';
import { createPgApp } from '../apps/saas/src/pg-app.js';

test('real PostgreSQL migrations, HTTP catalog and committed binding survive service recreation', async t => {
  const connection = process.env.COMPANION_PG_TEST_URL;
  assert.ok(connection, 'requires an isolated local PostgreSQL test instance');
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(connection).hostname), 'test must use local isolated PostgreSQL');
  const db = new PostgresStore(connection);
  t.after(() => db.close());
  const repo = new PgBusinessRepository(db);
  await repo.migrate();
  const tables = await db.pool.query("SELECT to_regclass('projects') AS projects, to_regclass('tasks') AS tasks");
  assert.ok(tables.rows[0].projects && tables.rows[0].tasks, 'migration must create catalog tables used by production routes');
  const tag = randomUUID();
  const token = 'fixture-' + tag;
  const binding = await repo.createBinding('user-' + tag, 'connector-' + tag, 'device-' + tag, token);
  const server = createPgApp(db, { asr: { kind: 'explicit-integration-fixture', transcribe: async () => ({ transcript: '合成语音识别结果' }) } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/device/projects`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.items, []);
  const refs = [0, 1, 2].map(index => ({ connectorId: binding.connectorId,
    projectId: `${tag}-project-${index < 2 ? 1 : 2}`, threadId: `${tag}-thread-${index}` }));
  for (const project of new Set(refs.map(ref => ref.projectId))) {
    await db.pool.query('INSERT INTO projects(connector_id,project_id,name,source) VALUES($1,$2,$3,$4)',
      [binding.connectorId, project, project, 'local']);
  }
  for (const ref of refs) {
    await db.pool.query('INSERT INTO tasks(connector_id,thread_id,project_id,title,status,revision,updated_at) VALUES($1,$2,$3,$4,$5,1,now())',
      [ref.connectorId, ref.threadId, ref.projectId, ref.threadId, 'completed']);
  }
  await repo.setGrants(binding.id, refs, '0', randomUUID().replaceAll('-', ''));
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const projects = await fetch(`${base}/v1/device/projects`, { headers });
  assert.equal(projects.status, 200);
  const projectItems = (await projects.json()).data.items;
  assert.equal(projectItems.length, 2);
  assert.deepEqual(projectItems.map((p: any) => p.taskCount).sort(), [1, 2]);
  const tasks = await fetch(`${base}/v1/device/tasks?projectId=${refs[0].projectId}`, { headers });
  assert.equal(tasks.status, 200);
  assert.deepEqual((await tasks.json()).data.items.map((item: any) => item.threadId).sort(), refs.slice(0, 2).map(ref => ref.threadId).sort());
  // A device must reach every authorized entry, not repeatedly receive page one.
  for (const [path, expectedIds, idKey] of [
    ['/v1/device/projects', [...new Set(refs.map(ref => ref.projectId))], 'projectId'],
    [`/v1/device/tasks?projectId=${refs[0].projectId}`, refs.slice(0, 2).map(ref => ref.threadId), 'threadId'],
  ] as const) {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const pageUrl = new URL(path, base);
      pageUrl.searchParams.set('limit', '1');
      if (cursor) pageUrl.searchParams.set('cursor', cursor);
      const response = await fetch(pageUrl, { headers });
      assert.equal(response.status, 200);
      const data = (await response.json()).data;
      assert.ok(data.items.length <= 1);
      seen.push(...data.items.map((item: any) => item[idKey]));
      if (!data.nextCursor) break;
      assert.notEqual(data.nextCursor, cursor, 'cursor must advance');
      cursor = data.nextCursor;
    }
    assert.deepEqual(seen.sort(), [...expectedIds].sort(), `${path} must expose all granted entries across pages`);
  }
  const pageBefore = (await (await fetch(`${base}/v1/device/projects?limit=1`, { headers })).json()).data;
  assert.ok(pageBefore.nextCursor);
  const wrongScope = await fetch(`${base}/v1/device/tasks?projectId=${refs[0].projectId}&cursor=${encodeURIComponent(pageBefore.nextCursor)}`, { headers });
  assert.equal(wrongScope.status, 409, 'project cursor cannot be reused as a task cursor');
  await db.pool.query('UPDATE projects SET name=$2 WHERE connector_id=$1', [binding.connectorId, 'same display name']);
  const stale = await fetch(`${base}/v1/device/projects?cursor=${encodeURIComponent(pageBefore.nextCursor)}`, { headers });
  assert.equal(stale.status, 409, 'changed directory must reject old snapshot cursor');
  const pageAfter = (await (await fetch(`${base}/v1/device/projects?limit=1`, { headers })).json()).data;
  assert.ok(BigInt(pageAfter.catalogVersion) > BigInt(pageBefore.catalogVersion));
  const secondPage = (await (await fetch(`${base}/v1/device/projects?limit=1&cursor=${encodeURIComponent(pageAfter.nextCursor)}`, { headers })).json()).data;
  assert.notEqual(pageAfter.items[0].projectId, secondPage.items[0].projectId, 'same display names must keep stable distinct IDs');
  const viewResponse = await fetch(`${base}/v1/device/view?screen=projects&choice=1`, { headers });
  assert.equal(viewResponse.status, 200);
  const view = (await viewResponse.json()).data;
  assert.equal(view.choice, 1);
  assert.ok(view.jpegPath && view.viewId);
  const jpegResponse = await fetch(base + view.jpegPath, { headers });
  assert.equal(jpegResponse.status, 200);
  assert.match(jpegResponse.headers.get('content-type') ?? '', /image\/jpeg/);
  const jpeg = Buffer.from(await jpegResponse.arrayBuffer());
  assert.ok(jpeg.length <= 150 * 1024);
  const image = await sharp(jpeg).metadata();
  assert.equal(image.width, 480);
  assert.equal(image.height, 320);
  const jpegAgain = await fetch(base + view.jpegPath, { headers });
  assert.deepEqual(Buffer.from(await jpegAgain.arrayBuffer()), jpeg);
  const resultText = '这是一段用于验证硬件中文阅读分页的真实格式回复。'.repeat(30);
  await db.pool.query(`INSERT INTO hc_task_results(connector_id,project_id,thread_id,result_revision,status,result_text)
    VALUES($1,$2,$3,'fixture-version','completed',$4)`, [refs[0].connectorId, refs[0].projectId, refs[0].threadId, resultText]);
  const detailPath = `/v1/device/view?screen=detail&projectId=${refs[0].projectId}&threadId=${refs[0].threadId}`;
  const detailResponse = await fetch(base + detailPath, { headers });
  assert.equal(detailResponse.status, 200);
  const detail = (await detailResponse.json()).data;
  assert.deepEqual(detail.target, refs[0]);
  assert.ok(detail.pageCount > 1);
  let displayed = '';
  for (let page = 0; page < detail.pageCount; page++) {
    const response = await fetch(`${base}${detailPath}&page=${page}`, { headers });
    assert.equal(response.status, 200);
    const data = (await response.json()).data;
    assert.equal(data.page, page);
    displayed += data.textLines.join('');
  }
  assert.equal(displayed, resultText, 'all pages together must preserve the full reply');
  const taskSummaryResponse = await fetch(`${base}/v1/device/task?threadId=${encodeURIComponent(refs[0].threadId)}&projectId=${encodeURIComponent(refs[0].projectId)}`, { headers });
  assert.equal(taskSummaryResponse.status, 200);
  const taskSummary = (await taskSummaryResponse.json()).data;
  assert.deepEqual(taskSummary.target, refs[0]);
  assert.equal(taskSummary.pageCount, detail.pageCount);
  assert.equal(taskSummary.resultRevision, detail.resultRevision);
  assert.equal(taskSummary.capabilities.nativeApproval, false);
  const detailJpeg = await fetch(base + detail.jpegPath, { headers });
  assert.equal(detailJpeg.status, 200);
  const detailMeta = await sharp(Buffer.from(await detailJpeg.arrayBuffer())).metadata();
  assert.equal(detailMeta.width, 480); assert.equal(detailMeta.height, 320);
  const otherToken = 'ungranted-' + tag;
  await repo.createBinding('other-' + tag, binding.connectorId, 'other-device-' + tag, otherToken);
  assert.equal((await fetch(base + detailPath, { headers: { authorization: `Bearer ${otherToken}` } })).status, 403);
  const body = JSON.stringify({ target: refs[0], expectedSelectionRevision: '0', clientRequestId: randomUUID().replaceAll('-', '') });
  const first = await fetch(`${base}/v1/device/selection`, { method: 'POST', headers, body });
  assert.equal(first.status, 200);
  const selected = (await first.json()).data;
  const retry = await fetch(`${base}/v1/device/selection`, { method: 'POST', headers, body });
  assert.equal(retry.status, 200, 'same request retry must return persisted success rather than a stale-selection conflict');
  assert.deepEqual((await retry.json()).data, selected);
  const form = new FormData();
  form.set('metadata', JSON.stringify({ clientRequestId: randomUUID().replaceAll('-', ''), target: refs[0], bindingEpoch: 1, selectionRevision: '1' }));
  form.set('audio', new Blob([Buffer.from('synthetic-audio-fixture')], { type: 'audio/mp4' }), 'recording.m4a');
  const uploaded = await fetch(`${base}/v1/device/recordings`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  assert.equal(uploaded.status, 202, await uploaded.clone().text());
  const uploadedEnvelope = await uploaded.json();
  assert.equal(uploadedEnvelope.protocol, 'hc/1');
  const recording = uploadedEnvelope.data;
  let ready: any;
  for (let attempt = 0; attempt < 50; attempt++) {
    const status = await fetch(`${base}/v1/device/recordings/${recording.recordingId}`, { headers });
    assert.equal(status.status, 200);
    ready = (await status.json()).data;
    if (ready.status !== 'processing') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(ready.status, 'ready');
  assert.equal(ready.transcript, '合成语音识别结果');
  assert.deepEqual(ready.target, refs[0]);
  const transcriptView = await fetch(`${base}/v1/device/view?screen=transcript&recordingId=${recording.recordingId}`, { headers });
  assert.equal(transcriptView.status, 200, await transcriptView.clone().text());
  const transcriptDescriptor = (await transcriptView.json()).data;
  assert.equal(transcriptDescriptor.recordingId, recording.recordingId);
  assert.deepEqual(transcriptDescriptor.target, refs[0]);
  assert.equal(transcriptDescriptor.textLines.join(''), ready.transcript);
  const transcriptJpeg = await fetch(base + transcriptDescriptor.jpegPath, { headers });
  assert.equal(transcriptJpeg.status, 200);
  assert.equal((await sharp(Buffer.from(await transcriptJpeg.arrayBuffer())).metadata()).width, 480);
  const confirmed = JSON.stringify({ clientRequestId: randomUUID().replaceAll('-', ''),
    target: refs[0], bindingEpoch: 1, selectionRevision: '1', recordingId: recording.recordingId,
    text: '客户端替换正文不得采用' });
  const submitted = await fetch(`${base}/v1/device/messages`, { method: 'POST', headers, body: confirmed });
  assert.equal(submitted.status, 202, await submitted.clone().text());
  const accepted = (await submitted.json()).data;
  const submittedAgain = await fetch(`${base}/v1/device/messages`, { method: 'POST', headers, body: confirmed });
  assert.equal(submittedAgain.status, 202);
  assert.deepEqual((await submittedAgain.json()).data, accepted);
  const messageRead = await fetch(`${base}/v1/device/messages/${accepted.messageId}`, { headers });
  assert.equal(messageRead.status, 200);
  const storedMessage = (await messageRead.json()).data;
  assert.equal(storedMessage.text, ready.transcript, 'only the confirmed recording supplies message text');
  assert.deepEqual(storedMessage.target, refs[0]);
  const commands = await db.pool.query('SELECT * FROM hc_commands WHERE message_id=$1', [accepted.messageId]);
  assert.equal(commands.rowCount, 1, 'an HTTP retry must not generate a second command');
  const reopened = new PostgresStore(connection);
  try {
    const row = await reopened.pool.query('SELECT id,active_task_ref,selection_revision FROM hc_bindings WHERE id=$1', [binding.id]);
    assert.equal(row.rows[0]?.id, binding.id);
    assert.deepEqual(row.rows[0]?.active_task_ref, refs[0]);
    assert.equal(String(row.rows[0]?.selection_revision), '1');
  } finally { await reopened.close(); }
});

test('real PG email code is single-use and session hash survives a new database connection', async t => {
  const connection = process.env.COMPANION_PG_TEST_URL;
  assert.ok(connection);
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(connection).hostname));
  const db = new PostgresStore(connection);
  t.after(() => db.close());
  let deliveredCode = '';
  await new PgBusinessRepository(db).migrate();
  const server = createPgApp(db, { mailProvider: { send: async (_email: string, code: string) => { deliveredCode = code; } } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const email = `fixture-${randomUUID()}@example.test`;
  const post = (path: string, data: unknown) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const started = await post('/v1/auth/email/start', { email });
  assert.equal(started.status, 200);
  assert.match(deliveredCode, /^\d{6}$/);
  assert.ok(!(await started.text()).includes(deliveredCode), 'code must be delivered only by the injected mail provider');
  const verified = await post('/v1/auth/email/verify', { email, code: deliveredCode });
  assert.equal(verified.status, 200);
  const token = (await verified.json()).data.sessionToken;
  assert.ok(token);
  assert.equal((await post('/v1/connectors/register', { name: 'fixture', userId: 'forged' })).status, 401);
  const registered = await fetch(url + '/v1/connectors/register', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'fixture', userId: 'forged' }),
  });
  assert.equal(registered.status, 200);
  const connector = (await registered.json()).data;
  assert.ok(connector.connectorId && connector.token);
  const storedConnector = await db.pool.query('SELECT email,token_hash FROM hc_connectors WHERE id=$1', [connector.connectorId]);
  assert.equal(storedConnector.rows[0].email, email, 'caller-supplied userId must not determine ownership');
  assert.equal(storedConnector.rows[0].token_hash, createHash('sha256').update(connector.token).digest('hex'));
  const managementRepo = new PgBusinessRepository(db);
  const deviceId = 'managed-' + randomUUID(), deviceToken = randomUUID();
  const managed = await managementRepo.createBinding('synthetic-user', connector.connectorId, deviceId, deviceToken);
  const managementHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const grantedRef = { connectorId: connector.connectorId, projectId: 'grant-project-' + randomUUID(), threadId: 'grant-task-' + randomUUID() };
  await db.pool.query("INSERT INTO projects VALUES($1,$2,'授权项目','local')", [grantedRef.connectorId, grantedRef.projectId]);
  await db.pool.query("INSERT INTO tasks VALUES($1,$2,$3,'授权任务','idle',1,now())", [grantedRef.connectorId, grantedRef.threadId, grantedRef.projectId]);
  const grantsPath = `${url}/v1/bindings/${managed.id}/task-grants`;
  const initialGrants = await fetch(grantsPath, { headers: managementHeaders });
  assert.equal(initialGrants.status, 200);
  assert.deepEqual((await initialGrants.json()).data, { grantsVersion: '0', grants: [] });
  const grantBody = JSON.stringify({ grants: [grantedRef], expectedGrantsVersion: '0', clientRequestId: randomUUID().replaceAll('-', '') });
  const grantResponse = await fetch(grantsPath, { method: 'PUT', headers: managementHeaders, body: grantBody });
  assert.equal(grantResponse.status, 200);
  const grantResult = (await grantResponse.json()).data;
  assert.equal(grantResult.grantsVersion, '1');
  const grantRetry = await fetch(grantsPath, { method: 'PUT', headers: managementHeaders, body: grantBody });
  assert.equal(grantRetry.status, 200); assert.deepEqual((await grantRetry.json()).data, grantResult);
  assert.equal((await fetch(grantsPath, { headers: { authorization: `Bearer ${deviceToken}` } })).status, 401);
  const visibleTasks = await fetch(`${url}/v1/device/tasks?projectId=${grantedRef.projectId}`, { headers: { authorization: `Bearer ${deviceToken}` } });
  assert.equal(visibleTasks.status, 200);
  assert.equal((await visibleTasks.json()).data.items[0].threadId, grantedRef.threadId);
  const selectedByConnector = await fetch(`${url}/v1/device/selection`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${connector.token}` },
    body: JSON.stringify({ bindingId: managed.id, target: grantedRef, expectedSelectionRevision: '0', clientRequestId: randomUUID().replaceAll('-', '') }),
  });
  assert.equal(selectedByConnector.status, 200);
  assert.equal((await selectedByConnector.json()).data.selectionRevision, '1');
  const devicesAfterSelect = await fetch(`${url}/v1/devices`, { headers: managementHeaders });
  const managedAfterSelect = (await devicesAfterSelect.json()).data.find((d: any) => d.bindingId === managed.id);
  assert.equal(managedAfterSelect.selectionRevision, '1');
  assert.deepEqual(managedAfterSelect.activeTaskRef, grantedRef);
  const renamed = await fetch(`${url}/v1/devices/${deviceId}`, { method: 'PATCH', headers: managementHeaders,
    body: JSON.stringify({ name: '随身提醒器', clientRequestId: randomUUID().replaceAll('-', '') }) });
  assert.equal(renamed.status, 200);
  const listed = await fetch(`${url}/v1/devices`, { headers: managementHeaders });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).data.find((d: any) => d.deviceId === deviceId)?.name, '随身提醒器');
  const revokeBody = JSON.stringify({ clientRequestId: randomUUID().replaceAll('-', '') });
  const revoked = await fetch(`${url}/v1/bindings/${managed.id}`, { method: 'DELETE', headers: managementHeaders, body: revokeBody });
  assert.equal(revoked.status, 200);
  const revokedData = (await revoked.json()).data;
  assert.equal(revokedData.epoch, 2);
  const revokedAgain = await fetch(`${url}/v1/bindings/${managed.id}`, { method: 'DELETE', headers: managementHeaders, body: revokeBody });
  assert.equal(revokedAgain.status, 200);
  assert.deepEqual((await revokedAgain.json()).data, revokedData);
  assert.equal((await fetch(`${url}/v1/device/projects`, { headers: { authorization: `Bearer ${deviceToken}` } })).status, 401);
  assert.equal((await post('/v1/auth/email/verify', { email, code: deliveredCode })).status, 401);
  const reopened = new PostgresStore(connection);
  try {
    const row = await reopened.pool.query('SELECT session_hash FROM hc_auth WHERE email=$1', [email]);
    assert.equal(row.rows[0].session_hash, createHash('sha256').update(token).digest('hex'));
  } finally { await reopened.close(); }
});
