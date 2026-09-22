import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";
import type { TaskRef } from "@companion/protocol";
import { apiError, apiOk } from "@companion/protocol";
import { PostgresStore } from "./pg-store.js";

const requestPattern = /^[a-f0-9]{32}$/i;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sameTarget = (a: any, b: any) => a?.connectorId === b?.connectorId && a?.projectId === b?.projectId && a?.threadId === b?.threadId;
function assertId(value: unknown) { if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > 128) throw Error("INVALID_REQUEST"); }
function assertTarget(target: unknown): asserts target is TaskRef { const t = target as any; if (!t || [t.connectorId, t.projectId, t.threadId].some((x: unknown) => { try { assertId(x); return false; } catch { return true; } })) throw Error("INVALID_REQUEST"); }
function assertRequest(value: unknown) { if (typeof value !== "string" || !requestPattern.test(value)) throw Error("INVALID_REQUEST"); }
function jsonBody(req: IncomingMessage) { return new Promise<any>((resolve, reject) => { const chunks: Buffer[] = []; let size = 0; req.on("data", c => { const b = Buffer.from(c); size += b.length; if (size > 128 * 1024) { reject(Error("PAYLOAD_TOO_LARGE")); req.destroy(); } else chunks.push(b); }); req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(Error("INVALID_REQUEST")); } }); req.on("error", reject); }); }

export async function migrateMessages(db: PostgresStore) {
  await db.pool.query(`ALTER TABLE hc_messages ADD COLUMN IF NOT EXISTS text text;
    ALTER TABLE hc_messages ADD COLUMN IF NOT EXISTS binding_epoch integer;
    ALTER TABLE hc_messages ADD COLUMN IF NOT EXISTS selection_revision numeric;
    ALTER TABLE hc_messages ADD COLUMN IF NOT EXISTS client_request_id text;
    CREATE TABLE IF NOT EXISTS hc_commands(
      command_id text primary key, message_id text not null, binding_id text not null,
      connector_id text not null, binding_epoch integer not null, grants_version numeric not null,
      target jsonb not null, text text not null, state text not null,
      expires_at timestamptz not null, execution_id text unique, execution_state text,
      claimed_at timestamptz, created_at timestamptz not null default now()
    )`);
}

async function activeDeviceBinding(c: pg.PoolClient, token: string) {
  const r = await c.query(`SELECT * FROM hc_bindings WHERE device_token=$1 AND state='active' FOR UPDATE`, [token]);
  if (!r.rowCount) throw Error("UNAUTHORIZED"); return r.rows[0];
}
async function idempotent(c: pg.PoolClient, principal: string, operation: string, requestId: string, bodyHash: string) {
  const r = await c.query(`SELECT body_hash,result FROM hc_idempotency WHERE principal=$1 AND operation=$2 AND client_request_id=$3 FOR UPDATE`, [principal, operation, requestId]);
  if (!r.rowCount) return undefined; if (r.rows[0].body_hash !== bodyHash) throw Error("IDEMPOTENCY_CONFLICT"); return r.rows[0].result;
}
async function saveIdempotent(c: pg.PoolClient, principal: string, operation: string, requestId: string, bodyHash: string, result: unknown) {
  await c.query(`INSERT INTO hc_idempotency(principal,operation,client_request_id,body_hash,result) VALUES($1,$2,$3,$4,$5)`, [principal, operation, requestId, bodyHash, JSON.stringify(result)]);
}
function commandResult(row: any) { return { executionId: row.execution_id, commandId: row.command_id, messageId: row.message_id, bindingId: row.binding_id, bindingEpoch: Number(row.binding_epoch), grantsVersion: String(row.grants_version), target: row.target, text: row.text, expiresAt: new Date(row.expires_at).toISOString(), executionState: row.execution_state ?? row.state }; }

async function expireBinding(c: pg.PoolClient, bindingId: string) {
  const expired = await c.query(`UPDATE hc_commands SET state='failed',execution_state='failed'
    WHERE binding_id=$1 AND state='available' AND expires_at<=now()
    RETURNING command_id,message_id`, [bindingId]);
  for (const row of expired.rows)
    await c.query(`UPDATE hc_messages SET status='failed' WHERE id=$1 AND status IN ('accepted','waiting_connector')`, [row.message_id]);
  return expired.rowCount ?? 0;
}

