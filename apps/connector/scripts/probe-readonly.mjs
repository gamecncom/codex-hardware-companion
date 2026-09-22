#!/usr/bin/env node
import {spawn} from 'node:child_process';
const binary=process.env.CODEX_BINARY??'/Applications/ChatGPT.app/Contents/Resources/codex';
const child=spawn(binary,['app-server','--stdio'],{stdio:['pipe','pipe','inherit']}); let buf=''; let id=0; const pending=new Map();
child.stdout.on('data',d=>{buf+=d;for(;;){const i=buf.indexOf('\n');if(i<0)break;const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line)continue;const m=JSON.parse(line);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}}});
const req=(method,params)=>new Promise(resolve=>{const n=++id;pending.set(n,resolve);child.stdin.write(JSON.stringify({method,id:n,params})+'\n');});
const init=await req('initialize',{clientInfo:{name:'hc-readonly-probe',version:'0.2.0'},capabilities:{}});const list=await req('thread/list',{limit:5});console.log(JSON.stringify({binary,initialize:{userAgent:init.result?.userAgent,codexHome:init.result?.codexHome},threadListCount:list.result?.data?.length??0,nextCursor:list.result?.nextCursor,writeActionsInvoked:[]},null,2));child.kill('SIGTERM');
