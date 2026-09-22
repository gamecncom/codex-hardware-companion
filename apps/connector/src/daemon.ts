import { randomBytes } from 'node:crypto';
import type { CodexAdapter, IdentityContext } from './types.js';
import { CompanionHttpClient } from './httpClient.js';
import { ExecutionLedger } from './ledger.js';
import type { WssTransport } from './wssTransport.js';
import { normalizeMessageText, normalizeThread } from './threadNormalize.js';

export interface DaemonOptions { client: CompanionHttpClient; adapter: CodexAdapter; ledger: ExecutionLedger; connectionEpoch: string; expectedIdentityFingerprint?: string; pollMs?: number; catalogPollMs?: number; commandSource?: () => Promise<any[]>; transport?: WssTransport; syncOnConnect?: () => Promise<unknown>; isAuthorizedTarget?: (target: any, cwd: string) => Promise<boolean> | boolean; }
type Monitor = { projectId?: string; lastRevision: string; baselineTurnId?: string; expectedText?: string; executionId?: string; messageId?: string; commandId?: string };
type Waiting = { commandId: string; messageId: string; executionId: string; threadId: string; projectId?: string; text: string; target: any };

export class CompanionDaemon {
  private timer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private stopping = false;
  private paused = false;
  private lastCatalog = 0;
  private inFlight?: Promise<void>;
  private restorePromise?: Promise<void>;
  private pending = new Set<string>();
  private monitor = new Map<string, Monitor[]>();
  private waiting = new Map<string, Waiting>();
  private blockedThreads = new Set<string>();
  private helloInFlight?: Promise<void>;

  constructor(readonly options: DaemonOptions) {}

  start() {
    if (this.timer || this.stopping) return;
    this.ensureRestored();
    this.options.transport?.connect();
    this.options.transport?.on('open', () => { void this.sendHello(); void this.options.syncOnConnect?.(); });
    this.options.transport?.on('message', (message: any) => {
      if (message?.type === 'connector.welcome' && message.payload?.connectionEpoch) this.options.connectionEpoch = String(message.payload.connectionEpoch);
      if (message?.type === 'command.available' && message.payload?.commandId) { this.pending.add(String(message.payload.commandId)); void this.tick(); }
    });
    this.heartbeat = setInterval(() => { if (!this.stopping && this.options.transport) try { this.options.transport.send({ protocol: 'hc/1', type: 'heartbeat', seq: String(Date.now()) }); } catch {} }, 10000);
    this.timer = setInterval(() => void this.tick(), this.options.pollMs ?? 2000);
    void this.tick();
  }

  private async sendHello() {
    if (!this.options.transport || this.helloInFlight) return this.helloInFlight;
    this.helloInFlight = (async () => {
      let capabilities: any;
      try {
        const detected = await this.options.adapter.detect();
        capabilities = { list: Boolean(detected.list), read: Boolean(detected.read), enqueue: Boolean(detected.enqueue), accountContextDetection: typeof detected.accountContextDetection === 'boolean' ? detected.accountContextDetection : 'unknown', nativeApproval: false, version: detected.version || 'unknown' };
      } catch {
        capabilities = { list: 'unknown', read: 'unknown', enqueue: 'unknown', accountContextDetection: 'unknown', nativeApproval: false, version: 'unknown' };
      }
      this.options.transport?.send({ protocol: 'hc/1', type: 'connector.hello', payload: { capabilities } });
    })().finally(() => { this.helloInFlight = undefined; });
    return this.helloInFlight;
  }

  private ensureRestored() {
    if (this.restorePromise) return this.restorePromise;
    if (typeof (this.options.ledger as any).list !== 'function') { this.restorePromise = Promise.resolve(); return this.restorePromise; }
    this.restorePromise = this.options.ledger.list().then((rows: any[]) => {
      for (const row of rows) {
        if (['queued', 'running', 'uncertain'].includes(row.state)) {
          const list = this.monitor.get(row.threadId) ?? [];
          if (!list.some(item => item.executionId === row.executionId)) list.push({ projectId: row.projectId, lastRevision: row.baselineRevision ?? '', baselineTurnId: row.baselineTurnId, expectedText: row.text, executionId: row.executionId, messageId: row.messageId, commandId: row.commandId });
          this.monitor.set(row.threadId, list);
          if (row.state === 'uncertain') this.blockedThreads.add(row.threadId);
        } else if (row.state === 'waiting_turn' && row.commandId && row.executionId && row.text) {
          this.waiting.set(row.commandId, { commandId: row.commandId, messageId: row.messageId, executionId: row.executionId, threadId: row.threadId, projectId: row.projectId, text: row.text, target: { threadId: row.threadId, projectId: row.projectId } });
        } else if (row.state === 'dispatching') this.blockedThreads.add(row.threadId);
      }
    });
    return this.restorePromise;
  }

