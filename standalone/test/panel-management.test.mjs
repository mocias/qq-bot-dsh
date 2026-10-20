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
import {scopeOf} from '../lib/memory.mjs';
import {Knowledge} from '../lib/knowledge.mjs';
import {SystemLog} from '../lib/system-log.mjs';
import {recoverMemoryReset} from '../lib/reset-memory.mjs';
import {VoiceProfiles} from '../lib/voice-profiles.mjs';
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-panel-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function wav(){const b=Buffer.alloc(364);b.write('RIFF');b.writeUInt32LE(356,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(320,40);return b;}
test('named voice profiles bind independent persona snapshots, preserve global credentials and survive preset edits/deletion',async t=>{
 const {api,runtime,app,voice,origin}=await panel(t),a='100000001/private/100000002',b='100000001/group/100000003',c='100000009/private/100000002';
 await api('/api/config',{botQQ:'100000001',privateUsers:['100000002'],groups:['100000003']});
 assert.equal((await fetch(origin+'/api/voice/profiles')).status,401);
 const settings={voiceProvider:'mimo',mimoTtsMode:'design',mimoDesign:'清亮而温暖',mimoStyle:'温柔'};
 let saved=await api('/api/voice/profiles/save',{name:'设计 A',settings,revision:0});
 assert.equal(saved.status,200);const id=saved.data.profile.id;
 assert.equal((await api('/api/voice/profiles/save',{name:'非法',settings:{...settings,mimoApiKey:'SECRET'},revision:1})).status,400);
 let info=(await api('/api/manage?key='+a)).data;
 assert.equal((await api('/api/manage/voice',{key:a,profileId:id,revision:info.personaVoice.revision})).status,200);
 assert.equal((await api('/api/manage/voice',{key:a,profileId:id,revision:info.personaVoice.revision})).status,400);
 app.bridge.config=validate({mimoApiKey:'SHARED-SECRET'});
 assert.equal(app.bridge.configFor({key:a}).mimoDesign,settings.mimoDesign);
 assert.equal(app.bridge.configFor({key:a}).mimoApiKey,'SHARED-SECRET');
 assert.equal(app.bridge.configFor({key:b}).mimoDesign,'');assert.equal(app.bridge.configFor({key:c}).mimoDesign,'');
 assert.equal(new VoiceProfiles(runtime).resolve(app.bridge.config,a).mimoTtsMode,'design');
 saved=await api('/api/voice/profiles/save',{id,name:'修改后的设计',settings:{...settings,mimoDesign:'低沉沉稳'},revision:1});
 assert.equal(saved.status,200);assert.equal(app.bridge.configFor({key:a}).mimoDesign,settings.mimoDesign);
 await api('/api/voice/profiles/delete',{id,revision:2});assert.equal(app.bridge.configFor({key:a}).mimoDesign,settings.mimoDesign);
 assert.ok(!JSON.stringify((await api('/api/manage?key='+a)).data).includes('SHARED-SECRET'));
 await api('/api/voice/profiles/restore',{id,revision:3});
 info=(await api('/api/manage?key='+a)).data;
 await api('/api/manage/voice',{key:a,profileId:id,revision:info.personaVoice.revision});
 assert.equal(app.bridge.configFor({key:a}).mimoDesign,'低沉沉稳');
 info=(await api('/api/manage?key='+a)).data;
 await api('/api/manage/voice',{key:a,profileId:'',revision:info.personaVoice.revision});
 assert.equal(app.bridge.configFor({key:a}).voiceProvider,'local');
 // Preview is selected explicitly and does not alter the saved default.
 voice.synthesize=async(text,cfg)=>({text,model:cfg.mimoTtsMode,description:cfg.mimoDesign});
 const preview=await api('/api/voice/synthesize',{text:'hello',profileId:id});
 assert.equal(preview.data.model,'design');assert.equal(preview.data.description,'低沉沉稳');
 assert.equal((await api('/api/status')).data.config.voiceProvider,'local');
 const files=[fs.readFileSync(path.join(runtime,'voice-profiles.private.json'),'utf8'),fs.readFileSync(new MemoryStore(runtime,a).safe('.runtime/persona-voice.json'),'utf8')];
 assert.ok(files.every(text=>!text.includes('SHARED-SECRET')&&!text.includes('mimoApiKey')));
});
test('clone reference remains protected by presets and persona snapshots; reset removes only the persona selection',async t=>{
 const {api,voice,runtime,app}=await panel(t),key='100000001/private/100000002',ref=voice.uploadReference(wav(),'sample');
 await api('/api/config',{botQQ:'100000001',privateUsers:['100000002']});
 const settings={voiceProvider:'mimo',mimoTtsMode:'clone',mimoReferenceId:ref.id};
 const created=await api('/api/voice/profiles/save',{name:'克隆',settings,revision:0});assert.equal(created.status,200);
 const id=created.data.profile.id,info=(await api('/api/manage?key='+key)).data;
 await api('/api/manage/voice',{key,profileId:id,revision:info.personaVoice.revision});
 assert.equal((await api('/api/voice/reference/delete',{id:ref.id})).status,400);
 await api('/api/voice/profiles/delete',{id,revision:1});
 assert.equal((await api('/api/voice/reference/delete',{id:ref.id})).status,400);
 app.bridge.status.state='running';assert.equal((await api('/api/manage/voice',{key,profileId:'',revision:(await api('/api/manage?key='+key)).data.personaVoice.revision})).status,400);app.bridge.status.state='stopped';
 await api('/api/manage/reset',{scope:key,confirm:'RESET '+key});
 assert.equal(new VoiceProfiles(runtime).selection(key).saved,null);
 assert.equal((await api('/api/voice/reference/delete',{id:ref.id})).status,200);
 assert.equal((await api('/api/voice/profiles/restore',{id,revision:2})).status,400);
 await api('/api/voice/reference/restore',{id:ref.id});
 assert.equal((await api('/api/voice/profiles/restore',{id,revision:2})).status,200);
});
test('QQ outgoing voice uses each persona model and audio options without cross-chat leakage',async t=>{
 const {api,app,voice,runtime}=await panel(t),a='100000001/private/100000002',b='100000001/group/100000003';
 await api('/api/config',{botQQ:'100000001',privateUsers:['100000002'],groups:['100000003']});
 const profiles=new VoiceProfiles(runtime),ref=voice.uploadReference(wav(),'reference');
 const design=profiles.save({name:'design',settings:{voiceProvider:'mimo',mimoTtsMode:'design',mimoDesign:'清亮温暖'},revision:0});
 const clone=profiles.save({name:'clone',settings:{voiceProvider:'mimo',mimoTtsMode:'clone',mimoReferenceId:ref.id},revision:1});
 profiles.assign({key:a,profileId:design.id,revision:profiles.selection(a).revision});
 profiles.assign({key:b,profileId:clone.id,revision:profiles.selection(b).revision});
 const calls=[];voice.fetch=async(url,options)=>{calls.push(JSON.parse(options.body));return Response.json({choices:[{finish_reason:'stop',message:{audio:{data:wav().toString('base64')}}}]});};
 app.bridge.config=validate({botQQ:'100000001',mimoApiKey:'shared-test-key',voiceQuietMode:'never',chatPolicy:{group:{voiceSend:true}}});
 for(const key of [a,b]){
  const route={key,id:key.split('/')[2],group:key.includes('/group/'),messageId:'test',text:'你好'};
  const plan=await app.bridge.media.outgoing({reply:'',qq:{voice:'你好'}},route,{workspace:runtime},app.bridge.configFor(route));
  assert.equal(plan.params.message[0].type,'record');
 }
 assert.equal(calls[0].model,'mimo-v2.5-tts-voicedesign');assert.equal(Object.hasOwn(calls[0].audio,'voice'),false);
 assert.equal(calls[0].messages[0].content,'清亮温暖');
 assert.equal(calls[1].model,'mimo-v2.5-tts-voiceclone');assert.match(calls[1].audio.voice,/^data:audio\/wav;base64,/);
 assert.ok(!JSON.stringify(calls[1]).includes('清亮温暖'));
});
test('memory reset archives only requested scope, invalidates old sessions and creates a fresh workspace epoch',async t=>{
 const {api,app,runtime}=await panel(t),key='100000001/private/100000002',other='100000001/group/100000003',historic='100000009/private/100000002';
 await api('/api/config',{botQQ:'100000001',privateUsers:['100000002'],groups:['100000003']});
 for(const k of [key,other,historic]){
  const data=(await api('/api/manage/open',{kind:k.split('/')[1],id:k.split('/')[2]})).data;
  const store=new MemoryStore(runtime,k);fs.writeFileSync(store.safe('SOUL.md'),'private persona '+k);
  store.commit([{action:'write',page:'user/test.md',text:'# secret old memory',reason:'test',evidence:['test']}],{id:'test',evidenceIds:['test']});
 }
 new Knowledge(runtime,key).learn([{term:'testing',meaning:'meaning',evidence:['test']}],['test']);
 app.bridge.config=validate({botQQ:'100000001'});const route={key,id:'100000002',group:false},oldScope=app.bridge.scope(route);
 app.bridge.state.sessions[oldScope]={id:'old-session',route,life:{compactions:[],digestedIds:[]}};
 app.bridge.state.retired=[{id:'old-retired',route}];app.bridge.persist();
 const before=(await api('/api/manage')).data;assert.ok(before.connectedKeys.includes(key));assert.ok(!before.connectedKeys.includes(historic));assert.ok(before.keys.includes(historic));
 assert.equal((await api('/api/manage/reset',{scope:key,confirm:'bad'})).status,400);
 app.bridge.status.state='running';assert.equal((await api('/api/manage/reset',{scope:key,confirm:'RESET '+key})).status,400);app.bridge.status.state='stopped';
 const result=await api('/api/manage/reset',{scope:key,confirm:'RESET '+key});assert.equal(result.status,200);assert.equal(result.data.count,1);
 assert.equal(new MemoryStore(runtime,key).pages().length,0);assert.equal(new Knowledge(runtime,key).read().slang.length,0);
 assert.ok(!fs.readFileSync(new MemoryStore(runtime,key).safe('SOUL.md'),'utf8').includes('private persona'));
 assert.equal(new MemoryStore(runtime,other).pages().length,1);assert.equal(new MemoryStore(runtime,historic).pages().length,1);
 assert.notEqual(app.bridge.scope(route),oldScope);assert.equal(Object.keys(app.bridge.state.sessions).length,0);assert.equal(app.bridge.state.retired.length,0);
 assert.ok(fs.existsSync(path.join(runtime,'memory-reset-backups',result.data.backupId,'memories',scopeOf(key),'user/test.md')));
 assert.equal((await api('/api/manage/reset',{scope:'account',confirm:'RESET 100000001'})).status,200);
 assert.equal(new MemoryStore(runtime,other).pages().length,0);assert.equal(new MemoryStore(runtime,historic).pages().length,1);
});
test('unfinished reset is rolled back before loading bridge state',t=>{
 const runtime=temp(t),key='100000001/private/100000002',store=new MemoryStore(runtime,key),source='memories/'+scopeOf(key),backup='memory-reset-backups/test/'+source;
 fs.writeFileSync(store.safe('SOUL.md'),'must survive');
 const before={sessions:{preserved:{id:'old'}},retired:[]};writeJson(path.join(runtime,'memory-reset.pending.json'),{phase:'pending',before,moves:[{source,backup}]});
 fs.mkdirSync(path.dirname(path.join(runtime,backup)),{recursive:true});fs.renameSync(path.join(runtime,source),path.join(runtime,backup));
 recoverMemoryReset(runtime);assert.equal(fs.readFileSync(store.safe('SOUL.md'),'utf8'),'must survive');
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtime,'bridge.private.json'))),before);
});
test('system logs persist, filter and rotate without recording credentials or arbitrary payloads',async t=>{
 const {api,app,runtime,origin}=await panel(t);
 assert.equal((await fetch(origin+'/api/logs')).status,401);
 await api('/api/voice/config',{mimoApiKey:'SECRET-NEVER-LOG'});
 app.bridge.reportError('SECRET-CHAT-CONTENT Bearer SECRET-NEVER-LOG');
 const data=(await api('/api/logs?level=error')).data;
 assert.ok(data.entries.some(e=>e.event==='bridge.error'));
 const text=fs.readFileSync(path.join(runtime,'logs','system.jsonl'),'utf8');assert.ok(!text.includes('SECRET-'));assert.ok(!text.includes(app.token));
 const log=new SystemLog(runtime);assert.ok(log.read().entries.length);
 fs.writeFileSync(log.file,' '.repeat(1024*1024+1));log.record('test.rotation');assert.ok(fs.existsSync(log.file+'.1'));assert.equal(log.read().entries.at(-1).event,'test.rotation');
});
test('timer participation yields both before and during candidate selection to buffered group messages',async t=>{
 const runtime=temp(t),bridge=new Bridge(runtime),key='100000001/group/100000003',route={key,id:'100000003',group:true};
 bridge.config=validate({botQQ:'100000001',groups:['100000003']});bridge.status.state='running';bridge.media.prune=()=>{};bridge.syncReminders=()=>{};bridge.sweep=async()=>{};
 const session={id:'s',route,life:{version:0},blocked:false};bridge.state.sessions[bridge.scope(route)]=session;
 let calls=0,reserved=0;
 bridge.proactive.candidate=async()=>{calls++;bridge.ambient.set(key,{routes:[]});return {reserve:()=>reserved++,route};};
 bridge.ambient.set(key,{routes:[]});await bridge.tick();assert.equal(calls,0);
 bridge.ambient.clear();await bridge.tick();assert.equal(calls,1);assert.equal(reserved,0);
 bridge.ambient.clear();bridge.stop();
});
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
 const config=validate({recallEnabled:true,recallMinSeconds:60,recallMaxSeconds:60,recallMaxPerDay:5,proactiveMaxPerSession:1}),scheduler=new Proactive(runtime,{now:()=>now,random:()=>0}),opts={activeKey:key};
 assert.equal(await scheduler.candidate(session,config,store,opts),null);now+=60001;
 assert.ok(await scheduler.candidate(session,config,store,opts));session.proactiveAttempts=1;
 assert.equal(await scheduler.candidate(session,config,store,opts),null);
 assert.ok(await scheduler.candidate({...session,proactiveAttempts:0},config,store,opts));
});
