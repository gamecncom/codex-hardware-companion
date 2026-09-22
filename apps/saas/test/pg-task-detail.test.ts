import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresStore } from '../src/pg-store.js';
import { PgBusinessRepository } from '../src/pg-repository.js';
import { getTaskDetail } from '../src/pg-task-detail.js';

test('PG task detail exposes only the exact granted task with decimal revision and result pages', async t => {
  const url = process.env.COMPANION_PG_TEST_URL;
  if (!url) return t.skip('COMPANION_PG_TEST_URL not set');
  const db = new PostgresStore(url);
  const repo = new PgBusinessRepository(db);
  await repo.migrate();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const connector = `detail-connector-${suffix}`;
  const binding = `detail-binding-${suffix}`;
  const otherBinding = `detail-other-binding-${suffix}`;
  const project = `detail-project-${suffix}`;
  const otherProject = `detail-other-project-${suffix}`;
  const thread = `detail-thread-${suffix}`;
  const otherThread = `detail-other-thread-${suffix}`;
  const token = `detail-token-${suffix}`;
  const otherToken = `detail-other-token-${suffix}`;
  const lines = Array.from({ length: 17 }, (_, i) => `result line ${i + 1}`).join('\n');
  await db.pool.query('INSERT INTO hc_connectors(id,email,name,token_hash) VALUES($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING', [connector, `detail-${suffix}@test.invalid`, 'detail', '0'.repeat(64)]);
  await db.pool.query(`INSERT INTO hc_bindings(id,user_id,device_id,connector_id,epoch,state,selection_revision,grants_version,device_token)
    VALUES($1,'detail-user',$2,$3,1,'active',0,0,$4) ON CONFLICT (id) DO UPDATE SET state='active',device_token=$4`, [binding, `detail-device-${suffix}`, connector, token]);
  await db.pool.query(`INSERT INTO hc_bindings(id,user_id,device_id,connector_id,epoch,state,selection_revision,grants_version,device_token)
    VALUES($1,'detail-user-2',$2,$3,1,'active',0,0,$4) ON CONFLICT (id) DO UPDATE SET state='active',device_token=$4`, [otherBinding, `detail-device-2-${suffix}`, connector, otherToken]);
  await db.pool.query('INSERT INTO projects(connector_id,project_id,name,source) VALUES($1,$2,$3,$4),($1,$5,$3,$4) ON CONFLICT DO NOTHING', [connector, project, 'same title project', 'local', otherProject]);
  await db.pool.query(`INSERT INTO tasks(connector_id,thread_id,project_id,title,status,revision,updated_at)
    VALUES($1,$2,$3,'same title','completed',37,now()),($1,$4,$5,'same title','failed',4,now())
    ON CONFLICT (connector_id,thread_id) DO UPDATE SET project_id=EXCLUDED.project_id,title=EXCLUDED.title,status=EXCLUDED.status,revision=EXCLUDED.revision`, [connector, thread, project, otherThread, otherProject]);
  await db.pool.query('INSERT INTO hc_grants(binding_id,connector_id,project_id,thread_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [binding, connector, project, thread]);
  await db.pool.query(`INSERT INTO hc_task_results(connector_id,project_id,thread_id,result_revision,last_turn_id,status,result_text,summary)
    VALUES($1,$2,$3,'provider-hash','turn-37','completed',$4,'summary')
    ON CONFLICT (connector_id,project_id,thread_id) DO UPDATE SET result_text=EXCLUDED.result_text,status=EXCLUDED.status`, [connector, project, thread, lines]);
  t.after(async () => { await db.pool.query('DELETE FROM hc_task_results WHERE connector_id=$1', [connector]); await db.pool.query('DELETE FROM hc_grants WHERE binding_id IN ($1,$2)', [binding, otherBinding]); await db.pool.query('DELETE FROM tasks WHERE connector_id=$1', [connector]); await db.pool.query('DELETE FROM projects WHERE connector_id=$1', [connector]); await db.pool.query('DELETE FROM hc_bindings WHERE id IN ($1,$2)', [binding, otherBinding]); await db.pool.query('DELETE FROM hc_connectors WHERE id=$1', [connector]); await db.close(); });

  const detail = await getTaskDetail(db, token, thread, project);
  assert.deepEqual(detail.target, { connectorId: connector, projectId: project, threadId: thread });
  assert.equal(detail.title, 'same title');
  assert.equal(detail.status, 'completed');
  assert.equal(detail.resultRevision, '37');
  assert.equal(detail.pageCount, 3);
  assert.equal(detail.capabilities.list, 'unknown');
  assert.equal(detail.capabilities.enqueue, 'unknown');
  assert.equal(detail.capabilities.nativeApproval, false);
  assert.equal(detail.capabilities.canSend, 'unknown');
  await assert.rejects(() => getTaskDetail(db, token, thread, otherProject), /TARGET_NOT_GRANTED/);
  await assert.rejects(() => getTaskDetail(db, otherToken, thread, project), /TARGET_NOT_GRANTED/);
  await assert.rejects(() => getTaskDetail(db, token, otherThread, project), /TARGET_NOT_GRANTED/);
});
