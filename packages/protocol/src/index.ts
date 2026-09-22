export const PROTOCOL = 'hc/1' as const;
export const LIMITS = { idBytes: 128, displayNameBytes: 120, summaryBytes: 384, requestIdLength: 32, pageSize: 5, maxPageSize: 20, transcriptBytes: 4096, resultBytes: 32768 } as const;

export type TaskStatus = 'idle'|'running'|'waiting_user'|'completed'|'failed'|'unknown';
export type LinkStatus = 'online'|'offline'|'auth_required'|'unsupported';
export type MessageStatus = 'accepted'|'waiting_connector'|'waiting_turn'|'dispatching'|'queued'|'running'|'completed'|'failed'|'uncertain'|'cancelled';
export type Grant = { connectorId: string; projectId: string; threadId: string };
export type TaskRef = Grant;
export type ProjectSummary = { projectId:string; connectorId:string; name:string; source:'local'|'projectless'; taskCount:number };
export type TaskSummary = { connectorId:string; projectId:string; threadId:string; title:string; titleSource:'codex'|'fallback'; status:TaskStatus; unread:boolean; revision:string; updatedAt:string };
export type ProtocolErrorCode = 'UNBOUND'|'BINDING_REVOKED'|'TARGET_NOT_GRANTED'|'TARGET_MOVED'|'TARGET_UNAVAILABLE'|'SELECTION_CONFLICT'|'CATALOG_CHANGED'|'CONNECTOR_OFFLINE'|'CODEX_UNSUPPORTED'|'ASR_FAILED'|'PAYLOAD_TOO_LARGE'|'DISPATCH_UNCERTAIN'|'IDEMPOTENCY_CONFLICT'|'INVALID_REQUEST'|'NOT_FOUND'|'UNAUTHORIZED'|'BUSY';
export type ApiSuccess<T> = { protocol:typeof PROTOCOL; requestId:string; data:T };
export type ApiFailure = { protocol:typeof PROTOCOL; requestId:string; error:{code:ProtocolErrorCode; message:string; retryable:boolean} };

export function apiOk<T>(requestId:string, data:T):ApiSuccess<T> { return { protocol:PROTOCOL, requestId, data }; }
export function apiError(requestId:string, code:ProtocolErrorCode, message:string, retryable=false):ApiFailure { return { protocol:PROTOCOL, requestId, error:{code,message,retryable} }; }
export function byteLength(value:string):number { return Buffer.byteLength(value, 'utf8'); }
export function assertId(value:string, field='id'):void { if (typeof value!=='string' || !value || byteLength(value)>LIMITS.idBytes) throw new Error(`${field} must be a non-empty string no longer than ${LIMITS.idBytes} UTF-8 bytes`); }
export function assertClientRequestId(value:string):void { if (!/^[0-9a-f]{32}$/i.test(value)) throw new Error('clientRequestId must be 32 hexadecimal characters'); }
export function assertTaskRef(ref:TaskRef):void { assertId(ref.connectorId,'connectorId'); assertId(ref.projectId,'projectId'); assertId(ref.threadId,'threadId'); }
export function nowIso():string { return new Date().toISOString(); }

export type CatalogSnapshot = { snapshotId:string; catalogVersion:string; projects:ProjectSummary[]; tasks:TaskSummary[] };
export type ConnectorEvent = { protocol:typeof PROTOCOL; eventId:string; seq:string; type:string; connectorId:string; sentAt:string; payload:Record<string,unknown> };
export type Command = { commandId:string; messageId:string; connectorId:string; bindingId:string; bindingEpoch:number; grantsVersion:string; target:TaskRef; text:string; state:'available'|'claimed'|'cancelled'|'completed'|'failed'|'uncertain'; executionId?:string; expiresAt:string };
