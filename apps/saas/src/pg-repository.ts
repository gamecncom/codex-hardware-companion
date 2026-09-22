import type pg from "pg";
import { randomUUID, createHash, randomInt } from "node:crypto";
import { PostgresStore } from "./pg-store.js";
import { migrateCatalog } from "./pg-catalog.js";
import { migrateDevicePairings } from './pg-device-pairing.js';
import { migrateConnectorLogins } from './pg-connector-login.js';
import { migrateDeviceState } from './pg-device-state.js';
import { migrateDeviceViews } from './pg-device-view.js';
import { migratePgChannel } from './pg-channel.js';
import { migrateDeviceManagement } from './pg-device-management.js';
import { migrateRecordings } from './pg-recordings.js';
import { migrateMessages } from './pg-messages.js';
import { migrateAlerts } from './pg-alerts.js';
import { migrateV03 } from './pg-v03.js';
const crypto = { randomInt };
/** SQL-owned business repository. Every mutation runs inside one DB transaction; no in-memory snapshot is used. */
export class PgBusinessRepository {
  constructor(public db: PostgresStore) {}
  async migrate() {
    await this.db.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('hardware-companion-schema-v03'))");
      // All migration helpers only need query(); use this transaction's connection,
      // so concurrent process startup cannot race CREATE TABLE in pg_catalog.
      const migrationDb = { pool: client } as unknown as PostgresStore;
      await new PgBusinessRepository(migrationDb).migrateUnlocked();
    });
  }
  private async migrateUnlocked() {
    await this.db.pool.query(
      `CREATE TABLE IF NOT EXISTS projects(connector_id text not null,project_id text not null,name text not null,source text not null,primary key(connector_id,project_id));CREATE TABLE IF NOT EXISTS tasks(connector_id text not null,thread_id text not null,project_id text not null,title text not null,status text not null,revision numeric not null,updated_at timestamptz not null,primary key(connector_id,thread_id));CREATE TABLE IF NOT EXISTS hc_users(id text primary key,email text unique not null,created_at timestamptz not null default now());CREATE TABLE IF NOT EXISTS hc_bindings(id text primary key,user_id text not null,device_id text not null,connector_id text not null,epoch integer not null,state text not null,selection_revision numeric not null default 0,grants_version numeric not null default 0,active_task_ref jsonb,device_token text not null);CREATE TABLE IF NOT EXISTS hc_grants(binding_id text not null,connector_id text not null,project_id text not null,thread_id text not null,primary key(binding_id,connector_id,project_id,thread_id));CREATE TABLE IF NOT EXISTS hc_idempotency(principal text not null,operation text not null,client_request_id text not null,body_hash text not null,result jsonb not null,primary key(principal,operation,client_request_id));CREATE TABLE IF NOT EXISTS hc_messages(id text primary key,binding_id text not null,target jsonb not null,recording_id text not null,status text not null,command_id text unique,execution_id text);`,
    );
    await this.db.pool.query("CREATE TABLE IF NOT EXISTS hc_connectors(id text primary key,email text not null,name text not null,token_hash text not null)");
    await this.migrateAuth();
    await this.migratePairingSchema();
    await migrateCatalog(this.db);
    await migrateDevicePairings(this.db);
    await migrateConnectorLogins(this.db);
    await migrateDeviceState(this.db);
    await migrateDeviceViews(this.db);
    await migratePgChannel(this.db);
    await migrateDeviceManagement(this.db);
    await migrateRecordings(this.db);
    await migrateMessages(this.db);
    await migrateAlerts(this.db);
    await migrateV03(this.db);
    await this.db.pool.query("ALTER TABLE hc_pairings ADD COLUMN IF NOT EXISTS preset_version numeric NOT NULL DEFAULT 0");
  }
  async createBinding(
    userId: string,
    connectorId: string,
    deviceId: string,
    deviceToken: string,
  ) {
    return this.db.transaction(async (c) => {
      const id = `bind-${randomUUID()}`;
      await c.query(
        "INSERT INTO hc_bindings(id,user_id,device_id,connector_id,epoch,state,device_token) VALUES($1,$2,$3,$4,1,$5,$6)",
        [id, userId, deviceId, connectorId, "active", deviceToken],
      );
      return {
        id,
        userId,
        connectorId,
        deviceId,
        epoch: 1,
        state: "active",
        selectionRevision: "0",
        grantsVersion: "0",
        deviceToken,
      };
    });
  }
  async setGrants(
    bindingId: string,
    refs: Array<{
      connectorId: string;
      projectId: string;
      threadId: string;
    }>,
    expected: string,
    clientRequestId: string,
  ) {
    return this.db.transaction(async (c) => {
      const old = await c.query(
        "SELECT result,body_hash FROM hc_idempotency WHERE principal=$1 AND operation=$2 AND client_request_id=$3 FOR UPDATE",
        ["binding:" + bindingId, "grants", clientRequestId],
      );
      if (old.rowCount) return old.rows[0].result;
      const b = await c.query(
        "SELECT grants_version FROM hc_bindings WHERE id=$1 AND state=$2 FOR UPDATE",
        [bindingId, "active"],
      );
      if (!b.rowCount || String(b.rows[0].grants_version) !== expected)
        throw new Error("CATALOG_CHANGED");
      await c.query("DELETE FROM hc_grants WHERE binding_id=$1", [bindingId]);
      for (const r of refs)
        await c.query("INSERT INTO hc_grants VALUES($1,$2,$3,$4)", [
          bindingId,
          r.connectorId,
          r.projectId,
          r.threadId,
        ]);
      const result = {
        grantsVersion: String(Number(expected) + 1),
        grants: refs,
      };
      await c.query("UPDATE hc_bindings SET grants_version=$2 WHERE id=$1", [
        bindingId,
        result.grantsVersion,
      ]);
      await c.query("INSERT INTO hc_idempotency VALUES($1,$2,$3,$4,$5)", [
        `binding:${bindingId}`,
        "grants",
        clientRequestId,
        "sql",
        JSON.stringify(result),
      ]);
      return result;
    });
  }
  async migrateAuth() {
    await this.db.pool.query(
      `CREATE TABLE IF NOT EXISTS hc_auth(email text primary key,code_hash text,code_expires_at timestamptz,code_consumed_at timestamptz,session_hash text,session_expires_at timestamptz)`,
    );
  }
  async emailStart(
    email: string,
    provider: {
      send(email: string, code: string): Promise<void>;
    },
  ) {
    const code = String(Math.floor(100000 + Math.random() * 900000)),
      hash = createHash("sha256").update(code).digest("hex");
    await this.db.pool.query(
      `INSERT INTO hc_auth(email,code_hash,code_expires_at) VALUES($1,$2,now()+interval '10 minutes') ON CONFLICT(email) DO UPDATE SET code_hash=$2,code_expires_at=now()+interval '10 minutes',code_consumed_at=NULL`,
      [email.toLowerCase(), hash],
    );
    await provider.send(email, code);
    return { status: "sent" };
  }
  async emailVerify(email: string, code: string) {
    const h = createHash("sha256").update(code).digest("hex"),
      s = `sess-${randomUUID()}${randomUUID()}`,
      sh = createHash("sha256").update(s).digest("hex");
    const r = await this.db.pool.query(
      `UPDATE hc_auth SET code_consumed_at=now(),session_hash=$2,session_expires_at=now()+interval '30 days' WHERE email=$1 AND code_hash=$3 AND code_consumed_at IS NULL AND code_expires_at>now() RETURNING email`,
      [email.toLowerCase(), sh, h],
    );
    if (!r.rowCount) throw Error("UNAUTHORIZED");
    return { sessionToken: s };
  }
  async health() {
    return this.db.health();
  }
  async migratePairingSchema() {
    await this.db.pool.query(
      `CREATE TABLE IF NOT EXISTS hc_pairings(id text primary key,connector_id text not null,code_hash text not null,code text not null,expires_at timestamptz not null,consumed_at timestamptz,request_id text);ALTER TABLE hc_pairings DROP CONSTRAINT IF EXISTS hc_pairings_request_id_key;CREATE UNIQUE INDEX IF NOT EXISTS hc_pairings_connector_request_uq ON hc_pairings(connector_id,request_id)`,
    );
  }
  async registerConnector(sessionToken: string, name: string) {
    const h = createHash("sha256").update(sessionToken).digest("hex");
    const a = await this.db.pool.query(
      "SELECT email FROM hc_auth WHERE session_hash=$1 AND session_expires_at>now()",
      [h],
    );
    if (!a.rowCount) throw Error("UNAUTHORIZED");
    const id = `cn-${randomUUID()}`,
      token = randomUUID() + randomUUID();
    await this.db.pool.query("INSERT INTO hc_connectors VALUES($1,$2,$3,$4)", [
      id,
      a.rows[0].email,
      name,
      createHash("sha256").update(token).digest("hex"),
    ]);
    return { connectorId: id, token };
  }
  async createPairing(connectorToken: string, requestId: string) {
    const h = createHash("sha256").update(connectorToken).digest("hex");
    const c = await this.db.pool.query(
      "SELECT id FROM hc_connectors WHERE token_hash=$1",
      [h],
    );
    if (!c.rowCount) throw Error("UNAUTHORIZED");
    const old = await this.db.pool.query(
      "SELECT id,code,expires_at FROM hc_pairings WHERE connector_id=$1 AND request_id=$2",
      [c.rows[0].id, requestId],
    );
    if (old.rowCount)
      return {
        pairingId: old.rows[0].id,
        code: old.rows[0].code,
        expiresAt: old.rows[0].expires_at,
      };
    const code = String(crypto.randomInt(100000, 1000000)),
      id = `pair-${randomUUID()}`,
      exp = new Date(Date.now() + 300000);
    await this.db.pool.query(
      "INSERT INTO hc_pairings VALUES($1,$2,$3,$4,$5,NULL,$6)",
      [
        id,
        c.rows[0].id,
        createHash("sha256").update(code).digest("hex"),
        code,
        exp,
        requestId,
      ],
    );
    return { pairingId: id, code, expiresAt: exp.toISOString() };
  }
  async listTasks(bindingToken: string, projectId: string, limit = 5) {
    return this.db.pool.query(
      `SELECT t.connector_id,t.project_id,t.thread_id,t.title,t.status,t.revision,t.updated_at FROM hc_bindings b JOIN hc_grants g ON g.binding_id=b.id JOIN tasks t ON t.connector_id=g.connector_id AND t.project_id=g.project_id AND t.thread_id=g.thread_id WHERE b.device_token=$1 AND b.state='active' AND t.project_id=$2 ORDER BY t.updated_at DESC LIMIT $3`,
      [bindingToken, projectId, Math.min(limit, 20)],
    );
  }
  async select(
    bindingToken: string,
    ref: {
      connectorId: string;
      projectId: string;
      threadId: string;
    },
    expected: string,
    requestId: string,
  ) {
    return this.db.transaction(async (c) => {
      const b = await c.query(
        `SELECT id,selection_revision FROM hc_bindings WHERE device_token=$1 AND state='active' FOR UPDATE`,
        [bindingToken],
      );
      if (!b.rowCount) throw Error("UNAUTHORIZED");
      const hash = createHash("sha256")
        .update(JSON.stringify({ ref, expected }))
        .digest("hex");
      const old = await c.query(
        `SELECT result,body_hash FROM hc_idempotency WHERE principal=$1 AND operation='selection' AND client_request_id=$2`,
        [bindingToken, requestId],
      );
      if (old.rowCount) {
        if (old.rows[0].body_hash !== hash) throw Error("IDEMPOTENCY_CONFLICT");
        return old.rows[0].result;
      }
      if (BigInt(b.rows[0].selection_revision) !== BigInt(expected))
        throw Error("SELECTION_CONFLICT");
      const g = await c.query(
        `SELECT 1 FROM hc_grants WHERE binding_id=$1 AND connector_id=$2 AND project_id=$3 AND thread_id=$4`,
        [b.rows[0].id, ref.connectorId, ref.projectId, ref.threadId],
      );
      if (!g.rowCount) throw Error("TARGET_NOT_GRANTED");
      const next = (BigInt(expected) + 1n).toString();
      const result = { activeTaskRef: ref, selectionRevision: next };
      await c.query(
        `UPDATE hc_bindings SET active_task_ref=$2,selection_revision=$3 WHERE id=$1`,
        [b.rows[0].id, JSON.stringify(ref), next],
      );
      await c.query(
        `INSERT INTO hc_idempotency(principal,operation,client_request_id,body_hash,result) VALUES($1,'selection',$2,$3,$4)`,
        [bindingToken, requestId, hash, JSON.stringify(result)],
      );
      return result;
    });
  }
}