async function expireConnector(db: PostgresStore, connectorId: string) {
  return db.transaction(async c => {
    const bindings = await c.query('SELECT id FROM hc_bindings WHERE connector_id=$1 FOR UPDATE', [connectorId]);
    let count = 0;
    for (const row of bindings.rows as Array<{ id: string }>) count += await expireBinding(c, row.id);
    return count;
  });
}

export class PgMessages {
  constructor(readonly db: PostgresStore) {}

  async submit(token: string, input: { clientRequestId: string; bindingEpoch: number; target: TaskRef; selectionRevision: string; recordingId: string }) {
    assertRequest(input.clientRequestId); assertTarget(input.target); assertId(input.recordingId);
    if (!Number.isSafeInteger(input.bindingEpoch) || input.bindingEpoch < 1 || typeof input.selectionRevision !== "string" || !/^\d+$/.test(input.selectionRevision) || Buffer.byteLength(input.selectionRevision, "utf8") > 20) throw Error("INVALID_REQUEST");
    const bodyHash = hash({ clientRequestId: input.clientRequestId, bindingEpoch: input.bindingEpoch, target: { connectorId: input.target.connectorId, projectId: input.target.projectId, threadId: input.target.threadId }, selectionRevision: input.selectionRevision, recordingId: input.recordingId });
    return this.db.transaction(async c => {
      const b = await activeDeviceBinding(c, token), principal = `binding:${b.id}`;
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${principal}:message`]);
      const old = await idempotent(c, principal, "message", input.clientRequestId, bodyHash); if (old !== undefined) return old;
      const target = input.target, current = b.active_task_ref;
      if (input.bindingEpoch !== Number(b.epoch) || input.selectionRevision !== String(b.selection_revision) || !sameTarget(target, current)) throw Error("TARGET_MOVED");
      const grant = await c.query(`SELECT 1 FROM hc_grants WHERE binding_id=$1 AND connector_id=$2 AND project_id=$3 AND thread_id=$4`, [b.id, target.connectorId, target.projectId, target.threadId]); if (!grant.rowCount) throw Error("TARGET_NOT_GRANTED");
      const recording = await c.query(`SELECT * FROM hc_recordings WHERE id=$1 FOR UPDATE`, [input.recordingId]);
      if (!recording.rowCount || recording.rows[0].binding_id !== b.id || recording.rows[0].status !== "ready") throw Error("ASR_FAILED");
      const r = recording.rows[0]; if (Number(r.binding_epoch) !== input.bindingEpoch || String(r.selection_revision) !== input.selectionRevision || !sameTarget(r.target, target)) throw Error("TARGET_MOVED");
      const existing = await c.query(`SELECT command_id FROM hc_messages WHERE recording_id=$1 LIMIT 1`, [input.recordingId]); if (existing.rowCount) throw Error("TARGET_MOVED");
      await expireBinding(c, b.id);
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${target.connectorId}:${target.projectId}:${target.threadId}:message-capacity`]);
      const capacity = await c.query(`SELECT count(*)::int AS count FROM hc_commands c
        JOIN hc_bindings b ON b.id=c.binding_id
        WHERE b.connector_id=$1 AND b.state='active' AND c.connector_id=$1
          AND c.target->>'projectId'=$2 AND c.target->>'threadId'=$3
          AND c.state NOT IN ('completed','failed','uncertain')
          AND (c.state <> 'available' OR c.expires_at>now())`, [target.connectorId, target.projectId, target.threadId]);
      if (Number(capacity.rows[0]?.count ?? 0) >= 5) throw Error("BUSY");
      const messageId = `msg-${randomUUID()}`, commandId = `cmd-${randomUUID()}`, expires = new Date(Date.now() + 600000), text = r.transcript ?? "";
      const channel = await c.query(`SELECT connected,last_seen_at FROM hc_connector_channel_state WHERE connector_id=$1`, [target.connectorId]);
      const online = Boolean(channel.rows[0]?.connected) && channel.rows[0]?.last_seen_at && new Date(channel.rows[0].last_seen_at).getTime() > Date.now() - 45_000;
      const messageStatus = online ? 'accepted' : 'waiting_connector';
      const result = { messageId, status: messageStatus };
      await c.query(`INSERT INTO hc_messages(id,binding_id,target,recording_id,status,command_id,text,binding_epoch,selection_revision,client_request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [messageId, b.id, JSON.stringify(target), input.recordingId, messageStatus, commandId, text, input.bindingEpoch, input.selectionRevision, input.clientRequestId]);
      await c.query(`INSERT INTO hc_commands(command_id,message_id,binding_id,connector_id,binding_epoch,grants_version,target,text,state,expires_at,execution_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'available',$9,'available')`, [commandId, messageId, b.id, target.connectorId, input.bindingEpoch, String(b.grants_version), JSON.stringify(target), text, expires]);
      await saveIdempotent(c, principal, "message", input.clientRequestId, bodyHash, result); return result;
    });
  }

  async get(token: string, messageId: string) {
    return this.db.transaction(async c => {
      const binding = await c.query("SELECT id FROM hc_bindings WHERE device_token=$1 AND state='active' FOR UPDATE", [token]);
      if (!binding.rowCount) throw Error("NOT_FOUND");
      await expireBinding(c, binding.rows[0].id);
      const r = await c.query(`SELECT m.id AS message_id,m.status,m.target,m.recording_id,m.command_id,m.text FROM hc_messages m WHERE m.id=$1 AND m.binding_id=$2`, [messageId, binding.rows[0].id]); if (!r.rowCount) throw Error("NOT_FOUND");
      const x = r.rows[0]; return { messageId: x.message_id, status: x.status, target: x.target, recordingId: x.recording_id, commandId: x.command_id, text: x.text };
    });
  }

  async claim(token: string, commandId: string, input: { clientRequestId: string; connectionEpoch: string }) {
    assertRequest(input.clientRequestId); assertId(commandId); if (typeof input.connectionEpoch !== "string" || !/^\d+$/.test(input.connectionEpoch)) throw Error("INVALID_REQUEST");
    const bodyHash = hash({ clientRequestId: input.clientRequestId, connectionEpoch: input.connectionEpoch, commandId });
    const connectorAuth = await this.db.pool.query(`SELECT id FROM hc_connectors WHERE token_hash=$1`, [createHash("sha256").update(token).digest("hex")]);
    if (!connectorAuth.rowCount) throw Error("UNAUTHORIZED");
    await expireConnector(this.db, connectorAuth.rows[0].id);
    return this.db.transaction(async c => {
      const auth = await c.query(`SELECT id FROM hc_connectors WHERE token_hash=$1`, [createHash("sha256").update(token).digest("hex")]); if (!auth.rowCount) throw Error("UNAUTHORIZED"); const connectorId = auth.rows[0].id;
      const principal = `connector:${connectorId}`; await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${principal}:claim:${commandId}`]);
      const old = await idempotent(c, principal, "claim", input.clientRequestId, bodyHash);
      const channel = await c.query(`SELECT connection_epoch FROM hc_connector_channel_state WHERE connector_id=$1 FOR UPDATE`, [connectorId]); if (!channel.rowCount || String(channel.rows[0].connection_epoch) !== input.connectionEpoch) throw Error("UNAUTHORIZED");
      const located = await c.query(`SELECT binding_id FROM hc_commands WHERE command_id=$1 AND connector_id=$2`, [commandId, connectorId]); if (!located.rowCount) throw Error("NOT_FOUND");
      // Lock binding before command, matching revoke's order.
      const binding = await c.query(`SELECT * FROM hc_bindings WHERE id=$1 FOR UPDATE`, [located.rows[0].binding_id]);
      const command = await c.query(`SELECT * FROM hc_commands WHERE command_id=$1 AND connector_id=$2 FOR UPDATE`, [commandId, connectorId]); if (!command.rowCount) throw Error("NOT_FOUND"); const row = command.rows[0];
      if (!binding.rowCount || binding.rows[0].state !== "active" || Number(binding.rows[0].epoch) !== Number(row.binding_epoch)) throw Error("BINDING_REVOKED");
      const grant = await c.query(`SELECT 1 FROM hc_grants WHERE binding_id=$1 AND connector_id=$2 AND project_id=$3 AND thread_id=$4`, [row.binding_id, row.target.connectorId, row.target.projectId, row.target.threadId]); if (!grant.rowCount) throw Error("TARGET_NOT_GRANTED");
      if ((row.state === 'failed' && !row.execution_id) || (new Date(row.expires_at).getTime() <= Date.now() && !row.execution_id)) throw Error("BUSY");
      if (!row.execution_id) { row.execution_id = `exec-${randomUUID()}`; row.execution_state = "claimed"; await c.query(`UPDATE hc_commands SET state='claimed',execution_id=$2,execution_state='claimed',claimed_at=now() WHERE command_id=$1`, [commandId, row.execution_id]); await c.query(`UPDATE hc_messages SET status='dispatching',execution_id=$2 WHERE id=$1`, [row.message_id, row.execution_id]); }
      const result = commandResult(row); if (old === undefined) await saveIdempotent(c, principal, "claim", input.clientRequestId, bodyHash, result); return result;
    });
  }

  async pending(connectorId: string) {
    await expireConnector(this.db, connectorId);
    return this.db.transaction(async c => {
      const r = await c.query(`SELECT c.* FROM hc_commands c JOIN hc_bindings b ON b.id=c.binding_id
        WHERE c.connector_id=$1 AND b.state='active' AND c.state IN ('available','waiting_turn')
          AND (c.state='waiting_turn' OR c.expires_at>now()) ORDER BY c.created_at`, [connectorId]);
      for (const row of r.rows) {
        if (row.execution_state === 'available') {
          await c.query(`UPDATE hc_messages SET status='accepted' WHERE id=$1 AND status='waiting_connector'`, [row.message_id]);
          row.state = 'available'; row.execution_state = 'available';
        }
      }
      return r.rows.map(commandResult);
    });
  }
}

