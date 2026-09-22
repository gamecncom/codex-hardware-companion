import { createHash, randomUUID, randomInt } from 'node:crypto';
import type pg from 'pg';
import { PostgresStore } from './pg-store.js';
import type { AsrAdapter } from './asr.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const requestId = /^[a-f0-9]{32}$/i;
type Ref = { connectorId: string; projectId: string; threadId: string };
export function deviceIdFromBootstrap(options: { deviceBootstraps?: Record<string, string> }, token: string) {
  const found = Object.entries(options.deviceBootstraps ?? {}).find(([, value]) => hash(value) === hash(token));
  if (!found) throw Error('UNAUTHORIZED');
  return found[0];
}

export async function migrateV03(db: PostgresStore) {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS hc_connector_grant_presets(
      connector_id text PRIMARY KEY, version numeric NOT NULL DEFAULT 0,
      targets jsonb NOT NULL DEFAULT '[]', preferred_target jsonb,
      updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS hc_unbind_operations(
      id text PRIMARY KEY, binding_id text NOT NULL, device_id text NOT NULL,
      connector_id text NOT NULL, binding_epoch integer NOT NULL, intent text NOT NULL,
      expires_at timestamptz NOT NULL, confirmed_at timestamptz, result jsonb);
    CREATE TABLE IF NOT EXISTS hc_voice_pairing_attempts(
      id text PRIMARY KEY, device_id text NOT NULL, client_request_id text NOT NULL,
      status text NOT NULL, transcript text, binding_id text, binding_epoch integer,
      binding_token text, target jsonb, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(device_id, client_request_id));
  `);
}

async function connector(c: pg.PoolClient, token: string) {
  const r = await c.query('SELECT id,email FROM hc_connectors WHERE token_hash=$1', [hash(token)]);
  if (!r.rowCount) throw Error('UNAUTHORIZED');
  return r.rows[0];
}
async function userEmail(c: pg.PoolClient, token: string) {
  const r = await c.query(`SELECT email FROM hc_auth WHERE session_hash=$1 AND session_expires_at>now()
    UNION SELECT email FROM hc_connectors WHERE token_hash=$1 LIMIT 1`, [hash(token)]);
  if (!r.rowCount) throw Error('UNAUTHORIZED');
  return r.rows[0].email as string;
}
function assertRef(ref: any): asserts ref is Ref {
  if (!ref || ['connectorId', 'projectId', 'threadId'].some(k => typeof ref[k] !== 'string' || !ref[k] || Buffer.byteLength(ref[k]) > 128)) throw Error('INVALID_REQUEST');
}
function assertPreset(targets: any[], preferredTarget: any) {
  if (!Array.isArray(targets) || targets.length > 100) throw Error('INVALID_REQUEST');
  const unique = new Set<string>();
  for (const ref of targets) { assertRef(ref); const key = JSON.stringify(ref); if (unique.has(key)) throw Error('INVALID_REQUEST'); unique.add(key); }
  if (preferredTarget !== undefined && preferredTarget !== null) { assertRef(preferredTarget); if (!unique.has(JSON.stringify(preferredTarget))) throw Error('TARGET_NOT_GRANTED'); }
}

export async function getGrantPreset(db: PostgresStore, token: string) {
  return db.transaction(async c => {
    const owner = await connector(c, token);
    const r = await c.query('SELECT version,targets,preferred_target FROM hc_connector_grant_presets WHERE connector_id=$1', [owner.id]);
    const row = r.rows[0];
    return { version: String(row?.version ?? 0), targets: row?.targets ?? [], preferredTarget: row?.preferred_target ?? null };
  });
}

export async function putGrantPreset(db: PostgresStore, token: string, body: any) {
  if (!requestId.test(body?.clientRequestId ?? '') || !/^\d{1,20}$/.test(body?.expectedVersion ?? '')) throw Error('INVALID_REQUEST');
  assertPreset(body.targets, body.preferredTarget);
  return db.transaction(async c => {
    const owner = await connector(c, token);
    const current = await c.query('SELECT version FROM hc_connector_grant_presets WHERE connector_id=$1 FOR UPDATE', [owner.id]);
    const version = String(current.rows[0]?.version ?? 0);
    if (version !== body.expectedVersion) throw Error('CATALOG_CHANGED');
    for (const ref of body.targets) {
      if (ref.connectorId !== owner.id) throw Error('TARGET_NOT_GRANTED');
      const task = await c.query('SELECT 1 FROM tasks WHERE connector_id=$1 AND project_id=$2 AND thread_id=$3', [ref.connectorId, ref.projectId, ref.threadId]);
      if (!task.rowCount) throw Error('TARGET_NOT_GRANTED');
    }
    const next = (BigInt(version) + 1n).toString();
    await c.query(`INSERT INTO hc_connector_grant_presets(connector_id,version,targets,preferred_target)
      VALUES($1,$2,$3,$4) ON CONFLICT(connector_id) DO UPDATE SET version=$2,targets=$3,preferred_target=$4,updated_at=now()`, [owner.id, next, JSON.stringify(body.targets), body.preferredTarget ? JSON.stringify(body.preferredTarget) : null]);
    return { version: next, targets: body.targets, preferredTarget: body.preferredTarget ?? null };
  });
}

export async function copyPreset(c: pg.PoolClient, connectorId: string, bindingId: string) {
  const p = await c.query('SELECT targets,preferred_target FROM hc_connector_grant_presets WHERE connector_id=$1', [connectorId]);
  const targets: Ref[] = p.rows[0]?.targets ?? [];
  await c.query('DELETE FROM hc_grants WHERE binding_id=$1', [bindingId]);
  for (const ref of targets) await c.query('INSERT INTO hc_grants(binding_id,connector_id,project_id,thread_id) VALUES($1,$2,$3,$4)', [bindingId, ref.connectorId, ref.projectId, ref.threadId]);
  const preferred = p.rows[0]?.preferred_target;
  if (preferred && targets.some(x => JSON.stringify(x) === JSON.stringify(preferred))) await c.query('UPDATE hc_bindings SET active_task_ref=$2,selection_revision=selection_revision+1 WHERE id=$1', [bindingId, JSON.stringify(preferred)]);
  return { targets, preferredTarget: preferred ?? null };
}

export function normalizePairingDigits(value: string) {
  const map: Record<string, string> = { 零:'0',〇:'0',一:'1',二:'2',两:'2',三:'3',四:'4',五:'5',六:'6',七:'7',八:'8',九:'9' };
  const normalized = value.replace(/[零〇一二两三四五六七八九]/g, x => map[x]).replace(/[\s-]/g, '');
  return /^\d{8}$/.test(normalized) ? normalized : undefined;
}

export async function createV03Pairing(db: PostgresStore, token: string, clientRequestId: string) {
  if (!requestId.test(clientRequestId)) throw Error('INVALID_REQUEST');
  return db.transaction(async c => {
    const owner = await connector(c, token);
    const old = await c.query('SELECT id,code,expires_at,preset_version FROM hc_pairings WHERE connector_id=$1 AND request_id=$2', [owner.id, clientRequestId]);
    if (old.rowCount) return { pairingId: old.rows[0].id, code: old.rows[0].code, expiresAt: new Date(old.rows[0].expires_at).toISOString(), presetVersion: String(old.rows[0].preset_version ?? 0) };
    const preset = await c.query('SELECT version FROM hc_connector_grant_presets WHERE connector_id=$1', [owner.id]);
    const code = String(randomInt(0, 100000000)).padStart(8, '0'), id = `pair-${randomUUID()}`, exp = new Date(Date.now() + 15 * 60_000), version = String(preset.rows[0]?.version ?? 0);
    await c.query('INSERT INTO hc_pairings(id,connector_id,code_hash,code,expires_at,consumed_at,request_id,preset_version) VALUES($1,$2,$3,$4,$5,NULL,$6,$7)', [id, owner.id, hash(code), code, exp, clientRequestId, version]);
    return { pairingId: id, code, expiresAt: exp.toISOString(), presetVersion: version };
  });
}

export async function prepareUnbind(db: PostgresStore, token: string, bindingId: string, intent: string) {
  if (intent !== 'release') throw Error('INVALID_REQUEST');
  return db.transaction(async c => {
    const email = await userEmail(c, token);
    const r = await c.query(`SELECT b.id,b.device_id,b.connector_id,b.epoch,co.name AS connector_name
      FROM hc_bindings b JOIN hc_connectors co ON co.id=b.connector_id WHERE b.id=$1 AND co.email=$2 AND b.state='active' FOR UPDATE`, [bindingId, email]);
    if (!r.rowCount) throw Error('UNAUTHORIZED');
    const row = r.rows[0], id = `unbind-${randomUUID()}`;
    await c.query(`INSERT INTO hc_unbind_operations(id,binding_id,device_id,connector_id,binding_epoch,intent,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')`, [id, row.id, row.device_id, row.connector_id, row.epoch, intent]);
    return { operationId: id, bindingId: row.id, deviceId: row.device_id, connectorId: row.connector_id, bindingEpoch: Number(row.epoch), intent, expiresAt: new Date(Date.now() + 600000).toISOString(), impact: '云端立即失效；在线设备清理当前绑定，离线设备联网后同步回待绑定页；Codex 任务和历史不删除。' };
  });
}

