import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";
import type { TaskRef } from "@companion/protocol";
import { apiError, apiOk } from "@companion/protocol";
import { PostgresStore } from "./pg-store.js";
import type { AsrAdapter } from "./asr.js";

const MAX_AUDIO = 4 * 1024 * 1024;
const MAX_TRANSCRIPT = 4096;
const requestIdPattern = /^[a-f0-9]{32}$/i;

export type RecordingMetadata = {
  clientRequestId: string;
  target: TaskRef;
  bindingEpoch: number;
  selectionRevision: string;
};
export type RecordingResult = {
  recordingId: string;
  status: "processing" | "ready" | "failed" | "cancelled";
  target: TaskRef;
  transcript?: string | null;
};

export async function migrateRecordings(db: PostgresStore) {
  await db.pool.query(`CREATE TABLE IF NOT EXISTS hc_recordings(
    id text primary key,
    binding_id text not null,
    binding_epoch integer not null,
    selection_revision numeric not null,
    target jsonb not null,
    client_request_id text not null,
    audio bytea not null,
    status text not null,
    transcript text,
    provider_task_id text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    worker_claimed_at timestamptz
  )`);
  await db.pool.query("ALTER TABLE hc_recordings ADD COLUMN IF NOT EXISTS worker_claimed_at timestamptz");
}

function tokenHash(token: string) { return createHash("sha256").update(token).digest("hex"); }
function bodyHash(audio: Buffer, metadata: RecordingMetadata) {
  const canonical = { clientRequestId: metadata.clientRequestId, target: { connectorId: metadata.target.connectorId, projectId: metadata.target.projectId, threadId: metadata.target.threadId }, bindingEpoch: metadata.bindingEpoch, selectionRevision: metadata.selectionRevision };
  return createHash("sha256").update(audio).update("\0").update(JSON.stringify(canonical)).digest("hex");
}
function assertMetadata(metadata: RecordingMetadata) {
  if (!metadata || typeof metadata !== "object" || !requestIdPattern.test(metadata.clientRequestId)) throw Error("INVALID_REQUEST");
  const t = metadata.target;
  if (!t || typeof t.connectorId !== "string" || typeof t.projectId !== "string" || typeof t.threadId !== "string" || [t.connectorId, t.projectId, t.threadId].some(x => Buffer.byteLength(x, "utf8") < 1 || Buffer.byteLength(x, "utf8") > 128)) throw Error("INVALID_REQUEST");
  if (!Number.isSafeInteger(metadata.bindingEpoch) || metadata.bindingEpoch < 1 || typeof metadata.selectionRevision !== "string" || !/^\d+$/.test(metadata.selectionRevision) || Buffer.byteLength(metadata.selectionRevision, "utf8") > 20) throw Error("INVALID_REQUEST");
}
function assertTranscript(transcript: string) { if (Buffer.byteLength(transcript, "utf8") > MAX_TRANSCRIPT) throw Error("PAYLOAD_TOO_LARGE"); }

async function deviceBinding(c: pg.PoolClient, token: string) {
  const r = await c.query(`SELECT b.* FROM hc_bindings b WHERE b.device_token=$1 AND b.state='active' FOR UPDATE`, [token]);
  if (!r.rowCount) throw Error("UNAUTHORIZED");
  return r.rows[0];
}

function frozenTarget(value: unknown): TaskRef {
  const x = value as TaskRef;
  return { connectorId: x.connectorId, projectId: x.projectId, threadId: x.threadId };
}

export class PgRecordings {
  constructor(readonly db: PostgresStore, readonly asr?: AsrAdapter) {}

