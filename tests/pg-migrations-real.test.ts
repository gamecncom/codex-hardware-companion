import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresStore } from '../apps/saas/src/pg-store.js';
import { PgBusinessRepository } from '../apps/saas/src/pg-repository.js';

test('two startup migrations succeed against one entirely fresh PG schema', async t => {
  const connection = process.env.COMPANION_PG_TEST_URL;
  assert.ok(connection && ['127.0.0.1', 'localhost'].includes(new URL(connection).hostname));
  const admin = new PostgresStore(connection);
  const schema = 'hc_migration_' + randomUUID().replaceAll('-', '');
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(connection);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const first = new PostgresStore(url.toString()), second = new PostgresStore(url.toString());
  t.after(async () => {
    await first.close(); await second.close();
    // Only this test's randomly named synthetic schema is removed.
    await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.close();
  });
  await Promise.all([new PgBusinessRepository(first).migrate(), new PgBusinessRepository(second).migrate()]);
  const tables = await first.pool.query('SELECT tablename FROM pg_tables WHERE schemaname=$1', [schema]);
  for (const name of ['hc_bindings', 'hc_connectors', 'hc_device_pairings', 'hc_connector_logins',
    'hc_device_views', 'hc_connector_channel_state', 'hc_device_names']) {
    assert.ok(tables.rows.some(row => row.tablename === name), name);
  }
});