export async function confirmUnbind(db: PostgresStore, token: string, operationId: string, clientRequestId: string) {
  if (!requestId.test(clientRequestId)) throw Error('INVALID_REQUEST');
  return db.transaction(async c => {
    const email = await userEmail(c, token);
    const op = await c.query(`SELECT o.*,co.email FROM hc_unbind_operations o JOIN hc_connectors co ON co.id=o.connector_id WHERE o.id=$1 AND co.email=$2 FOR UPDATE`, [operationId, email]);
    if (!op.rowCount || new Date(op.rows[0].expires_at).getTime() < Date.now()) throw Error('NOT_FOUND');
    if (op.rows[0].result) return op.rows[0].result;
    const b = await c.query("SELECT * FROM hc_bindings WHERE id=$1 FOR UPDATE", [op.rows[0].binding_id]);
    if (!b.rowCount || b.rows[0].state !== 'active' || Number(b.rows[0].epoch) !== Number(op.rows[0].binding_epoch)) throw Error('SELECTION_CONFLICT');
    const result = { bindingId: b.rows[0].id, deviceId: b.rows[0].device_id, cloudState: 'revoked', deviceAppliedState: 'pending', epoch: Number(b.rows[0].epoch) + 1, oldBindingEpoch: Number(b.rows[0].epoch) };
    await c.query("UPDATE hc_bindings SET state='revoked',epoch=$2,active_task_ref=NULL WHERE id=$1", [b.rows[0].id, result.epoch]);
    await c.query("UPDATE hc_commands SET state=CASE WHEN state='available' THEN 'cancelled' ELSE 'uncertain' END,execution_state=CASE WHEN state='available' THEN 'cancelled' ELSE 'uncertain' END WHERE binding_id=$1 AND state IN ('available','claimed','waiting_turn','queued','running')", [b.rows[0].id]);
    await c.query('UPDATE hc_unbind_operations SET confirmed_at=now(),result=$2 WHERE id=$1', [operationId, JSON.stringify(result)]);
    return result;
  });
}

