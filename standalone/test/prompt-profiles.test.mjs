import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {PromptProfiles} from '../lib/prompt-profiles.mjs';
import {PersonaCards} from '../lib/persona-cards.mjs';
import {promptText,promptTool} from '../../native-dsh-plugin/lib/prompt-text.mjs';
import {DEFINITIONS} from '../../native-dsh-plugin/lib/schema.mjs';
import {PROMPT_CATALOG} from '../../native-dsh-plugin/lib/prompt-catalog.mjs';
import {nativePrompt} from '../lib/native-turn.mjs';
import {worldSimulationPrompt,WorldSimulationClock} from '../lib/world-simulation.mjs';
import {ConversationInbox} from '../lib/continuous-chat.mjs';
import {workspaceFor} from '../lib/workspace.mjs';
import {createApp} from '../server.mjs';
const key='100000001/group/100000002';
function temp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-prompts-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}

test('global defaults, independent persona overrides, intentional blank, reset and stale save survive restart',t=>{
  const root=temp(t),cards=new PersonaCards(root),p=new PromptProfiles(root);
  const a=cards.create({key,name:'小夏',revision:0}),b=cards.create({key,name:'小冬',revision:1});
  assert.equal(fs.existsSync(p.file),false);p.view(key,a.id);assert.equal(fs.existsSync(p.file),false);
  p.save({revision:0,overrides:{'chat.style':'全局：随意聊天','simulation.body':'全局模拟'}});
  p.save({key,personaId:a.id,revision:1,overrides:{'chat.style':'小夏：少说话','chat.shortStyle':''}});
  assert.equal(promptText(p.resolve(key,a.id),'chat.style'),'小夏：少说话');
  assert.equal(promptText(p.resolve(key,b.id),'chat.style'),'全局：随意聊天');
  assert.equal(promptText(p.resolve(key,a.id),'chat.shortStyle'),'');
  assert.equal(promptText(p.resolve('100000001/private/100000002'),'chat.style'),'全局：随意聊天');
  p.save({revision:2,overrides:{'chat.style':'新版全局'}});
  assert.equal(promptText(new PromptProfiles(root).resolve(key,b.id),'chat.style'),'新版全局');
  assert.equal(promptText(p.resolve(key,a.id),'chat.style'),'小夏：少说话');
  const before=fs.readFileSync(p.file,'utf8');
  assert.throws(()=>p.save({key,personaId:a.id,revision:2,overrides:{}}),/已被修改/);
  assert.throws(()=>p.save({revision:3,overrides:{'unknown':'bad'}}),/条目无效/);
  assert.throws(()=>p.save({revision:3,overrides:{'chat.style':null}}),/条目无效/);
  assert.equal(fs.readFileSync(p.file,'utf8'),before);
  p.save({key,personaId:a.id,revision:3,overrides:{}});
  assert.equal(promptText(p.resolve(key,a.id),'chat.style'),'新版全局');
  assert.equal(fs.readdirSync(path.join(root,'prompt-backups')).length,4);
  assert.equal(fs.existsSync(path.join(root,'memories')),false);
});

