import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import type { TaskRef } from '@companion/protocol';
import { apiError, apiOk } from '@companion/protocol';
import { PostgresStore } from './pg-store.js';

export type AlertKind = 'completed' | 'failed' | 'waiting_user';
export interface TaskAttentionInput {
  connectorId: string;
  projectId: string;
  threadId: string;
  turnId: string;
  status: string;
  resultRevision: string;
  hadPreviousSnapshot: boolean;
}
export interface AlertItem {
  alertId: string;
  target: TaskRef;
  kind: AlertKind;
  turnId: string;
  resultRevision: string;
  createdAt: string;
}
export interface AlertSummary { unreadCount: number; latestAlertCursor: string | null; }
export const ALERTS_SCHEMA = {
  list: { method: 'GET', path: '/v1/device/alerts', query: { cursor: 'decimalCursor', limit: '1..20' }, response: '{items,nextCursor}' },
  ack: { method: 'POST', path: '/v1/device/alerts/{alertId}/ack', body: '{clientRequestId}' },
  read: { method: 'POST', path: '/v1/device/read', body: '{clientRequestId,target,resultRevision}' },
} as const;

const terminalKinds: Record<string, AlertKind | undefined> = { completed: 'completed', failed: 'failed', waiting_user: 'waiting_user' };
const requestIdPattern = /^[a-f0-9]{32}$/i;
const id = (v: unknown) => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v, 'utf8') <= 128;
const revision = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v) ? String(BigInt(v)) : undefined;
const bodyHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function migrateAlerts(db: PostgresStore) {
  await db.pool.query(`CREATE TABLE IF NOT EXISTS hc_task_attention(
    binding_id text NOT NULL, connector_id text NOT NULL, project_id text NOT NULL, thread_id text NOT NULL,
    last_turn_id text, last_result_revision numeric, status text NOT NULL DEFAULT 'unknown',
    unread boolean NOT NULL DEFAULT false, read_result_revision numeric,
    PRIMARY KEY(binding_id,connector_id,project_id,thread_id)
  );
  CREATE TABLE IF NOT EXISTS hc_alerts(
    alert_id text PRIMARY KEY, binding_id text NOT NULL, connector_id text NOT NULL, project_id text NOT NULL, thread_id text NOT NULL,
    seq bigserial UNIQUE, kind text NOT NULL, turn_id text NOT NULL, result_revision numeric NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), acknowledged_at timestamptz,
    UNIQUE(binding_id,connector_id,project_id,thread_id,turn_id,kind)
  );
  CREATE INDEX IF NOT EXISTS hc_alerts_binding_cursor_idx ON hc_alerts(binding_id,created_at,alert_id);
  CREATE TABLE IF NOT EXISTS hc_alert_idempotency(
    binding_id text NOT NULL, operation text NOT NULL, client_request_id text NOT NULL, body_hash text NOT NULL, result jsonb NOT NULL,
    PRIMARY KEY(binding_id,operation,client_request_id)
  )`);
}

function validateAttention(input: TaskAttentionInput) {
  if (!input || !id(input.connectorId) || !id(input.projectId) || !id(input.threadId) ||
      !(id(input.turnId) || (input.turnId === '' && !terminalKinds[input.status])) || !revision(input.resultRevision)) throw Error('INVALID_REQUEST');
}

/** Called inside the caller's existing transaction. It never changes binding.active_task_ref. */
export async function recordTaskAttention(c: pg.PoolClient, input: TaskAttentionInput): Promise<AlertItem | undefined> {
  validateAttention(input);
  const kind = terminalKinds[input.status];
  const bindings = await c.query(`SELECT b.id FROM hc_bindings b JOIN hc_grants g ON g.binding_id=b.id
    WHERE b.connector_id=$1 AND b.state='active' AND g.connector_id=$1 AND g.project_id=$2 AND g.thread_id=$3
    FOR UPDATE OF b`, [input.connectorId, input.projectId, input.threadId]);
  let created: AlertItem | undefined;
  for (const binding of bindings.rows) {
    const attention = await c.query(`SELECT last_turn_id,last_result_revision,unread FROM hc_task_attention
      WHERE binding_id=$1 AND connector_id=$2 AND project_id=$3 AND thread_id=$4 FOR UPDATE`,
    [binding.id, input.connectorId, input.projectId, input.threadId]);
    const previous = attention.rows[0];
    const baseline = !input.hadPreviousSnapshot || !previous;
    const currentRevision = revision(input.resultRevision)!;
    const revisionChanged = !previous || previous.last_result_revision === null || BigInt(String(previous.last_result_revision)) < BigInt(currentRevision);
    const duplicate = kind ? await c.query(`SELECT alert_id FROM hc_alerts WHERE binding_id=$1 AND connector_id=$2 AND project_id=$3 AND thread_id=$4 AND turn_id=$5 AND kind=$6`,
      [binding.id, input.connectorId, input.projectId, input.threadId, input.turnId, kind]) : { rowCount: 0 } as any;
    const shouldAlert = Boolean(!baseline && kind && revisionChanged && !duplicate.rowCount);
    await c.query(`INSERT INTO hc_task_attention(binding_id,connector_id,project_id,thread_id,last_turn_id,last_result_revision,status,unread)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(binding_id,connector_id,project_id,thread_id) DO UPDATE SET
      last_turn_id=$5,last_result_revision=$6,status=$7,unread=CASE WHEN $8 THEN true ELSE hc_task_attention.unread END`,
    [binding.id, input.connectorId, input.projectId, input.threadId, input.turnId, currentRevision, input.status, shouldAlert]);
    if (!shouldAlert) continue;
    const alertId = `alert-${randomUUID()}`;
    const result = await c.query(`INSERT INTO hc_alerts(alert_id,binding_id,connector_id,project_id,thread_id,kind,turn_id,result_revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING alert_id,kind,turn_id,result_revision,created_at`,
    [alertId, binding.id, input.connectorId, input.projectId, input.threadId, kind, input.turnId, currentRevision]);
    const row = result.rows[0];
    created = { alertId: row.alert_id, target: { connectorId: input.connectorId, projectId: input.projectId, threadId: input.threadId }, kind: row.kind, turnId: row.turn_id, resultRevision: String(row.result_revision), createdAt: new Date(row.created_at).toISOString() };
  }
  return created;
}

