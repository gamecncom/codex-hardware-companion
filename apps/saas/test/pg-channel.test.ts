import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { PostgresStore } from '../src/pg-store.js';
import { PgBusinessRepository } from '../src/pg-repository.js';
import { attachPgChannel, migratePgChannel } from '../src/pg-channel.js';
import { CatalogSync } from '../../connector/src/catalogSync.js';
import { WssTransport } from '../../connector/src/wssTransport.js';

test('PG channel authenticates connector, commits catalog and authorized results by epoch', async (t) => {
  const url = process.env.COMPANION_PG_TEST_URL;
  if (!url) return t.skip('COMPANION_PG_TEST_URL not set');
  const db = new PostgresStore(url), repo = new PgBusinessRepository(db);
  await repo.migrate(); await migratePgChannel(db);
  const suffix = Date.now().toString(36), connector = `channel-${suffix}`, token = `channel-token-${suffix}`, project = `channel-project-${suffix}`, thread = `channel-thread-${suffix}`;
  await db.pool.query('INSERT INTO hc_connectors(id,email,name,token_hash) VALUES($1,$2,$3,$4)', [connector, `${suffix}@test.invalid`, 'channel', createHash('sha256').update(token).digest('hex')]);
  await db.pool.query('INSERT INTO projects(connector_id,project_id,name,source) VALUES($1,$2,$3,$4)', [connector, project, 'old', 'codex']);
  await db.pool.query('INSERT INTO hc_bindings(id,user_id,device_id,connector_id,epoch,state,device_token) VALUES($1,$2,$3,$4,1,\'active\',$5)', [`bind-${suffix}`, `user-${suffix}`, `device-${suffix}`, connector, `device-token-${suffix}`]);
  await db.pool.query('INSERT INTO hc_grants(binding_id,connector_id,project_id,thread_id) VALUES($1,$2,$3,$4)', [`bind-${suffix}`, connector, project, thread]);
  const server = createServer(); attachPgChannel(server, db); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  let ws: WebSocket | undefined, ws2: WebSocket | undefined, transport: WssTransport | undefined;
  const closeSocket = async (socket?: WebSocket) => {
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve, reject) => {
      const onClose = () => { socket.off('error', onError); resolve(); };
      const onError = (error: Error) => { socket.off('close', onClose); reject(error); };
      socket.once('close', onClose); socket.once('error', onError); socket.close();
    });
  };
  const waitForServerClose = async () => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const state = await db.pool.query('SELECT connected FROM hc_connector_channel_state WHERE connector_id=$1', [connector]);
      if (!state.rowCount || state.rows[0].connected === false) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('CHANNEL_CLOSE_PERSISTENCE_TIMEOUT');
  };
  t.after(async () => {
    await closeSocket(ws2); await closeSocket(ws);
    transport?.close();
    await waitForServerClose();
    await new Promise<void>(r => server.close(() => r()));
    await db.close();
  });
  const port = (server.address() as any).port;
  const connect = () => new WebSocket(`ws://127.0.0.1:${port}/v1/connectors/channel`, { headers: { authorization: `Bearer ${token}`, 'x-connector-id': connector } });
  ws = connect(); const events: any[] = []; ws.on('message', raw => events.push(JSON.parse(raw.toString()))); await new Promise<void>(r => ws.once('open', () => r())); await new Promise<void>(r => setTimeout(r, 30));
  const welcome = events.find(x => x.type === 'connector.welcome'); assert.ok(welcome); const epoch = welcome.payload.connectionEpoch;
  const send = (type: string, payload: any) => ws.send(JSON.stringify({ protocol: 'hc/1', type, payload }));
  send('catalog.snapshot.begin', { snapshotId: 'snap-1' });
  send('catalog.snapshot.page', { snapshotId: 'snap-1', items: [{ projectId: project, projectName: 'new', connectorId: 'spoofed' }, { projectId: project, threadId: thread, title: 'task', connectorId: 'spoofed', status: 'completed', revision: '2' }] });
  send('catalog.snapshot.end', { snapshotId: 'snap-1' });
  send('task.snapshot', { projectId: project, threadId: thread, connectorId: 'spoofed', resultRevision: 'r1', status: 'completed', resultText: '结果' });
  await new Promise<void>(r => setTimeout(r, 120));
  const catalog = await db.pool.query('SELECT * FROM projects WHERE connector_id=$1 AND project_id=$2', [connector, project]); assert.equal(catalog.rows[0].name, 'new');
  const result = await db.pool.query('SELECT * FROM hc_task_results WHERE connector_id=$1 AND project_id=$2 AND thread_id=$3', [connector, project, thread]); assert.equal(result.rowCount, 1); assert.equal(result.rows[0].result_text, '结果');
  send('heartbeat', { seq: '7' }); await new Promise<void>(r => setTimeout(r, 20)); assert.ok(events.some(x => x.type === 'heartbeat.ack' && x.payload.seq === '7'));
  ws.close();
  transport = new WssTransport({ url: `ws://127.0.0.1:${port}/v1/connectors/channel`, token, connectorId: connector });
  await new Promise<void>((resolve, reject) => { transport!.once('open', resolve); transport!.once('error', reject); transport!.connect(); });
  const adapter: any = { listThreads: async () => ({ data: [{ threadId: thread, cwd: '/workspace', title: 'from CatalogSync', status: 'completed', updatedAt: new Date().toISOString() }] }), readThread: async () => ({ threadId: thread, cwd: '/workspace', status: 'completed', turns: [] }) };
  await new CatalogSync(adapter, transport, [{ projectId: project, name: 'from CatalogSync', root: '/workspace' }], () => true).sync();
  transport.close();
  await new Promise<void>(r => setTimeout(r, 80));
  const synced = await db.pool.query('SELECT name FROM projects WHERE connector_id=$1 AND project_id=$2', [connector, project]); assert.equal(synced.rows[0].name, 'from CatalogSync');
  ws2 = connect(); await new Promise<void>(r => ws2!.once('open', () => r())); const events2: any[] = []; ws2.on('message', raw => events2.push(JSON.parse(raw.toString()))); await new Promise<void>(r => setTimeout(r, 40));
  const epoch2 = events2.find(x => x.type === 'connector.welcome')?.payload.connectionEpoch; assert.ok(Number(epoch2) > Number(epoch)); assert.equal(ws.readyState, WebSocket.CLOSED);
  await closeSocket(ws2);
  await waitForServerClose();
});
