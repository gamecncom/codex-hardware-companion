import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanionDaemon } from '../../apps/connector/src/daemon.js';

test('server execution already queued or terminal is never enqueued again without a local ledger', async () => {
  for (const executionState of ['queued', 'running', 'completed', 'failed', 'uncertain']) {
    let enqueues = 0;
    const daemon = new CompanionDaemon({
      connectionEpoch: '1',
      commandSource: async () => [{ commandId: 'cmd' }],
      client: { claim: async () => ({ executionState, commandId: 'cmd', executionId: 'exec', messageId: 'msg',
        target: { connectorId: 'cn', projectId: 'pr', threadId: 'thread' }, text: 'fixture' }) } as any,
      adapter: {
        readIdentity: async () => ({ available: true, fingerprint: 'fixture' }),
        readThread: async () => ({ cwd: '/fixture', turns: [] }),
        enqueue: async () => { enqueues++; return { accepted: true, status: 'queued' }; },
      } as any,
      ledger: { find: async () => undefined, begin: async () => ({ executionId: 'exec' }), update: async () => {} } as any,
    });
    await daemon.tick();
    assert.equal(enqueues, 0, executionState);
  }
});
