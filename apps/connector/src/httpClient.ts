import { randomBytes } from 'node:crypto';
import type { Grant, TaskRef } from '@companion/protocol';
const requestId=()=>randomBytes(16).toString('hex');
export interface ConnectorHttpOptions { baseUrl:string; token?:string; connectorId?:string; userId?:string; bindingId?:string; deviceToken?:string; fetchImpl?:typeof fetch; }
export class CompanionHttpClient {
  private f:typeof fetch; constructor(readonly options:ConnectorHttpOptions){this.f=options.fetchImpl??fetch;}
  private async call<T>(method:string,path:string,body?:unknown):Promise<T>{const h:Record<string,string>={'accept':'application/json','x-request-id':requestId()};if(body!==undefined)h['content-type']='application/json';if(this.options.token)h.authorization=`Bearer ${this.options.token}`;if(this.options.deviceToken)h.authorization=`Bearer ${this.options.deviceToken}`;if(this.options.connectorId)h['x-connector-id']=this.options.connectorId;if(this.options.userId)h['x-user-id']=this.options.userId;const r=await this.f(new URL(path,this.options.baseUrl),{method,headers:h,body:body===undefined?undefined:JSON.stringify(body)});const x:any=await r.json();if(!r.ok||x.error)throw new Error(x.error?.code??`HTTP_${r.status}`);return x.data as T;}
  health(){return this.call<{status:string}>('GET','/healthz');}
  loginStart(){return this.call<any>('POST','/v1/connector-login/start',{});}
  loginPoll(loginId:string,pollSecret:string){return this.call<any>('POST',`/v1/connector-login/${encodeURIComponent(loginId)}/poll`,{pollSecret});}
  emailStart(email:string){return this.call<any>('POST','/v1/auth/email/start',{email});}
  emailVerify(email:string,code:string){return this.call<any>('POST','/v1/auth/email/verify',{email,code});}
  devices(){return this.call<any[]>('GET','/v1/devices');}
  renameDevice(deviceId:string,name:string,clientRequestId:string){return this.call<any>('PATCH',`/v1/devices/${encodeURIComponent(deviceId)}`,{name,clientRequestId});}
  register(userId?:string,name='Mac Connector'){return this.call<{connectorId:string;token:string}>('POST','/v1/connectors/register',{...(userId?{userId}:{}),name});}
  bindTest(userId:string,deviceId:string,clientRequestId:string){return this.call<any>('POST','/v1/test/bind',{userId,connectorId:this.options.connectorId,deviceId,clientRequestId});}
  pair(clientRequestId:string){return this.call<any>('POST','/v1/pairings',{clientRequestId});}
  startDevicePairing(deviceBootstrap:string,clientRequestId:string){const c=new CompanionHttpClient({...this.options,deviceToken:deviceBootstrap,token:this.options.token});return c.call<any>('POST','/v1/device-pairings',{connectorToken:this.options.token,clientRequestId});}
  claimPairing(pairingId:string,code:string,userId:string){return this.call<any>('POST',`/v1/pairings/${encodeURIComponent(pairingId)}/claim`,{code,userId});}
  projects(bindingId=this.options.bindingId!){return this.call<any>('GET',`/v1/device/projects?bindingId=${encodeURIComponent(bindingId)}`);}
  tasks(projectId?:string,bindingId=this.options.bindingId!){return this.call<any>('GET',`/v1/device/tasks?bindingId=${encodeURIComponent(bindingId)}${projectId?`&projectId=${encodeURIComponent(projectId)}`:''}`);}
  grants(bindingId=this.options.bindingId!){return this.call<any>('GET',`/v1/bindings/${encodeURIComponent(bindingId)}/task-grants`);}
  setGrants(bindingId:string,grants:Grant[],expectedGrantsVersion:string,clientRequestId:string){return this.call<any>('PUT',`/v1/bindings/${encodeURIComponent(bindingId)}/task-grants`,{grants,expectedGrantsVersion,clientRequestId});}
  grantPreset(){return this.call<any>('GET','/v1/connectors/self/grant-preset');}
  setGrantPreset(targets:Grant[],preferredTarget:Grant|null,expectedVersion:string,clientRequestId:string){return this.call<any>('PUT','/v1/connectors/self/grant-preset',{targets,preferredTarget,expectedVersion,clientRequestId});}
  select(bindingId:string,target:TaskRef,expectedSelectionRevision:string,clientRequestId:string){return this.call<any>('POST','/v1/device/selection',{bindingId,target,expectedSelectionRevision,clientRequestId});}
  prepareUnbind(bindingId:string,intent='release'){return this.call<any>('POST',`/v1/bindings/${encodeURIComponent(bindingId)}/unbind/prepare`,{intent});}
  confirmUnbind(operationId:string,clientRequestId:string){return this.call<any>('POST','/v1/device/unbind/confirm',{operationId,clientRequestId});}
  unbind(bindingId:string,clientRequestId:string){return this.call<any>('DELETE',`/v1/bindings/${encodeURIComponent(bindingId)}`,{clientRequestId});}
  claim(commandId:string,connectionEpoch:string,clientRequestId:string){return this.call<any>('POST',`/v1/connectors/commands/${encodeURIComponent(commandId)}/claim`,{connectorId:this.options.connectorId,connectionEpoch,clientRequestId});}
}
