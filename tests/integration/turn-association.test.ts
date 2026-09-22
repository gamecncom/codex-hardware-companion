import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanionDaemon } from '../../apps/connector/src/daemon.js';

test('desktop text containing hardware text is not the hardware turn', async () => {
  const states: string[] = [];
  let read = 0;
  const snapshot = (id: string, text: string) => ({ threadId: 'thread', cwd: '/fixture', status: 'completed',
    turns: [{ id, status: 'completed', items: [
      { type: 'userMessage', content: [{ type: 'text', text }] },
      { type: 'agentMessage', text: '电脑消息的回复' },
    ] }], raw: {} });
  const daemon = new CompanionDaemon({
    connectionEpoch: '1',
    commandSource: async () => [{ commandId: 'command' }],
    client: { claim: async () => ({ commandId: 'command', executionId: 'execution', messageId: 'message',
      target: { connectorId: 'connector', projectId: 'project', threadId: 'thread' }, text: '好' }) } as any,
    adapter: {
      readIdentity: async () => ({ available: true, fingerprint: 'fixture' }),
      readThread: async () => ++read === 1 ? snapshot('baseline', '原消息') : snapshot('desktop-turn', '不好'),
      enqueue: async () => ({ accepted: true, status: 'queued', queueId: 'queue' }),
    } as any,
    ledger: { find: async () => undefined,
      begin: async () => ({ executionId: 'execution' }),
      update: async (_id: string, patch: any) => states.push(patch.state),
    } as any,
    transport: { send: () => {} } as any,
    isAuthorizedTarget: () => true,
  });
  await daemon.tick();
  assert.deepEqual(states, ['queued'], 'another user message must not complete the hardware execution');
});