test('effective sections reach normal input, timed simulation, wait returns and tool descriptions without changing tool schema',async t=>{
  const root=temp(t),p=new PromptProfiles(root);
  p.save({revision:0,overrides:{'chat.style':'[style]','chat.shortStyle':'[brief]','chat.input.5':'[reply scope]',
    'simulation.body':'[simulation]','simulation.next.1':'[save state]','wait.messages':'[wait choice]',
    'chat.continuous':'[loop]','chat.delegation':'[delegate]','tool.qq_send_message':'[send description]',
    'tool.qq_wait_for_messages.timeoutSeconds':'[seconds]'}});
  const config=p.resolve(key),route={key,group:true,text:'hello',messages:[]};
  const text=nativePrompt(null,route,config,{bootstrap:true,persona:'[persona]',knowledge:{context:()=>''}});
  for(const marker of ['[style]','[reply scope]','[simulation]','[loop]','[delegate]','[persona]'])assert.ok(text.includes(marker),marker);
  assert.match(worldSimulationPrompt(Date.now(),{id:'simulation-test'},config),/\[save state\].*simulation-test/);
  const session={worldSimulationInputAt:0},clock=new WorldSimulationClock(session,{now:()=>60000,config});
  assert.match(clock.delivered(),/\[simulation\]/);
  const inbox=new ConversationInbox(new AbortController().signal,()=>true,{config});inbox.push(route);
  assert.equal((await inbox.take({},async r=>r)).instruction,'[wait choice]');
  const def=DEFINITIONS.find(d=>d.name==='qq_send_message'),overridden=promptTool(def,config);
  assert.equal(overridden.description,'[send description]');
  const structural=p=>Object.fromEntries(Object.entries(p).map(([k,{description,...s}])=>[k,s]));
  assert.deepEqual(structural(overridden.parameters),structural(def.parameters));
  const wait=promptTool(DEFINITIONS.find(d=>d.name==='qq_wait_for_messages'),config);
  assert.equal(wait.parameters.timeoutSeconds.description,'[seconds]');assert.equal(wait.parameters.timeoutSeconds.type,'number');
});

test('scene defaults, scene edits and persona overrides stay isolated through native input and restart',t=>{
  const root=temp(t),p=new PromptProfiles(root),privateKey='100000001/private/100000002';
  const priv=p.resolve(privateKey),group=p.resolve(key);
  assert.match(promptText(priv,'chat.style'),/【私聊】/);
  assert.doesNotMatch(promptText(priv,'chat.style'),/【群聊不是客服队列】/);
  assert.match(promptText(group,'chat.style'),/【群聊不是客服队列】/);
  assert.notEqual(priv.promptProfileRevision,group.promptProfileRevision);
  p.save({kind:'private',revision:0,overrides:{'chat.style':'私聊覆盖','simulation.body':'私聊推演'}});
  assert.equal(promptText(p.resolve(privateKey),'chat.style'),'私聊覆盖');
  assert.notEqual(promptText(p.resolve(key),'chat.style'),'私聊覆盖');
  p.save({key:privateKey,personaId:'default',revision:1,overrides:{'chat.style':'人格覆盖'}});
  assert.equal(p.view(privateKey).inherited['chat.style'],'私聊覆盖');
  assert.equal(promptText(new PromptProfiles(root).resolve(privateKey),'chat.style'),'人格覆盖');
  assert.match(worldSimulationPrompt(Date.now(),null,p.resolve(privateKey)),/私聊推演/);
  assert.throws(()=>p.save({key,kind:'private',personaId:'default',revision:2,overrides:{}}),/不一致/);
  assert.throws(()=>p.view(undefined,undefined,'invalid'),/类型无效/);
  for(const [route,cfg,expected,excluded] of [[{key:privateKey,group:false},p.resolve(privateKey),'人格覆盖','群聊不是客服队列'],[{key,group:true},p.resolve(key),'群聊不是客服队列','私聊覆盖']]){
    const result=nativePrompt(null,{...route,messages:[]},cfg,{bootstrap:true,persona:'测试人格'});
    assert.ok(result.includes(expected));assert.ok(!result.includes(excluded));
  }
  const tools=promptTool(DEFINITIONS.find(x=>x.name==='qq_reply'),JSON.parse(JSON.stringify(p.resolve(privateKey))));
  assert.match(tools.description,/省略replyToMessageId/);
});

test('new workspace names carry only date and explicit persona name; collisions and old paths remain isolated',t=>{
  const root=temp(t),cards=new PersonaCards(root),state={sessions:{}},now=Date.parse('2026-10-20T16:00:00Z'),persist=()=>{};
  cards.rename({key,personaId:'default',name:'知遥',revision:0});
  const a=cards.create({key,name:'小夏/研究员',revision:1});
  const first=workspaceFor(root,state,{key,personaId:a.id},'a',now,persist);
  assert.equal(path.basename(first),'2026-10-21-小夏_研究员');
  const b=cards.create({key,name:'小夏\\研究员',revision:2});
  const other=workspaceFor(root,state,{key,personaId:b.id},'b',now,persist);assert.notEqual(first,other);
  cards.rename({key,personaId:a.id,name:'新名字',revision:3});
  assert.equal(workspaceFor(root,state,{key,personaId:a.id},'a',now,persist),first);
  assert.match(path.basename(workspaceFor(root,state,{key},'default',now,persist)),/^2026-10-21-知遥$/);
  const old=path.join(root,'old-directory');fs.mkdirSync(old);state.sessions.old={workspace:old};
  assert.equal(workspaceFor(root,state,{key},'old',now,persist),old);
});

