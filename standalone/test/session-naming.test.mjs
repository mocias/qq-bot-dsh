import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Bridge} from '../lib/bridge.mjs';
import {validate} from '../lib/config.mjs';
import {initializeLife,observeCompaction,maintain,due,noteArrival} from '../lib/lifecycle.mjs';

const privateKey='100000001/private/100000002',groupKey='100000001/group/100000003';
const route=key=>({key,group:key.includes('/group/'),id:key.split('/')[2],text:'你好',messageId:key+'/1'});
function setup(t){
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-session-'));
  t.after(()=>fs.rmSync(runtime,{recursive:true,force:true}));
  const bridge=new Bridge(runtime,{now:()=>Date.parse('2026-10-20T16:01:00Z'),media:{outgoing:async()=>null}});
  bridge.config=validate({botQQ:'100000001',privateUsers:['100000002'],groups:['100000003'],privatePreset:'private',groupPreset:'group',
    chatPolicy:{group:{rotationEnabled:true,rotateAfterCompactions:1,memoryIdleSeconds:60}}});
  bridge.status.state='running';bridge.generation=1;
  let count=0;const titles=[];
  bridge.dsh={createSession:async()=>`session-${++count}`,rename:async(id,title)=>titles.push({id,title}),prompt:async()=>'{"reply":"","memory":[],"summary":"无新增"}'};
  return {bridge,runtime,titles};
}
function compact(bridge,session){
  const store=bridge.memory(session.route.key),time=bridge.now()-120000;
  initializeLife(session,time);
  observeCompaction(session,{type:'compaction/summary',seq:1,time,data:{compactionId:'cp',summary:[]}},store,()=>{});
  observeCompaction(session,{type:'compaction/end',seq:2,time,data:{compactionId:'cp'}},store,()=>{});
  session.life.lastAt=time;
}

test('first and manual sessions use Beijing date, peer number and durable per-chat numbering',async t=>{
  const {bridge,runtime,titles}=setup(t);
  await bridge.handle(route(privateKey),1);await bridge.handle(route(groupKey),1);
  assert.deepEqual(titles.map(x=>x.title),['2026-10-21-私聊-100000002-1','2026-10-21-群聊-100000003-1']);
  const before=bridge.state.sessions[bridge.scope(route(groupKey))];
  bridge.memory(groupKey).commit([],{id:'keep-memory',evidenceIds:[],digest:true});
  await bridge.newConversation(groupKey);
  assert.equal(titles.at(-1).title,'2026-10-21-群聊-100000003-2');
  const restored=new Bridge(runtime,{now:()=>Date.parse('2026-10-21T16:01:00Z')});
  restored.config=bridge.config;restored.status.state='running';restored.dsh=bridge.dsh;
  await restored.newConversation(groupKey);
  assert.equal(titles.at(-1).title,'2026-10-22-群聊-100000003-3');
  assert.equal(restored.state.sessions[restored.scope(route(groupKey))].workspace,before.workspace);
  assert.ok(restored.memory(groupKey).hasReceipt('keep-memory'));
  assert.equal(restored.state.sessionNaming.counters[privateKey],1);
});

test('initial rename failure retries the same session and number after restart, before any model prompt',async t=>{
  const {bridge,runtime,titles}=setup(t);let prompts=0;
  bridge.dsh.rename=async()=>{throw Error('rename unavailable');};bridge.dsh.prompt=async()=>{prompts++;return '{"reply":"","memory":[]}';};
  await assert.rejects(bridge.handle(route(groupKey),1),/rename unavailable/);
  assert.equal(prompts,0);
  const restored=new Bridge(runtime,{now:()=>Date.parse('2026-10-22T16:00:00Z'),media:{outgoing:async()=>null}});
  restored.config=bridge.config;restored.generation=1;restored.status.state='running';
  restored.dsh={...bridge.dsh,createSession:async()=>assert.fail('must reuse initial session'),rename:async(id,title)=>titles.push({id,title})};
  await restored.handle(route(groupKey),1);
  assert.deepEqual(titles,[{id:'session-1',title:'2026-10-21-群聊-100000003-1'}]);assert.equal(prompts,1);
});

test('group sweep digests before rotation, obeys per-group disable and waits for buffered group messages',async t=>{
  const {bridge,titles}=setup(t);await bridge.handle(route(groupKey),1);
  const scope=bridge.scope(route(groupKey)),old=bridge.state.sessions[scope];compact(bridge,old);
  bridge.config=validate({chatPolicy:{...bridge.config.chatPolicy,overrides:{[groupKey]:{rotationEnabled:false}}}},bridge.config);
  await bridge.sweep();
  assert.equal(bridge.state.sessions[scope].id,old.id);assert.ok(bridge.memory(groupKey).hasReceipt(old.life.receipt));
  bridge.config=validate({chatPolicy:{...bridge.config.chatPolicy,overrides:{}}},bridge.config);
  bridge.ambient.set(groupKey,{routes:[]});await bridge.sweep();assert.equal(bridge.state.sessions[scope].id,old.id);
  bridge.ambient.delete(groupKey);await bridge.sweep();
  const fresh=bridge.state.sessions[scope];
  assert.notEqual(fresh.id,old.id);assert.equal(fresh.workspace,old.workspace);
  assert.equal(titles.at(-1).title,'2026-10-21-群聊-100000003-2');
  assert.equal(fresh.life.compactions.length,0);assert.ok(bridge.memory(groupKey).hasReceipt(old.life.receipt));
  assert.equal(bridge.state.retired.at(-1).id,old.id);
});