export async function recordCommandEvent(db: PostgresStore, connectorId: string, connectionEpoch: string, type: string, payload: { commandId?: string; executionId?: string }) {
  const states: Record<string, string> = { "command.received": "claimed", "command.waiting_turn": "waiting_turn", "command.queued": "queued", "command.running": "running", "command.completed": "completed", "command.failed": "failed", "command.uncertain": "uncertain" };
  const next = states[type]; if (!next || !payload.commandId) throw Error("INVALID_REQUEST");
  return db.transaction(async c => {
    const live = await c.query(`SELECT connection_epoch FROM hc_connector_channel_state WHERE connector_id=$1 FOR UPDATE`, [connectorId]); if (!live.rowCount || String(live.rows[0].connection_epoch) !== connectionEpoch) throw Error("UNAUTHORIZED");
    const command = await c.query(`SELECT * FROM hc_commands WHERE command_id=$1 AND connector_id=$2 FOR UPDATE`, [payload.commandId, connectorId]); if (!command.rowCount) throw Error("NOT_FOUND");
    const row = command.rows[0]; if (!row.execution_id || row.execution_id !== payload.executionId) throw Error("TARGET_MOVED");
    const terminal = new Set(["completed", "failed", "uncertain"]); if (terminal.has(row.state) && !terminal.has(next)) throw Error("TARGET_MOVED");
    await c.query(`UPDATE hc_commands SET state=$2,execution_state=$2 WHERE command_id=$1`, [payload.commandId, next]);
    const messageState = next === "claimed" ? "dispatching" : next;
    await c.query(`UPDATE hc_messages SET status=$2 WHERE id=$1`, [row.message_id, messageState]);
    return { commandId: payload.commandId, executionId: row.execution_id, executionState: next };
  });
}

