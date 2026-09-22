import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CompanionDaemon } from '../../apps/connector/src/daemon.js';

test('default daemon consumes command.available without an injected commandSource', async t => {
  class Transport extends EventEmitter {
    connect() { queueMicrotask(() => this.emit('open')); }
    send(_value: unknown) {}
    close() {}
  }
  const transport = new Transport();
  const claims: string[] = [];
  const target = { connectorId: 'connector-test', projectId: 'project-test', threadId: 'thread-test' };
  const daemon = new CompanionDaemon({
    transport: transport as any,
    connectionEpoch: '1', pollMs: 20,
    client: { claim: async (commandId: string) => {
      claims.push(commandId);
      return { commandId, messageId: 'message-test', executionId: 'execution-test', target, text: 'test', state: 'claimed' };
    } } as any,
    adapter: {
      readThread: async () => ({ threadId: target.threadId, cwd: '/tmp', status: 'idle', turns: [] }),
      readIdentity: async () => ({ available: true, fingerprint: 'test' }),
      enqueue: async () => ({ accepted: true, status: 'queued', queueId: 'queue-test' }),
      close: async () => {},
    } as any,
    ledger: {
      list: async () => [],
      find: async () => undefined,
      begin: async () => ({ executionId: 'execution-test' }),
      update: async () => {},
    } as any,
  });
  t.after(() => daemon.stop());
  daemon.start();
  await new Promise(resolve => setImmediate(resolve));
  transport.emit('message', { protocol: 'hc/1', type: 'connector.welcome', payload: { connectionEpoch: '2' } });
  transport.emit('message', { protocol: 'hc/1', type: 'command.available', payload: { commandId: 'command-test' } });
  for (let i = 0; i < 20 && claims.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(claims, ['command-test']);
});
