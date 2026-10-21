import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {PersonaCards,personaScope} from '../lib/persona-cards.mjs';
import {MemoryStore,scopeOf} from '../lib/memory.mjs';
import {Management} from '../lib/management.mjs';
import {VoiceProfiles} from '../lib/voice-profiles.mjs';
import {Knowledge} from '../lib/knowledge.mjs';
import {Bridge} from '../lib/bridge.mjs';
import {validate,writeJson} from '../lib/config.mjs';
import {resetMemories} from '../lib/reset-memory.mjs';
import {createApp} from '../server.mjs';

const key='100000001/group/100000003',other='100000001/private/100000003';
const route={key,id:'100000003',group:true,sender:'100000002',text:'你好',messageId:'input-1'};
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-personas-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
const create=(cards,name='小夏',chat=key)=>cards.create({key:chat,name,revision:cards.read().revision});
const assign=(bridge,cards,id)=>bridge.configurePersona({key,personaId:id,revision:cards.read().revision});

test('default keeps legacy paths; previews and edits isolate memories, voice, and knowledge without activation',t=>{
 const runtime=temp(t),cards=new PersonaCards(runtime),management=new Management(runtime),voice=new VoiceProfiles(runtime);
 const old=new MemoryStore(runtime,key);fs.writeFileSync(old.safe('SOUL.md'),'原有的人格');
 assert.equal(old.dir,path.join(runtime,'memories',scopeOf(key)));
 const card=create(cards);assert.equal(cards.view(key).activeId,'default');
 const fresh=management.inspect(key,card.id);assert.notEqual(fresh.persona,'原有的人格');
 management.savePersona({key,personaId:card.id,text:'我是小夏',revision:fresh.personaRevision});
 management.savePage({key,personaId:card.id,page:'concepts/persona-note.md',text:'# 小夏的独立记忆',revision:fresh.emptyRevision});
 assert.equal(management.inspect(key,'default').persona,'原有的人格');
 assert.ok(!new MemoryStore(runtime,key,'default').pages().some(p=>p.text.includes('小夏的独立记忆')));
 const profile=voice.save({name:'声音 A',settings:{voiceProvider:'local'},revision:0});
 voice.assign({key,personaId:card.id,profileId:profile.id,revision:voice.selection(key,card.id).revision});
 assert.equal(voice.selection(key,'default').saved,null);assert.equal(voice.selection(key,card.id).saved.name,'声音 A');
 const knowledge=new Knowledge(runtime,key,card.id),state=knowledge.read();state.slang.push({id:'note',term:'小夏用语'});knowledge.save(state);
 assert.equal(new Knowledge(runtime,key).read().slang.length,0);
 assert.equal(cards.view(key).activeId,'default');
 assert.throws(()=>new MemoryStore(runtime,other,card.id),/不存在/);
 assert.throws(()=>new MemoryStore(runtime,key,'../../escape'),/不存在/);
 assert.throws(()=>create(cards,'小夏'),/名称/);
});

test('A-B-A restores sessions, workspaces, inbox and context; inactive reminders cannot send',async t=>{
 const runtime=temp(t),cards=new PersonaCards(runtime),bridge=new Bridge(runtime);
 bridge.config=validate({botQQ:'100000001',groups:['100000003'],groupPreset:'test'});
 let count=0,sent=0;bridge.dsh={async createSession(){return 'session-'+(++count);},async rename(){},async prompt(){return '';},close(){}};
 bridge.call=async()=>{sent++;return {message_id:'sent'};};t.after(()=>bridge.stop());
 const card=create(cards);
 bridge.status.state='running';await bridge.handle({...route},0);
 const aScope=bridge.scope(route),aSession=bridge.state.sessions[aScope];
 bridge.inbox(key).append({sourceId:'only-A',sender:'100000002',text:'A的消息'});
 bridge.chatWindow(key).sync(bridge.inbox(key).read().messages);
 const aDir=bridge.memory(key).dir,aContext=bridge.chatWindow(key).dir;
 bridge.status.state='stopped';assign(bridge,cards,card.id);
 assert.notEqual(bridge.memory(key).dir,aDir);assert.notEqual(bridge.chatWindow(key).dir,aContext);
 assert.equal(bridge.inbox(key).read().messages.length,0);
 bridge.status.state='running';await bridge.handle({...route,messageId:'input-B'},0);
 const bSession=bridge.state.sessions[bridge.scope(route)];
 assert.notEqual(bSession.id,aSession.id);assert.notEqual(bSession.workspace,aSession.workspace);
 assert.equal(bSession.personaId,card.id);
 await bridge.deliverReminder(aSession,'旧人格提醒','old');assert.equal(sent,0);
 bridge.inbox(key).append({sourceId:'only-B',sender:'100000002',text:'B的消息'});
 bridge.status.state='stopped';assign(bridge,cards,'default');
 assert.equal(bridge.scope(route),aScope);assert.equal(bridge.state.sessions[aScope].id,aSession.id);
 assert.equal(bridge.memory(key).dir,aDir);assert.equal(bridge.chatWindow(key).dir,aContext);
 assert.deepEqual(bridge.inbox(key).read().messages.map(m=>m.sourceId),['only-A']);
 const restored=new Bridge(runtime);restored.config=bridge.config;
 assert.equal(restored.scope(route),aScope);assert.equal(restored.memory(key).dir,aDir);
 assert.equal(restored.state.sessions[aScope].id,aSession.id);restored.stop();
});

