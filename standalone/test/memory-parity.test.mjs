import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MemoryStore} from '../lib/memory.mjs';
import {maintainMemory,maintenanceRevision,diagnoseMemory} from '../lib/memory-maintenance.mjs';
import {pageAttribution} from '../lib/message-snapshot.mjs';
import {pageState} from '../lib/memory-state.mjs';
import {initializeLife,due,maintain,noteArrival,digestReasons} from '../lib/lifecycle.mjs';
import {defaults,validate} from '../lib/config.mjs';
import {resolveChatConfig} from '../lib/chat-policy.mjs';

function fixture(t,kind='private'){
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-parity-'));
  t.after(()=>{for(const name of fs.readdirSync(runtime,{recursive:true})){const f=path.join(runtime,name);if(fs.lstatSync(f).isFile())fs.chmodSync(f,0o666);}fs.rmSync(runtime,{recursive:true,force:true});});
  const store=new MemoryStore(runtime,`100000001/${kind}/100000002`);
  const get=p=>fs.readFileSync(store.safe(p),'utf8');
  const put=(p,text)=>{fs.mkdirSync(path.dirname(store.safe(p)),{recursive:true});fs.writeFileSync(store.safe(p),text);};
  const session={id:'session',route:{key:store.key,group:kind==='group'}};initializeLife(session,Date.now()-10000);
  const run=(operations,preview=false)=>maintainMemory(store,{operations,expectedRevision:maintenanceRevision(store),preview});
  return {runtime,store,session,get,put,run};
}
const fm=(title,body)=>`---\ntitle: ${title}\ndate: 2020-01-01\ntype: concept\nsummary: ${title}\nsalience: 2\nlast_access: 2020-01-01\n---\n${body}\n`;
const op=(action,page,extra={})=>({action,page,reason:'核对原文后整理',...extra});
const attrs=qq=>'\n<!-- qq-attribution-v2 -->\n来源\n'+JSON.stringify([{qq,basis:'reported',sources:[{sourceId:'original',speaker:{qq:'100000003'},subjectQQ:qq,basis:'reported'}]}])+'\n<!-- /qq-attribution-v2 -->';

for(const kind of ['private','group'])test(kind+' completed conversations digest without compression, coalesce and do not rotate',async t=>{
  const {store,session}=fixture(t,kind),config={...defaults,memoryIdleSeconds:1,memoryMinTurns:3};
  session.life.conversation=Array.from({length:3},(_,i)=>({inputs:[{messageId:'m'+i}],reply:'reply',at:Date.now()-10000}));
  assert.equal(due(session,config,Date.now(),store),'digest');let calls=0;
  await maintain({session,config,store,dsh:{async prompt(id,text){calls++;assert.match(text,/conversation-idle/);return JSON.stringify({reply:'',summary:'核对无新增',memory:[]});}},persist(){},now:Date.now,isCurrent:()=>true,signal:new AbortController().signal,rotate(){assert.fail('no compression, no rotation');}});
  assert.equal(calls,1);assert.equal(store.state.completed,1);assert.ok(store.hasReceipt(session.life.receipt));assert.equal(due(session,config,Date.now(),store),null);
  assert.equal(session.life.conversation.length,0);
});

test('stale reminders use log/index mtime, persist cooldown/cap, require human conversation and share idle gate',async t=>{
  const {store,session}=fixture(t);const config={...defaults,memoryIdleSeconds:1,memoryStaleSeconds:10,memoryStaleCooldownSeconds:20,memoryStaleMaxPerSession:1};
  const old=Date.now()-100000;for(const name of ['index.md','log.md'])fs.utimesSync(store.safe(name),old/1000,old/1000);
  assert.equal(due(session,config,Date.now(),store),null);
  session.life.conversation=[{inputs:[{messageId:'one'}]}];assert.deepEqual(digestReasons(session,config,Date.now(),store),['stale-store']);
  noteArrival(session,Date.now());assert.equal(due(session,config,Date.now(),store),null);session.life.lastAt=old;
  await maintain({session,config,store,dsh:{async prompt(){return JSON.stringify({reply:'',summary:'无新增',memory:[]});}},persist(){},now:Date.now,isCurrent:()=>true,signal:new AbortController().signal,rotate(){assert.fail();}});
  const restored=JSON.parse(JSON.stringify(session));assert.equal(restored.life.staleNudges,1);
  for(const name of ['index.md','log.md'])fs.utimesSync(store.safe(name),old/1000,old/1000);
  assert.equal(due(restored,config,Date.now()+30000,store),null);
  restored.life.staleNudges=0;assert.equal(due(restored,config,restored.life.lastStaleNudgeAt+19000,store),null);
  assert.equal(due(restored,config,restored.life.lastStaleNudgeAt+21000,store),'digest');
  fs.utimesSync(store.safe('index.md'),Date.now()/1000,Date.now()/1000);assert.equal(due(restored,config,Date.now(),store),null);
});

test('all trigger reasons coalesce; explicit version invalidation prevents a stale digest commit',async t=>{
  const {store,session}=fixture(t),config={...defaults,memoryIdleSeconds:1,memoryMinTurns:1,memoryStaleSeconds:1};
  session.life.conversation=[{inputs:[{messageId:'one'}]}];session.life.compactions=[{id:'c',sourceId:'c'}];
  for(const name of ['index.md','log.md'])fs.utimesSync(store.safe(name),1,1);
  assert.deepEqual(digestReasons(session,config,Date.now(),store),['compaction-idle','conversation-idle','stale-store']);
  session.life.compactions=[];let release;
  const task=maintain({session,config,store,dsh:{prompt(){return new Promise(r=>release=r);}},persist(){},now:Date.now,isCurrent:()=>true,signal:new AbortController().signal,rotate(){assert.fail();}});
  noteArrival(session,Date.now());release(JSON.stringify({reply:'',summary:'too late',memory:[]}));await task;
  assert.equal(store.state.completed,0);assert.equal(session.life.conversation.length,1);
});

