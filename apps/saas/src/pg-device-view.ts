import { randomUUID } from 'node:crypto';
import { PostgresStore } from './pg-store.js';
import { catalogPage } from './pg-catalog.js';
import { renderDeviceJpeg, paginateResult, compactDetailLines, compactStatusLabel, type DeviceViewDescriptor } from './view-renderer.js';
import { getAlertSummary } from './pg-alerts.js';

export interface DeviceViewQuery { kind: 'projects' | 'tasks' | 'detail' | 'transcript'; projectId?: string; threadId?: string; recordingId?: string; page?: number; choice?: number; cursor?: string | null; limit?: number; layout?: 'compact'; }

export async function migrateDeviceViews(db: PostgresStore) {
  await db.pool.query(`CREATE TABLE IF NOT EXISTS hc_device_views(
    view_id text PRIMARY KEY, binding_id text NOT NULL, descriptor jsonb NOT NULL,
    jpeg bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
  ); CREATE INDEX IF NOT EXISTS hc_device_views_binding_idx ON hc_device_views(binding_id)`);
}

export async function createDeviceView(db: PostgresStore, token: string, query: DeviceViewQuery) {
  if (query?.kind === 'detail') return createDetailView(db, token, query);
  if (query?.kind === 'transcript') return createTranscriptView(db, token, query);
  if (!token || !query || !['projects', 'tasks'].includes(query.kind)) throw Error('INVALID_REQUEST');
  if (query.kind === 'tasks' && !query.projectId) throw Error('INVALID_REQUEST');
  const limit = query.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw Error('INVALID_REQUEST');
  const page = await catalogPage(db, token, query.kind, query.projectId ?? '', limit, query.cursor ?? null);
  const epochResult = await db.pool.query('SELECT server_epoch FROM hc_server_meta LIMIT 1');
  if (!epochResult.rowCount) throw Error('CONFIG_MISSING');
  return db.transaction(async (c) => {
    const binding = await c.query("SELECT id FROM hc_bindings WHERE device_token=$1 AND state='active'", [token]);
    if (!binding.rowCount) throw Error('UNAUTHORIZED');
    const bindingId = binding.rows[0].id as string;
    const choice = Number.isInteger(query.choice) && (query.choice as number) >= 0 && (query.choice as number) < page.items.length ? query.choice as number : 0;
    const selected = page.items[choice];
    const items = page.items.map((item: any) => query.kind === 'projects'
      ? { id: `${item.connectorId}:${item.projectId}`, label: item.name, action: 'open', projectId: item.projectId, connectorId: item.connectorId }
      : { id: item.threadId, label: item.title, action: 'open', threadId: item.threadId, projectId: item.projectId, connectorId: item.connectorId });
    const viewId = `view-${randomUUID()}`;
    const descriptor: DeviceViewDescriptor = { viewId, serverEpoch: String(epochResult.rows[0].server_epoch), revision: page.catalogVersion, screen: query.kind, kind: query.kind, choice, catalogVersion: page.catalogVersion, items, nextCursor: page.nextCursor, jpegPath: `/v1/device/views/${viewId}.jpg`, ...(selected?.threadId ? { target: { connectorId: selected.connectorId, projectId: selected.projectId, threadId: selected.threadId } } : {}) };
    const jpeg = await renderDeviceJpeg(descriptor);
    await c.query('INSERT INTO hc_device_views(view_id,binding_id,descriptor,jpeg) VALUES($1,$2,$3,$4)', [viewId, bindingId, JSON.stringify(descriptor), jpeg]);
    return descriptor;
  });
}

async function createTranscriptView(db: PostgresStore, token: string, query: DeviceViewQuery) {
  if (!token || !query.recordingId || typeof query.recordingId !== 'string' || query.recordingId.length > 128) throw Error('INVALID_REQUEST');
  const page = query.page ?? 0;
  if (!Number.isInteger(page) || page < 0) throw Error('INVALID_REQUEST');
  return db.transaction(async c => {
    const binding = await c.query("SELECT id,connector_id FROM hc_bindings WHERE device_token=$1 AND state='active' FOR UPDATE", [token]);
    if (!binding.rowCount) throw Error('UNAUTHORIZED');
    const b = binding.rows[0];
    const recording = await c.query(`SELECT id,status,target,transcript,binding_epoch,selection_revision
      FROM hc_recordings WHERE id=$1 AND binding_id=$2`, [query.recordingId, b.id]);
    if (!recording.rowCount) throw Error('NOT_FOUND');
    const row = recording.rows[0];
    if (row.status !== 'ready' || typeof row.transcript !== 'string') throw Error('RECORDING_NOT_READY');
    const target = row.target as { connectorId?: string; projectId?: string; threadId?: string };
    const connectorId = target?.connectorId;
    if (connectorId !== b.connector_id || typeof connectorId !== 'string' || typeof target.projectId !== 'string' || typeof target.threadId !== 'string') throw Error('TARGET_MOVED');
    const pages = paginateResult(row.transcript);
    if (page >= pages.length) throw Error('INVALID_REQUEST');
    const meta = await c.query('SELECT server_epoch FROM hc_server_meta WHERE id=1');
    if (!meta.rowCount) throw Error('CONFIG_MISSING');
    const viewId = `view-${randomUUID()}`;
    const frozenTarget = { connectorId, projectId: target.projectId, threadId: target.threadId };
    const descriptor: DeviceViewDescriptor = {
      viewId,
      serverEpoch: String(meta.rows[0].server_epoch),
      revision: String(row.selection_revision),
      screen: 'transcript',
      kind: 'transcript',
      choice: 0,
      catalogVersion: String(row.binding_epoch),
      recordingId: row.id,
      target: frozenTarget,
      page,
      pageCount: pages.length,
      textLines: pages[page],
      items: [
        { id: 'confirm', label: '确认发送', action: 'confirm' },
        { id: 'cancel', label: '取消录音', action: 'cancel' },
      ],
      jpegPath: `/v1/device/views/${viewId}.jpg`,
    };
    const jpeg = await renderDeviceJpeg(descriptor);
    if (jpeg.length > 150 * 1024) throw Error('PAYLOAD_TOO_LARGE');
    await c.query('INSERT INTO hc_device_views(view_id,binding_id,descriptor,jpeg) VALUES($1,$2,$3,$4)',
      [viewId, b.id, JSON.stringify(descriptor), jpeg]);
    return descriptor;
  });
}

