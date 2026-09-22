import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { PostgresStore } from './pg-store.js';
import { PgMessages, recordCommandEvent } from './pg-messages.js';
import { recordTaskAttention } from './pg-alerts.js';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
type Stage = { epoch: string; items: any[] };
type DeclaredCapabilities = { list: boolean | 'unknown'; read: boolean | 'unknown'; enqueue: boolean | 'unknown'; accountContextDetection: boolean | 'unknown'; nativeApproval: false };

function declaredCapabilities(raw: unknown): DeclaredCapabilities {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const field = (name: string): boolean | 'unknown' => typeof value[name] === 'boolean' ? value[name] as boolean : 'unknown';
  return { list: field('list'), read: field('read'), enqueue: field('enqueue'), accountContextDetection: field('accountContextDetection'), nativeApproval: false };
}

export async function migratePgChannel(db: PostgresStore) {
  await db.pool.query(`CREATE TABLE IF NOT EXISTS hc_connector_channel_state(
    connector_id text PRIMARY KEY, connection_epoch bigint NOT NULL DEFAULT 0,
    connected boolean NOT NULL DEFAULT false, last_seen_at timestamptz
  ); ALTER TABLE hc_connector_channel_state ADD COLUMN IF NOT EXISTS connected boolean NOT NULL DEFAULT false;
    ALTER TABLE hc_connector_channel_state ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
    ALTER TABLE hc_connector_channel_state ADD COLUMN IF NOT EXISTS capabilities jsonb;
    CREATE TABLE IF NOT EXISTS hc_task_results(
    connector_id text NOT NULL, project_id text NOT NULL, thread_id text NOT NULL,
    result_revision text NOT NULL, last_turn_id text, status text NOT NULL,
    result_text text, summary text, updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(connector_id,project_id,thread_id)
  )`);
}