async function deviceBinding(c: pg.PoolClient, token: string) {
  const result = await c.query("SELECT id FROM hc_bindings WHERE device_token=$1 AND state='active' FOR UPDATE", [token]);
  if (!result.rowCount) throw Error('UNAUTHORIZED');
  return result.rows[0].id as string;
}

function cursorValue(value: unknown) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw Error('INVALID_REQUEST');
  return String(BigInt(value));
}

export async function getAlerts(db: PostgresStore, token: string, cursor = '0', limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw Error('INVALID_REQUEST');
  const after = cursorValue(cursor);
  return db.transaction(async c => {
    const bindingId = await deviceBinding(c, token);
    const rows = await c.query(`SELECT seq,alert_id,connector_id,project_id,thread_id,kind,turn_id,result_revision,created_at
      FROM hc_alerts a WHERE a.binding_id=$1 AND a.acknowledged_at IS NULL AND a.seq>$2
      AND EXISTS (SELECT 1 FROM hc_grants g WHERE g.binding_id=a.binding_id AND g.connector_id=a.connector_id AND g.project_id=a.project_id AND g.thread_id=a.thread_id)
      ORDER BY seq LIMIT $3`, [bindingId, after, limit]);
    const items = rows.rows.map(row => ({ alertId: row.alert_id, target: { connectorId: row.connector_id, projectId: row.project_id, threadId: row.thread_id }, kind: row.kind, turnId: row.turn_id, resultRevision: String(row.result_revision), createdAt: new Date(row.created_at).toISOString() }));
    const nextCursor = rows.rows.length ? String(rows.rows[rows.rows.length - 1].seq) : String(after);
    return { items, nextCursor };
  });
}

export async function ackAlert(db: PostgresStore, token: string, alertId: string, clientRequestId: string) {
  if (!id(alertId) || !requestIdPattern.test(clientRequestId)) throw Error('INVALID_REQUEST');
  return db.transaction(async c => {
    const bindingId = await deviceBinding(c, token);
    const hash = bodyHash({ alertId });
    const old = await c.query('SELECT body_hash,result FROM hc_alert_idempotency WHERE binding_id=$1 AND operation=$2 AND client_request_id=$3 FOR UPDATE', [bindingId, 'alert-ack', clientRequestId]);
    if (old.rowCount) { if (old.rows[0].body_hash !== hash) throw Error('IDEMPOTENCY_CONFLICT'); return old.rows[0].result; }
    const alert = await c.query('SELECT alert_id FROM hc_alerts WHERE alert_id=$1 AND binding_id=$2 FOR UPDATE', [alertId, bindingId]);
    if (!alert.rowCount) throw Error('NOT_FOUND');
    const result = { alertId, acknowledged: true };
    await c.query('UPDATE hc_alerts SET acknowledged_at=COALESCE(acknowledged_at,now()) WHERE alert_id=$1', [alertId]);
    await c.query('INSERT INTO hc_alert_idempotency VALUES($1,$2,$3,$4,$5)', [bindingId, 'alert-ack', clientRequestId, hash, JSON.stringify(result)]);
    return result;
  });
}

