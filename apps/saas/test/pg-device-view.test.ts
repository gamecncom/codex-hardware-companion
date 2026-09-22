import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { PostgresStore } from '../src/pg-store.js';
import { PgBusinessRepository } from '../src/pg-repository.js';
import { createDeviceView, migrateDeviceViews, readDeviceJpeg } from '../src/pg-device-view.js';

test('PG device views are immutable JPEGs and isolated by binding', async (t) => {
  const url = process.env.COMPANION_PG_TEST_URL;
  if (!url) return t.skip('COMPANION_PG_TEST_URL not set');
  const db = new PostgresStore(url), repo = new PgBusinessRepository(db);
  await repo.migrate();
  await migrateDeviceViews(db);
  const suffix = Date.now().toString(36), connector = `view-connector-${suffix}`, project = `view-project-${suffix}`;
  const tokenA = `view-token-a-${suffix}`, tokenB = `view-token-b-${suffix}`;
  await db.pool.query("INSERT INTO hc_bindings(id,user_id,device_id,connector_id,epoch,state,device_token) VALUES($1,$2,$3,$4,1,'active',$5),($6,$7,$8,$4,1,'active',$9)", [`bind-view-a-${suffix}`, `user-a-${suffix}`, `device-a-${suffix}`, connector, tokenA, `bind-view-b-${suffix}`, `user-b-${suffix}`, `device-b-${suffix}`, tokenB]);
  await db.pool.query('INSERT INTO projects(connector_id,project_id,name,source) VALUES($1,$2,$3,$4)', [connector, project, '中文项目', 'codex']);
  await db.pool.query('INSERT INTO tasks(connector_id,project_id,thread_id,title,status,revision,updated_at) VALUES($1,$2,$3,$4,$5,$6,now()),($1,$2,$7,$8,$5,$6,now())', [connector, project, `thread-a-${suffix}`, '第一条任务', 'completed', 1, `thread-b-${suffix}`, '第二条任务']);
  await db.pool.query('INSERT INTO hc_grants(binding_id,connector_id,project_id,thread_id) VALUES($1,$2,$3,$4),($1,$2,$3,$5),($6,$2,$3,$4),($6,$2,$3,$5)', [`bind-view-a-${suffix}`, connector, project, `thread-a-${suffix}`, `thread-b-${suffix}`, `bind-view-b-${suffix}`]);
  for (let i = 2; i < 7; i++) {
    const thread = `thread-${i}-${suffix}`;
    await db.pool.query('INSERT INTO tasks(connector_id,project_id,thread_id,title,status,revision,updated_at) VALUES($1,$2,$3,$4,$5,$6,now())', [connector, project, thread, `第${i + 1}条任务`, 'running', i + 1]);
    await db.pool.query('INSERT INTO hc_grants(binding_id,connector_id,project_id,thread_id) VALUES($1,$2,$3,$4),($5,$2,$3,$4)', [`bind-view-a-${suffix}`, connector, project, thread, `bind-view-b-${suffix}`]);
  }
  t.after(() => db.close());
  const first = await createDeviceView(db, tokenA, { kind: 'tasks', projectId: project, choice: 0, limit: 5 });
  assert.ok(first.nextCursor);
  const second = await createDeviceView(db, tokenA, { kind: 'tasks', projectId: project, choice: 1, limit: 5 });
  const nextPage = await createDeviceView(db, tokenA, { kind: 'tasks', projectId: project, choice: 0, cursor: first.nextCursor, limit: 5 });
  assert.equal(nextPage.items.length, 2);
  const bytes = await readDeviceJpeg(db, tokenA, first.viewId);
  assert.deepEqual(await readDeviceJpeg(db, tokenA, first.viewId), bytes);
  assert.notDeepEqual(bytes, await readDeviceJpeg(db, tokenA, second.viewId));
  assert.notDeepEqual(bytes, await readDeviceJpeg(db, tokenA, nextPage.viewId));
  assert.equal((await sharp(bytes).metadata()).format, 'jpeg');
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.width, 480);
  assert.equal(metadata.height, 320);
  assert.ok(bytes.byteLength <= 150 * 1024);
  await assert.rejects(() => readDeviceJpeg(db, tokenB, first.viewId), /UNAUTHORIZED/);
});
