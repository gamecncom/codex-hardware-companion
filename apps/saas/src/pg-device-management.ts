import { createHash } from "node:crypto";
import type pg from "pg";
import { PostgresStore } from "./pg-store.js";

export async function migrateDeviceManagement(db: PostgresStore) {
  await db.pool.query("CREATE TABLE IF NOT EXISTS hc_device_names(device_id text primary key,name text not null)");
}
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
function assertRequestId(requestId: string) { if (typeof requestId !== "string" || !/^[a-f0-9]{32}$/i.test(requestId)) throw Error("INVALID_REQUEST"); }
function assertDeviceName(name: string) { if (typeof name !== "string") throw Error("INVALID_NAME"); const bytes = Buffer.byteLength(name, "utf8"); if (bytes < 1 || bytes > 120) throw Error("INVALID_NAME"); }

async function authenticatedEmail(c: pg.PoolClient, token: string) {
  const result = await c.query(`SELECT email FROM hc_auth WHERE session_hash=$1 AND session_expires_at>now() UNION SELECT email FROM hc_connectors WHERE token_hash=$1 LIMIT 1`, [hashToken(token)]);
  if (!result.rowCount) throw Error("UNAUTHORIZED");
  return result.rows[0].email as string;
}
async function ownedBinding(c: pg.PoolClient, email: string, bindingId: string) {
  const result = await c.query(`SELECT b.* FROM hc_bindings b JOIN hc_connectors co ON co.id=b.connector_id WHERE b.id=$1 AND co.email=$2 AND b.state='active' FOR UPDATE`, [bindingId, email]);
  if (!result.rowCount) throw Error("UNAUTHORIZED");
  return result.rows[0];
}
async function idempotentResult(c: pg.PoolClient, principal: string, operation: string, requestId: string, bodyHash: string) {
  const old = await c.query(`SELECT body_hash,result FROM hc_idempotency WHERE principal=$1 AND operation=$2 AND client_request_id=$3 FOR UPDATE`, [principal, operation, requestId]);
  if (!old.rowCount) return undefined;
  if (old.rows[0].body_hash !== bodyHash) throw Error("IDEMPOTENCY_CONFLICT");
  return old.rows[0].result;
}
async function saveIdempotent(c: pg.PoolClient, principal: string, operation: string, requestId: string, bodyHash: string, result: unknown) {
  await c.query(`INSERT INTO hc_idempotency(principal,operation,client_request_id,body_hash,result) VALUES($1,$2,$3,$4,$5)`, [principal, operation, requestId, bodyHash, JSON.stringify(result)]);
}

export async function listDevices(db: PostgresStore, token: string) {
  const auth = await db.pool.query(`SELECT email FROM hc_auth WHERE session_hash=$1 AND session_expires_at>now() UNION SELECT email FROM hc_connectors WHERE token_hash=$1 LIMIT 1`, [hashToken(token)]);
  if (!auth.rowCount) throw Error("UNAUTHORIZED");
  const q = await db.pool.query(`SELECT b.device_id,b.id binding_id,b.connector_id,b.state,b.epoch,b.selection_revision,b.active_task_ref,COALESCE(n.name,b.device_id) AS name FROM hc_bindings b JOIN hc_connectors co ON co.id=b.connector_id LEFT JOIN hc_device_names n ON n.device_id=b.device_id WHERE co.email=$1`, [auth.rows[0].email]);
  return q.rows.map(x => ({ deviceId:x.device_id, name:x.name, bindingId:x.binding_id, connectorId:x.connector_id, state:x.state, epoch:x.epoch, selectionRevision:String(x.selection_revision), activeTaskRef:x.active_task_ref }));
}

export async function renameDevice(db: PostgresStore, token: string, deviceId: string, name: string, requestId: string) {
  assertRequestId(requestId); assertDeviceName(name);
  const bodyHash = createHash("sha256").update(JSON.stringify({ deviceId, name })).digest("hex");
  return db.transaction(async c => {
    const email = await authenticatedEmail(c, token), principal = `user:${email}:device:${deviceId}`;
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${principal}:rename-device`]);
    const old = await idempotentResult(c, principal, "rename-device", requestId, bodyHash); if (old !== undefined) return old;
    const binding = await c.query(`SELECT b.id FROM hc_bindings b JOIN hc_connectors co ON co.id=b.connector_id WHERE b.device_id=$1 AND co.email=$2 AND b.state='active' FOR UPDATE`, [deviceId, email]);
    if (!binding.rowCount) throw Error("UNAUTHORIZED");
    await c.query(`INSERT INTO hc_device_names(device_id,name) VALUES($1,$2) ON CONFLICT(device_id) DO UPDATE SET name=EXCLUDED.name`, [deviceId, name]);
    const result = { deviceId, name }; await saveIdempotent(c, principal, "rename-device", requestId, bodyHash, result); return result;
  });
}

export async function revokeBinding(db: PostgresStore, token: string, bindingId: string, requestId: string) {
  assertRequestId(requestId);
  const bodyHash = createHash("sha256").update(JSON.stringify({ bindingId })).digest("hex");
  return db.transaction(async c => {
    const email = await authenticatedEmail(c, token), principal = `user:${email}:binding:${bindingId}`;
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${principal}:revoke-binding`]);
    const old = await idempotentResult(c, principal, "revoke-binding", requestId, bodyHash); if (old !== undefined) return old;
    const binding = await ownedBinding(c, email, bindingId);
    const result = binding.state === "revoked" ? { bindingId, epoch:binding.epoch, state:"revoked" } : { bindingId, epoch:Number(binding.epoch)+1, state:"revoked" };
    if (binding.state !== "revoked") await c.query(`UPDATE hc_bindings SET state='revoked',epoch=$2,active_task_ref=NULL WHERE id=$1`, [bindingId, result.epoch]);
    await c.query(`WITH changed AS (
      UPDATE hc_commands SET state=CASE WHEN state='available' THEN 'cancelled' ELSE 'uncertain' END,
        execution_state=CASE WHEN state='available' THEN 'cancelled' ELSE 'uncertain' END
      WHERE binding_id=$1 AND state IN ('available','claimed','waiting_turn','queued','running')
      RETURNING message_id,state
    ) UPDATE hc_messages m SET status=changed.state FROM changed WHERE m.id=changed.message_id`, [bindingId]);
    await saveIdempotent(c, principal, "revoke-binding", requestId, bodyHash, result); return result;
  });
}