  private async identityOk() {
    const identity: IdentityContext = await this.options.adapter.readIdentity();
    if (!identity.available || !identity.fingerprint) { this.paused = true; this.options.transport?.send({ protocol: 'hc/1', type: 'connector.identity_required', payload: { reason: 'identity_unavailable' } }); return false; }
    if (this.options.expectedIdentityFingerprint && identity.fingerprint !== this.options.expectedIdentityFingerprint) { this.paused = true; this.options.transport?.send({ protocol: 'hc/1', type: 'connector.identity_changed', payload: { reason: 'identity_changed' } }); return false; }
    this.paused = false; return true;
  }

  private isBusy(threadId: string, snapshot: any) { return this.blockedThreads.has(threadId) || (this.monitor.get(threadId) ?? []).some(item => item.executionId !== undefined) || ['running', 'busy', 'processing', 'waiting_user', 'waiting_turn', 'queued'].includes(String(snapshot?.status ?? '')); }

  private async enqueue(claimed: any, executionId: string, snapshot: any, baseline: any, commandId: string) {
    const receipt = await this.options.adapter.enqueue(claimed.target.threadId, claimed.text, snapshot.cwd);
    await this.options.ledger.update(executionId, { state: receipt.status, queueId: receipt.queueId });
    if (receipt.accepted || receipt.status === 'uncertain') {
      const list = this.monitor.get(claimed.target.threadId) ?? [];
      list.push({ projectId: claimed.target.projectId, lastRevision: baseline.resultRevision, baselineTurnId: baseline.lastTurnId, expectedText: claimed.text, executionId, messageId: claimed.messageId, commandId });
      this.monitor.set(claimed.target.threadId, list);
      if (receipt.status !== 'uncertain') this.blockedThreads.delete(claimed.target.threadId);
    }
    this.options.transport?.send({ protocol: 'hc/1', type: receipt.accepted ? 'command.queued' : 'command.uncertain', payload: { commandId, executionId, queueId: receipt.queueId } });
  }

  private async persistWaiting(claimed: any) {
    const snapshot = await this.options.adapter.readThread(claimed.target.threadId);
    if (!snapshot.cwd) return;
    const baseline = normalizeThread(snapshot);
    const entry = await this.options.ledger.begin(claimed.messageId, claimed.target.threadId, claimed.text, snapshot.cwd, claimed.executionId, claimed.target.projectId, baseline.resultRevision, baseline.lastTurnId, claimed.commandId);
    await this.options.ledger.update(entry.executionId, { state: 'waiting_turn' });
    this.waiting.set(String(claimed.commandId), { commandId: String(claimed.commandId), messageId: claimed.messageId, executionId: entry.executionId, threadId: claimed.target.threadId, projectId: claimed.target.projectId, text: claimed.text, target: claimed.target });
    this.options.transport?.send({ protocol: 'hc/1', type: 'command.waiting_turn', payload: { commandId: claimed.commandId, executionId: entry.executionId } });
  }

  private async publishMonitor() {
    for (const [threadId, entries] of this.monitor) {
      const result = normalizeThread(await this.options.adapter.readThread(threadId));
      const changed = entries.filter(entry => result.resultRevision !== entry.lastRevision);
      if (!changed.length) continue;
      for (const entry of entries) entry.lastRevision = result.resultRevision;
      const fresh = Boolean(result.lastTurnId && entries.some(entry => result.lastTurnId !== entry.baselineTurnId));
      const candidates = changed.filter(entry => fresh && Boolean(entry.expectedText) && normalizeMessageText(result.lastUserText) === normalizeMessageText(entry.expectedText));
      if (candidates.length > 1) { for (const entry of candidates) await this.options.ledger.update(entry.executionId!, { state: 'uncertain', turnId: result.lastTurnId }); this.blockedThreads.add(threadId); this.monitor.set(threadId, entries.filter(entry => !candidates.includes(entry))); }
      else if (candidates.length === 1) {
        const entry = candidates[0]; const state = result.status === 'completed' ? 'completed' : result.status === 'failed' ? 'failed' : result.status === 'running' ? 'running' : undefined;
        if (state) { await this.options.ledger.update(entry.executionId!, { state, turnId: result.lastTurnId }); if (state === 'completed' || state === 'failed') { this.monitor.set(threadId, entries.filter(item => item !== entry)); this.blockedThreads.delete(threadId); } this.options.transport?.send({ protocol: 'hc/1', type: `command.${state}`, payload: { commandId: entry.commandId, messageId: entry.messageId, executionId: entry.executionId, turnId: result.lastTurnId, resultRevision: result.resultRevision } }); }
      }
      this.options.transport?.send({ protocol: 'hc/1', type: 'task.snapshot', payload: { projectId: entries[0]?.projectId, threadId, status: result.status, resultRevision: result.resultRevision, lastTurnId: result.lastTurnId, resultText: result.resultText, summary: result.resultText?.slice(-384) } });
    }
  }

