import { randomUUID, createHash } from 'node:crypto';
import type { Command, Grant, LinkStatus, MessageStatus, ProjectSummary, TaskRef, TaskSummary } from '@companion/protocol';
import { assertTaskRef, nowIso } from '@companion/protocol';

export type User={id:string;email:string};
export type Connector={id:string;userId:string;name:string;online:boolean;connectionEpoch:string;tokenHash:string};
export type Device={id:string;name:string;bootstrap:string};
export type Binding={id:string;userId:string;connectorId:string;deviceId:string;epoch:number;state:'active'|'revoked';activeTaskRef?:TaskRef;selectionRevision:string;grantsVersion:string;deviceToken:string};
export type Recording={id:string;bindingId:string;epoch:number;target:TaskRef;selectionRevision:string;clientRequestId:string;status:'processing'|'ready'|'failed'|'cancelled';transcript?:string};
export type Message={id:string;bindingId:string;epoch:number;target:TaskRef;recordingId:string;clientRequestId:string;status:MessageStatus;text:string;commandId?:string};
export type Idempotency={principal:string;operation:string;clientRequestId:string;bodyHash:string;result:unknown};
export type IdempotencyProbe={k:string;bodyHash:string};

export class MemoryStore {
  users=new Map<string,User>(); connectors=new Map<string,Connector>(); devices=new Map<string,Device>(); bindings=new Map<string,Binding>();
  connectorSecrets=new Map<string,string>(); loginTransactions=new Map<string,{id:string;pollSecret:string;userId?:string;expiresAt:string;approved?:boolean;token?:string}>(); pairings=new Map<string,{id:string;connectorId:string;deviceId?:string;code:string;expiresAt:string;claimed?:boolean}>();
  sessions=new Map<string,string>(); emailCodes=new Map<string,string>();
  devicePairings=new Map<string,{id:string;deviceId:string;connectorId:string;pollSecret:string;code?:string;claimedUserId?:string;expiresAt:string;confirmedBindingId?:string}>();
  projects=new Map<string,ProjectSummary>(); tasks=new Map<string,TaskSummary>(); grants=new Map<string,Set<string>>(); recordings=new Map<string,Recording>(); messages=new Map<string,Message>(); commands=new Map<string,Command>(); idempotency=new Map<string,Idempotency>();
  addUser(email:string){const user={id:randomUUID(),email:email.trim().toLowerCase()}; this.users.set(user.id,user); return user;}
  addConnector(userId:string,name='Mac Connector'){const id=`cn-${randomUUID()}`; const token=randomUUID()+randomUUID(); const c={id,userId,name,online:true,connectionEpoch:'1',tokenHash:hash(token)}; this.connectors.set(id,c); this.connectorSecrets.set(id,token); return {connector:c,token};}
  addDevice(name='Hardware Companion'){const id=`dev-${randomUUID()}`,bootstrap=randomUUID()+randomUUID(); const d={id,name,bootstrap}; this.devices.set(id,d); return {device:d,bootstrap};}
  seedCatalog(connectorId:string,projects:ProjectSummary[],tasks:TaskSummary[]){for(const p of projects)this.projects.set(`${connectorId}:${p.projectId}`,p);for(const t of tasks)this.tasks.set(`${connectorId}:${t.threadId}`,t);}
  key(ref:TaskRef){return `${ref.connectorId}:${ref.threadId}`;}
  grantKey(ref:TaskRef){return `${ref.connectorId}:${ref.projectId}:${ref.threadId}`;}
  getBinding(id:string){const b=this.bindings.get(id);if(!b||b.state!=='active')throw new Error('BINDING_REVOKED');return b;}
  ensureGrant(b:Binding,ref:TaskRef){assertTaskRef(ref);const set=this.grants.get(b.id);if(!set?.has(this.grantKey(ref)))throw new Error('TARGET_NOT_GRANTED');const task=this.tasks.get(this.key(ref));if(!task||task.projectId!==ref.projectId)throw new Error('TARGET_MOVED');}
  idempotent<T>(principal:string,operation:string,requestId:string,body:unknown):any{const k=`${principal}:${operation}:${requestId}`,bodyHash=hash(JSON.stringify(body));const old=this.idempotency.get(k);if(old){if(old.bodyHash!==bodyHash)throw new Error('IDEMPOTENCY_CONFLICT');return old.result as T;}return {k,bodyHash};}
  saveIdempotent(k:string,principal:string,operation:string,requestId:string,bodyHash:string,result:unknown){this.idempotency.set(k,{principal,operation,clientRequestId:requestId,bodyHash,result});}
}
export function hash(value:string){return createHash('sha256').update(value).digest('hex');}
