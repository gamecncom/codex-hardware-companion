import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionDaemon } from '../../apps/connector/src/daemon.js';
import { ExecutionLedger } from '../../apps/connector/src/ledger.js';

test('an unresolved dispatching execution blocks its task after restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hc-restart-dispatch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = new ExecutionLedger(join(dir, 'ledger.json'));
  await ledger.begin('old-msg', 'task-a', 'old text', '/synthetic', 'old-exec', 'p', '', undefined, 'old-cmd');
  const enqueued: string[] = [];
  const daemon = new CompanionDaemon({
    connectionEpoch: '2', ledger,
    commandSource: async () => [{ commandId: 'new-a' }, { commandId: 'new-b' }],
    client: { claim: async (id: string) => ({ executionState: 'claimed', commandId: id, executionId: `exec-${id}`,
      messageId: `msg-${id}`, text: id, target: { connectorId: 'cn', projectId: 'p', threadId: id === 'new-a' ? 'task-a' : 'task-b' } }) } as any,
    adapter: {
      readIdentity: async () => ({ available: true, fingerprint: 'synthetic' }),
      readThread: async (threadId: string) => ({ threadId, cwd: '/synthetic', status: 'idle', turns: [], raw: {} }),
      enqueue: async (_id: string, text: string) => { enqueued.push(text); return { accepted: true, status: 'queued' }; },
    } as any,
  });
  await daemon.tick();
  assert.deepEqual(enqueued, ['new-b'], 'unknown previous dispatch must not be overtaken after restart');
});

test('hardware commands serialize within a task while another task can proceed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hc-serial-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const commands = ['a1', 'a2', 'b1'];
  const enqueued: string[] = [];
  const daemon = new CompanionDaemon({
    connectionEpoch: '1',
    commandSource: async () => commands.map(commandId => ({ commandId })),
    client: { claim: async (id: string) => ({ executionState: 'claimed', commandId: id,
      executionId: `exec-${id}`, messageId: `msg-${id}`, text: id,
      target: { connectorId: 'cn', projectId: 'project', threadId: id.startsWith('a') ? 'task-a' : 'task-b' } }) } as any,
    ledger: new ExecutionLedger(join(dir, 'ledger.json')),
    adapter: {
      readIdentity: async () => ({ available: true, fingerprint: 'synthetic' }),
      readThread: async (threadId: string) => ({ threadId, cwd: '/synthetic', status: 'idle', turns: [], raw: {} }),
      enqueue: async (_threadId: string, text: string) => { enqueued.push(text); return { accepted: true, status: 'queued', queueId: text }; },
    } as any,
  });
  await daemon.tick();
  assert.deepEqual(enqueued, ['a1', 'b1'], 'second same-task message must wait for the first execution');
});

test('a hardware message waits for a desktop turn and dispatches once when idle', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hc-desktop-busy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let desktopBusy = true;
  let serverExecutionState = 'claimed';
  let enqueues = 0;
  const events: string[] = [];
  const daemon = new CompanionDaemon({
    connectionEpoch: '1',
    commandSource: async () => [{ commandId: 'cmd' }],
    client: { claim: async () => ({ executionState: serverExecutionState, commandId: 'cmd', executionId: 'exec',
      messageId: 'msg', text: 'hardware text', target: { connectorId: 'cn', projectId: 'p', threadId: 't' } }) } as any,
    ledger: new ExecutionLedger(join(dir, 'ledger.json')),
    adapter: {
      readIdentity: async () => ({ available: true, fingerprint: 'synthetic' }),
      readThread: async () => ({ threadId: 't', cwd: '/synthetic', status: desktopBusy ? 'running' : 'completed',
        turns: [{ id: 'desktop-turn', status: desktopBusy ? 'inProgress' : 'completed',
          items: [{ type: 'userMessage', text: 'desktop text' }] }], raw: {} }),
      enqueue: async () => { enqueues++; return { accepted: true, status: 'queued', queueId: 'q' }; },
    } as any,
    transport: { send: (event: any) => {
      events.push(event.type);
      if (event.type === 'command.waiting_turn') serverExecutionState = 'waiting_turn';
      if (event.type === 'command.queued') serverExecutionState = 'queued';
    } } as any,
  });
  await daemon.tick();
  assert.equal(enqueues, 0, 'desktop running turn must not receive a simultaneous enqueue');
  assert.ok(events.includes('command.waiting_turn'));
  desktopBusy = false;
  await daemon.tick();
  await daemon.tick();
  assert.equal(enqueues, 1, 'waiting hardware message dispatches once after the desktop finishes');
});
