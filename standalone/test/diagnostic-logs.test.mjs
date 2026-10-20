import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Bridge} from '../lib/bridge.mjs';
import {SystemLog} from '../lib/system-log.mjs';
import {validate} from '../lib/config.mjs';
import {DiagnosticLogs,redactLog} from '../lib/diagnostic-logs.mjs';
import {QQControl} from '../lib/qq-control.mjs';
import {createApp} from '../server.mjs';
import {once} from 'node:events';

test('ordinary group input remains observable during cooldown and direct input still passes',t=>{
 const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-flow-'));
 t.after(()=>fs.rmSync(runtime,{recursive:true,force:true}));
 t.mock.timers.enable({apis:['setTimeout']});
 let now=1000000;
 const bridge=new Bridge(runtime,{now:()=>now}),accepted=[];
 bridge.config=validate({botQQ:'100000001',groups:['100000003'],groupAmbientEnabled:true,groupAmbientDelaySeconds:10,groupAmbientMinSeconds:300,memoryEnabled:false});
 bridge.status={state:'running',active:0,channels:{group:true,private:false}};
 bridge.systemLog=new SystemLog(runtime);bridge.accept=r=>accepted.push(r);
 const key='100000001/group/100000003';
 const incoming=(id,direct=false)=>bridge.receive({post_type:'message',message_type:'group',self_id:100000001,user_id:100000002,group_id:100000003,message_id:id,message:[...(direct?[{type:'at',data:{qq:'100000001'}}]:[]),{type:'text',data:{text:'PRIVATE_BODY'}}]},bridge.generation);
 incoming(1);t.mock.timers.tick(10000);assert.equal(accepted.length,1);
 now+=11000;incoming(2);t.mock.timers.tick(10000);assert.equal(accepted.length,1);
 assert.equal(bridge.inbox(key).read().messages.length,2);
 assert.ok(bridge.systemLog.read({component:'flow'}).entries.some(e=>e.event==='ambient.cooldown'));
 assert.ok(bridge.status.lastObservedAt);
 incoming(3,true);assert.equal(accepted.length,2);
 now+=300000;incoming(4);t.mock.timers.tick(10000);assert.equal(accepted.length,3);
 assert.ok(!fs.readFileSync(bridge.systemLog.file,'utf8').includes('PRIVATE_BODY'));
 bridge.stop();
});

test('external logs redact known credentials, login links and secret fields before truncation',()=>{
 const input='SECRET_LITERAL\nhttp://127.0.0.1:3199/login?token=PRIVATE_LOGIN\n{"api_key":"a long key with spaces","token":"secret"}\nAuthorization: Bearer credential\nCookie: session=abc\nnormal log';
 const output=redactLog(input,['SECRET_LITERAL']);
 for(const v of ['SECRET_LITERAL','PRIVATE_LOGIN','long key','credential','session=abc','"secret"'])assert.ok(!output.includes(v),v);
 assert.ok(output.includes('normal log'));
});

test('related logs use fixed directories, bounded tails, no secrets and idle stream cleanup',async t=>{
 const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-related-'));t.after(()=>fs.rmSync(runtime,{recursive:true,force:true}));
 const napcat=path.join(runtime,'napcat');fs.mkdirSync(napcat);
 fs.writeFileSync(path.join(runtime,'server-test.out.log'),'startup token=secret\n'+'x'.repeat(70000)+'\nlast event\n');
 fs.writeFileSync(path.join(runtime,'config.private.json'),'MUST_NOT_READ');
 fs.writeFileSync(path.join(napcat,'boot.err.log'),'mimo=known-key');
 let calls=0,aborted=false;
 const logs=new DiagnosticLogs(runtime,{async followLogs(c,{signal,onLine,onReady}){
   calls++;onReady();for(let n=0;n<250;n++)onLine('token=private known-key event '+n);
   await new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));
 }},{home:path.join(runtime,'fake-home'),appData:path.join(runtime,'fake-appdata')});
 t.after(()=>logs.close());
 const config={napcatFrameworkDir:napcat,mimoApiKey:'known-key'};
 const a=logs.read(config);logs.read(config);assert.equal(calls,1);assert.equal(a.napcat.entries.length,200);
 assert.equal(a.process.files[0].truncated,true);assert.match(a.process.files[0].text,/last event/);
 assert.ok(!JSON.stringify(a).includes('known-key'));assert.ok(!JSON.stringify(a).includes('token=private'));
 assert.ok(!JSON.stringify(a).includes('MUST_NOT_READ'));
 logs.close();await new Promise(r=>setImmediate(r));assert.ok(aborted);
});

test('NapCat log stream accepts split CRLF SSE frames and decodes message without exposing credentials',async()=>{
 let pending;
 const control=new QQControl();
 control.admin=async()=>({logStream:async()=>new ReadableStream({start(c){pending=c;}})});
 const lines=[],controller=new AbortController();let ready=false;
 const task=control.followLogs({}, {signal:controller.signal,onReady:()=>{ready=true;},onLine:x=>lines.push(x)});
 await new Promise(r=>setImmediate(r));
 pending.enqueue(new TextEncoder().encode('data: {"level":"info","message":"hello"}\r'));
 pending.enqueue(new TextEncoder().encode('\n\r\ndata: second\n\n'));
 controller.abort();pending.close();await task;
 assert.ok(ready);assert.deepEqual(lines,['[info] hello','second']);
});

test('related log endpoint requires panel login and reads only log sources',async t=>{
 const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-log-api-'));t.after(()=>fs.rmSync(runtime,{recursive:true,force:true}));
 const app=createApp({runtime,qqControl:{},diagnosticOptions:{home:path.join(runtime,'fake-home'),appData:path.join(runtime,'fake-appdata')}});
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 t.after(async()=>{app.bridge.stop();await new Promise(r=>app.server.close(r));});
 const origin=new URL(app.loginUrl()).origin;
 assert.equal((await fetch(origin+'/api/logs/related')).status,401);
 const login=await fetch(app.loginUrl(),{redirect:'manual'}),cookie=login.headers.get('set-cookie').split(';')[0];
 const response=await fetch(origin+'/api/logs/related?path=../../config.private.json',{headers:{cookie}});
 assert.equal(response.status,200);const data=await response.json();
 assert.deepEqual(data.process.files,[]);assert.ok(Array.isArray(data.flow.entries));
});
