import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Bridge} from '../lib/bridge.mjs';
import {defaults} from '../lib/config.mjs';
import {initializeLife} from '../lib/lifecycle.mjs';

function fixture(t,group=true){
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-maintenance-inbox-'));
  const bridge=new Bridge(runtime,{now:()=>1000000});
  t.after(()=>{bridge.stop();fs.rmSync(runtime,{recursive:true,force:true});});
  bridge.config={...defaults,botQQ:'100000001',groups:['100000002'],privateUsers:['100000002'],adminUsers:['100000003'],
    privatePreset:'test',groupPreset:'test',groupAmbientEnabled:true,groupAmbientMinSeconds:0,memoryIdleSeconds:1,memoryMinTurns:1,dshNativeTools:true};
  bridge.status={state:'running',active:0,channels:{private:true,group:true}};bridge.generation=1;
  const key=`100000001/${group?'group':'private'}/100000002`;
  const session={id:'existing',route:{key,id:'100000002',group},blocked:false};initializeLife(session,0);
  session.life.conversation=[{inputs:[{messageId:'old-input'}],reply:'old reply'}];
  bridge.state.sessions[bridge.scope(session.route)]=session;
  const processed=[];bridge.handle=async route=>{processed.push(route);};
  const event=(i,direct=false,text=`message ${i}`)=>({post_type:'message',message_type:group?'group':'private',self_id:'100000001',
    user_id:group?'100000003':'100000002',group_id:group?'100000002':undefined,message_id:String(i),
    message:[...(direct&&group?[{type:'at',data:{qq:'100000001'}}]:[]),{type:'text',data:{text}}]});
  let finish,options;
  bridge.dsh={close(){},createSession:async()=>assert.fail('maintenance must reuse current session'),rename:async()=>{},prompt:async(id,_text,o)=>{assert.equal(id,session.id);options=o;await new Promise(resolve=>finish=resolve);
    if(o.signal.aborted)throw Object.assign(Error('cancelled'),{cancelled:true,acknowledged:true});
    await o.nativeTools.execute('qq_memory_digest',{summary:'核对完成',updates:[]});return '';}};
  return {bridge,runtime,key,session,event,processed,finish:()=>finish(),options:()=>options};
}

for(const group of [true,false])test(`${group?'group':'private'} arrivals persist during digest and replay after receipt, without cancellation or active-limit loss`,async t=>{
  const f=fixture(t,group),{bridge,key,session}=f;
  const sweep=bridge.sweep();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));assert.ok(f.options());
  for(let i=1;i<=25;i++)bridge.receive(f.event(i,i%2===0),1);
  bridge.receive(f.event(1),1); // OneBot duplicate is not queued twice.
  assert.equal(f.processed.length,0);assert.equal(f.options().signal.aborted,false);
  assert.equal(session.life.version,0);assert.equal(bridge.status.active,0);
  const saved=JSON.parse(fs.readFileSync(bridge.file));assert.equal(saved.maintenanceInbox[key].length,25);
  assert.equal(saved.maintenanceInbox[key][0].route.segments.at(-1).data.text,'message 1');
  bridge.handle=async route=>{assert.ok(bridge.memory(key).hasReceipt(session.life.receipt));f.processed.push(route);};
  f.finish();await sweep;await bridge.deferredDrains.get(key);
  assert.equal(bridge.status.lastError,undefined,'queue error: '+bridge.status.lastError);
  assert.deepEqual(f.processed.map(r=>r.qqMessageId),Array.from({length:25},(_,i)=>String(i+1)));
  assert.equal(bridge.hasDeferred(key),false);assert.equal(session.life.conversation.length,0);
  assert.ok(session.life.receipt);assert.equal(session.blocked,false);
});

