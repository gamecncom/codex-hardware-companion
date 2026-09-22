import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudGrants } from '../src/cloudGrants.js';

test('cloud grants are runtime-only, scoped to active bindings of this connector, and converge on revoke', async () => {
  let revoked = false;
  const client = {
    devices: async () => [
      { bindingId: 'b-current', connectorId: 'cn-current', state: 'active' },
      { bindingId: 'b-other-connector', connectorId: 'cn-other', state: 'active' },
      { bindingId: 'b-revoked', connectorId: 'cn-current', state: 'revoked' },
    ],
    grants: async (bindingId: string) => bindingId === 'b-current' && !revoked ? { grants: [{ connectorId: 'cn-current', projectId: 'p', threadId: 't' }, { connectorId: 'cn-other', projectId: 'other', threadId: 'x' }] } : { grants: [] },
  } as any;
  const cloud = new CloudGrants(client, 'cn-current');
  await cloud.refresh();
  assert.equal(cloud.isAuthorized({ connectorId: 'cn-current', projectId: 'p', threadId: 't' }), true);
  assert.equal(cloud.isAuthorized({ connectorId: 'cn-other', projectId: 'other', threadId: 'x' }), false);
  revoked = true; await cloud.refresh();
  assert.equal(cloud.isAuthorized({ connectorId: 'cn-current', projectId: 'p', threadId: 't' }), false);
});

test('failed cloud refresh clears old grants and exposes unavailable state', async () => {
  let fail = false;
  const cloud = new CloudGrants({ devices: async () => { if (fail) throw new Error('NETWORK_DOWN'); return [{ bindingId: 'b', connectorId: 'cn', state: 'active' }]; }, grants: async () => ({ grants: [{ connectorId: 'cn', projectId: 'p', threadId: 't' }] }) } as any, 'cn');
  await cloud.refresh(); fail = true; await assert.rejects(() => cloud.refresh(), /NETWORK_DOWN/);
  assert.equal(cloud.snapshot().state, 'unavailable'); assert.equal(cloud.isAuthorized({ connectorId: 'cn', projectId: 'p', threadId: 't' }), false); assert.deepEqual(cloud.snapshot().grants, []);
});