test('switch rejects live channels, unfinished exits, stale revisions and preserves other chats',t=>{
 const runtime=temp(t),cards=new PersonaCards(runtime),bridge=new Bridge(runtime),card=create(cards);
 bridge.config=validate({botQQ:'100000001',groups:['100000003'],privateUsers:['100000003']});
 bridge.status.state='running';assert.throws(()=>assign(bridge,cards,card.id),/停止群聊/);
 bridge.status.channels={group:false,private:true};bridge.jobs.set(key,{});
 assert.throws(()=>assign(bridge,cards,card.id),/未结束/);bridge.jobs.clear();
 bridge.state.sessions.old={id:'old',route,exitUnconfirmed:{sessionId:'old'}};
 assert.throws(()=>assign(bridge,cards,card.id),/未结束/);delete bridge.state.sessions.old;
 assert.throws(()=>bridge.configurePersona({key,personaId:card.id,revision:-1}),/已变化/);
 assert.equal(cards.view(key).activeId,'default');assign(bridge,cards,card.id);
 assert.equal(cards.view(other).activeId,'default');assert.equal(bridge.status.channels.private,true);
 bridge.stop();
});

test('reset backs up all cards for one chat and leaves other chat data intact',t=>{
 const runtime=temp(t),cards=new PersonaCards(runtime),bridge=new Bridge(runtime),card=create(cards);
 const a=new MemoryStore(runtime,key,'default'),b=new MemoryStore(runtime,key,card.id),untouched=new MemoryStore(runtime,other);
 fs.writeFileSync(a.safe('SOUL.md'),'A');fs.writeFileSync(b.safe('SOUL.md'),'B');fs.writeFileSync(untouched.safe('SOUL.md'),'other');
 const result=resetMemories(runtime,bridge,[key]);
 assert.ok(!fs.existsSync(a.dir));assert.ok(!fs.existsSync(b.dir));
 assert.equal(fs.readFileSync(untouched.safe('SOUL.md'),'utf8'),'other');
 for(const id of ['default',card.id])assert.ok(fs.existsSync(path.join(runtime,'memory-reset-backups',result.backupId,'memories',personaScope(key,id),'SOUL.md')));
});

test('HTTP create-preview-edit-confirm round trip and concurrent tabs do not cross persona boundaries',async t=>{
 const runtime=temp(t);writeJson(path.join(runtime,'config.private.json'),validate({botQQ:'100000001',groups:['100000003']}));
 const app=createApp({runtime,voice:{status:()=>({}),audio:()=>Buffer.alloc(44)}});
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 t.after(async()=>{app.bridge.stop();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});
 const origin=new URL(app.loginUrl()).origin,login=await fetch(app.loginUrl(),{redirect:'manual'}),cookie=login.headers.get('set-cookie').split(';')[0];
 const api=async(url,input)=>{const r=await fetch(origin+url,{method:input?'POST':'GET',headers:{cookie,Origin:origin,'Content-Type':'application/json','X-QQ-RSI':'panel'},...(input?{body:JSON.stringify(input)}:{})});return {status:r.status,data:await r.json()};};
 let initial=(await api('/api/manage?key='+key)).data;
 const created=await api('/api/persona-cards/create',{key,name:'研究员',revision:initial.personas.revision});assert.equal(created.status,200);
 const id=created.data.detail.personaId;assert.equal(created.data.personas.activeId,'default');
 let saved=await api('/api/manage/persona',{key,personaId:id,text:'只属于研究员的设定',revision:created.data.detail.personaRevision});assert.equal(saved.status,200);
 const missing=await api('/api/manage/persona',{key,text:'不应写入',revision:initial.detail.personaRevision});assert.equal(missing.status,400);
 assert.notEqual((await api('/api/manage?key='+key)).data.detail.persona,'只属于研究员的设定');
 const switched=await api('/api/persona-cards/assign',{key,personaId:id,revision:created.data.personas.revision});assert.equal(switched.status,200);
 assert.equal((await api('/api/manage?key='+key)).data.detail.persona,'只属于研究员的设定');
 assert.equal((await api('/api/persona-cards/assign',{key,personaId:'default',revision:created.data.personas.revision})).status,400);
 initial=(await api('/api/manage?key='+key+'&personaId=default')).data;
 assert.notEqual(initial.detail.persona,'只属于研究员的设定');assert.equal(initial.personas.activeId,id);
 assert.equal((await api('/api/persona-cards/assign',{key,personaId:'default',revision:initial.personas.revision})).status,200);
 const html=await (await fetch(origin+'/',{headers:{cookie}})).text();
 assert.ok(html.includes('id="persona-card"'));assert.ok(html.includes('确定配置'));assert.ok(!html.includes('id="memory-kind"'));
});