  private async runTick() {
    await this.ensureRestored();
    if (this.options.syncOnConnect && Date.now() - this.lastCatalog >= (this.options.catalogPollMs ?? 15000)) { this.lastCatalog = Date.now(); await this.options.syncOnConnect().catch(() => undefined); }
    if (!(await this.identityOk())) return;
    const commands = await (this.options.commandSource?.() ?? Promise.resolve([...this.pending].map(commandId => ({ commandId }))));
    for (const command of commands) {
      const commandId = String(command.commandId); const claimed = await this.options.client.claim(commandId, this.options.connectionEpoch, randomBytes(16).toString('hex')).catch(() => undefined);
      if (!claimed?.executionId || !claimed.target || typeof claimed.text !== 'string') continue;
      if (claimed.executionState && claimed.executionState !== 'claimed' && claimed.executionState !== 'waiting_turn') { continue; }
      this.pending.delete(commandId);
      const old = await this.options.ledger.find(claimed.messageId);
      if (old && ['queued', 'running', 'completed', 'failed', 'uncertain'].includes(old.state)) continue;
      const snapshot = await this.options.adapter.readThread(claimed.target.threadId); if (!snapshot.cwd) throw new Error('TARGET_CWD_UNAVAILABLE');
      if (this.options.isAuthorizedTarget && !(await this.options.isAuthorizedTarget(claimed.target, snapshot.cwd))) continue;
      const baseline = normalizeThread(snapshot); const entry = await this.options.ledger.begin(claimed.messageId, claimed.target.threadId, claimed.text, snapshot.cwd, claimed.executionId, claimed.target.projectId, baseline.resultRevision, baseline.lastTurnId, commandId);
      if (this.isBusy(claimed.target.threadId, snapshot)) { await this.options.ledger.update(entry.executionId, { state: 'waiting_turn' }); this.waiting.set(commandId, { commandId, messageId: claimed.messageId, executionId: entry.executionId, threadId: claimed.target.threadId, projectId: claimed.target.projectId, text: claimed.text, target: claimed.target }); this.options.transport?.send({ protocol: 'hc/1', type: 'command.waiting_turn', payload: { commandId, executionId: entry.executionId } }); continue; }
      await this.enqueue(claimed, entry.executionId, snapshot, baseline, commandId);
    }
    for (const [commandId, waiting] of this.waiting) {
      const claimed = await this.options.client.claim(commandId, this.options.connectionEpoch, randomBytes(16).toString('hex')).catch(() => undefined);
      if (!claimed?.executionId || claimed.executionId !== waiting.executionId || !claimed.target || (claimed.executionState !== 'claimed' && claimed.executionState !== 'waiting_turn')) continue;
      const snapshot = await this.options.adapter.readThread(claimed.target.threadId); if (!snapshot.cwd || this.isBusy(claimed.target.threadId, snapshot)) continue;
      if (this.options.isAuthorizedTarget && !(await this.options.isAuthorizedTarget(claimed.target, snapshot.cwd))) continue;
      waiting.target = claimed.target; waiting.text = claimed.text; await this.enqueue(claimed, waiting.executionId, snapshot, normalizeThread(snapshot), commandId); this.waiting.delete(commandId);
    }
    await this.publishMonitor();
  }

  async tick() { if (this.stopping) return; if (this.inFlight) return this.inFlight; this.inFlight = this.runTick().finally(() => { this.inFlight = undefined; }); return this.inFlight; }
  async stop() { this.stopping = true; if (this.timer) clearInterval(this.timer); if (this.heartbeat) clearInterval(this.heartbeat); this.timer = undefined; this.heartbeat = undefined; await this.inFlight; this.options.transport?.close(); await this.options.adapter.close(); }
}
