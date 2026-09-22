import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionDaemon } from '../src/daemon.js';
import { ExecutionLedger } from '../src/ledger.js';

const adapter = (status = 'idle', enqueued: string[] = []) => ({
  readIdentity: async () => ({ available: true, fingerprint: 'fixture' }),
  readThread: async (threadId: string) => ({ threadId, cwd: '/fixture', status, turns: [], resultRevision: '1', raw: {} }),
  enqueue: async (_threadId: string, text: string) => { enqueued.push(text); return { accepted: true, status: 'queued', queueId: text }; },
  close: async () => {},
});

test('delayed ledger restore completes before dispatch and blocks dispatching task', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hc-daemon-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let release!: (rows: any[]) => void; const restored = new Promise<any[]>(resolve => { release = resolve; }); const enqueued: string[] = [];
  const daemon = new CompanionDaemon({ connectionEpoch: '1', commandSource: async () => [{ commandId: 'b' }], client: { claim: async () => ({ executionState: 'claimed', commandId: 'b', executionId: 'eb', messageId: 'mb', text: 'new-b', target: { threadId: 'task-a', projectId: 'p' } }) } as any, ledger: { list: async () => restored, find: async () => undefined, begin: async () => ({ executionId: 'eb' }), update: async () => {} } as any, adapter: adapter('idle', enqueued) as any });
  const tick = daemon.tick(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(enqueued, []); release([{ state: 'dispatching', threadId: 'task-a', executionId: 'old', messageId: 'old-message', text: 'old' }]); await tick; assert.deepEqual(enqueued, []);
});

test('waiting_turn survives restart and sends only after re-claim becomes eligible', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hc-daemon-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, 'ledger.json'); await writeFile(ledgerPath, JSON.stringify([{ executionId: 'ew', messageId: 'mw', commandId: 'cw', threadId: 'task', projectId: 'p', text: 'wait', bodyHash: 'x', originalCwd: '/fixture', state: 'waiting_turn', baselineRevision: '1', createdAt: '', updatedAt: '' }]));
  let claims = 0; const enqueued: string[] = []; const daemon = new CompanionDaemon({ connectionEpoch: '1', commandSource: async () => [], client: { claim: async () => ({ executionState: claims++ === 0 ? 'waiting_turn' : 'claimed', commandId: 'cw', executionId: 'ew', messageId: 'mw', text: 'wait', target: { threadId: 'task', projectId: 'p' } }) } as any, ledger: new ExecutionLedger(ledgerPath), adapter: adapter('idle', enqueued) as any });
  await daemon.tick(); await daemon.tick(); assert.deepEqual(enqueued, ['wait']);
});

test('revoked or otherwise unauthorized waiting target is never enqueued', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hc-daemon-')); t.after(() => rm(dir, { recursive: true, force: true })); const enqueued: string[] = [];
  const daemon = new CompanionDaemon({ connectionEpoch: '1', commandSource: async () => [{ commandId: 'x' }], client: { claim: async () => ({ executionState: 'claimed', commandId: 'x', executionId: 'ex', messageId: 'mx', text: 'blocked', target: { threadId: 'task', projectId: 'p' } }) } as any, ledger: new ExecutionLedger(join(dir, 'ledger.json')), adapter: adapter('idle', enqueued) as any, isAuthorizedTarget: async () => false });
  await daemon.tick(); assert.deepEqual(enqueued, []);
});
