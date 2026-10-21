import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ChatHandoff} from '../lib/handoff.mjs';
import {hookCompaction,publicEvents,saveHandoff} from '../../native-dsh-plugin/lib/handoff.mjs';
import {Continuations,isHostContext} from '../../native-dsh-plugin/lib/continuations.mjs';

function fixture(t,kind='group'){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-handoff-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const session={id:'original-session',personaId:'card-a'},route={key:`100001/${kind}/100002`,group:kind==='group',id:'100002'};
  return {root,session,route,create:()=>new ChatHandoff({session,route,store:{safe:p=>path.join(root,p)},inputs:()=>[]})};
}
for(const kind of ['group','private'])test(`handoff survives restart, pages losslessly and keeps ${kind} scope`,async t=>{
  const f=fixture(t,kind),h=f.create(),secret='private reasoning must not be archived';
  const events=[{seq:1,type:'assistant/message',data:{message:{content:[{type:'thinking',text:secret},{type:'text',text:'done'}]}}},
    {seq:2,type:'tool/call',data:{name:'qq_send_message',callId:'send',args:{messages:['sent text']}}},
    {seq:3,type:'tool/result',data:{message:{source:{callId:'send'},content:[{type:'text',text:JSON.stringify({sent:true,qqMessageId:'123'})}]}}},
    {seq:4,type:'user/message',data:{content:[{type:'text',text:'中'.repeat(250000)}]}}];
  const agent={session:{log:events}},saved=await saveHandoff((a,v)=>{assert.ok(Buffer.byteLength(JSON.stringify(v))+1000<300000);return h.control(a,v);},agent,{summary:'继续等地址',unfinished:['等对方地址']});
  h.control('commit',saved);const restored=f.create(),resume=restored.resume();
  assert.equal(resume.handoff.chat.type,kind);assert.equal(resume.handoff.chat.personaId,'card-a');assert.equal(resume.handoff.sessionId,'original-session');
  let text='',offset=0;do{const page=restored.view({section:'events',offset});text+=page.text;offset=page.nextOffset;}while(offset!==null);
  assert.equal(JSON.parse(text).events.length,4);assert.equal(JSON.parse(text).events[3].message.content[0].text.length,250000);
  assert.doesNotMatch(text,new RegExp(secret));assert.match(text,/123/);assert.match(text,/sent text/);
  restored.delivered(resume.handoff.id);assert.ok(f.create().resume());restored.acknowledge();assert.equal(f.create().resume(),null);assert.ok(restored.view({id:saved.id}));
  assert.throws(()=>restored.view({id:'../escape'}));
  const before=fs.readdirSync(path.join(f.root,'.runtime','handoffs'),{recursive:true}).length;
  for(let i=0;i<100;i++)assert.equal(restored.resume(),null);
  assert.equal(fs.readdirSync(path.join(f.root,'.runtime','handoffs'),{recursive:true}).length,before);
});
test('incomplete or failed handoff is preserved but cannot become ready',t=>{
  const h=fixture(t).create();h.control('begin',{id:'partial'});h.control('part',{id:'partial',index:1,text:'tail'});
  assert.throws(()=>h.control('commit',{id:'partial',parts:2}),/缺失/);assert.equal(h.resume(),null);
  h.control('failed',{id:'partial',error:'provider failure'});assert.equal(h.load('partial').status,'failed');
  assert.throws(()=>h.control('commit',{id:'partial',parts:2}));
});
test('compaction hook waits for durable preparation and only wraps its own agent',async()=>{
  const agent={},other={},trace=[],engine={async compactRegion(s,e,a){trace.push(a===agent?'compact':'other');return 'result';}},original=engine.compactRegion;
  const dispose=hookCompaction(engine,agent,async({compact})=>{trace.push('save');const result=await compact();trace.push('commit');return result;});
  assert.equal(await engine.compactRegion(1,2,agent),'result');await engine.compactRegion(1,2,other);assert.deepEqual(trace,['save','compact','commit','other']);
  dispose();assert.equal(engine.compactRegion,original);
  const off=hookCompaction(engine,agent,async()=>{throw Error('disk full');});await assert.rejects(engine.compactRegion(1,2,agent),/disk full/);off();
  assert.deepEqual(trace,['save','compact','commit','other']);
});
test('only a checkpoint correlated to an observed compaction keeps authority',()=>{
  const c=new Continuations(),message={source:{kind:'compact-checkpoint',compactionId:'known'}};
  assert.equal(isHostContext(message,c.compactions),false);c.observe({type:'compaction/start',data:{compactionId:'known'}});
  assert.equal(isHostContext(message,c.compactions),true);assert.equal(isHostContext({source:{kind:'compact-checkpoint',compactionId:'unknown'}},c.compactions),false);
  assert.deepEqual(publicEvents([{type:'assistant/thinking',data:{text:'private'}}]),[]);
});
