import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { Capabilities, CodexAdapter, IdentityContext, QueueReceipt, ThreadPage, ThreadSnapshot, ThreadSummary, TaskStatus } from './types.js';

type Pending = { resolve:(v:any)=>void; reject:(e:Error)=>void };
const status = (s: any): TaskStatus => s === 'running' ? 'running' : s === 'completed' ? 'completed' : s === 'failed' ? 'failed' : s === 'waiting_user' ? 'waiting_user' : s === 'idle' ? 'idle' : 'unknown';

export class AppServerAdapter implements CodexAdapter {
  readonly binary: string; private child?: ReturnType<typeof spawn>; private seq=0; private pending=new Map<number,Pending>(); private buffer=''; private init?:Promise<any>;
  constructor(binary='/Applications/ChatGPT.app/Contents/Resources/codex') { this.binary=binary; }
  private start() {
    if (this.child) return;
    this.child=spawn(this.binary,['app-server','--stdio'],{stdio:['pipe','pipe','pipe']});
    this.child.stdout!.on('data',(d:Buffer)=>{ this.buffer+=d.toString(); let i; while((i=this.buffer.indexOf('\n'))>=0){ const line=this.buffer.slice(0,i).trim(); this.buffer=this.buffer.slice(i+1); if(!line) continue; try { const m=JSON.parse(line); if(m.id && this.pending.has(m.id)){const p=this.pending.get(m.id)!;this.pending.delete(m.id);m.error?p.reject(new Error(m.error.message??'app-server error')):p.resolve(m.result);}} catch {} } });
    this.child.stderr!.on('data',()=>{});
    this.child.on('error',(e)=>{for(const p of this.pending.values())p.reject(e);this.pending.clear();this.child=undefined;this.init=undefined;});
    this.child.on('exit',()=>{for(const p of this.pending.values())p.reject(new Error('app-server exited'));this.pending.clear();this.child=undefined;this.init=undefined;});
  }
  private request(method:string, params:unknown={}) { this.start(); const id=++this.seq; return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('APP_SERVER_TIMEOUT'))},15000);this.pending.set(id,{resolve:(v)=>{clearTimeout(timer);resolve(v)},reject:(e)=>{clearTimeout(timer);reject(e)}}); try{this.child!.stdin!.write(JSON.stringify({method,id,params})+'\n')}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e)}}); }
  private async ensureInit(){ this.init ??= this.request('initialize',{clientInfo:{name:'hardware-companion',version:'0.3.0'},capabilities:{}}); return this.init; }
  async detect():Promise<Capabilities>{ const r=await this.ensureInit(); const v=String(r.userAgent??'').match(/Codex Desktop\/([^ ]+)/)?.[1] ?? 'unknown'; let accountContextDetection=false;try{const a=await this.request('account/read');accountContextDetection=Boolean(a?.account?.type)}catch{} return {list:true,read:true,enqueue:true,accountContextDetection,nativeApproval:false,version:v,binary:this.binary}; }
  async listThreads(cursor?:string):Promise<ThreadPage>{ await this.ensureInit(); const r=await this.request('thread/list',{limit:100,...(cursor?{cursor}:{})}); const data=(r.data??[]).map((x:any):ThreadSummary=>{const id=String(x.id??x.sessionId);return {threadId:id,title:x.name?String(x.name):`未命名任务 · ${id.slice(-8)}`,titleSource:x.name?'codex':'fallback',cwd:x.cwd,status:status(x.status?.type),updatedAt:x.updatedAt?new Date(Number(x.updatedAt)*1000).toISOString():undefined,source:x.source};}); return {data,nextCursor:r.nextCursor}; }
  async readThread(threadId:string):Promise<ThreadSnapshot>{ await this.ensureInit(); const r=await this.request('thread/read',{threadId,includeTurns:true}); const x=r.thread??r; const actual=String(x.id??x.threadId??threadId); if(actual!==threadId)throw new Error('THREAD_ID_MISMATCH'); if(!x.cwd)throw new Error('THREAD_CWD_UNAVAILABLE'); return {threadId,cwd:x.cwd,title:x.name??undefined,turns:x.turns??[],status:status(x.status?.type),raw:r}; }
  async enqueue(threadId:string,text:string,originalCwd:string):Promise<QueueReceipt>{ return new Promise((resolve)=>{ execFile(this.binary,['queue','--thread',threadId,'--message',text],{cwd:originalCwd,windowsHide:true},(error,stdout,stderr)=>{ const raw=(stdout||stderr||'').trim(); if(error||!raw){resolve({accepted:false,raw:raw||error?.message||'empty queue output',status:'uncertain'});return;} const m=raw.match(/Queued message\s+([0-9a-f-]+)\s+for thread\s+([0-9a-f-]+)/i); if(!m||m[2]!==threadId){resolve({accepted:false,raw,status:'uncertain'});return;} resolve({accepted:true,queueId:m[1],raw,status:'queued'}); }); }); }
  async readIdentity():Promise<IdentityContext>{ try { await this.ensureInit(); const a=await this.request('account/read');if(!a?.account?.type)return {available:false,source:'app-server'};const s=JSON.stringify({type:a.account.type,planType:a.account.planType,email:a.account.email});return {available:true,source:'app-server',fingerprint:createHash('sha256').update(s).digest('hex').slice(0,16)}; } catch { return {available:false,source:'unavailable'}; } }
  async close(){ if(this.child){this.child.kill('SIGTERM'); await once(this.child,'exit').catch(()=>{});this.child=undefined;} }
}
