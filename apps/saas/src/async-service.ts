import { PgBusinessRepository } from './pg-repository.js';
import type { Grant } from '@companion/protocol';

/** Production façade for SQL-owned mutations. It intentionally exposes only operations backed by PgBusinessRepository. */
export class AsyncCompanionService {
  constructor(public repo:PgBusinessRepository) {}
  async migrate(){await this.repo.migrate();}
  async health(){return this.repo.health();}
  async createBinding(userId:string,connectorId:string,deviceId:string,deviceToken:string){return this.repo.createBinding(userId,connectorId,deviceId,deviceToken);}
  async setGrants(bindingId:string,refs:Grant[],expected:string,clientRequestId:string){return this.repo.setGrants(bindingId,refs,expected,clientRequestId);}
}
