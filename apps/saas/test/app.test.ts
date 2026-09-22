import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

async function request(server:ReturnType<typeof createApp>['server'],path:string,init:RequestInit={}){await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));const address=server.address();const port=typeof address==='object'&&address?address.port:0;const response=await fetch(`http://127.0.0.1:${port}${path}`,init);server.close();return response;}
test('test routes are absent unless explicitly injected',async()=>{const {server}=createApp();const res=await request(server,'/v1/test/users',{method:'POST',body:'{}'});assert.equal(res.status,404);});
test('spoofed x-user-id cannot authorize binding resources',async()=>{const {server}=createApp();const res=await request(server,'/v1/bindings/fake/task-grants',{headers:{'x-user-id':'victim'}});assert.notEqual(res.status,200);});