export async function handleMessageRequest(db: PostgresStore, req: IncomingMessage, res: ServerResponse, token: string, pathname: string) {
  const messages = new PgMessages(db), requestId = randomUUID().replaceAll("-", "").slice(0, 32), send = (status: number, value: unknown) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(apiOk(requestId, value))); };
  try {
    const get = /^\/v1\/device\/messages\/([^/]+)$/.exec(pathname), claim = /^\/v1\/connectors\/commands\/([^/]+)\/claim$/.exec(pathname);
    if (req.method === "POST" && pathname === "/v1/device/messages") { send(202, await messages.submit(token, await jsonBody(req))); return true; }
    if (req.method === "GET" && get) { send(200, await messages.get(token, decodeURIComponent(get[1]))); return true; }
    if (req.method === "POST" && claim) { send(200, await messages.claim(token, decodeURIComponent(claim[1]), await jsonBody(req))); return true; }
    return false;
  } catch (error) { const code = error instanceof Error ? error.message : "INVALID_REQUEST"; const status = code === "UNAUTHORIZED" ? 401 : code === "NOT_FOUND" ? 404 : code === "TARGET_NOT_GRANTED" ? 403 : code === "PAYLOAD_TOO_LARGE" ? 413 : ["IDEMPOTENCY_CONFLICT", "TARGET_MOVED", "BINDING_REVOKED", "BUSY"].includes(code) ? 409 : 400; res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(apiError(requestId, code as any, code))); return true; }
}