export async function voicePair(db: PostgresStore, asr: AsrAdapter | undefined, bootstrap: string, deviceId: string, clientRequestId: string, audio: Buffer) {
  if (!asr) throw Error('CONFIG_MISSING');
  if (!requestId.test(clientRequestId) || !audio.length || audio.length > 4 * 1024 * 1024) throw Error('INVALID_REQUEST');
  const attempt = await db.transaction(async c => {
    const old = await c.query('SELECT * FROM hc_voice_pairing_attempts WHERE device_id=$1 AND client_request_id=$2', [deviceId, clientRequestId]);
    if (old.rowCount) return old.rows[0];
    const id = `vpa-${randomUUID()}`; await c.query('INSERT INTO hc_voice_pairing_attempts(id,device_id,client_request_id,status) VALUES($1,$2,$3,$4)', [id, deviceId, clientRequestId, 'processing']); return { id, device_id: deviceId };
  });
  if (attempt.status !== 'processing') return { pairingAttemptId: attempt.id, status: attempt.status, bindingId: attempt.binding_id, epoch: attempt.binding_epoch, target: attempt.target };
  const tmp = `/tmp/${attempt.id}.m4a`; const { promises: fs } = await import('node:fs'); await fs.writeFile(tmp, audio);
  try {
    const transcript = await asr.transcribe(tmp); const code = normalizePairingDigits(transcript.transcript);
    if (!code) { await db.pool.query('UPDATE hc_voice_pairing_attempts SET status=$2,transcript=$3,updated_at=now() WHERE id=$1', [attempt.id, 'no_match', transcript.transcript]); return { pairingAttemptId: attempt.id, status: 'no_match' }; }
    const result = await db.transaction(async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`device-pair:${deviceId}`]);
      const pair = await c.query("SELECT * FROM hc_pairings WHERE code_hash=$1 AND expires_at>now() AND consumed_at IS NULL FOR UPDATE", [hash(code)]);
      if (!pair.rowCount) { await c.query('UPDATE hc_voice_pairing_attempts SET status=$2,transcript=$3,updated_at=now() WHERE id=$1', [attempt.id, 'no_match', transcript.transcript]); return { pairingAttemptId: attempt.id, status: 'no_match' }; }
      const active = await c.query("SELECT id FROM hc_bindings WHERE device_id=$1 AND state='active'", [deviceId]); if (active.rowCount) throw Error('PAIRING_CONFLICT');
      const owner = await c.query(`SELECT email FROM hc_connectors WHERE id=$1`, [pair.rows[0].connector_id]);
      if (!owner.rowCount) throw Error('UNAUTHORIZED');
      const user = await c.query(`INSERT INTO hc_users(id,email) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id,email`, [`user-${randomUUID()}`, owner.rows[0].email]);
      const bindingId = `bind-${randomUUID()}`, deviceToken = randomUUID() + randomUUID();
      await c.query(`INSERT INTO hc_bindings(id,user_id,device_id,connector_id,epoch,state,device_token) VALUES($1,$2,$3,$4,1,'active',$5)`, [bindingId, user.rows[0].id, deviceId, pair.rows[0].connector_id, deviceToken]);
      await copyPreset(c, pair.rows[0].connector_id, bindingId); await c.query('UPDATE hc_pairings SET consumed_at=now() WHERE id=$1', [pair.rows[0].id]);
      const out = { pairingAttemptId: attempt.id, status: 'bound', bindingId, epoch: 1, bindingToken: deviceToken };
      await c.query('UPDATE hc_voice_pairing_attempts SET status=$2,transcript=$3,binding_id=$4,binding_epoch=1,binding_token=$5,updated_at=now() WHERE id=$1', [attempt.id, 'bound', transcript.transcript, bindingId, deviceToken]);
      return out;
    }); return result;
  } finally { await fs.rm(tmp, { force: true }).catch(() => undefined); }
}

