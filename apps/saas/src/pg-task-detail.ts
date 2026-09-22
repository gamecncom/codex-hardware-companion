import { PostgresStore } from './pg-store.js';
import { paginateResult } from './view-renderer.js';

export type TaskDetailCapabilities = {
  list: boolean | 'unknown';
  read: boolean | 'unknown';
  enqueue: boolean | 'unknown';
  accountContextDetection: boolean | 'unknown';
  canSend: boolean | 'unknown';
  nativeApproval: false;
};

function taskCapabilities(raw: unknown): TaskDetailCapabilities {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const field = (name: string): boolean | 'unknown' => typeof value[name] === 'boolean' ? value[name] as boolean : 'unknown';
  const list = field('list'), read = field('read'), enqueue = field('enqueue'), accountContextDetection = field('accountContextDetection');
  const canSend = [list, read, enqueue, accountContextDetection].some(x => x === false)
    ? false
    : [list, read, enqueue, accountContextDetection].every(x => x === true) ? true : 'unknown';
  return { list, read, enqueue, accountContextDetection, canSend, nativeApproval: false };
}

export type TaskDetail = {
  target: { connectorId: string; projectId: string; threadId: string };
  title: string;
  status: string;
  resultRevision: string;
  pageCount: number;
  capabilities: TaskDetailCapabilities;
};

/** Read one exact, currently granted task through a binding device token. */
export async function getTaskDetail(
  db: PostgresStore,
  token: string,
  threadId: string,
  projectId?: string,
): Promise<TaskDetail> {
  if (!token || typeof threadId !== 'string' || !threadId || Buffer.byteLength(threadId, 'utf8') > 128 ||
      (projectId !== undefined && (typeof projectId !== 'string' || !projectId || Buffer.byteLength(projectId, 'utf8') > 128))) {
    throw Error('INVALID_REQUEST');
  }
  return db.transaction(async c => {
    const binding = await c.query(
      "SELECT id,connector_id FROM hc_bindings WHERE device_token=$1 AND state='active' FOR UPDATE",
      [token],
    );
    if (!binding.rowCount) throw Error('UNAUTHORIZED');
    const bindingId = binding.rows[0].id as string;
    const connectorId = binding.rows[0].connector_id as string;
    const result = await c.query(
      `SELECT t.connector_id,t.project_id,t.thread_id,t.title,t.status,t.revision,r.result_text,cs.capabilities
         FROM hc_grants g
         JOIN tasks t ON t.connector_id=g.connector_id AND t.project_id=g.project_id AND t.thread_id=g.thread_id
         LEFT JOIN hc_task_results r ON r.connector_id=t.connector_id AND r.project_id=t.project_id AND r.thread_id=t.thread_id
         LEFT JOIN hc_connector_channel_state cs ON cs.connector_id=t.connector_id
        WHERE g.binding_id=$1 AND g.connector_id=$2 AND g.thread_id=$3
          AND ($4::text IS NULL OR g.project_id=$4)`,
      [bindingId, connectorId, threadId, projectId ?? null],
    );
    if (!result.rowCount) throw Error('TARGET_NOT_GRANTED');
    if (result.rowCount !== 1) throw Error('INVALID_REQUEST');
    const row = result.rows[0];
    const text = typeof row.result_text === 'string' && row.result_text.length
      ? row.result_text
      : `当前状态：${row.status}。暂无回复正文。`;
    return {
      target: { connectorId: row.connector_id, projectId: row.project_id, threadId: row.thread_id },
      title: row.title,
      status: row.status,
      resultRevision: String(row.revision),
      pageCount: paginateResult(text).length,
      // Connector capability persistence is not part of the current PG schema.
      // Keep send capability explicit rather than manufacturing a positive claim.
      capabilities: taskCapabilities(row.capabilities),
    };
  });
}
