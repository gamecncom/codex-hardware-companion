import test from 'node:test';
import assert from 'node:assert/strict';
import { CatalogSync } from '../src/catalogSync.js';
import { addMapping } from '../src/projectMapping.js';

test('deduplicates a thread repeated across catalog pages using latest updatedAt', async () => {
  const messages:any[] = [];
  const adapter:any = {
    pages: [
      { data: [{ threadId: 'thread-a', title: 'old', titleSource: 'codex', cwd: '/tmp/one', status: 'idle', updatedAt: '2026-09-18T01:00:00.000Z' }], nextCursor: 'next' },
      { data: [
        { threadId: 'thread-a', title: 'new', titleSource: 'codex', cwd: '/tmp/one', status: 'completed', updatedAt: '2026-09-18T02:00:00.000Z' },
        { threadId: 'thread-b', title: 'other', titleSource: 'codex', cwd: '/tmp/one', status: 'running', updatedAt: '2026-09-18T01:30:00.000Z' },
      ] },
    ],
    async listThreads(cursor?:string) { return this.pages[cursor ? 1 : 0]; },
    async readThread(threadId:string) { return { threadId, turns: [], status: 'completed', cwd: '/tmp/one', raw: {} }; },
  };
  const transport:any = { send(message:any) { messages.push(message); } };
  const sync = new CatalogSync(adapter, transport, [addMapping('OneTouch', '/tmp/one')]);

  assert.equal(await sync.sync(), 2);
  const page = messages.find(x => x.type === 'catalog.snapshot.page');
  assert.deepEqual(page.payload.items.map((x:any) => x.threadId), ['thread-a', 'thread-b']);
  assert.equal(page.payload.items[0].title, 'new');
  assert.equal(messages.find(x => x.type === 'catalog.snapshot.end').payload.count, 2);
});

test('uses normalized authorized status in catalog and task snapshots', async () => {
  const messages:any[] = [];
  const adapter:any = {
    async listThreads() { return { data: [{ threadId: 'thread-a', title: 'task', titleSource: 'codex', cwd: '/tmp/one', status: 'unknown', updatedAt: '2026-09-18T02:00:00.000Z' }] }; },
    async readThread() { return { threadId: 'thread-a', cwd: '/tmp/one', status: 'notLoaded', turns: [{ id: 'turn-a', status: 'completed', items: [] }], raw: {} }; },
  };
  const sync = new CatalogSync(adapter, { send(message:any) { messages.push(message); } }, [addMapping('OneTouch', '/tmp/one')], () => true);
  await sync.sync();
  const page = messages.find(x => x.type === 'catalog.snapshot.page');
  const task = messages.find(x => x.type === 'task.snapshot');
  assert.equal(page.payload.items[0].status, 'completed');
  assert.equal(task.payload.status, 'completed');
});

test('a notLoaded active Codex turn is not published as a failed task', async () => {
  const messages:any[] = [];
  const adapter:any = {
    async listThreads() { return { data: [{ threadId: 'thread-a', title: 'task', titleSource: 'codex', cwd: '/tmp/one', status: 'unknown' }] }; },
    async readThread() { return { threadId: 'thread-a', cwd: '/tmp/one', status: 'notLoaded', turns: [{ id: 'turn-a', status: 'interrupted', items: [] }], raw: {} }; },
  };
  const sync = new CatalogSync(adapter, { send(message:any) { messages.push(message); } }, [addMapping('OneTouch', '/tmp/one')], () => true);
  await sync.sync();
  assert.equal(messages.find(x => x.type === 'task.snapshot').payload.status, 'unknown');
  assert.equal(messages.find(x => x.type === 'catalog.snapshot.page').payload.items[0].status, 'unknown');
});
