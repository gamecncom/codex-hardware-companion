import test from 'node:test'; import assert from 'node:assert/strict'; import {AppServerAdapter} from '../src/appServerAdapter.js';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('real binary read-only probe detects queue capability and lists threads',async()=>{const a=new AppServerAdapter('/Applications/ChatGPT.app/Contents/Resources/codex');const c=await a.detect();assert.match(c.version,/^\d+\.\d+/);assert.equal(c.enqueue,true);const p=await a.listThreads();assert.ok(Array.isArray(p.data));assert.ok(p.data.every(x=>x.threadId&&x.cwd));await a.close();});

test('close terminates an app-server child that ignores SIGTERM',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'hc-stuck-app-server-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const binary=join(dir,'codex');
  await writeFile(binary,`#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});
process.on('SIGTERM',()=>{});
rl.on('line',line=>{const x=JSON.parse(line);const result=x.method==='initialize'?{userAgent:'Codex Desktop/0.1'}:{account:{type:'chatgpt'}};process.stdout.write(JSON.stringify({id:x.id,result})+'\\n');});
`);
  await chmod(binary,0o755);
  const adapter=new AppServerAdapter(binary);
  await adapter.detect();
  const child=(adapter as any).child;
  const closed=adapter.close().then(()=>true);
  const timely=await Promise.race([closed,new Promise<false>(resolve=>setTimeout(()=>resolve(false),1800))]);
  if(!timely)child.kill('SIGKILL');
  await closed;
  assert.equal(timely,true);
});
