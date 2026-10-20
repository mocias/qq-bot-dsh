import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore,scopeOf } from '../lib/memory.mjs';
import { initializeLife,observeCompaction,due,maintain,noteArrival } from '../lib/lifecycle.mjs';
import { defaults,writeJson } from '../lib/config.mjs';
import { Bridge } from '../lib/bridge.mjs';
import { importMemory } from '../lib/import-memory.mjs';

const key='123456/private/234567';
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-lifecycle-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
const update=(text='用户喜欢红茶')=>({action:'write',page:'user/preferences.md',text,reason:'用户明确要求记住',evidence:['message-1']});
function compression(session,store,id,seq,time=1000000,error){
  observeCompaction(session,{type:'compaction/summary',seq,time,data:{compactionId:id,summary:[{type:'text',text:'用户喜欢红茶'}]}},store,()=>{});
  observeCompaction(session,{type:'compaction/end',seq:seq+1,time,data:{compactionId:id,...(error?{error}: {})}},store,()=>{});
}
function session(){const s={id:'old',blocked:false,route:{key,id:'234567',group:false},workspace:'same-workspace',preset:'private'};initializeLife(s,1000000);return s;}

test('memory writes have evidence, survive restart, recall and forget, and cannot cross private/group stores',t=>{
  const runtime=temp(t),privateMemory=new MemoryStore(runtime,key),group=new MemoryStore(runtime,'123456/group/345678');
  assert.throws(()=>privateMemory.commit([update()],{id:'bad',evidenceIds:['wrong']}),/来源/);
  privateMemory.commit([update()],{id:'remember-1',evidenceIds:['message-1'],summary:'用户喜欢红茶'});
  const restored=new MemoryStore(runtime,key);
  assert.match(restored.context('喝什么',defaults),/用户喜欢红茶/);
  assert.doesNotMatch(group.context('喝什么',defaults),/用户喜欢红茶/);
  assert.equal(restored.commit([update()],{id:'remember-1',evidenceIds:['message-1']}),false);
  assert.throws(()=>group.commit([{...update(),page:'identity/admin.md'}],{id:'group',evidenceIds:['message-1']}),/基础身份/);
  assert.throws(()=>restored.commit([{...update(),page:'../group/private.md'}],{id:'traverse',evidenceIds:['message-1']}),/格式/);
  restored.commit([{...update(),action:'forget',text:''}],{id:'forget-1',evidenceIds:['message-1']});
  assert.doesNotMatch(restored.context('喝什么',defaults),/用户喜欢红茶/);
  assert.ok(fs.readdirSync(path.join(restored.dir,'.runtime/revisions')).length===2);
});
test('partially written memory transactions recover before returning a durable receipt',t=>{
  const runtime=temp(t),store=new MemoryStore(runtime,key);
  writeJson(store.txFile,{key,files:[{name:'user/recovery.md',text:'recoverable fact'},{name:'log.md',text:'<!-- recovery -->'},{name:'.runtime/store.json',text:JSON.stringify({...store.state,receipts:['recovery']})}]});
  const recovered=new MemoryStore(runtime,key);assert.equal(recovered.hasReceipt('recovery'),true);
  assert.match(recovered.context('fact',defaults),/recoverable fact/);assert.equal(fs.existsSync(store.txFile),false);
});
test('only matching successful compactions count, replays and maintenance cannot trigger self loops',t=>{
  const store=new MemoryStore(temp(t),key),s=session();
  compression(s,store,'ok',1);compression(s,store,'ok',1);compression(s,store,'failed',3,1000000,'model error');
  observeCompaction(s,{type:'compaction/end',seq:5,data:{compactionId:'missing'}},store,()=>{});
  observeCompaction(s,{type:'compaction/summary',seq:6,data:{compactionId:'internal',summary:[]}},store,()=>{},true);
  observeCompaction(s,{type:'compaction/end',seq:7,data:{compactionId:'internal'}},store,()=>{},true);
  assert.equal(s.life.compactions.length,1);assert.equal(due(s,defaults,1000000+29*60000),null);
  assert.equal(due(s,defaults,1000000+30*60000),'digest');
  noteArrival(s,1000000+30*60000);assert.equal(due(s,defaults,1000000+31*60000),null);
  const empty=session();empty.life.conversation=[{text:'many conversations'}];assert.equal(due(empty,defaults,9000000),null);
});
test('30-minute idle digest writes a receipt and 15 compactions rotate only after that receipt',async t=>{
  const store=new MemoryStore(temp(t),key),s=session();for(let i=0;i<15;i++)compression(s,store,'cp-'+i,i*2+1);
  const rotated=[];let called=0;
  const dsh={async prompt(id,text){called++;assert.equal(id,'old');assert.match(text,/空闲记忆整理/);return JSON.stringify({reply:'',summary:'无新增',memory:[]});}};
  await maintain({session:s,config:defaults,store,dsh,persist(){},now:()=>2800000,isCurrent:()=>true,signal:new AbortController().signal,rotate:async receipt=>{assert.ok(store.hasReceipt(receipt));rotated.push(receipt);}});
  assert.equal(called,1);assert.equal(rotated.length,1);assert.equal(s.life.digestedIds.length,15);assert.equal(s.life.pending,null);
});
test('failed maintenance retains pending compactions and no receipt can cause rotation',async t=>{
  const store=new MemoryStore(temp(t),key),s=session();compression(s,store,'cp',1);
  await assert.rejects(maintain({session:s,config:{...defaults,rotateAfterCompactions:1},store,dsh:{async prompt(){return'我已整理好了';}},persist(){},now:()=>2800000,isCurrent:()=>true,signal:new AbortController().signal,rotate(){assert.fail();}}),/格式/);
  assert.deepEqual(s.life.digestedIds,[]);assert.equal(s.life.receipt,null);assert.equal(store.state.completed,0);assert.ok(s.life.retryAt>2800000);
});
test('new input cancels maintenance, preserves undigested work, and never publishes a stale result',async t=>{
  const store=new MemoryStore(temp(t),key),s=session();compression(s,store,'cp',1);
  const controller=new AbortController();let release;
  const task=maintain({session:s,config:defaults,store,dsh:{prompt(){return new Promise(resolve=>release=resolve);}},persist(){},now:()=>2800000,isCurrent:()=>true,signal:controller.signal,rotate(){assert.fail();}});
  noteArrival(s,2800001);controller.abort();release(JSON.stringify({reply:'',summary:'late',memory:[]}));await task;
  assert.equal(store.state.completed,0);assert.equal(s.life.receipt,null);assert.deepEqual(s.life.digestedIds,[]);
});
test('rotation survives restart during rename, reuses candidate and retains workspace, history and memory',async t=>{
  const runtime=temp(t),bridge=new Bridge(runtime,{now:()=>2800000});bridge.config={...defaults,privatePreset:'private'};bridge.generation=1;
  const s=session();s.workspace=path.join(runtime,'original');const scope=bridge.scope(s.route);bridge.state.sessions[scope]=s;
  const store=bridge.memory(key);store.commit([],{id:'digest-proof',evidenceIds:[],digest:true});
  let creates=0;bridge.dsh={async createSession(dir){creates++;assert.equal(dir,s.workspace);return'next';},async rename(){throw Error('temporary rename failure');}};
  await assert.rejects(bridge.rotate(scope,s,'digest-proof',0,1,new AbortController().signal));
  assert.equal(bridge.state.sessions[scope].id,'old');assert.equal(bridge.state.rotations.old.newId,'next');
  const restored=new Bridge(runtime,{now:()=>2800000});restored.config=bridge.config;restored.generation=1;
  restored.dsh={async createSession(){assert.fail('must reuse persisted candidate');},async rename(id,title){assert.equal(id,'next');assert.equal(title,'1970-01-01-私聊-234567-2');}};
  await restored.rotate(scope,restored.state.sessions[scope],'digest-proof',0,1,new AbortController().signal);
  assert.equal(restored.state.sessions[scope].id,'next');assert.equal(restored.state.sessions[scope].workspace,s.workspace);
  assert.equal(restored.state.retired[0].id,'old');assert.equal(restored.state.rotations.old.status,'complete');assert.equal(creates,1);
  assert.ok(restored.memory(key).hasReceipt('digest-proof'));
});
test('arrival while a successor is being created keeps the current conversation',async t=>{
  const runtime=temp(t),bridge=new Bridge(runtime,{now:()=>2800000});bridge.config={...defaults,privatePreset:'private'};bridge.generation=1;
  const s=session(),scope=bridge.scope(s.route);bridge.state.sessions[scope]=s;bridge.memory(key).commit([],{id:'proof',evidenceIds:[],digest:true});
  let create;bridge.dsh={createSession(){return new Promise(resolve=>create=resolve);},rename(){assert.fail('cannot commit after arrival');}};
  const task=bridge.rotate(scope,s,'proof',0,1,new AbortController().signal);noteArrival(s,2800001);create('unused');await task;
  assert.equal(bridge.state.sessions[scope].id,'old');assert.equal(bridge.state.rotations.old.status,'pending');
});
test('saved receipt recovers digest checkpoint without asking the model to digest again',t=>{
  const runtime=temp(t),bridge=new Bridge(runtime),s=session();bridge.config={...defaults,privatePreset:'private'};
  s.life.pending={id:'saved',version:0,compactionIds:['cp']};bridge.state.sessions[bridge.scope(s.route)]=s;
  bridge.memory(key).commit([],{id:'saved',evidenceIds:[],digest:true});bridge.persist();
  const restored=new Bridge(runtime),life=Object.values(restored.state.sessions)[0].life;
  assert.equal(life.pending,null);assert.equal(life.receipt,'saved');assert.deepEqual(life.digestedIds,['cp']);
});
test('legacy import is immutable, owner-scoped and excludes embedded groups from private recall',t=>{
  const root=temp(t),source=path.join(root,'source'),runtime=path.join(root,'runtime');fs.mkdirSync(path.join(source,'user'),{recursive:true});fs.mkdirSync(path.join(source,'groups/345678'),{recursive:true});
  fs.writeFileSync(path.join(source,'SOUL.md'),'# old persona');fs.writeFileSync(path.join(source,'user/preferences.md'),'old tea preference');fs.writeFileSync(path.join(source,'groups/345678/MEMORY.md'),'GROUP_ONLY_SECRET');
  const result=importMemory({runtime,key,source});assert.equal(result.files,2);assert.match(new MemoryStore(runtime,key).context('tea',defaults),/old tea/);
  assert.equal(fs.existsSync(path.join(result.target,'groups')),false);assert.throws(()=>importMemory({runtime,key,source}),/拒绝覆盖/);
  assert.doesNotMatch(new MemoryStore(runtime,'123456/group/345678').context('tea',defaults),/old tea/);
  assert.equal(fs.readFileSync(path.join(source,'user/preferences.md'),'utf8'),'old tea preference');
});