test('prompt page API is authenticated, isolated, revision-checked and blocks active configuration changes',async t=>{
  const root=temp(t),app=createApp({runtime:root,voice:{status:()=>({}),busy:false}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{app.bridge.stop();await new Promise(r=>app.server.close(r));});
  const origin=new URL(app.loginUrl()).origin;
  assert.equal((await fetch(origin+'/api/prompts')).status,401);
  const login=await fetch(app.loginUrl(),{redirect:'manual'}),cookie=login.headers.get('set-cookie').split(';')[0];
  const headers={cookie,Origin:origin,'X-QQ-RSI':'panel','Content-Type':'application/json'};
  const post=(url,body)=>fetch(origin+url,{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal((await post('/api/config',{botQQ:'100000001',groups:['100000002']})).status,200);
  let r=await fetch(origin+'/api/prompts',{headers}),data=await r.json();
  assert.equal(data.catalog.length,PROMPT_CATALOG.length);assert.ok(data.catalog.some(entry=>entry.id==='tool.qq_send_message.faceId'));assert.equal(data.targets.length,1);assert.equal(fs.existsSync(path.join(root,'memories')),false);
  assert.equal((await fetch(origin+'/prompt-editor.js',{headers})).status,200);
  const html=await(await fetch(origin+'/',{headers})).text();assert.match(html,/id="prompts-tab"/);assert.match(html,/id="prompt-full"/);
  assert.equal((await post('/api/prompts',{revision:0,overrides:{'chat.style':'[owner override]'}})).status,200);
  assert.equal((await post('/api/prompts',{revision:0,overrides:{}})).status,400);
  assert.equal((await post('/api/prompts',{key:'100000001/group/999999999',personaId:'default',revision:1,overrides:{}})).status,400);
  app.bridge.status.state='running';app.bridge.status.channels={group:true,private:false};
  assert.equal((await post('/api/prompts',{revision:1,overrides:{}})).status,400);
  assert.equal((await post('/api/prompts',{key,personaId:'default',revision:1,overrides:{}})).status,400);
  app.bridge.status.state='stopped';app.bridge.status.channels={group:false,private:false};
  assert.equal((await post('/api/prompts',{key,personaId:'default',revision:1,overrides:{'chat.style':'[persona override]'}})).status,200);
  app.bridge.config=JSON.parse(fs.readFileSync(path.join(root,'config.private.json')));
  assert.equal(promptText(app.bridge.configFor({key,group:true}),'chat.style'),'[persona override]');
  assert.equal((await post('/api/persona-cards/rename',{key,personaId:'default',revision:0,name:'知遥'})).status,200);
  assert.equal(new PersonaCards(root).get(key).name,'知遥');
  const privateView=await(await fetch(origin+'/api/prompts?kind=private',{headers})).json();
  assert.equal(privateView.scope,'scene');assert.equal(privateView.kind,'private');
  assert.ok(!privateView.catalog.some(e=>e.id==='chat.input.8'||e.id.startsWith('tool.qq_group_')));
  assert.equal((await post('/api/prompts',{kind:'private',revision:2,overrides:{'chat.style':'private-default'}})).status,200);
  assert.equal((await post('/api/prompts',{kind:'bad',revision:3,overrides:{}})).status,400);
  assert.notEqual(promptText(app.bridge.configFor({key,group:true}),'chat.style'),'private-default');
  app.bridge.status.state='running';app.bridge.status.channels={group:false,private:true};
  assert.equal((await post('/api/prompts',{kind:'private',revision:3,overrides:{}})).status,400);
  app.bridge.status.state='stopped';app.bridge.status.channels={group:false,private:false};
});
