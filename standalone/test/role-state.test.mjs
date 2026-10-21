import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MemoryStore} from '../lib/memory.mjs';
import {RoleState,currentRoleState,ROLE_STATE_PAGE} from '../lib/role-state.mjs';
import {WorldSimulationClock} from '../lib/world-simulation.mjs';
import {ConversationInbox} from '../lib/continuous-chat.mjs';
import {PersonaCards} from '../lib/persona-cards.mjs';
import {nativeTurn} from '../lib/native-turn.mjs';
import {defaults} from '../lib/config.mjs';
const key='100000001/group/100000002';
function fixture(t){const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-role-'));t.after(()=>fs.rmSync(runtime,{force:true,recursive:true}));const store=new MemoryStore(runtime,key),session={id:'test'};return {runtime,store,session,role:new RoleState(store,session)};}
const update=id=>({simulationId:id,activity:'在家看书',mood:'平静',attention:'阅读与群聊',progress:'读到第二章',nextIntent:'读完这一章再休息'});

test('each simulation commits canonical state and chronological memory, survives reload and isolates personas',t=>{
 const {runtime,store,session,role}=fixture(t);const task=role.begin();assert.equal(role.begin().id,task.id);
 assert.equal(role.required().reason,'role-state-required');const saved=role.update(update(task.id));
 assert.equal(saved.saved,true);assert.equal(role.required(),null);assert.equal(session.roleSimulation,undefined);
 assert.equal(currentRoleState(new MemoryStore(runtime,key)).activity,'在家看书');
 assert.match(fs.readFileSync(store.safe(saved.journal),'utf8'),/本人格正式经历/);
 assert.match(fs.readFileSync(store.safe('index.md'),'utf8'),/character-state/);
 assert.equal(role.update(update(task.id)).duplicate,true);
 assert.throws(()=>role.update({...update(task.id),mood:'改写'}),/不能/);
 const second=role.begin();assert.equal(second.previous.simulationId,task.id);
 role.update({...update(second.id),progress:'读完第二章'});
 const journal=fs.readFileSync(store.safe(saved.journal),'utf8');assert.match(journal,/读到第二章/);assert.match(journal,/读完第二章/);
 const cards=new PersonaCards(runtime),other=cards.create({key,name:'另一人格',revision:cards.read().revision});
 assert.equal(currentRoleState(new MemoryStore(runtime,key,other.id)),null);
 const foreign=new RoleState(new MemoryStore(runtime,key,other.id),{});foreign.begin();
 assert.throws(()=>foreign.update(update(second.id)),/不属于/);
 assert.equal(currentRoleState(new MemoryStore(runtime,'100000001/private/100000002')),null);
 assert.equal(store.pages().some(p=>p.name.startsWith('user/')),false);
 // A crash after the atomic memory transaction but before session persistence
 // must clear the already-completed task without appending a duplicate.
 session.roleSimulation={id:second.id,at:second.at};assert.equal(role.task(),null);
 assert.throws(()=>store.commit([{page:ROLE_STATE_PAGE,action:'write',text:'fake',reason:'edit',evidence:['input']}],{id:'fake',evidenceIds:['input']}),/qq_role_state_update/);
});

test('long role history rolls into linked pages without discarding previous experiences',t=>{
 const {store,role}=fixture(t),pages=new Set();
 for(let i=0;i<7;i++){
   const task=role.begin(),args=update(task.id);for(const k of ['activity','mood','attention','progress','nextIntent'])args[k]=`${i} `+'内容'.repeat(280);
   pages.add(role.update(args).journal);
 }
 assert.ok(pages.size>1);const text=[...pages].map(p=>fs.readFileSync(store.safe(p),'utf8')).join('\n');
 for(let i=0;i<7;i++)assert.ok(text.includes(`${i} 内容`));
 assert.ok([...pages].every(p=>fs.readFileSync(store.safe(p),'utf8').length<20000));
});

test('invalid, stale and cross-persona updates cannot consume pending work or overwrite facts',t=>{
 const {role,store,session}=fixture(t),task=role.begin();
 for(const args of [{...update(task.id),mood:''},{...update(task.id),activity:'x'.repeat(601)},{...update(task.id),page:'user/100000003.md'},update('other')])assert.throws(()=>role.update(args));
 assert.equal(session.roleSimulation.id,task.id);assert.equal(currentRoleState(store),null);
 const commit=store.commit;store.commit=()=>{throw Error('disk failure');};assert.throws(()=>role.update(update(task.id)),/disk failure/);
 assert.equal(role.task().id,task.id);store.commit=commit;role.update(update(task.id));
});

test('minute wake must be saved before waiting again; state tool never sends QQ and updates remain in the same turn',async t=>{
 const {store,session,role}=fixture(t);let now=100000;
 const clock=new WorldSimulationClock(session,{now:()=>now,roleState:role});clock.delivered();now+=60000;
 const controller=new AbortController(),inbox=new ConversationInbox(controller.signal,()=>true,{now:()=>now,simulation:clock});
 const job={continuous:true,controller,inputs:[],conversationInbox:inbox,prepareIncoming:async x=>x};
 const native=nativeTurn({config:{...defaults,memoryEnabled:true},route:{key,id:'100000002',group:true},session,store,tools:{images:[],replyImages:[]},messaging:{outputs:[],run:()=>assert.fail('must not send')},job,isCurrent:()=>true});
 const result=(await native.execute('qq_wait_for_messages',{timeoutSeconds:120},'first')).result;
 assert.equal(result.reason,'world-simulation');assert.match(result['真实世界模拟'],/qq_role_state_update/);
 const required=(await native.execute('qq_wait_for_messages',{timeoutSeconds:120},'second')).result;
 assert.equal(required.reason,'role-state-required');
 const saved=await native.execute('qq_role_state_update',update(required.simulation.id),'save');assert.equal(saved.result.saved,true);
 assert.match(saved.memoryContext.text,/character-state/);
 assert.equal(currentRoleState(store).simulationId,required.simulation.id);
 now+=60000;const next=(await native.execute('qq_wait_for_messages',{timeoutSeconds:120},'third')).result;
 assert.equal(next.reason,'world-simulation');assert.notEqual(role.task().id,required.simulation.id);
 assert.equal(role.task().previous.simulationId,required.simulation.id);assert.equal(session.id,'test');
 controller.abort();
});
