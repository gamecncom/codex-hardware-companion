import { randomUUID, createHash } from 'node:crypto';
import { PostgresStore } from './pg-store.js';

export interface DevicePairingOptions {
  publicBaseUrl?: string;
  deviceBootstraps?: Record<string, string>;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export async function migrateDevicePairings(db: PostgresStore) {
  await db.pool.query(`CREATE TABLE IF NOT EXISTS hc_device_pairings(
    id text PRIMARY KEY, device_id text NOT NULL, connector_id text,
    poll_secret_hash text NOT NULL, challenge text NOT NULL,
    expires_at timestamptz NOT NULL, claimed_at timestamptz, confirmed_at timestamptz, binding_id text,
    request_id text, poll_secret text, qr_url text);
    ALTER TABLE hc_device_pairings ALTER COLUMN connector_id DROP NOT NULL;
    ALTER TABLE hc_device_pairings ADD COLUMN IF NOT EXISTS request_id text;
    ALTER TABLE hc_device_pairings ADD COLUMN IF NOT EXISTS poll_secret text;
    ALTER TABLE hc_device_pairings ADD COLUMN IF NOT EXISTS qr_url text;
    ALTER TABLE hc_device_pairings ADD COLUMN IF NOT EXISTS computer_pairing_id text;
    CREATE UNIQUE INDEX IF NOT EXISTS hc_device_pairing_request ON hc_device_pairings(device_id,request_id)`);
}

export class PgDevicePairing {
  constructor(private db: PostgresStore, private options: DevicePairingOptions) {}
  private device(token: string) {
    if (!token) throw Error('UNAUTHORIZED');
    const matches = Object.entries(this.options.deviceBootstraps ?? {}).filter(([, secret]) => hash(secret) === hash(token));
    if (matches.length !== 1) throw Error('UNAUTHORIZED');
    return matches[0][0];
  }
  async start(token: string, requestId: string) {
    const deviceId = this.device(token);
    if (typeof requestId !== 'string' || !/^[a-f0-9]{32}$/i.test(requestId)) throw Error('INVALID_REQUEST');
    const base = this.options.publicBaseUrl;
    if (!base || !/^https?:\/\//.test(base)) throw Error('CONFIG_MISSING');
    return this.db.transaction(async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`device-pairing:${deviceId}`]);
      const old = await c.query('SELECT * FROM hc_device_pairings WHERE device_id=$1 AND request_id=$2', [deviceId, requestId]);
      let row = old.rows[0];
      if (!row) {
        const id = `dp-${randomUUID()}`, secret = randomUUID() + randomUUID(), challenge = randomUUID();
        const qr = new URL('/pair', base);
        qr.searchParams.set('devicePairingId', id);
        qr.searchParams.set('challenge', challenge);
        const inserted = await c.query(`INSERT INTO hc_device_pairings
          (id,device_id,poll_secret_hash,challenge,expires_at,request_id,poll_secret,qr_url)
          VALUES($1,$2,$3,$4,now()+interval '5 minutes',$5,$6,$7) RETURNING *`,
        [id, deviceId, hash(secret), challenge, requestId, secret, qr.toString()]);
        row = inserted.rows[0];
      }
      return { devicePairingId: row.id, pollSecret: row.poll_secret, qrUrl: row.qr_url,
        expiresAt: new Date(row.expires_at).toISOString() };
    });
  }
  async claim(sessionToken: string, id: string, code: string, challenge: string) {
    if (!sessionToken || typeof code !== 'string' || typeof challenge !== 'string') throw Error('UNAUTHORIZED');
    return this.db.transaction(async c => {
      const auth = await c.query('SELECT email FROM hc_auth WHERE session_hash=$1 AND session_expires_at>now()', [hash(sessionToken)]);
      if (!auth.rowCount) throw Error('UNAUTHORIZED');
      const device = await c.query('SELECT * FROM hc_device_pairings WHERE id=$1 AND challenge=$2 AND expires_at>now() FOR UPDATE', [id, challenge]);
      if (!device.rowCount) throw Error('UNAUTHORIZED');
      const computer = await c.query(`SELECT p.id,p.connector_id FROM hc_pairings p JOIN hc_connectors k ON k.id=p.connector_id
        WHERE p.code_hash=$1 AND p.expires_at>now() AND k.email=$2 AND
        (p.consumed_at IS NULL OR p.id=$3)`, [hash(code), auth.rows[0].email, device.rows[0].computer_pairing_id]);
      if (computer.rowCount !== 1) throw Error('UNAUTHORIZED');
      const chosen = computer.rows[0];
      if (device.rows[0].computer_pairing_id && device.rows[0].computer_pairing_id !== chosen.id) throw Error('PAIRING_CONFLICT');
      await c.query('UPDATE hc_device_pairings SET connector_id=$2,computer_pairing_id=$3,claimed_at=COALESCE(claimed_at,now()) WHERE id=$1',
        [id, chosen.connector_id, chosen.id]);
      return { status: 'approved', devicePairingId: id, connectorId: chosen.connector_id };
    });
  }
  async confirm(token: string, id: string, secret: string, requestId: string) {
    const deviceId = this.device(token);
    if (typeof secret !== 'string' || !secret) throw Error('UNAUTHORIZED');
    if (typeof requestId !== 'string' || !/^[a-f0-9]{32}$/i.test(requestId)) throw Error('INVALID_REQUEST');
    return this.db.transaction(async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`device-pairing:${deviceId}`]);
      const result = await c.query('SELECT * FROM hc_device_pairings WHERE id=$1 AND device_id=$2 AND poll_secret_hash=$3 FOR UPDATE', [id, deviceId, hash(secret)]);
      if (!result.rowCount) throw Error('UNAUTHORIZED');
      const row = result.rows[0];
      if (row.binding_id) {
        const bound = await c.query("SELECT * FROM hc_bindings WHERE id=$1 AND device_id=$2 AND state='active'", [row.binding_id, deviceId]);
        if (!bound.rowCount) throw Error('BINDING_REVOKED');
        return { bindingId: bound.rows[0].id, epoch: bound.rows[0].epoch, bindingToken: bound.rows[0].device_token };
      }
      if (!row.claimed_at || new Date(row.expires_at).getTime() <= Date.now()) throw Error('UNAUTHORIZED');
      const computer = await c.query(`SELECT p.*,k.email FROM hc_pairings p JOIN hc_connectors k ON k.id=p.connector_id
        WHERE p.id=$1 AND p.connector_id=$2 AND p.consumed_at IS NULL AND p.expires_at>now() FOR UPDATE OF p`,
        [row.computer_pairing_id, row.connector_id]);
      if (!computer.rowCount) throw Error('PAIRING_CONFLICT');
      const active = await c.query("SELECT id FROM hc_bindings WHERE device_id=$1 AND state='active'", [deviceId]);
      if (active.rowCount) throw Error('PAIRING_CONFLICT');
      const user = await c.query(`INSERT INTO hc_users(id,email) VALUES($1,$2)
        ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id`, [`user-${randomUUID()}`, computer.rows[0].email]);
      const bindingId = `bind-${randomUUID()}`, bindingToken = randomUUID() + randomUUID();
      await c.query(`INSERT INTO hc_bindings(id,user_id,device_id,connector_id,epoch,state,device_token)
        VALUES($1,$2,$3,$4,1,'active',$5)`, [bindingId, user.rows[0].id, deviceId, row.connector_id, bindingToken]);
      await c.query('UPDATE hc_pairings SET consumed_at=now() WHERE id=$1', [row.computer_pairing_id]);
      await c.query('UPDATE hc_device_pairings SET confirmed_at=now(),binding_id=$2 WHERE id=$1', [id, bindingId]);
      return { bindingId, epoch: 1, bindingToken };
    });
  }
  async recover(token:string,requestId:string){const deviceId=this.device(token);if(typeof requestId!=='string'||!/^[a-f0-9]{32}$/i.test(requestId))throw Error('INVALID_REQUEST');return this.db.transaction(async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`device-pairing:${deviceId}`]);const old=await c.query("SELECT result FROM hc_idempotency WHERE principal=$1 AND operation='binding-recover' AND client_request_id=$2",[`device:${deviceId}`,requestId]);if(old.rowCount){const saved=old.rows[0].result;const live=await c.query("SELECT id,epoch,device_token FROM hc_bindings WHERE device_id=$1 AND state='active' FOR UPDATE",[deviceId]);if(!live.rowCount)return {status:'unbound'};if(live.rows[0].id!==saved.bindingId||live.rows[0].epoch!==saved.epoch||live.rows[0].device_token!==saved.bindingToken)throw Error('SELECTION_CONFLICT');return saved;}const r=await c.query("SELECT id,epoch FROM hc_bindings WHERE device_id=$1 AND state='active' FOR UPDATE",[deviceId]);if(!r.rowCount){const out={status:'unbound'};return out;}const next=randomUUID()+randomUUID();await c.query('UPDATE hc_bindings SET device_token=$2 WHERE id=$1',[r.rows[0].id,next]);const out={status:'bound',bindingId:r.rows[0].id,epoch:r.rows[0].epoch,bindingToken:next};await c.query("INSERT INTO hc_idempotency(principal,operation,client_request_id,body_hash,result) VALUES($1,'binding-recover',$2,'recover',$3)",[ `device:${deviceId}`,requestId,JSON.stringify(out)]);return out;});}
  async poll(token: string, id: string, secret: string) {
    const deviceId = this.device(token);
    if (typeof secret !== 'string' || !secret) throw Error('UNAUTHORIZED');
    const result = await this.db.pool.query(`SELECT * FROM hc_device_pairings
      WHERE id=$1 AND device_id=$2 AND poll_secret_hash=$3 AND expires_at>now()`, [id, deviceId, hash(secret)]);
    if (!result.rowCount) throw Error('UNAUTHORIZED');
    const row = result.rows[0];
    return { status: row.confirmed_at ? 'confirmed' : row.claimed_at ? 'approved' : 'pending',
      expiresAt: new Date(row.expires_at).toISOString() };
  }
}