export async function markRead(db: PostgresStore, token: string, target: TaskRef, resultRevision: string, clientRequestId: string) {
  const currentRevision = revision(resultRevision);
  if (!requestIdPattern.test(clientRequestId) || !currentRevision || !target || !id(target.connectorId) || !id(target.projectId) || !id(target.threadId)) throw Error('INVALID_REQUEST');
  return db.transaction(async c => {
    const bindingId = await deviceBinding(c, token);
    const hash = bodyHash({ target, resultRevision });
    const old = await c.query('SELECT body_hash,result FROM hc_alert_idempotency WHERE binding_id=$1 AND operation=$2 AND client_request_id=$3 FOR UPDATE', [bindingId, 'task-read', clientRequestId]);
    if (old.rowCount) { if (old.rows[0].body_hash !== hash) throw Error('IDEMPOTENCY_CONFLICT'); return old.rows[0].result; }
    const grant = await c.query('SELECT 1 FROM hc_grants WHERE binding_id=$1 AND connector_id=$2 AND project_id=$3 AND thread_id=$4', [bindingId, target.connectorId, target.projectId, target.threadId]);
    if (!grant.rowCount) throw Error('TARGET_NOT_GRANTED');
    const current = await c.query('SELECT revision FROM tasks WHERE connector_id=$1 AND project_id=$2 AND thread_id=$3', [target.connectorId, target.projectId, target.threadId]);
    if (!current.rowCount || String(current.rows[0].revision) !== currentRevision) throw Error('RESULT_MOVED');
    await c.query(`INSERT INTO hc_task_attention(binding_id,connector_id,project_id,thread_id,last_result_revision,status,unread,read_result_revision)
      VALUES($1,$2,$3,$4,$5,'read',false,$5)
      ON CONFLICT(binding_id,connector_id,project_id,thread_id) DO UPDATE SET
      unread=false,read_result_revision=CASE WHEN hc_task_attention.read_result_revision IS NULL OR hc_task_attention.read_result_revision<>$5 THEN $5 ELSE hc_task_attention.read_result_revision END`,
    [bindingId, target.connectorId, target.projectId, target.threadId, currentRevision]);
    const result = { target, resultRevision: currentRevision, read: true };
    await c.query('INSERT INTO hc_alert_idempotency VALUES($1,$2,$3,$4,$5)', [bindingId, 'task-read', clientRequestId, hash, JSON.stringify(result)]);
    return result;
  });
}

export async function getAlertSummary(c: pg.PoolClient, bindingId: string): Promise<AlertSummary> {
  const unread = await c.query(`SELECT COUNT(*)::int AS count FROM hc_task_attention a
    WHERE a.binding_id=$1 AND a.unread=true AND EXISTS (SELECT 1 FROM hc_grants g WHERE g.binding_id=a.binding_id AND g.connector_id=a.connector_id AND g.project_id=a.project_id AND g.thread_id=a.thread_id)`, [bindingId]);
  const latest = await c.query(`SELECT MAX(a.seq) AS seq FROM hc_alerts a
    WHERE a.binding_id=$1 AND a.acknowledged_at IS NULL AND EXISTS (SELECT 1 FROM hc_grants g WHERE g.binding_id=a.binding_id AND g.connector_id=a.connector_id AND g.project_id=a.project_id AND g.thread_id=a.thread_id)`, [bindingId]);
  return { unreadCount: Number(unread.rows[0]?.count ?? 0), latestAlertCursor: latest.rows[0]?.seq === null || latest.rows[0]?.seq === undefined ? null : String(latest.rows[0].seq) };
}

async function body(req: IncomingMessage) { let text = ''; for await (const chunk of req) text += chunk; return text ? JSON.parse(text) : {}; }
export async function handleAlertRequest(db: PostgresStore, token: string, req: IncomingMessage, res: ServerResponse, methodPath: string) {
  const requestId = randomUUID().replaceAll('-', '').slice(0, 32);
  const send = (res: ServerResponse, status: number, value: unknown) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(apiOk(requestId, value))); };
  const fail = (res: ServerResponse, status: number, code: string) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(apiError(requestId, code as any, code, status >= 500))); };
  try {
    const url = new URL(req.url ?? methodPath, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/v1/device/alerts') { send(res, 200, await getAlerts(db, token, url.searchParams.get('cursor') ?? '0', Number(url.searchParams.get('limit') ?? 20))); return true; }
    const ack = /^\/v1\/device\/alerts\/([^/]+)\/ack$/.exec(url.pathname);
    if (req.method === 'POST' && ack) { send(res, 200, await ackAlert(db, token, decodeURIComponent(ack[1]), (await body(req)).clientRequestId)); return true; }
    if (req.method === 'POST' && url.pathname === '/v1/device/read') { const x = await body(req); send(res, 200, await markRead(db, token, x.target, x.resultRevision, x.clientRequestId)); return true; }
    return false;
  } catch (error) {
    const code = error instanceof Error ? error.message : 'INVALID_REQUEST';
    const status = code === 'UNAUTHORIZED' ? 401 : code === 'NOT_FOUND' ? 404 : code === 'TARGET_NOT_GRANTED' ? 403 : ['RESULT_MOVED', 'IDEMPOTENCY_CONFLICT'].includes(code) ? 409 : 400;
    fail(res, status, code);
    return true;
  }
}
