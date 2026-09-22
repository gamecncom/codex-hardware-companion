import {readFile} from 'node:fs/promises';
import {basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {AsrAdapter} from './asr.js';
export interface QwenAsrOptions{apiKey:string;model?:string;baseURL:string;fetchFn?:typeof fetch;pollIntervalMs?:number;maxPolls?:number}
const MODEL = 'qwen3-asr-flash-filetrans';
const requiredPolicy = (value: unknown) => {
  const p = (value as any)?.data;
  if (!p || typeof p.upload_host !== 'string' || typeof p.upload_dir !== 'string' ||
    typeof p.oss_access_key_id !== 'string' || typeof p.signature !== 'string' ||
    typeof p.policy !== 'string' || typeof p.x_oss_object_acl !== 'string' ||
    typeof p.x_oss_forbid_overwrite !== 'string') throw Error('ASR_FAILED');
  return p as { upload_host: string; upload_dir: string; oss_access_key_id: string; signature: string; policy: string; x_oss_object_acl: string; x_oss_forbid_overwrite: string };
};
const transcriptFrom = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  if (typeof (value as any).transcript === 'string' && (value as any).transcript.trim()) return (value as any).transcript.trim();
  if (typeof (value as any).text === 'string' && (value as any).text.trim()) return (value as any).text.trim();
  if (Array.isArray((value as any).transcripts)) {
    const text = (value as any).transcripts.map((item: unknown) => transcriptFrom(item)).filter((item: string | undefined): item is string => Boolean(item)).join(' ');
    if (text) return text;
  }
  for (const key of ['result', 'results', 'data', 'output']) {
    const text = transcriptFrom((value as any)[key]);
    if (text) return text;
  }
  return undefined;
};
const transcriptionUrlFrom = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as any;
  if (typeof record.transcription_url === 'string' && record.transcription_url) return record.transcription_url;
  for (const key of ['result', 'results', 'data', 'output']) {
    const nested = record[key];
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const url = transcriptionUrlFrom(item);
        if (url) return url;
      }
    } else {
      const url = transcriptionUrlFrom(nested);
      if (url) return url;
    }
  }
  return undefined;
};
export class QwenAsr implements AsrAdapter{readonly kind='qwen3-asr-flash-filetrans';constructor(private o:QwenAsrOptions){}private f(){return this.o.fetchFn??fetch}async transcribe(filePath:string){const f=this.f(),model=this.o.model??MODEL,h={Authorization:`Bearer ${this.o.apiKey}`};const p=await f(`${this.o.baseURL}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`,{headers:{...h,'Content-Type':'application/json'}});if(!p.ok)throw Error('ASR_FAILED');const policy=requiredPolicy(await p.json());const key=`${policy.upload_dir}/${randomUUID()}-${basename(filePath)}`;const form=new FormData();for(const [k,v] of Object.entries({OSSAccessKeyId:policy.oss_access_key_id,Signature:policy.signature,policy:policy.policy,key,'x-oss-object-acl':policy.x_oss_object_acl,'x-oss-forbid-overwrite':policy.x_oss_forbid_overwrite,success_action_status:'200'}))form.append(k,v);form.append('file',new Blob([await readFile(filePath)]),basename(filePath));const up=await f(policy.upload_host,{method:'POST',body:form});if(!up.ok)throw Error('ASR_FAILED');const task=await f(`${this.o.baseURL}/api/v1/services/audio/asr/transcription`,{method:'POST',headers:{...h,'Content-Type':'application/json','X-DashScope-Async':'enable','X-DashScope-OssResourceResolve':'enable'},body:JSON.stringify({model,input:{file_url:`oss://${key}`}})});if(!task.ok)throw Error('ASR_FAILED');const taskBody=await task.json() as any,id=taskBody.output?.task_id??taskBody.task_id;if(typeof id!=='string'||!id)throw Error('ASR_FAILED');for(let i=0;i<(this.o.maxPolls??120);i++){const r=await f(`${this.o.baseURL}/api/v1/tasks/${encodeURIComponent(id)}`,{headers:{...h,'Content-Type':'application/json'}});if(!r.ok)throw Error('ASR_FAILED');const j=await r.json() as any,s=j.output?.task_status??j.task_status;if(s==='SUCCEEDED'){const url=transcriptionUrlFrom(j.output);if(typeof url!=='string'||!url)throw Error('ASR_FAILED');const z=await f(url);if(!z.ok)throw Error('ASR_FAILED');const transcript=transcriptFrom(await z.json());if(!transcript)throw Error('ASR_FAILED');return {providerTaskId:id,transcript};}if(['FAILED','CANCELED','CANCELLED'].includes(s))throw Error('ASR_FAILED');await new Promise(r=>setTimeout(r,this.o.pollIntervalMs??1000));}throw Error('ASR_FAILED');}}
