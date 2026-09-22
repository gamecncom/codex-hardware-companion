import { createHash, randomUUID } from 'node:crypto';
import { PostgresStore } from './pg-store.js';

export async function migrateCatalog(db: PostgresStore) {
  await db.pool.query(`CREATE TABLE IF NOT EXISTS hc_catalog_snapshots (
    binding_id text PRIMARY KEY, snapshot_id text NOT NULL, revision numeric NOT NULL,
    digest text NOT NULL, payload jsonb NOT NULL)`);
}

type Cursor = { snapshot: string; binding: string; kind: string; project: string; offset: number };

/** Persist the authorized directory as one version; cursors never cross bindings or snapshots. */
export async function catalogPage(db: PostgresStore, token: string, kind: 'projects' | 'tasks',
  project: string, limit: number, rawCursor: string | null) {
  return db.transaction(async c => {
    const binding = await c.query("SELECT id FROM hc_bindings WHERE device_token=$1 AND state='active' FOR UPDATE", [token]);
    if (!binding.rowCount) throw Error('UNAUTHORIZED');
    const bindingId = binding.rows[0].id;
    const projects = await c.query(`SELECT p.project_id,p.connector_id,p.name,p.source,
      COUNT(DISTINCT g.thread_id)::int task_count FROM hc_grants g
      JOIN projects p ON p.connector_id=g.connector_id AND p.project_id=g.project_id
      WHERE g.binding_id=$1 GROUP BY p.project_id,p.connector_id,p.name,p.source
      ORDER BY p.name,p.connector_id,p.project_id`, [bindingId]);
    const tasks = await c.query(`SELECT t.*,COALESCE(a.unread,false) AS unread FROM hc_grants g JOIN tasks t
      ON t.connector_id=g.connector_id AND t.project_id=g.project_id AND t.thread_id=g.thread_id
      LEFT JOIN hc_task_attention a ON a.binding_id=g.binding_id AND a.connector_id=t.connector_id
        AND a.project_id=t.project_id AND a.thread_id=t.thread_id
      WHERE g.binding_id=$1 ORDER BY t.updated_at DESC,t.connector_id,t.thread_id`, [bindingId]);
    const payload = {
      projects: projects.rows.map(x => ({ projectId: x.project_id, connectorId: x.connector_id,
        name: x.name, source: x.source, taskCount: x.task_count })),
      tasks: tasks.rows.map(x => ({ connectorId: x.connector_id, projectId: x.project_id,
        threadId: x.thread_id, title: x.title, titleSource: 'codex', status: x.status,
        unread: Boolean(x.unread), revision: String(x.revision), updatedAt: new Date(x.updated_at).toISOString() })),
    };
    const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const previous = await c.query('SELECT * FROM hc_catalog_snapshots WHERE binding_id=$1', [bindingId]);
    let snapshot = previous.rows[0];
    if (!snapshot || snapshot.digest !== digest) {
      const revision = snapshot ? (BigInt(snapshot.revision) + 1n).toString() : '1';
      snapshot = { snapshot_id: randomUUID(), revision, digest, payload };
      await c.query(`INSERT INTO hc_catalog_snapshots(binding_id,snapshot_id,revision,digest,payload)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(binding_id) DO UPDATE SET
        snapshot_id=$2,revision=$3,digest=$4,payload=$5`,
      [bindingId, snapshot.snapshot_id, revision, digest, JSON.stringify(payload)]);
    }
    let offset = 0;
    if (rawCursor) {
      let cursor: Cursor;
      try { cursor = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8')); }
      catch { throw Error('CATALOG_CHANGED'); }
      if (!cursor || cursor.snapshot !== snapshot.snapshot_id || cursor.binding !== bindingId ||
        cursor.kind !== kind || cursor.project !== project || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0)
        throw Error('CATALOG_CHANGED');
      offset = cursor.offset;
    }
    const all: any[] = kind === 'projects' ? snapshot.payload.projects :
      snapshot.payload.tasks.filter((task: any) => task.projectId === project);
    if (offset > all.length) throw Error('CATALOG_CHANGED');
    const encode = (next: number) => next < all.length ? Buffer.from(JSON.stringify({
      snapshot: snapshot.snapshot_id, binding: bindingId, kind, project, offset: next,
    })).toString('base64url') : undefined;
    const items: any[] = [];
    // Reserve 512 bytes for the protocol envelope; never truncate serialized JSON.
    for (const item of all.slice(offset, offset + Math.min(limit, 20))) {
      const candidate = { items: [...items, item], catalogVersion: String(snapshot.revision), nextCursor: encode(offset + items.length + 1) };
      if (Buffer.byteLength(JSON.stringify(candidate)) > 16 * 1024 - 512) break;
      items.push(item);
    }
    if (offset < all.length && !items.length) throw Error('PAYLOAD_TOO_LARGE');
    return { items, catalogVersion: String(snapshot.revision), nextCursor: encode(offset + items.length) };
  });
}
