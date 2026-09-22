import type { CompanionHttpClient } from './httpClient.js';
import type { TaskRef } from '@companion/protocol';
import { hasAuthorizedGrant } from './authorization.js';

export type CloudGrantState = 'uninitialized' | 'ready' | 'unavailable';

/** Runtime-only cloud authorization. It never writes the selected binding's local grants. */
export class CloudGrants {
  private grants: TaskRef[] = [];
  private state: CloudGrantState = 'uninitialized';
  private error?: string;

  constructor(readonly client: CompanionHttpClient, readonly connectorId: string) {}

  async refresh() {
    try {
      const bindings = await this.client.devices();
      const active = bindings.filter((binding: any) => binding?.state === 'active' && binding?.connectorId === this.connectorId && typeof binding.bindingId === 'string');
      const all: TaskRef[] = [];
      for (const binding of active) {
        const result = await this.client.grants(binding.bindingId);
        for (const grant of result?.grants ?? []) if (grant?.connectorId === this.connectorId && grant.projectId && grant.threadId) all.push({ connectorId: grant.connectorId, projectId: grant.projectId, threadId: grant.threadId });
      }
      this.grants = all;
      this.state = 'ready';
      this.error = undefined;
      return this.snapshot();
    } catch (error) {
      this.grants = [];
      this.state = 'unavailable';
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  isAuthorized(target: Partial<TaskRef>) { return this.state === 'ready' && hasAuthorizedGrant(this.grants, { connectorId: target.connectorId ?? this.connectorId, projectId: target.projectId, threadId: target.threadId }); }
  snapshot() { return { state: this.state, error: this.error, grants: this.grants.map(grant => ({ ...grant })) }; }
}