test('messages arriving during replay join the tail; no overlap, duplicates or early rotation',async t=>{
  const f=fixture(t),{bridge,key,session}=f;bridge.config.rotateAfterCompactions=1;
  session.life.compactions=[{id:'cp',sourceId:'cp'}];bridge.dsh.createSession=async()=> 'memory-worker';
  const sweep=bridge.sweep();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));bridge.receive(f.event(1),1);bridge.receive(f.event(2,true),1);
  let release,started;const first=new Promise(r=>started=r);
  bridge.handle=async route=>{f.processed.push(route);if(route.qqMessageId==='1'){started();await new Promise(r=>release=r);}};
  f.finish();await sweep;await first;bridge.receive(f.event(3,true),1);
  assert.deepEqual(f.processed.map(r=>r.qqMessageId),['1']);release();await bridge.deferredDrains.get(key);
  assert.deepEqual(f.processed.map(r=>r.qqMessageId),['1','2','3']);assert.equal(session.id,'existing');
});

test('explicit channel stop cancels maintenance and never replays saved inputs',async t=>{
  const f=fixture(t),{bridge,key}=f;const sweep=bridge.sweep();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));bridge.receive(f.event(1),1);
  bridge.stop('group');assert.equal(f.options().signal.aborted,true);f.finish();await sweep;
  assert.equal(f.processed.length,0);assert.equal(bridge.state.maintenanceInbox[key][0].state,'cancelled');
  assert.equal(bridge.inbox(key).read().messages.length,1);
});

test('authorized /stop remains immediate; ordinary commands wait until digest completes',async t=>{
  const f=fixture(t),{bridge,key}=f;bridge.sendText=async()=>{};
  const sweep=bridge.sweep();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));bridge.receive(f.event(1,true,'/status'),1);
  assert.equal(bridge.state.maintenanceInbox[key][0].state,'pending');assert.equal(f.options().signal.aborted,false);
  bridge.receive(f.event(2,true,'/stop'),1);assert.equal(f.options().signal.aborted,true);
  f.finish();await sweep;assert.equal(bridge.state.maintenanceInbox[key][0].state,'cancelled');
});

test('restart retains pending input but never auto-replays a request with uncertain outcome',async t=>{
  const f=fixture(t),{bridge,key,runtime}=f;const sweep=bridge.sweep();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));bridge.receive(f.event(1),1);bridge.receive(f.event(2),1);
  bridge.state.maintenanceInbox[key][0].state='running';bridge.persist();
  const restored=new Bridge(runtime);restored.config=bridge.config;restored.status={...bridge.status};restored.generation=1;
  restored.handle=()=>assert.fail('uncertain request cannot be replayed');
  assert.equal(restored.state.maintenanceInbox[key][0].state,'uncertain');assert.equal(restored.state.maintenanceInbox[key][1].state,'pending');
  await restored.drainDeferred(key);f.finish();await sweep;await bridge.deferredDrains.get(key);
});

test('failed replay is retained and does not start repeated replacement sessions',async t=>{
  const f=fixture(t),{bridge,key}=f;const sweep=bridge.sweep();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));bridge.receive(f.event(1),1);bridge.receive(f.event(2),1);
  let calls=0;bridge.handle=async()=>{calls++;throw Error('submission rejected');};
  f.finish();await sweep;await bridge.deferredDrains.get(key);await bridge.sweep();
  assert.equal(calls,1);assert.deepEqual(bridge.state.maintenanceInbox[key].map(r=>r.state),['uncertain','pending']);
  assert.match(bridge.status.lastError,/submission rejected/);
});

test('real bridge handler consumes queued input only after native digest commits',async t=>{
  const f=fixture(t),{bridge,key,session}=f;session.transport='native-v1';session.workspace=f.runtime;
  bridge.handle=Bridge.prototype.handle.bind(bridge);
  const original=bridge.dsh.prompt;let prompts=0;
  bridge.dsh.prompt=async(id,text,options)=>{
    assert.equal(id,session.id);
    if(options.nativeTools.allowed.includes('qq_memory_digest'))return original(id,text,options);
    assert.ok(session.life.receipt);assert.equal(bridge.maintenance.has(key),false);
    assert.ok(options.nativeTools.continuous);prompts++;return [];
  };
  const sweep=bridge.sweep();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));bridge.receive(f.event(1,true),1);bridge.receive(f.event(2,true),1);
  assert.equal(bridge.inbox(key).list({unread:true}).unreadCount,2);
  f.finish();await sweep;await bridge.deferredDrains.get(key);
  assert.equal(prompts,2);assert.equal(bridge.inbox(key).list({unread:true}).unreadCount,0);
  assert.equal(session.blocked,false);assert.equal(bridge.state.deliveries.length,0);
});

