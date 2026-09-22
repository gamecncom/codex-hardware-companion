import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../../apps/saas/src/app.js';
import { CompanionService } from '../../apps/saas/src/service.js';
import WebSocket from 'ws';

const rid = (n: number) => n.toString(16).padStart(32, '0');
async function fixture(t: any) {
  const service = new CompanionService();
  const user = service.store.addUser('integration@example.test');
  const { connector } = service.register(user.id);
  const { device } = service.createDevice();
  const binding = service.bind(user.id, connector.id, device.id, rid(1));
  const app = createApp(service);
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise<void>(resolve => app.server.close(() => resolve()));
  });
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  return { service, user, connector, binding, url: `http://127.0.0.1:${address.port}` };
}

test('production HTTP does not expose test-user creation even with attacker-supplied test header', async t => {
  const { url } = await fixture(t);
  const response = await fetch(`${url}/v1/test/users`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-mode': '1' },
    body: JSON.stringify({ email: 'attacker@example.test' }),
  });
  assert.equal(response.status, 404);
});

test('user ID header is not a login credential', async t => {
  const { url, user, binding } = await fixture(t);
  const response = await fetch(`${url}/v1/bindings/${binding.id}/task-grants`, {
    headers: { 'x-user-id': user.id },
  });
  assert.ok([401, 403].includes(response.status), `expected denial, got ${response.status}`);
});

test('device token cannot edit task grants', async t => {
  const { url, binding } = await fixture(t);
  const response = await fetch(`${url}/v1/bindings/${binding.id}/task-grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${binding.deviceToken}` },
    body: JSON.stringify({ grants: [], expectedGrantsVersion: '0', clientRequestId: rid(2) }),
  });
  assert.ok([401, 403].includes(response.status), `expected denial, got ${response.status}`);
});

test('anonymous caller cannot mint a connector for a known user', async t => {
  const { url, user } = await fixture(t);
  const response = await fetch(`${url}/v1/connectors/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: user.id, name: 'untrusted' }),
  });
  assert.ok([401, 403].includes(response.status), `expected denial, got ${response.status}`);
});

test('connector ID alone cannot authenticate the WebSocket channel', async t => {
  const { url, connector } = await fixture(t);
  const result = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(`${url.replace('http:', 'ws:')}/v1/connectors/channel?connectorId=${encodeURIComponent(connector.id)}`);
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error('handshake did not settle')); }, 3000);
    const finish = (outcome: string) => { clearTimeout(timeout); ws.terminate(); resolve(outcome); };
    ws.once('open', () => finish('accepted'));
    ws.once('error', () => finish('rejected'));
    ws.once('unexpected-response', (_request, response) => { response.resume(); finish('rejected'); });
  });
  assert.equal(result, 'rejected');
});

test('production email login never accepts the fixed development code', async t => {
  const { url } = await fixture(t);
  const headers = { 'content-type': 'application/json' };
  await fetch(`${url}/v1/auth/email/start`, {
    method: 'POST', headers, body: JSON.stringify({ email: 'fixed-code@example.test' }),
  });
  const response = await fetch(`${url}/v1/auth/email/verify`, {
    method: 'POST', headers, body: JSON.stringify({ email: 'fixed-code@example.test', code: '000000' }),
  });
  assert.ok(response.status >= 400, `fixed development code accepted with status ${response.status}`);
});