export async function voicePairStatus(db: PostgresStore, bootstrap: string, deviceId: string, attemptId: string) {
  const r = await db.pool.query('SELECT status,binding_id,binding_epoch,binding_token,target FROM hc_voice_pairing_attempts WHERE id=$1 AND device_id=$2', [attemptId, deviceId]);
  if (!r.rowCount) throw Error('NOT_FOUND'); const x = r.rows[0]; return { pairingAttemptId: attemptId, status: x.status, ...(x.status === 'bound' ? { bindingId: x.binding_id, epoch: Number(x.binding_epoch), bindingToken: x.binding_token, target: x.target } : {}) };
}

export async function readVoiceMultipart(req: { headers: Record<string, string | string[] | undefined>; [key: string]: any }) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req as any) { const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += b.length; if (size > 4 * 1024 * 1024 + 128 * 1024) throw Error('PAYLOAD_TOO_LARGE'); chunks.push(b); }
  const contentType = String(req.headers['content-type'] ?? ''), match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!match) throw Error('INVALID_REQUEST');
  const marker = Buffer.from(`--${match[1] ?? match[2]}`), body = Buffer.concat(chunks), parts: Array<{ headers: string; data: Buffer }> = [];
  let cursor = marker.length;
  if (!body.subarray(0, marker.length).equals(marker)) throw Error('INVALID_REQUEST');
  while (cursor < body.length) {
    if (body.subarray(cursor, cursor + 2).equals(Buffer.from('--'))) break;
    if (!body.subarray(cursor, cursor + 2).equals(Buffer.from('\r\n'))) throw Error('INVALID_REQUEST');
    const end = body.indexOf(Buffer.from('\r\n\r\n'), cursor + 2), next = body.indexOf(Buffer.from(`\r\n${marker.toString()}`), end + 4);
    if (end < 0 || next < 0) throw Error('INVALID_REQUEST');
    parts.push({ headers: body.subarray(cursor + 2, end).toString(), data: body.subarray(end + 4, next) }); cursor = next + 2 + marker.length;
  }
  let audio: Buffer | undefined, clientRequestId: string | undefined;
  for (const part of parts) { const name = /name="([^"]+)"/i.exec(part.headers)?.[1]; if (name === 'audio') audio = part.data; if (name === 'clientRequestId') clientRequestId = part.data.toString().trim(); }
  if (!audio || !clientRequestId) throw Error('INVALID_REQUEST');
  return { audio, clientRequestId };
}
