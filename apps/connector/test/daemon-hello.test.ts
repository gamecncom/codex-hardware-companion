import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CompanionDaemon } from '../src/daemon.js';

class FixtureTransport extends EventEmitter {
  sent: any[] = [];
  connect() { queueMicrotask(() => this.emit('open')); }
  send(value: any) { this.sent.push(value); }
  close() {}
}

function daemon(transport: FixtureTransport, detect: () => Promise<any>) {
  return new CompanionDaemon({
    connectionEpoch: '1', transport: transport as any,
    client: { claim: async () => undefined } as any,
    ledger: { list: async () => [], find: async () => undefined } as any,
    adapter: { detect, readIdentity: async () => ({ available: true, fingerprint: 'fixture' }), close: async () => {}, readThread: async () => ({ cwd: '/fixture', status: 'idle', turns: [] }) } as any,
  });
}

test('connector hello uploads only public detected capabilities after connect', async t => {
  const transport = new FixtureTransport(); const instance = daemon(transport, async () => ({ list: true, read: true, enqueue: false, accountContextDetection: false, nativeApproval: false, version: '0.154.0' }));
  t.after(() => instance.stop()); instance.start();
  for (let i = 0; i < 20 && !transport.sent.some(item => item.type === 'connector.hello'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  const hello = transport.sent.find(item => item.type === 'connector.hello');
  assert.deepEqual(hello.payload.capabilities, { list: true, read: true, enqueue: false, accountContextDetection: false, nativeApproval: false, version: '0.154.0' });
  assert.equal(JSON.stringify(hello).includes('binary'), false);
});

test('failed capability detection reports unknown and never claims native approval', async t => {
  const transport = new FixtureTransport(); const instance = daemon(transport, async () => { throw new Error('probe failed'); });
  t.after(() => instance.stop()); instance.start();
  for (let i = 0; i < 20 && !transport.sent.some(item => item.type === 'connector.hello'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  const capabilities = transport.sent.find(item => item.type === 'connector.hello').payload.capabilities;
  assert.deepEqual(capabilities, { list: 'unknown', read: 'unknown', enqueue: 'unknown', accountContextDetection: 'unknown', nativeApproval: false, version: 'unknown' });
});

test('hello is sent once per transport open and welcome does not create a hello loop', async t => {
  const transport = new FixtureTransport(); const instance = daemon(transport, async () => ({ list: true, read: true, enqueue: true, accountContextDetection: true, version: 'v' }));
  t.after(() => instance.stop()); instance.start();
  for (let i = 0; i < 20 && transport.sent.filter(item => item.type === 'connector.hello').length < 1; i++) await new Promise(resolve => setTimeout(resolve, 5));
  transport.emit('message', { type: 'connector.welcome', payload: { connectionEpoch: '2' } });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(transport.sent.filter(item => item.type === 'connector.hello').length, 1);
  transport.emit('open');
  for (let i = 0; i < 20 && transport.sent.filter(item => item.type === 'connector.hello').length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(transport.sent.filter(item => item.type === 'connector.hello').length, 2);
});
