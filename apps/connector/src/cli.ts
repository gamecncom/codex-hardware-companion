#!/usr/bin/env node
import { AppServerAdapter } from './appServerAdapter.js';
import { addMapping } from './projectMapping.js';
import { ExecutionLedger } from './ledger.js';
import { CompanionHttpClient } from './httpClient.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WssTransport } from './wssTransport.js';
import { CatalogSync } from './catalogSync.js';
import { CompanionDaemon } from './daemon.js';
import { hasAuthorizedGrant, taskRefMatches } from './authorization.js';
import { ServiceManager } from './serviceManager.js';
import { UpdateManager } from './updateManager.js';
import { CloudGrants } from './cloudGrants.js';
const args=process.argv.slice(2), op=args.join(' ');
const DEFAULT_BASE_URL='https://gamecncom.nat200.top';
const flag=(name:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined};
const configPath=()=>flag('--config')??`${process.env.HOME}/Library/Application Support/HardwareCompanion/config.json`;
async function readConfig(){try{return JSON.parse(await fs.readFile(configPath(),'utf8'))}catch{return {}}}
async function writeConfig(x:unknown){await fs.mkdir((configPath().split('/').slice(0,-1).join('/')||'.'),{recursive:true});await fs.writeFile(configPath(),JSON.stringify(x,null,2));}
function baseUrl(c:any): string {
 const value=flag('--base-url')??c.baseUrl??process.env.HC_COMPANION_BASE_URL??DEFAULT_BASE_URL;
 let parsed: URL;
 try { parsed=new URL(value); } catch { throw new Error('INVALID_BASE_URL'); }
 if(parsed.protocol!=='http:'&&parsed.protocol!=='https:')throw new Error('INVALID_BASE_URL');
 return value.replace(/\/$/,'');
}
function http(c:any){return new CompanionHttpClient({baseUrl:baseUrl(c),token:c.token,connectorId:c.connectorId,userId:c.userId,bindingId:c.bindingId});}
function out(ok:boolean,operation:string,data?:unknown,error?:{code:string;message:string;retryable?:boolean}){console.log(JSON.stringify({ok,operation,...(data===undefined?{}:{data}),...(error?{error}:{})}));process.exitCode=ok?0:1;}
async function main(){
 const adapter=new AppServerAdapter(flag('--binary'));
 try {
  if(args[0]==='service'&&['install','start','status','stop','uninstall'].includes(args[1]??'')){
   const c=await readConfig(),installRoot=flag('--install-root')??c.installRoot;
   const service=new ServiceManager({homeDir:flag('--service-home'),installRoot,nodePath:flag('--service-node'),cliPath:flag('--service-cli'),configPath:configPath(),logDir:flag('--service-log-dir')});
   const action=args[1];
   const result=action==='install'?await service.install():action==='start'?await service.start():action==='status'?await service.status():action==='stop'?await service.stop():await service.uninstall();
   if(action==='install'&&installRoot)await writeConfig({...c,installRoot});
   out(true,`service ${action}`,result);return;
  }
  if(args[0]==='update'){
   const from=flag('--from'),installRoot=flag('--install-root');
   if(!from)throw new Error('RELEASE_PATH_REQUIRED');
   const configured=installRoot??(await readConfig()).installRoot;
   if(!configured)throw new Error('UPDATE_INSTALL_ROOT_REQUIRED');
   const service=new ServiceManager({homeDir:flag('--service-home'),installRoot:configured,nodePath:flag('--service-node'),cliPath:flag('--service-cli')});
   const result=await new UpdateManager({installRoot:configured,service,healthCheck:async(expected)=> (await service.status()).running && (await fs.readFile(join(configured,'current','VERSION'),'utf8')).trim()===expected}).update(from);
   out(true,'update',result);return;
  }
  if(args[0]==='auth'&&args[1]==='start'){const c=await readConfig(),base=baseUrl(c),result=await new CompanionHttpClient({baseUrl:base}).loginStart();await writeConfig({...c,baseUrl:base,loginId:result.loginId,pollSecret:result.pollSecret});const {pollSecret:_,...safe}=result;out(true,'auth start',safe);return;}
  if(args[0]==='auth'&&args[1]==='poll'){const c=await readConfig(),loginId=flag('--login-id')??c.loginId,pollSecret=c.pollSecret??flag('--poll-secret'),base=baseUrl(c);if(!loginId||!pollSecret)throw new Error('LOGIN_NOT_STARTED');const result=await new CompanionHttpClient({baseUrl:base,token:undefined}).loginPoll(loginId,pollSecret);if(result.status==='pending'){out(true,'auth poll',{status:'pending',loginId});return;}const next={...c,baseUrl:base,loginId:undefined,pollSecret:undefined,connectorId:result.connectorId,token:result.token};await writeConfig(next);out(true,'auth poll',{status:'approved',connectorId:result.connectorId});return;}
  if(args[0]==='init'){const c=await readConfig(),name=flag('--name')??'Mac Connector',explicitEmail=flag('--email');if(c.connectorId&&c.token){out(true,'init',{stage:'ready',clientId:c.clientId,connectorId:c.connectorId});return;}const base=baseUrl(c);if(explicitEmail){const unauth=new CompanionHttpClient({baseUrl:base}),code=flag('--code');if(!code){const started=await unauth.emailStart(explicitEmail);await writeConfig({...c,baseUrl:base,email:explicitEmail});out(true,'init',{stage:'verification_required',email:explicitEmail,mail:started});return;}const sessionToken=(await unauth.emailVerify(explicitEmail,code)).sessionToken;const reg=await new CompanionHttpClient({baseUrl:base,token:sessionToken}).register(undefined,name);await writeConfig({...c,baseUrl:base,email:explicitEmail,sessionToken,connectorId:reg.connectorId,token:reg.token});out(true,'init',{stage:'ready',connectorId:reg.connectorId,legacy:true});return;}const clientId=typeof c.clientId==='string'&&c.clientId.length>=16?c.clientId:`client-${randomBytes(16).toString('hex')}`;await writeConfig({...c,baseUrl:base,clientId,loginId:undefined,pollSecret:undefined,email:undefined,sessionToken:undefined});const reg=await new CompanionHttpClient({baseUrl:base}).registerAnonymous(clientId,name);await writeConfig({...c,baseUrl:base,clientId,loginId:undefined,pollSecret:undefined,email:undefined,sessionToken:undefined,connectorId:reg.connectorId,token:reg.token});out(true,'init',{stage:'ready',clientId,connectorId:reg.connectorId});return;}
  if(args[0]==='device'&&args[1]==='pair'){const c=await readConfig();if(!c.connectorId||!c.token)throw new Error('INIT_REQUIRED');const result=await http(c).pair(flag('--client-request-id')??randomBytes(16).toString('hex'));out(true,'device pair',result);return;}
  if(args[0]==='device'&&args[1]==='list'){const c=await readConfig(),client=http(c);out(true,'device list',await client.devices());return;}
  if(args[0]==='device'&&args[1]==='use'){
   const c=await readConfig(),deviceId=flag('--device'),requestedBinding=flag('--binding');
   if(!c.connectorId||!c.token)throw new Error('INIT_REQUIRED');
   if((deviceId&&requestedBinding)||(!deviceId&&!requestedBinding))throw new Error('DEVICE_OR_BINDING_REQUIRED');
   const devices=await http(c).devices();
   const matches=devices.filter((device:any)=>device?.state==='active'&&device?.connectorId===c.connectorId&&((deviceId&&device.deviceId===deviceId)||(requestedBinding&&device.bindingId===requestedBinding)));
   if(matches.length===0)throw new Error('ACTIVE_BINDING_NOT_FOUND');
   if(matches.length!==1)throw new Error('ACTIVE_BINDING_NOT_UNIQUE');
   const selected=matches[0];
   if(typeof selected.bindingId!=='string'||typeof selected.selectionRevision!=='string')throw new Error('DEVICE_BINDING_STATE_INVALID');
   const confirmed=await http(c).grants(selected.bindingId);
   const next={...c,bindingId:selected.bindingId,selectionRevision:selected.selectionRevision,grants:confirmed.grants??[],grantsVersion:confirmed.grantsVersion};
   delete next.deviceToken;
   await writeConfig(next);
   out(true,'device use',{deviceId:selected.deviceId,bindingId:selected.bindingId,connectorId:selected.connectorId,state:selected.state,selectionRevision:selected.selectionRevision,grants:next.grants,grantsVersion:next.grantsVersion});
   return;
  }
  if(args[0]==='device'&&args[1]==='rename'){const c=await readConfig(),deviceId=flag('--device'),name=flag('--name');if(!deviceId||!name)throw new Error('DEVICE_AND_NAME_REQUIRED');const client=new CompanionHttpClient({baseUrl:baseUrl(c),token:c.sessionToken??c.token,userId:c.userId});try{out(true,'device rename',await client.renameDevice(deviceId,name,flag('--client-request-id')??randomBytes(16).toString('hex')))}catch(e){out(false,'device rename',{}, {code:'UNSUPPORTED_OPERATION',message:e instanceof Error?e.message:String(e),retryable:false});}return;}
  if(args[0]==='task'&&(args[1]==='grant'||args[1]==='revoke')){const c=await readConfig(),client=http(c),binding=c.bindingId;if(!binding)throw new Error('BINDING_REQUIRED');const current=await client.grants(binding);const ref=JSON.parse(flag('--ref')??'{}');const grants=(current.grants??[]).filter((x:any)=>args[1]==='revoke'?!taskRefMatches(x,ref):true);if(args[1]==='grant'&&!hasAuthorizedGrant(grants,ref))grants.push(ref);const result=await client.setGrants(binding,grants,current.grantsVersion,flag('--client-request-id')??randomBytes(16).toString('hex'));const confirmed=await client.grants(binding);const persistedGrants=confirmed.grants??grants;const persistedVersion=confirmed.grantsVersion??result.grantsVersion??result.version??current.grantsVersion;await writeConfig({...c,grants:persistedGrants,grantsVersion:persistedVersion});out(true,`task ${args[1]}`,{...result,grants:persistedGrants,grantsVersion:persistedVersion});return;}
  if(args[0]==='task'&&args[1]==='authorize'){
   const c=await readConfig(),client=http(c),current=await client.grantPreset(),refs=JSON.parse(flag('--refs')??'[]'),preferred=flag('--preferred')?JSON.parse(flag('--preferred')!):null;
   const result=await client.setGrantPreset(refs,preferred,current.version,flag('--client-request-id')??randomBytes(16).toString('hex'));
   await writeConfig({...c,grantPreset:result}); out(true,'task authorize',result); return;
  }
  if(args[0]==='task'&&args[1]==='select'){
   const c=await readConfig(),client=http(c),ref=JSON.parse(flag('--ref')??'{}');
   if(!c.bindingId)throw new Error('BINDING_REQUIRED');
   const devices=await client.devices();
   const matches=devices.filter((device:any)=>device?.state==='active'&&device?.connectorId===c.connectorId&&device?.bindingId===c.bindingId);
   if(matches.length===0)throw new Error('ACTIVE_BINDING_NOT_FOUND');
   if(matches.length!==1)throw new Error('ACTIVE_BINDING_NOT_UNIQUE');
   const expectedSelectionRevision=matches[0].selectionRevision;
   if(typeof expectedSelectionRevision!=='string')throw new Error('DEVICE_BINDING_STATE_INVALID');
   const result=await client.select(c.bindingId,ref,expectedSelectionRevision,flag('--client-request-id')??randomBytes(16).toString('hex'));
   await writeConfig({...c,selectionRevision:result.selectionRevision});
   out(true,'task select',result);return;
  }
  if(args[0]==='device'&&args[1]==='unbind'&&args[2]==='prepare'){const c=await readConfig();if(!c.bindingId)throw new Error('BINDING_REQUIRED');const result=await http(c).prepareUnbind(c.bindingId,'release');await writeConfig({...c,unbindOperationId:result.operationId});out(true,'device unbind prepare',result);return;}
  if(args[0]==='device'&&args[1]==='unbind'&&args[2]==='confirm'){const c=await readConfig(),operationId=flag('--operation')??c.unbindOperationId;if(!operationId)throw new Error('UNBIND_OPERATION_REQUIRED');const result=await http(c).confirmUnbind(operationId,flag('--client-request-id')??randomBytes(16).toString('hex'));await writeConfig({...c,bindingId:undefined,selectionRevision:undefined,unbindOperationId:undefined,grants:[],grantsVersion:undefined});out(true,'device unbind confirm',result);return;}
  if(args[0]==='status'){const [cap,id]=await Promise.all([adapter.detect(),adapter.readIdentity()]);out(true,'status',{capabilities:cap,identity:{...id,fingerprint:undefined},computerExecutable:cap.list&&cap.read&&cap.enqueue,nativeApproval:false});return;}
  if(args[0]==='task'&&args[1]==='discover'){const page=await adapter.listThreads(flag('--cursor'));out(true,'task discover',page);return;}
  if(args[0]==='task'&&args[1]==='read'){const id=flag('--thread');if(!id)throw new Error('THREAD_REQUIRED');out(true,'task read',await adapter.readThread(id));return;}
  if(args[0]==='project'&&args[1]==='add'){const root=flag('--root'),name=flag('--name');if(!root||!name)throw new Error('PROJECT_NAME_AND_ROOT_REQUIRED');const c=await readConfig(),mapping=addMapping(name,root);const projects=[...(c.projects??[]).filter((x:any)=>x.projectId!==mapping.projectId),mapping];await writeConfig({...c,projects});out(true,'project add',mapping);return;}
  if(args[0]==='catalog'&&args[1]==='sync'){const c=await readConfig();if(!c.connectorId||!c.token)throw new Error('INIT_REQUIRED');const adapter=new AppServerAdapter(flag('--binary'));const url=baseUrl(c).replace(/^http/,'ws')+'/v1/connectors/channel';const transport=new WssTransport({url,token:c.token,connectorId:c.connectorId});const opened=new Promise<void>((resolve,reject)=>{transport.once('open',()=>resolve());transport.once('error',reject)});transport.connect();await opened;const current=await readConfig();const count=await new CatalogSync(adapter,transport,current.projects??[],(target)=>hasAuthorizedGrant(current.grants??[],target)).sync();transport.close();await adapter.close();out(true,'catalog sync',{count});return;}
  if(args[0]==='daemon'&&args[1]==='start'){const c=await readConfig();if(!c.connectorId||!c.token)throw new Error('INIT_REQUIRED');const adapter=new AppServerAdapter(flag('--binary'));const identity=await adapter.readIdentity();if(!identity.available||!identity.fingerprint)throw new Error('CODEX_IDENTITY_UNAVAILABLE');const expectedIdentityFingerprint=c.identityFingerprint??identity.fingerprint;if(!c.identityFingerprint)await writeConfig({...c,identityFingerprint:expectedIdentityFingerprint});const client=http(c);const cloudGrants=new CloudGrants(client,c.connectorId);const transport=new WssTransport({url:baseUrl(c).replace(/^http/,'ws')+'/v1/connectors/channel',token:c.token,connectorId:c.connectorId});const sync=async()=>{await cloudGrants.refresh();const current=await readConfig();return new CatalogSync(adapter,transport,current.projects??[],(target)=>cloudGrants.isAuthorized(target)).sync();};const daemon=new CompanionDaemon({client,adapter,ledger:new ExecutionLedger(c.ledger??`${process.env.HOME}/Library/Application Support/HardwareCompanion/executions.json`),connectionEpoch:c.connectionEpoch??'1',expectedIdentityFingerprint,transport,syncOnConnect:sync,isAuthorizedTarget:async(target:any,cwd:string)=>cloudGrants.isAuthorized(target)&&Boolean((await readConfig()).projects?.some((p:any)=>p.projectId===target.projectId&&mapRoot(p.root,cwd))) });daemon.start();out(true,'daemon start',{running:true,stopping:false,identityVerified:true});await new Promise<void>(resolve=>{const stop=()=>{void daemon.stop().finally(resolve)};process.once('SIGINT',stop);process.once('SIGTERM',resolve)});return;}
  if(args[0]==='message'&&args[1]==='queue'){const thread=flag('--thread'),text=flag('--message'),cwd=flag('--cwd'),messageId=flag('--message-id');if(!thread||!text||!cwd||!messageId)throw new Error('THREAD_MESSAGE_CWD_AND_MESSAGE_ID_REQUIRED');const ledger=new ExecutionLedger(flag('--ledger')??`${process.env.HOME}/Library/Application Support/HardwareCompanion/executions.json`);const previous=await ledger.find(messageId);if(previous){out(true,'message queue',{execution:previous,duplicate:true});return;}const e=await ledger.begin(messageId,thread,text,cwd);const receipt=await adapter.enqueue(thread,text,cwd);const result=await ledger.update(e.executionId,{state:receipt.status,queueId:receipt.queueId});out(receipt.accepted,'message queue',{execution:result,receipt},receipt.accepted?undefined:{code:'QUEUE_UNCERTAIN',message:'Codex queue result was not confirmed',retryable:true});return;}
  if(args[0]==='doctor'){const cap=await adapter.detect();out(true,'doctor',{binary:cap.binary,version:cap.version,readOnlyProbe:true,realMessageSending:'not-authorized',nativeApproval:false});return;}
  out(false,op||'unknown',{supported:['init','status','doctor','service install','service start','service status','service stop','service uninstall','update --from','project add','catalog sync','daemon start','task discover','task read','task authorize','task grant','task revoke','task select','device list','device use','device pair','device unbind prepare','device unbind confirm','message queue']},{code:'UNSUPPORTED_OPERATION',message:'Unsupported operation',retryable:false});
 }catch(e){const message=e instanceof Error?e.message:String(e);const code=/^(BASE_URL_REQUIRED|INVALID_BASE_URL)(?::|$)/.test(message)?message.split(':',1)[0]:'CONNECTOR_ERROR';out(false,op,{}, {code,message,retryable:code==='CONNECTOR_ERROR'});}finally{await adapter.close();}
}
function mapRoot(root:string,cwd:string){return cwd===root||cwd.startsWith(root+'/');}
void main();
