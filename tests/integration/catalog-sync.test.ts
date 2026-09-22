import test from 'node:test';
import assert from 'node:assert/strict';
import { CatalogSync } from '../../apps/connector/src/catalogSync.js';

function setup() {
  const calls: Array<string | undefined> = [];
  const events: any[] = [];
  const thread = (id: string) => ({ threadId: id, cwd: '/fixture/project', title: id, titleSource: 'codex', status: 'completed' });
  const adapter = {
    listThreads: async (cursor?: string) => {
      calls.push(cursor);
      return cursor ? { data: [thread('second')] } : { data: [thread('first')], nextCursor: 'next-page' };
    },
    readThread: async (threadId: string) => ({
      threadId, cwd: '/fixture/project', status: 'completed',
      turns: [{ id: 'turn-' + threadId, status: 'completed', items: [
        { type: 'userMessage', content: [{ type: 'text', text: '请继续' }] },
        { type: 'agentMessage', text: '真实结构回复正文' },
      ] }],
    }),
  };
  const sync = new CatalogSync(adapter as any, { send: (event: any) => events.push(event) } as any,
    [{ projectId: 'project', name: '项目', root: '/fixture/project' }] as any, () => true);
  return { sync, calls, events };
}

test('catalog sync consumes every thread/list cursor', async () => {
  const { sync, calls } = setup();
  await sync.sync();
  assert.deepEqual(calls, [undefined, 'next-page']);
});

test('authorized task snapshot includes assistant text from Codex turn.items', async () => {
  const { sync, events } = setup();
  await sync.sync();
  const snapshot = events.find(e => e.type === 'task.snapshot');
  assert.ok(snapshot, 'authorized task must emit a snapshot');
  assert.ok(JSON.stringify(snapshot.payload).includes('真实结构回复正文'), 'snapshot must carry the actual assistant response');
});