export function attachPgChannel(server: Server, db: PostgresStore) {
  const wss = new WebSocketServer({ noServer: true });
  const active = new Map<string, { epoch: string; ws: WebSocket }>();
  const stages = new Map<string, Stage>();
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/v1/connectors/channel') return;
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/, '');
    const requested = String(req.headers['x-connector-id'] ?? '');
    const auth = await db.pool.query('SELECT id FROM hc_connectors WHERE id=$1 AND token_hash=$2', [requested, hash(token)]).catch(() => ({ rowCount: 0, rows: [] } as any));
    if (!token || !auth.rowCount) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => { void open(ws, requested); });
  });
  async function open(ws: WebSocket, connectorId: string) {
    let queue = Promise.resolve();
    let ready = false;
    const pending: string[] = [];
    const enqueue = (raw: string) => { queue = queue.then(() => receive(raw)).catch(() => { ws.close(1003, 'invalid message'); }); };
    ws.on('message', (raw) => { if (!ready) pending.push(raw.toString()); else enqueue(raw.toString()); });
    const epoch = await db.transaction(async c => {
      const result = await c.query(`INSERT INTO hc_connector_channel_state(connector_id,connection_epoch,connected,last_seen_at) VALUES($1,1,true,now())
        ON CONFLICT(connector_id) DO UPDATE SET connection_epoch=hc_connector_channel_state.connection_epoch+1,connected=true,last_seen_at=now() RETURNING connection_epoch`, [connectorId]);
      return String(result.rows[0].connection_epoch);
    });
    const previous = active.get(connectorId);
    if (previous) previous.ws.close(4001, 'superseded');
    active.set(connectorId, { epoch, ws });
    let seq = 0;
    const send = (type: string, payload: any) => { if (ws.readyState === 1) ws.send(JSON.stringify({ protocol: 'hc/1', eventId: `evt-${randomUUID()}`, seq: String(++seq), type, connectorId, sentAt: new Date().toISOString(), payload })); };
    const sendPending = async () => {
      const commands = await new PgMessages(db).pending(connectorId);
      if (active.get(connectorId)?.ws !== ws) return;
      for (const command of commands) send('command.available', { commandId: command.commandId });
    };
    const meta = await db.pool.query('SELECT server_epoch FROM hc_server_meta LIMIT 1');
    send('connector.welcome', { connectionEpoch: epoch, serverEpoch: meta.rows[0]?.server_epoch ?? 'unknown' });
    await sendPending();
    ready = true;
    for (const raw of pending.splice(0)) enqueue(raw);
    ws.on('close', () => { if (active.get(connectorId)?.ws === ws) { active.delete(connectorId); void db.pool.query('UPDATE hc_connector_channel_state SET connected=false,last_seen_at=now() WHERE connector_id=$1 AND connection_epoch=$2', [connectorId, epoch]); } });
    async function receive(raw: string) {
      const msg = JSON.parse(raw), type = msg?.type, payload = msg?.payload ?? {};
      if (active.get(connectorId)?.ws !== ws || active.get(connectorId)?.epoch !== epoch) return;
      if (type === 'heartbeat') { await db.pool.query('UPDATE hc_connector_channel_state SET connected=true,last_seen_at=now() WHERE connector_id=$1 AND connection_epoch=$2', [connectorId, epoch]); send('heartbeat.ack', { seq: payload.seq ?? '0' }); await sendPending(); return; }
      if (['command.received','command.waiting_turn','command.queued','command.running','command.completed','command.failed','command.uncertain'].includes(type)) {
        const persisted = await recordCommandEvent(db, connectorId, epoch, type, payload);
        return send('ack', { eventId: msg.eventId, ...persisted });
      }
      if (type === 'connector.hello') {
        if (payload.capabilities !== undefined) {
          await db.transaction(async c => {
            const live = await c.query('SELECT connection_epoch FROM hc_connector_channel_state WHERE connector_id=$1 FOR UPDATE', [connectorId]);
            if (String(live.rows[0]?.connection_epoch) !== epoch) return;
            await c.query('UPDATE hc_connector_channel_state SET capabilities=$2,last_seen_at=now() WHERE connector_id=$1 AND connection_epoch=$3', [connectorId, JSON.stringify(declaredCapabilities(payload.capabilities)), epoch]);
          });
        }
        return send('connector.welcome', { connectionEpoch: epoch, serverEpoch: meta.rows[0]?.server_epoch ?? 'unknown' });
      }
      const key = `${connectorId}:${String(payload.snapshotId ?? '')}`;
      if (type === 'catalog.snapshot.begin') { stages.set(key, { epoch, items: [] }); return send('catalog.ack', { snapshotId: payload.snapshotId, type }); }
      if (type === 'catalog.snapshot.page') { const stage = stages.get(key); if (stage?.epoch === epoch && Array.isArray(payload.items)) stage.items.push(...payload.items); return send('catalog.ack', { snapshotId: payload.snapshotId, type }); }
      if (type === 'catalog.snapshot.end') { await commitCatalog(connectorId, key, epoch, payload.snapshotId); return send('catalog.ack', { snapshotId: payload.snapshotId, type }); }
      if (type === 'task.snapshot') { await saveResult(connectorId, epoch, payload); }
    }
    async function commitCatalog(id: string, key: string, currentEpoch: string, snapshotId: string) {
      const stage = stages.get(key); stages.delete(key); if (!stage || stage.epoch !== currentEpoch) return;
      await db.transaction(async c => {
        const live = await c.query('SELECT connection_epoch FROM hc_connector_channel_state WHERE connector_id=$1 FOR UPDATE', [id]);
        if (String(live.rows[0]?.connection_epoch) !== currentEpoch) return;
        const oldRows = await c.query('SELECT thread_id,project_id,title,status,revision FROM tasks WHERE connector_id=$1', [id]);
        const oldByThread = new Map(oldRows.rows.map((row: any) => [row.thread_id, row]));
        await c.query('DELETE FROM projects WHERE connector_id=$1', [id]);
        await c.query('DELETE FROM tasks WHERE connector_id=$1', [id]);
        const seenProjects = new Set<string>();
        for (const item of stage.items) {
          if (item.threadId) {
            const projectId = String(item.projectId ?? '');
            if (projectId && !seenProjects.has(projectId)) {
              seenProjects.add(projectId);
              await c.query('INSERT INTO projects(connector_id,project_id,name,source) VALUES($1,$2,$3,$4)', [id, projectId, String(item.projectName ?? projectId), 'local']);
            }
            const old = oldByThread.get(item.threadId);
            const same = old && old.project_id === projectId && old.title === String(item.title ?? item.threadId) && old.status === String(item.status ?? 'unknown');
            const revision = same ? String(old.revision) : old ? (BigInt(String(old.revision)) + 1n).toString() : '1';
            await c.query('INSERT INTO tasks(connector_id,thread_id,project_id,title,status,revision,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, item.threadId, projectId, String(item.title ?? item.threadId), String(item.status ?? 'unknown'), revision, item.updatedAt ? new Date(item.updatedAt) : new Date()]);
          } else if (item.projectId && !seenProjects.has(String(item.projectId))) {
            seenProjects.add(String(item.projectId));
            await c.query('INSERT INTO projects(connector_id,project_id,name,source) VALUES($1,$2,$3,$4)', [id, item.projectId, String(item.projectName ?? item.name ?? item.projectId), 'local']);
          }
        }
      });
    }
    async function saveResult(id: string, currentEpoch: string, p: any) {
      if (!p.projectId || !p.threadId) return;
      await db.transaction(async c => {
        const live = await c.query('SELECT connection_epoch FROM hc_connector_channel_state WHERE connector_id=$1 FOR UPDATE', [id]);
        if (String(live.rows[0]?.connection_epoch) !== currentEpoch) return;
        const grant = await c.query("SELECT 1 FROM hc_grants g JOIN hc_bindings b ON b.id=g.binding_id WHERE g.connector_id=$1 AND g.project_id=$2 AND g.thread_id=$3 AND b.state='active' LIMIT 1", [id, p.projectId, p.threadId]);
        if (!grant.rowCount) return;
        const oldTask = await c.query('SELECT status,revision FROM tasks WHERE connector_id=$1 AND project_id=$2 AND thread_id=$3', [id, p.projectId, p.threadId]);
        const oldResult = await c.query('SELECT result_revision FROM hc_task_results WHERE connector_id=$1 AND project_id=$2 AND thread_id=$3', [id, p.projectId, p.threadId]);
        const status = String(p.status ?? 'unknown');
        const resultRevision = String(p.resultRevision ?? '0');
        const unchanged = oldTask.rowCount && oldTask.rows[0].status === status && oldResult.rowCount && String(oldResult.rows[0].result_revision) === resultRevision;
        const taskRevision = unchanged ? String(oldTask.rows[0].revision) : oldTask.rowCount ? (BigInt(String(oldTask.rows[0].revision)) + 1n).toString() : '1';
        await c.query('UPDATE tasks SET status=$4,revision=$5,updated_at=now() WHERE connector_id=$1 AND project_id=$2 AND thread_id=$3', [id, p.projectId, p.threadId, status, taskRevision]);
        await c.query(`INSERT INTO hc_task_results(connector_id,project_id,thread_id,result_revision,last_turn_id,status,result_text,summary)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(connector_id,project_id,thread_id) DO UPDATE SET
          result_revision=$4,last_turn_id=$5,status=$6,result_text=$7,summary=$8,updated_at=now()`, [id, p.projectId, p.threadId, String(p.resultRevision ?? '0'), p.lastTurnId ?? null, String(p.status ?? 'unknown'), p.resultText ?? null, p.summary ?? null]);
        // Empty idle tasks need a per-binding baseline before their first real reply.
        if ((typeof p.lastTurnId === 'string' && p.lastTurnId) || !['completed','failed','waiting_user'].includes(status)) {
          await recordTaskAttention(c, { connectorId: id, projectId: p.projectId, threadId: p.threadId,
            turnId: p.lastTurnId ?? '', status, resultRevision: taskRevision, hadPreviousSnapshot: Boolean(oldResult.rowCount) });
        }
      });
    }
  }
  return wss;
}