test('new trigger settings inherit and validate private/group overrides',()=>{
  const config=validate({botQQ:'100000001',privateUsers:['100000002'],chatPolicy:{private:{memoryMinTurns:7},group:{memoryStaleEnabled:false},overrides:{'100000001/private/100000002':{memoryMinTurns:2}}}});
  assert.equal(resolveChatConfig(config,'100000001/private/100000002').memoryMinTurns,2);
  assert.equal(resolveChatConfig(config,'100000001/group/100000002').memoryStaleEnabled,false);
  assert.throws(()=>validate({memoryMinTurns:0}));assert.throws(()=>validate({memoryStaleSeconds:-1}));
});

test('index editorial control preserves chosen sections/order and backfills original summaries',t=>{
  const {store,put,get,run}=fixture(t);put('concepts/a.md',fm('A','旧A').replace('summary: A\n',''));put('concepts/b.md',fm('B','旧B'));
  put('index.md','# 索引\n\n## 原区\n- [A](concepts/a.md) — 已有原始摘要 `salience:2`\n- [B](concepts/b.md)\n- [失效](concepts/gone.md)\n');
  const index='# 索引\n说明保留\n## 新分区乙\n- [B](concepts/b.md)\n## 新分区甲\n- [A](concepts/a.md)\n';
  run([op('sync_summaries'),op('edit_index',undefined,{index})],true);assert.match(get('index.md'),/原区/);
  run([op('sync_summaries'),op('edit_index',undefined,{index})]);assert.match(get('concepts/a.md'),/已有原始摘要/);
  assert.ok(get('index.md').indexOf('concepts/b.md')<get('index.md').indexOf('concepts/a.md'));assert.match(get('index.md'),/说明保留/);assert.doesNotMatch(get('index.md'),/gone.md/);
  const saved=get('index.md');run([op('sync_index')]);assert.equal(get('index.md'),saved);
  assert.throws(()=>run([op('edit_index',undefined,{index:'- [外部](../outside.md)'})]),/本库/);
});

for(const kind of ['private','group'])test(kind+' semantic merge keeps original provenance and full revisions, rejects fabricated quotes',t=>{
  const {store,put,get,run}=fixture(t,kind),target='user/100000002.md',source='user/100000002/tea.md';
  const a=fm('偏好','有人说他喜欢茶，但尚未本人确认。')+attrs('100000002'),b=fm('红茶','据转述，他在2020年喜欢红茶。')+attrs('100000002');
  put(target,a);put(source,b);
  const claims=[{text:'转述信息（未获本人确认）：他在2020年喜欢红茶。',evidence:[{page:target,quote:'有人说他喜欢茶，但尚未本人确认。'},{page:source,quote:'据转述，他在2020年喜欢红茶。'}]}];
  assert.throws(()=>run([op('merge',target,{sources:[source],claims:[{text:'伪造',evidence:[{page:target,quote:'不存在'}]}]})]),/原文/);
  assert.equal(get(target),a);assert.equal(get(source),b);
  run([op('merge',target,{sources:[source],claims})]);assert.match(get(target),/转述信息（未获本人确认）/);
  assert.equal(pageAttribution(get(target))[0].basis,'reported');assert.equal(pageState(get(source)).state,'merged');assert.ok(get(source).includes('据转述，他在2020年喜欢红茶。'));
  const revisions=fs.readdirSync(store.safe('.runtime/revisions')).map(f=>JSON.parse(get('.runtime/revisions/'+f)));
  assert.ok(revisions.some(r=>r.before.some(p=>p.text===a)));assert.ok(revisions.some(r=>r.before.some(p=>p.text===b)));
  assert.equal(revisions.at(-1).maintenance.operations[0].claims[0].evidence[0].quote,claims[0].evidence[0].quote);
  run([op('consolidate',target,{claims:[{text:'仍待本人核实的2020年红茶偏好。',evidence:[{page:target,quote:'转述信息（未获本人确认）：他在2020年喜欢红茶。'}]}]})]);assert.match(get(target),/仍待本人核实/);
});

test('strict lint covers original mandatory metadata, priority, routing bounds and log shape',t=>{
  const {store,put,get,run}=fixture(t);put('concepts/a.md','---\nsalience: 9\n---\n正文');put('log.md','# 日志\n## 日期错了\n');
  const report=diagnoseMemory(store,{limit:50}).strict;assert.equal(report.passed,false);
  for(const code of ['missing','missing-frontmatter','invalid-salience','malformed-log'])assert.ok(report.issues.some(x=>x.code===code),code);
  put('concepts/a.md',fm('A','正文'));put('log.md','# 日志\n## [2020-01-01] digest | 无新增\n## [2020-01-01T00:00:00.000Z] remember | 兼容旧宿主\n');run([op('sync_index')]);assert.equal(diagnoseMemory(store).strict.passed,true);
  put('index.md',get('index.md').replace('— A','— '+ '超长'.repeat(100)));assert.ok(diagnoseMemory(store).strict.issues.some(x=>x.code==='line-too-long'));
});
