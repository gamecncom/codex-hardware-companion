import { createHash } from 'node:crypto';
import type pg from 'pg';
import { PostgresStore } from './pg-store.js';
import { PgBusinessRepository } from './pg-repository.js';
const hash = (x: string) => createHash('sha256').update(x).digest('hex');
type Ref = { connectorId: string; projectId: string; threadId: string };
async function owner(c: pg.PoolClient, token: string, bindingId: string) {
  const auth = await c.query(`SELECT email FROM hc_auth WHERE session_hash=$1 AND session_expires_at>now()
    UNION SELECT email FROM hc_connectors WHERE token_hash=$1`, [hash(token)]);
  if (!auth.rowCount) throw Error('UNAUTHORIZED');
  const binding = await c.query(`SELECT b.* FROM hc_bindings b JOIN hc_connectors k ON k.id=b.connector_id
    WHERE b.id=$1 AND k.email=$2 AND b.state='active' FOR UPDATE OF b`, [bindingId, auth.rows[0].email]);
  if (!binding.rowCount) throw Error('UNAUTHORIZED');
  return binding.rows[0];
}
export async function getTaskGrants(db: PostgresStore, token: string, bindingId: string) {
  return db.transaction(async c => {
    const binding = await owner(c, token, bindingId);
    const rows = await c.query('SELECT * FROM hc_grants WHERE binding_id=$1 ORDER BY connector_id,project_id,thread_id', [bindingId]);
    return { grantsVersion: String(binding.grants_version), grants: rows.rows.map(r => ({ connectorId: r.connector_id, projectId: r.project_id, threadId: r.thread_id })) };
  });
}
export async function selectOwnedTask(db: PostgresStore, token: string, bindingId: string, body: any) {
  // Do not disclose the device credential to the caller. The selection operation
  // rechecks the active binding and grant after the ownership transaction ends.
  const deviceToken = await db.transaction(async c => (await owner(c, token, bindingId)).device_token);
  return new PgBusinessRepository(db).select(deviceToken, body.target, body.expectedSelectionRevision, body.clientRequestId);
}
export async function putTaskGrants(db: PostgresStore, token: string, bindingId: string, body: any) {
  if (!Array.isArray(body.grants) || !/^[0-9a-f]{32}$/i.test(body.clientRequestId ?? '') ||
      typeof body.expectedGrantsVersion !== 'string' || !/^\d{1,20}$/.test(body.expectedGrantsVersion)) throw Error('INVALID_REQUEST');
  const refs: Ref[] = body.grants.map((r: any) => {
    for (const key of ['connectorId', 'projectId', 'threadId']) {
      if (typeof r?.[key] !== 'string' || !r[key] || Buffer.byteLength(r[key]) > 128) throw Error('INVALID_REQUEST');
    }
    return { connectorId: r.connectorId, projectId: r.projectId, threadId: r.threadId };
  });
  if (new Set(refs.map(r => JSON.stringify(r))).size !== refs.length) throw Error('INVALID_REQUEST');
  const bodyHash = hash(JSON.stringify({ refs, expected: body.expectedGrantsVersion }));
  return db.transaction(async c => {
    const b = await owner(c, token, bindingId);
    const old = await c.query("SELECT body_hash,result FROM hc_idempotency WHERE principal=$1 AND operation='task-grants' AND client_request_id=$2", [bindingId, body.clientRequestId]);
    if (old.rowCount) {
      if (old.rows[0].body_hash !== bodyHash) throw Error('IDEMPOTENCY_CONFLICT');
      return old.rows[0].result;
    }
    if (String(b.grants_version) !== body.expectedGrantsVersion) throw Error('CATALOG_CHANGED');
    for (const ref of refs) {
      if (ref.connectorId !== b.connector_id) throw Error('TARGET_NOT_GRANTED');
      const found = await c.query('SELECT 1 FROM tasks WHERE connector_id=$1 AND project_id=$2 AND thread_id=$3', [ref.connectorId, ref.projectId, ref.threadId]);
      if (!found.rowCount) throw Error('TARGET_NOT_GRANTED');
    }
    await c.query('DELETE FROM hc_grants WHERE binding_id=$1', [bindingId]);
    for (const ref of refs) await c.query('INSERT INTO hc_grants(binding_id,connector_id,project_id,thread_id) VALUES($1,$2,$3,$4)', [bindingId, ref.connectorId, ref.projectId, ref.threadId]);
    const version = (BigInt(b.grants_version) + 1n).toString();
    const keepSelected = !b.active_task_ref || refs.some(r => r.connectorId === b.active_task_ref.connectorId && r.projectId === b.active_task_ref.projectId && r.threadId === b.active_task_ref.threadId);
    await c.query(`UPDATE hc_bindings SET grants_version=$2,active_task_ref=CASE WHEN $3 THEN active_task_ref ELSE NULL END,
      selection_revision=selection_revision+CASE WHEN $3 THEN 0 ELSE 1 END WHERE id=$1`, [bindingId, version, keepSelected]);
    const result = { grantsVersion: version, grants: refs };
    await c.query("INSERT INTO hc_idempotency(principal,operation,client_request_id,body_hash,result) VALUES($1,'task-grants',$2,$3,$4)", [bindingId, body.clientRequestId, bodyHash, JSON.stringify(result)]);
    return result;
  });
}