async function createDetailView(db: PostgresStore, token: string, query: DeviceViewQuery) {
  const page = query.page ?? 0;
  if (!query.projectId || !query.threadId || !Number.isInteger(page) || page < 0) throw Error('INVALID_REQUEST');
  return db.transaction(async c => {
    const binding = await c.query("SELECT id,connector_id FROM hc_bindings WHERE device_token=$1 AND state='active' FOR UPDATE", [token]);
    if (!binding.rowCount) throw Error('UNAUTHORIZED');
    const b = binding.rows[0];
    const result = await c.query(`SELECT t.*,r.result_text FROM hc_grants g JOIN tasks t
      ON t.connector_id=g.connector_id AND t.project_id=g.project_id AND t.thread_id=g.thread_id
      LEFT JOIN hc_task_results r ON r.connector_id=t.connector_id AND r.project_id=t.project_id AND r.thread_id=t.thread_id
      WHERE g.binding_id=$1 AND g.connector_id=$2 AND g.project_id=$3 AND g.thread_id=$4`,
      [b.id, b.connector_id, query.projectId, query.threadId]);
    if (!result.rowCount) throw Error('TARGET_NOT_GRANTED');
    const row = result.rows[0];
    const compact = query.layout === 'compact';
    const pages = compact ? [compactDetailLines(row.result_text || `当前状态：${row.status}。暂无回复正文。`)] : paginateResult(row.result_text || `当前状态：${row.status}。暂无回复正文。`);
    if (!compact && page >= pages.length) throw Error('INVALID_REQUEST');
    const meta = await c.query('SELECT server_epoch FROM hc_server_meta WHERE id=1');
    const catalog = await c.query('SELECT revision FROM hc_catalog_snapshots WHERE binding_id=$1', [b.id]);
    const attention = compact ? await getAlertSummary(c, b.id) : undefined;
    const viewId = `view-${randomUUID()}`;
    const descriptor: DeviceViewDescriptor = { viewId, serverEpoch: meta.rows[0].server_epoch,
      revision: String(row.revision), resultRevision: String(row.revision), screen: 'detail', kind: 'detail',
      title: row.title, choice: 0, catalogVersion: String(catalog.rows[0]?.revision ?? '0'),
      target: { connectorId: row.connector_id, projectId: row.project_id, threadId: row.thread_id },
      ...(compact ? { layout: 'compact' as const, status: compactStatusLabel(row.status), unreadCount: attention!.unreadCount, page: 0, pageCount: 1, textLines: pages[0] } : { page, pageCount: pages.length, textLines: pages[page] }), items: [], jpegPath: `/v1/device/views/${viewId}.jpg` };
    const jpeg = await renderDeviceJpeg(descriptor);
    if (jpeg.length > 150 * 1024) throw Error('PAYLOAD_TOO_LARGE');
    await c.query('INSERT INTO hc_device_views(view_id,binding_id,descriptor,jpeg) VALUES($1,$2,$3,$4)',
      [viewId, b.id, JSON.stringify(descriptor), jpeg]);
    return descriptor;
  });
}

export async function readDeviceJpeg(db: PostgresStore, token: string, viewId: string): Promise<Buffer> {
  const result = await db.pool.query(`SELECT v.jpeg FROM hc_device_views v JOIN hc_bindings b ON b.id=v.binding_id
    WHERE v.view_id=$1 AND b.device_token=$2 AND b.state='active'`, [viewId, token]);
  if (!result.rowCount) throw Error('UNAUTHORIZED');
  return Buffer.isBuffer(result.rows[0].jpeg) ? result.rows[0].jpeg : Buffer.from(result.rows[0].jpeg);
}
