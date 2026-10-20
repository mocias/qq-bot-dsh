import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {createApp} from '../server.mjs';
import {validate,writeJson} from '../lib/config.mjs';
import {VoiceService} from '../lib/voice-service.mjs';
import {QQControl} from '../lib/qq-control.mjs';
import {MemoryStore,preparePrompt} from '../lib/memory.mjs';
import {Bridge} from '../lib/bridge.mjs';
import {Proactive} from '../lib/proactive.mjs';
import {initializeLife} from '../lib/lifecycle.mjs';
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-panel-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function wav(){const b=Buffer.alloc(364);b.write('RIFF');b.writeUInt32LE(356,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(320,40);return b;}
async function panel(t){
 const runtime=temp(t),voice=new VoiceService(runtime,runtime),qqControl={status:async config=>({expectedAccount:config.botQQ,message:'mock-online'}),qrcode:async()=>({image:'data:image/png;base64,test'}),contacts:async()=>({items:[]})};
 const app=createApp({runtime,voice,qqControl});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 t.after(async()=>{app.bridge.stop();await new Promise(r=>app.server.close(r));});
 const origin=new URL(app.loginUrl()).origin,login=await fetch(app.loginUrl(),{redirect:'manual'}),cookie=login.headers.get('set-cookie').split(';')[0];
 const api=async(url,input)=>{const response=await fetch(origin+url,{method:input===undefined?'GET':'POST',headers:{cookie,Origin:origin,'X-QQ-RSI':'panel','Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:response.status,data:await response.json()};};
 return {runtime,voice,app,api,origin,cookie};
}
test('reference deletion is reversible, hides audio and protects the saved clone',async t=>{
 const {api,voice}=await panel(t),reference=voice.uploadReference(wav(),'test voice');
 assert.equal((await api('/api/voice/config',{mimoReferenceId:reference.id,mimoTtsMode:'clone'})).status,200);
 assert.equal((await api('/api/voice/reference/delete',{id:reference.id})).status,400);
 await api('/api/voice/config',{mimoTtsMode:'preset'});
 assert.equal((await api('/api/voice/reference/delete',{id:reference.id})).status,200);
 assert.throws(()=>voice.reference(reference.id));
 const list=(await api('/api/voice/references')).data;assert.equal(list.references.length,0);assert.equal(list.deleted[0].id,reference.id);
 assert.equal((await api('/api/status')).data.config.mimoReferenceId,'');
 assert.equal((await api('/api/voice/reference/restore',{id:reference.id})).status,200);
 assert.deepEqual(voice.reference(reference.id).bytes,wav());
 voice.busy=true;assert.equal((await api('/api/voice/reference/delete',{id:reference.id})).status,400);voice.busy=false;
 assert.equal((await api('/api/voice/reference/delete',{id:'../../config.private.json'})).status,400);
});
test('opening a numbered memory is isolated and does not expand reception; deleting policy or target retains memory',async t=>{
 const {api,runtime}=await panel(t);
 await api('/api/config',{botQQ:'100000001',privateUsers:['100000002'],groups:['100000003']});
 const opened=await api('/api/manage/open',{kind:'private',id:'100000004'});assert.equal(opened.status,200);assert.equal(opened.data.key,'100000001/private/100000004');
 assert.deepEqual((await api('/api/status')).data.config.privateUsers,['100000002']);
 assert.ok((await api('/api/manage')).data.keys.includes(opened.data.key));
 const peer=await api('/api/manage/open',{kind:'group',id:'100000004'});assert.notEqual(peer.data.detail.insights.store,opened.data.detail.insights.store);
 const key='100000001/private/100000002',data=(await api('/api/manage?key='+key)).data;
 await api('/api/manage/persona',{key,text:'isolated persona',revision:data.detail.personaRevision});
 let policy=(await api('/api/chat-policy?scope='+key)).data;
 await api('/api/chat-policy',{scope:key,revision:policy.revision,patch:{voiceSend:false,memoryAutoInject:false}});
 policy=(await api('/api/chat-policy?scope='+key)).data;assert.ok(policy.overriddenScopes.includes(key));
 await api('/api/chat-policy',{scope:key,revision:policy.revision,reset:true});
 assert.equal((await api('/api/manage?key='+key)).data.detail.persona,'isolated persona');
 await api('/api/chat-target',{kind:'private',id:'100000002',remove:true});
 assert.deepEqual((await api('/api/status')).data.config.privateUsers,[]);
 assert.equal((await api('/api/manage?key='+key)).data.detail.persona,'isolated persona');
 assert.equal((await api('/api/chat-policy?scope='+key)).status,400);
 assert.ok(fs.existsSync(new MemoryStore(runtime,key).dir));
 assert.equal((await api('/api/manage/open',{kind:'private',id:'../x'})).status,400);
});
test('QQ control endpoints are authenticated and login operations are gated by stopped bridge',async t=>{
 const {api,app,origin}=await panel(t);
 assert.equal((await fetch(origin+'/api/qq/control/status',{method:'POST'})).status,401);
 await api('/api/config',{botQQ:'100000001'});
 assert.equal((await api('/api/qq/control/status',{})).data.expectedAccount,'100000001');
 app.bridge.status.state='running';
 assert.equal((await api('/api/qq/control/qrcode',{})).status,400);
 assert.equal((await api('/api/chat-target',{kind:'private',id:'100000002'})).status,400);
 assert.equal((await api('/api/qq/control/status',{})).status,200);
 app.bridge.status.state='stopped';assert.equal((await api('/api/qq/control/qrcode',{})).status,200);
});
test('NapCat adapter uses local authenticated management, keeps QR local, refuses replacing login and sanitizes lists',async t=>{
 const dir=temp(t);writeJson(path.join(dir,'config','webui.json'),{token:'private-admin-test',port:6099,host:'0.0.0.0'});
 let logged=false;const calls=[];
 const control=new QQControl({fetch:async(url,options)=>{
   calls.push({url,options});const route=new URL(url).pathname;
   if(route.endsWith('/auth/login')){assert.equal(JSON.parse(options.body).hash,createHash('sha256').update('private-admin-test.napcat').digest('hex'));return Response.json({code:0,data:{Credential:'credential-test'}});}
   assert.equal(options.headers.Authorization,'Bearer credential-test');
   if(route.endsWith('/CheckLoginStatus'))return Response.json({code:0,data:{isLogin:logged}});
   if(route.endsWith('/GetQQLoginInfo'))return Response.json({code:0,data:{uin:'100000001'}});
   return Response.json({code:0,data:{qrcode:'https://login.example.test/qr'}});
 },connect:async()=>({account:'100000001',items:[{user_id:100000002,nickname:'friend'},{user_id:'../x'}]})});
 const config=validate({napcatFrameworkDir:dir,botQQ:'100000001'});
 const qr=await control.qrcode(config);assert.match(qr.image,/^data:image\/png;base64,/);
 assert.ok(calls.every(x=>x.url.startsWith('http://127.0.0.1:6099/api/')));
 logged=true;await assert.rejects(control.qrcode(config),/已登录/);
 assert.deepEqual((await control.contacts(config,'private')).items,[{id:'100000002',name:'friend'}]);
 assert.equal((await control.status(config)).interfaceOnline,true);
 await assert.rejects(control.contacts(config,'send_private_msg'));
 const status=JSON.stringify(await control.status(config));assert.ok(!status.includes('private-admin-test'));assert.ok(!status.includes('credential-test'));
});
test('memory injection settings change the prompt without reading another chat, and active-only uses persisted last active key',t=>{
 const runtime=temp(t),key='100000001/private/100000002',other='100000001/group/100000003',store=new MemoryStore(runtime,key);
 let reads=0;store.context=()=>{reads++;return 'MEMORY_SENTINEL';};
 const route={key,text:'hello',messageId:'1'},config=validate({memoryActiveOnly:true});
 assert.ok(preparePrompt(store,route,config).includes('MEMORY_SENTINEL'));assert.equal(reads,1);
 assert.ok(!preparePrompt(store,route,{...config,memoryAutoInject:false}).includes('MEMORY_SENTINEL'));
 assert.ok(!preparePrompt(store,route,{...config,memoryContextActive:false}).includes('MEMORY_SENTINEL'));assert.equal(reads,1);
 assert.ok(preparePrompt(store,route,config).length>preparePrompt(store,route,{...config,memoryRegisterSkill:false}).length);
 const bridge=new Bridge(runtime);bridge.config=config;bridge.state.lastActiveKey=other;
 assert.equal(bridge.configFor(route).memoryContextActive,false);
 bridge.state.lastActiveKey=key;assert.equal(bridge.configFor(route).memoryContextActive,true);bridge.stop();
 assert.throws(()=>validate({memoryBootMaxChars:0}));assert.throws(()=>validate({proactiveMaxPerSession:101}));
});
test('proactive session cap prevents further attempts but a successor has its own cap',async t=>{
 const runtime=temp(t);let now=Date.parse('2026-10-20T02:00:00Z');
 const key='100000001/private/100000002',route={key,group:false,id:'100000002'},session={route,lastUserAt:now,proactiveAttempts:0};initializeLife(session,now);
 const store=new MemoryStore(runtime,key);store.commit([{action:'write',page:'user/tea.md',text:'# Tea\n喜欢茶',reason:'request',evidence:['m']}],{id:'m',evidenceIds:['m'],summary:'Tea'});
 const config=validate({recallEnabled:true,recallMinMinutes:1,recallMaxMinutes:1,recallMaxPerDay:5,proactiveMaxPerSession:1}),scheduler=new Proactive(runtime,{now:()=>now,random:()=>0}),opts={activeKey:key};
 assert.equal(await scheduler.candidate(session,config,store,opts),null);now+=60001;
 assert.ok(await scheduler.candidate(session,config,store,opts));session.proactiveAttempts=1;
 assert.equal(await scheduler.candidate(session,config,store,opts),null);
 assert.ok(await scheduler.candidate({...session,proactiveAttempts:0},config,store,opts));
});
