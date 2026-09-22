import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPgApp } from '../../apps/saas/src/pg-app.js';

// HTTP boundary regression only. A synthetic query result is not PostgreSQL acceptance.
async function fixture(t: any) {
  const server = createPgApp({ pool: { query: async () => ({ rows: [], rowCount: 0 }) } } as any);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('PG HTTP rejects nonempty token absent from bindings', async t => {
  const url = await fixture(t);
  const response = await fetch(`${url}/v1/device/projects`, { headers: { authorization: 'Bearer unknown-token' } });
  assert.equal(response.status, 401);
});

test('PG HTTP rejects invalid page limits before database access', async t => {
  const url = await fixture(t);
  for (const limit of ['-1', '0', 'NaN', '1.5']) {
    const response = await fetch(`${url}/v1/device/projects?limit=${limit}`, { headers: { authorization: 'Bearer example-token' } });
    assert.equal(response.status, 400, limit);
  }
});