test('ambient cooldown retains the queue for later sweep and isolates other chats',async t=>{
  const f=fixture(t),{bridge,key}=f;bridge.config.groupAmbientMinSeconds=5;
  const sweep=bridge.sweep();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));bridge.receive(f.event(1),1);bridge.receive(f.event(2),1);
  bridge.receive({...f.event(3),message_type:'private',user_id:'100000002'},1);
  await bridge.queues.get('100000001/private/100000002');assert.equal(f.processed.length,1);
  f.finish();await sweep;await bridge.deferredDrains.get(key);
  assert.deepEqual(f.processed.map(r=>r.qqMessageId),['3','1']);assert.equal(bridge.hasDeferred(key),true);
  bridge.now=()=>1006000;await bridge.sweep();await bridge.deferredDrains.get(key);
  assert.deepEqual(f.processed.map(r=>r.qqMessageId),['3','1','2']);
});

test('pending queue survives restart and obeys account and allow-list checks before replay',async t=>{
  const f=fixture(t),{bridge,key}=f;const sweep=bridge.sweep();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));bridge.receive(f.event(1,true),1);
  const restored=new Bridge(f.runtime);restored.config={...bridge.config,groups:[]};restored.status={...bridge.status};restored.generation=1;
  const processed=[];restored.handle=async route=>processed.push(route);
  await restored.drainDeferred(key);assert.equal(processed.length,0);
  restored.config.groups=bridge.config.groups;await restored.drainDeferred(key);
  assert.equal(processed.length,1);assert.equal(restored.hasDeferred(key),false);
  f.finish();await sweep;await bridge.deferredDrains.get(key);
});

test('capacity changing during reference lookup cannot drop a deferred message',async t=>{
  const f=fixture(t),{bridge,key}=f;const sweep=bridge.sweep();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
  const event=f.event(1);event.message.unshift({type:'reply',data:{id:'previous'}});
  bridge.receive(event,1);let lookedUp;
  bridge.media.reference=async()=>{bridge.status.active=20;lookedUp=true;return {fromBot:true};};
  f.finish();await sweep;await bridge.deferredDrains.get(key);
  assert.equal(lookedUp,true);assert.equal(f.processed.length,0);
  assert.equal(bridge.state.maintenanceInbox[key][0].state,'pending');
  bridge.status.active=0;bridge.media.reference=async()=>({fromBot:true});
  await bridge.drainDeferred(key);assert.equal(f.processed.length,1);
});

test('definite rejection keeps queue pending until explicit resume; unknown outcome cannot be resumed',async t=>{
  const f=fixture(t),{bridge,key}=f;
  const route={...f.session.route,text:'one',messageId:'one',qqMessageId:'one',sender:'100000003',ambient:false};
  bridge.deferForMaintenance(route);bridge.deferForMaintenance({...route,messageId:'two'});
  bridge.handle=async()=>{throw Object.assign(Error('skills missing'),{notSubmitted:true});};
  await bridge.drainDeferred(key);
  assert.deepEqual(bridge.state.maintenanceInbox[key].map(r=>r.state),['pending','pending']);
  let calls=0;bridge.handle=async()=>{calls++;};
  await bridge.drainDeferred(key);assert.equal(calls,0);
  await bridge.resumeDeferred(key);assert.equal(calls,2);assert.equal(bridge.hasDeferred(key),false);
  bridge.deferForMaintenance(route);bridge.state.maintenanceInbox[key][0].state='uncertain';
  assert.throws(()=>bridge.resumeDeferred(key),/未确认/);assert.equal(calls,2);
});