  async upload(token: string, audio: Buffer, metadata: RecordingMetadata): Promise<RecordingResult> {
    if (!this.asr) throw Error("CONFIG_MISSING");
    const asr = this.asr;
    if (!Buffer.isBuffer(audio) || audio.length < 1 || audio.length > MAX_AUDIO) throw Error("PAYLOAD_TOO_LARGE");
    assertMetadata(metadata);
    const hash = bodyHash(audio, metadata);
    const result = await this.db.transaction(async c => {
      const binding = await deviceBinding(c, token);
      const principal = `binding:${binding.id}`;
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${principal}:recording`]);
      const old = await c.query(`SELECT body_hash,result FROM hc_idempotency WHERE principal=$1 AND operation='recording' AND client_request_id=$2 FOR UPDATE`, [principal, metadata.clientRequestId]);
      if (old.rowCount) {
        if (old.rows[0].body_hash !== hash) throw Error("IDEMPOTENCY_CONFLICT");
        return old.rows[0].result as RecordingResult;
      }
      const target = frozenTarget(metadata.target);
      const currentTarget = binding.active_task_ref as TaskRef;
      if (Number(metadata.bindingEpoch) !== Number(binding.epoch) || String(metadata.selectionRevision) !== String(binding.selection_revision) || target.connectorId !== currentTarget?.connectorId || target.projectId !== currentTarget?.projectId || target.threadId !== currentTarget?.threadId) throw Error("TARGET_MOVED");
      const grant = await c.query(`SELECT 1 FROM hc_grants WHERE binding_id=$1 AND connector_id=$2 AND project_id=$3 AND thread_id=$4`, [binding.id, target.connectorId, target.projectId, target.threadId]);
      if (!grant.rowCount) throw Error("TARGET_NOT_GRANTED");
      const recordingId = `rec-${randomUUID()}`;
      const result: RecordingResult = { recordingId, status: "processing", target, transcript: null };
      await c.query(`INSERT INTO hc_recordings(id,binding_id,binding_epoch,selection_revision,target,client_request_id,audio,status) VALUES($1,$2,$3,$4,$5,$6,$7,'processing')`, [recordingId, binding.id, Number(binding.epoch), String(binding.selection_revision), JSON.stringify(target), metadata.clientRequestId, audio]);
      await c.query(`INSERT INTO hc_idempotency(principal,operation,client_request_id,body_hash,result) VALUES($1,'recording',$2,$3,$4)`, [principal, metadata.clientRequestId, hash, JSON.stringify(result)]);
      return result;
    });
    void this.process(result.recordingId, asr);
    return result;
  }

  private async process(recordingId: string, asr: AsrAdapter) {
    let path: string | undefined;
    try {
      const row = await this.db.pool.query(`UPDATE hc_recordings SET worker_claimed_at=now(),updated_at=now() WHERE id=$1 AND status='processing' AND worker_claimed_at IS NULL RETURNING audio`, [recordingId]);
      if (!row.rowCount) return;
      path = join(tmpdir(), `hc-recording-${randomUUID()}.m4a`);
      await fs.writeFile(path, row.rows[0].audio);
      const out = await asr.transcribe(path);
      assertTranscript(out.transcript);
      await this.db.pool.query(`UPDATE hc_recordings SET status='ready',transcript=$2,provider_task_id=$3,updated_at=now() WHERE id=$1 AND status='processing'`, [recordingId, out.transcript, out.providerTaskId ?? null]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "ASR_FAILED";
      await this.db.pool.query(`UPDATE hc_recordings SET status='failed',transcript=NULL,updated_at=now() WHERE id=$1 AND status='processing'`, [recordingId]).catch(() => undefined);
      void message;
    } finally {
      if (path) await fs.rm(path, { force: true }).catch(() => undefined);
    }
  }

  async get(token: string, recordingId: string): Promise<RecordingResult> {
    const r = await this.db.pool.query(`SELECT r.recording_id FROM (SELECT id AS recording_id,binding_id FROM hc_recordings WHERE id=$1) r JOIN hc_bindings b ON b.id=r.binding_id WHERE b.device_token=$2 AND b.state='active'`, [recordingId, token]);
    if (!r.rowCount) throw Error("NOT_FOUND");
    const q = await this.db.pool.query(`SELECT id,status,target,transcript FROM hc_recordings WHERE id=$1`, [recordingId]);
    const x = q.rows[0];
    return { recordingId: x.id, status: x.status, target: x.target, transcript: x.transcript };
  }

  async cancel(token: string, recordingId: string) {
    return this.db.transaction(async c => {
      const r = await c.query(`SELECT r.*,b.device_token FROM hc_recordings r JOIN hc_bindings b ON b.id=r.binding_id WHERE r.id=$1 AND b.device_token=$2 AND b.state='active' FOR UPDATE`, [recordingId, token]);
      if (!r.rowCount) throw Error("NOT_FOUND");
      const x = r.rows[0];
      const submitted = await c.query(`SELECT 1 FROM hc_messages WHERE recording_id=$1 LIMIT 1`, [recordingId]);
      if (submitted.rowCount) throw Error("TARGET_MOVED");
      if (x.status === "processing" || x.status === "ready") await c.query(`UPDATE hc_recordings SET status='cancelled',updated_at=now() WHERE id=$1`, [recordingId]);
      return { recordingId, status: x.status === "cancelled" ? "cancelled" : (x.status === "processing" || x.status === "ready" ? "cancelled" : x.status) };
    });
  }
}

async function readBody(req: IncomingMessage, max = MAX_AUDIO + 128 * 1024) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += b.length; if (size > max) throw Error("PAYLOAD_TOO_LARGE"); chunks.push(b); }
  return Buffer.concat(chunks);
}
async function multipart(req: IncomingMessage) {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_AUDIO + 128 * 1024) throw Error("PAYLOAD_TOO_LARGE");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += b.length; if (size > MAX_AUDIO + 128 * 1024) throw Error("PAYLOAD_TOO_LARGE"); chunks.push(b); }
  const contentType = req.headers["content-type"] ?? "";
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType); if (!match) throw Error("INVALID_REQUEST");
  const boundary = Buffer.from(`--${match[1] ?? match[2]}`), body = Buffer.concat(chunks), first = body.indexOf(boundary);
  if (first !== 0) throw Error("INVALID_REQUEST");
  const parts: Array<{ headers: string; data: Buffer }> = []; let cursor = boundary.length;
  while (cursor < body.length) {
    if (body.subarray(cursor, cursor + 2).equals(Buffer.from("--"))) break;
    if (!body.subarray(cursor, cursor + 2).equals(Buffer.from("\r\n"))) throw Error("INVALID_REQUEST");
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), cursor + 2); if (headerEnd < 0) throw Error("INVALID_REQUEST");
    const next = body.indexOf(Buffer.from(`\r\n${boundary.toString()}`), headerEnd + 4); if (next < 0) throw Error("INVALID_REQUEST");
    parts.push({ headers: body.subarray(cursor + 2, headerEnd).toString("utf8"), data: body.subarray(headerEnd + 4, next) }); cursor = next + 2;
    if (body.subarray(cursor + boundary.length, cursor + boundary.length + 2).equals(Buffer.from("--"))) break;
    cursor += boundary.length;
  }
  let audio: Buffer | undefined, metadataText: string | undefined;
  for (const part of parts) { const name = /name="([^"]+)"/i.exec(part.headers)?.[1]; if (name === "audio") { if (!/filename="[^"]+\.m4a"/i.test(part.headers)) throw Error("INVALID_REQUEST"); audio = part.data; } else if (name === "metadata") metadataText = part.data.toString("utf8"); }
  if (!audio || metadataText === undefined) throw Error("INVALID_REQUEST");
  if (audio.length < 1 || audio.length > MAX_AUDIO) throw Error("PAYLOAD_TOO_LARGE");
  return { audio, metadata: JSON.parse(metadataText) as RecordingMetadata };
}

export async function handleRecordingRequest(db: PostgresStore, asr: AsrAdapter | undefined, req: IncomingMessage, res: ServerResponse, token: string, methodPath: string) {
  const recordings = new PgRecordings(db, asr);
  const requestId = randomUUID().replaceAll("-", "").slice(0, 32);
  const send = (status: number, value: unknown) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(apiOk(requestId, value))); };
  try {
    const get = /^\/v1\/device\/recordings\/([^/]+)$/.exec(methodPath), cancel = /^\/v1\/device\/recordings\/([^/]+)\/cancel$/.exec(methodPath);
    if (req.method === "POST" && methodPath === "/v1/device/recordings") { const parsed = await multipart(req); send(202, await recordings.upload(token, parsed.audio, parsed.metadata)); return true; }
    if (req.method === "GET" && get) { send(200, await recordings.get(token, decodeURIComponent(get[1]))); return true; }
    if (req.method === "POST" && cancel) { send(200, await recordings.cancel(token, decodeURIComponent(cancel[1]))); return true; }
    return false;
  } catch (error) { const code = error instanceof Error ? error.message : "INVALID_REQUEST"; const status = code === "UNAUTHORIZED" ? 401 : code === "NOT_FOUND" ? 404 : code === "TARGET_NOT_GRANTED" ? 403 : code === "PAYLOAD_TOO_LARGE" ? 413 : code === "CONFIG_MISSING" ? 503 : code === "IDEMPOTENCY_CONFLICT" || code === "TARGET_MOVED" ? 409 : 400; res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(apiError(requestId, code as any, code, status >= 500))); return true; }
}
