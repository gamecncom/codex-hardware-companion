import { createHash } from 'node:crypto';
import { PostgresStore } from './pg-store.js';
import { getAlertSummary } from './pg-alerts.js';
export async function migrateDeviceState(db: PostgresStore) {
  await db.pool.query(`CREATE TABLE IF NOT EXISTS hc_server_meta(id integer PRIMARY KEY CHECK(id=1),server_epoch text NOT NULL);
    INSERT INTO hc_server_meta(id,server_epoch) VALUES(1,gen_random_uuid()::text) ON CONFLICT(id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS hc_device_state_versions(binding_id text PRIMARY KEY,digest text NOT NULL,revision numeric NOT NULL)`);
}
export async function getDeviceState(db: PostgresStore, token: string) {
  return db.transaction(async c => {
    const bound = await c.query("SELECT * FROM hc_bindings WHERE device_token=$1 AND state='active' FOR UPDATE", [token]);
    if (!bound.rowCount) throw Error('UNAUTHORIZED');
    const b = bound.rows[0];
    const meta = await c.query('SELECT server_epoch FROM hc_server_meta WHERE id=1');
    const catalog = await c.query('SELECT revision FROM hc_catalog_snapshots WHERE binding_id=$1', [b.id]);
    const channel = await c.query(`SELECT connected,last_seen_at FROM hc_connector_channel_state WHERE connector_id=$1`, [b.connector_id]);
    const lastSeen = channel.rows[0]?.last_seen_at ? new Date(channel.rows[0].last_seen_at).getTime() : 0;
    const linkStatus = channel.rows[0]?.connected && Date.now() - lastSeen <= 45_000 ? 'online' : 'offline';
    const attention = await getAlertSummary(c, b.id);
    let activeResultRevision: string | undefined;
    const active = b.active_task_ref;
    if (active && typeof active === 'object' && typeof active.connectorId === 'string' && typeof active.projectId === 'string' && typeof active.threadId === 'string') {
      const result = await c.query(`SELECT t.revision FROM hc_grants g JOIN tasks t
        ON t.connector_id=g.connector_id AND t.project_id=g.project_id AND t.thread_id=g.thread_id
        WHERE g.binding_id=$1 AND g.connector_id=$2 AND g.project_id=$3 AND g.thread_id=$4`,
        [b.id, active.connectorId, active.projectId, active.threadId]);
      if (result.rowCount && result.rows[0].revision !== null && result.rows[0].revision !== undefined)
        activeResultRevision = String(result.rows[0].revision);
    }
    const state = { bindingId: b.id, bindingEpoch: b.epoch, activeTaskRef: b.active_task_ref,
      selectionRevision: String(b.selection_revision), grantsVersion: String(b.grants_version),
      catalogVersion: String(catalog.rows[0]?.revision ?? '0'), serverEpoch: meta.rows[0].server_epoch,
      linkStatus, ...attention, ...(activeResultRevision === undefined ? {} : { activeResultRevision }) };
    const digest = createHash('sha256').update(JSON.stringify(state)).digest('hex');
    const old = await c.query('SELECT digest,revision FROM hc_device_state_versions WHERE binding_id=$1', [b.id]);
    const revision = old.rowCount ? (BigInt(old.rows[0].revision) + (old.rows[0].digest === digest ? 0n : 1n)).toString() : '1';
    if (!old.rowCount || old.rows[0].digest !== digest) {
      await c.query(`INSERT INTO hc_device_state_versions(binding_id,digest,revision) VALUES($1,$2,$3)
        ON CONFLICT(binding_id) DO UPDATE SET digest=$2,revision=$3`, [b.id, digest, revision]);
    }
    return { ...state, revision };
  });
}