test('group rotation requires a durable receipt, and an arriving group message keeps the current session',async t=>{
  const {bridge}=setup(t);await bridge.handle(route(groupKey),1);
  const scope=bridge.scope(route(groupKey)),old=bridge.state.sessions[scope];compact(bridge,old);
  old.life.digestedIds=['cp'];old.life.receipt='not-on-disk';old.life.digestVersion=old.life.version;
  assert.equal(due(old,bridge.configFor(old.route),bridge.now()),'rotate');
  await assert.rejects(maintain({session:old,config:bridge.configFor(old.route),store:bridge.memory(groupKey),dsh:bridge.dsh,
    persist:()=>bridge.persist(),now:bridge.now,isCurrent:()=>true,signal:new AbortController().signal,rotate:()=>assert.fail('no receipt')}),/回执/);
  bridge.memory(groupKey).commit([],{id:'proof',evidenceIds:[],digest:true});
  let release;bridge.dsh.createSession=()=>new Promise(resolve=>release=resolve);
  const task=bridge.rotate(scope,old,'proof',old.life.version,1,new AbortController().signal);
  noteArrival(old,bridge.now());release('abandoned-candidate');await task;
  assert.equal(bridge.state.sessions[scope].id,old.id);
});

for(const replacement of ['manual','rotation'])test(`native ${replacement} session survives startup and the next message without another replacement`,async t=>{
  const {bridge,runtime,titles}=setup(t);
  bridge.config=validate({dshNativeTools:true},bridge.config);
  bridge.dsh.prompt=async()=>'';
  const input=route(groupKey),scope=bridge.scope(input);
  await bridge.handle(input,1);
  const previous=bridge.state.sessions[scope];
  if(replacement==='manual')await bridge.newConversation(groupKey);
  else{
    bridge.memory(groupKey).commit([],{id:'native-proof',evidenceIds:[],digest:true});
    await bridge.rotate(scope,previous,'native-proof',previous.life.version,1,new AbortController().signal);
  }
  const current=bridge.state.sessions[scope];
  assert.notEqual(current.id,previous.id);
  // Exercise persisted metadata too: startup and ordinary messages must agree.
  const restored=new Bridge(runtime,{media:{outgoing:async()=>null}});
  restored.config=bridge.config;restored.status.state='running';restored.generation=1;restored.dsh=bridge.dsh;
  assert.equal((await restored.ensureStartupSession(input)).id,current.id);
  await restored.handle({...input,messageId:groupKey+'/2'},1);
  assert.equal(restored.state.sessions[scope].id,current.id);
  assert.equal(restored.state.sessions[scope].transport,'native-v1');
  assert.equal(titles.length,2);
  assert.equal(restored.state.retired.length,1);
});

test('failed replacement creation leaves the current session and retirement history intact',async t=>{
  const {bridge}=setup(t),input=route(groupKey),scope=bridge.scope(input);
  await bridge.handle(input,1);
  const current=bridge.state.sessions[scope];current.blocked=true;
  bridge.dsh.createSession=async()=>{throw Error('create unavailable');};
  await assert.rejects(bridge.handle({...input,messageId:'retry'},1),/create unavailable/);
  assert.equal(bridge.state.sessions[scope],current);
  assert.equal(bridge.state.retired.length,0);
});

test('stopping during session creation prevents permission setup and model submission',async t=>{
  const {bridge}=setup(t),input=route(privateKey);
  bridge.config=validate({permissionPreset:'read-only'},bridge.config);
  let release;bridge.dsh.createSession=()=>new Promise(resolve=>release=resolve);
  bridge.dsh.applyPermission=async()=>assert.fail('stopped session cannot change permissions');
  bridge.dsh.prompt=async()=>assert.fail('stopped session cannot submit input');
  const task=bridge.handle(input,1);
  bridge.status.state='stopped';release('cancelled-candidate');
  await assert.rejects(task,/已停止/);
  assert.equal(Object.keys(bridge.state.sessions).length,0);
});

test('session provisioning follows restored bridge state after a rollback',async t=>{
  const {bridge}=setup(t),input=route(privateKey);
  const abandoned=bridge.state;
  bridge.state=structuredClone(bridge.state);
  await bridge.ensureStartupSession(input);
  assert.equal(Object.keys(bridge.state.sessions).length,1);
  assert.equal(Object.keys(abandoned.sessions).length,0);
});
