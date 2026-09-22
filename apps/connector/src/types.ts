export type TaskStatus = 'idle'|'running'|'waiting_user'|'completed'|'failed'|'unknown';
export interface Capabilities { list: boolean; read: boolean; enqueue: boolean; accountContextDetection: boolean; nativeApproval: false; version: string; binary: string; }
export interface ThreadSummary { threadId: string; title: string; titleSource: 'codex'|'fallback'; cwd?: string; status: TaskStatus; updatedAt?: string; source?: string; }
export interface ThreadPage { data: ThreadSummary[]; nextCursor?: string; }
export interface ThreadSnapshot { threadId: string; cwd?: string; title?: string; turns: unknown[]; status: TaskStatus; raw: unknown; }
export interface QueueReceipt { accepted: boolean; queueId?: string; raw: string; status: 'queued'|'uncertain'; }
export interface IdentityContext { available: boolean; fingerprint?: string; source: 'app-server'|'unavailable'; }
export interface CodexAdapter { detect(): Promise<Capabilities>; listThreads(cursor?: string): Promise<ThreadPage>; readThread(threadId: string): Promise<ThreadSnapshot>; enqueue(threadId: string, text: string, originalCwd: string): Promise<QueueReceipt>; readIdentity(): Promise<IdentityContext>; close(): Promise<void>; }
