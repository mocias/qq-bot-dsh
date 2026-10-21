import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WorldSimulationClock,worldSimulationPrompt} from '../lib/world-simulation.mjs';
import {ConversationInbox} from '../lib/continuous-chat.mjs';
import {Bridge} from '../lib/bridge.mjs';
import {defaults} from '../lib/config.mjs';
import {initializeLife} from '../lib/lifecycle.mjs';
import {nativePrompt} from '../lib/native-turn.mjs';
import {selectedTools} from '../../native-dsh-plugin/lib/schema.mjs';

test('clock is relative to delivered input, coalesces missed minutes and survives reconstruction',()=>{
  let now=100000;const session={},clock=new WorldSimulationClock(session,{now:()=>now});
  clock.delivered();now+=59000;assert.equal(clock.remaining(),1000);
  clock.delivered();now+=59000;assert.equal(clock.remaining(),1000);
  now+=600000;assert.equal(clock.remaining(),0);clock.delivered();
  assert.equal(new WorldSimulationClock(session,{now:()=>now}).remaining(),60000);
});

test('short waits do not reset clock; simulation wakes long wait; real message resets next reminder',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});
  const session={},clock=new WorldSimulationClock(session);clock.delivered();
  const inbox=new ConversationInbox(new AbortController().signal,()=>true,{simulation:clock});
  let wait=inbox.take({timeoutSeconds:30},async x=>x);
  t.mock.timers.tick(30000);assert.equal((await wait).reason,'timeout');assert.equal(session.worldSimulationInputAt,100000);
  wait=inbox.take({timeoutSeconds:300},async x=>x);t.mock.timers.tick(30000);
  const reminder=await wait;assert.equal(reminder.reason,'world-simulation');assert.equal(reminder.timeout,false);
  assert.equal(reminder.messages.length,0);assert.match(reminder['真实世界模拟'],/当前时间为.*Asia\/Shanghai/);
  t.mock.timers.tick(20000);inbox.push({compactView:{messages:[{text:'new'}]}});
  const input=await inbox.take({timeoutSeconds:300},async x=>x);
  assert.equal(input.reason,'messages');assert.ok(input['真实世界模拟']);assert.equal(clock.remaining(),60000);
  wait=inbox.take({timeoutSeconds:300},async x=>x);t.mock.timers.tick(60000);
  assert.equal((await wait).reason,'world-simulation');
});

test('new messages win a due reminder, and cancellation cannot return a timer prompt',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});
  const controller=new AbortController(),clock=new WorldSimulationClock({});clock.delivered();
  const inbox=new ConversationInbox(controller.signal,()=>true,{simulation:clock});
  t.mock.timers.tick(60000);inbox.push({compactView:{messages:[{text:'最新'}]}});
  const result=await inbox.take({timeoutSeconds:300},async x=>x);
  assert.equal(result.reason,'messages');assert.equal(result.messages.length,1);assert.ok(result['真实世界模拟']);
  const wait=inbox.take({timeoutSeconds:300},async x=>x);controller.abort();
  await assert.rejects(wait,/已停止/);assert.equal(inbox.wake,null);
});

test('idle listening continues through an hour of minute reminders until explicitly stopped',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});
  const controller=new AbortController(),clock=new WorldSimulationClock({});clock.delivered();
  const inbox=new ConversationInbox(controller.signal,()=>true,{simulation:clock});
  for(let minute=0;minute<60;minute++){
    const wait=inbox.take({timeoutSeconds:300},async x=>x);
    t.mock.timers.tick(60000);
    const result=await wait;
    assert.equal(result.reason,'world-simulation');assert.equal(result.messages.length,0);
    assert.equal(clock.remaining(),60000);
  }
  const wait=inbox.take({timeoutSeconds:300},async x=>x);controller.abort();
  await assert.rejects(wait,/已停止/);
});

test('normal prompts include the named field and wait tool; background silence remains available',()=>{
  const prompt=nativePrompt(null,{compactView:{messages:[]},modelInputAt:0},{},{bootstrap:false});
  assert.match(prompt,/"真实世界模拟":"当前时间为1970-01-01 08:00:00/);
  assert.match(worldSimulationPrompt(),/本人格的正式经历写入长期记忆/);
  assert.match(worldSimulationPrompt(),/不能据此写入群友的事实记忆/);
  assert.ok(selectedTools({},{}).includes('qq_wait_for_messages'));
  assert.ok(!selectedTools({},{}).includes('qq_no_reply'));
  assert.deepEqual(selectedTools({},{trigger:'background'}),['qq_no_reply']);
});

function fixture(t){
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-world-'));let now=100000;
  const bridge=new Bridge(runtime,{now:()=>now});
  t.after(()=>{bridge.stop();fs.rmSync(runtime,{recursive:true,force:true});});
  bridge.config={...defaults,botQQ:'100000001',groups:['100000002'],privateUsers:['100000003'],dshNativeTools:true};
  bridge.status={state:'running',channels:{group:true,private:true},active:0};bridge.generation=1;
  bridge.media.prune=()=>{};bridge.syncReminders=()=>{};bridge.sweep=async()=>{};
  bridge.dsh={close(){}};bridge.proactive.candidate=async()=>null;
  const sessions=[true,false].map(group=>{
    const id=group?'100000002':'100000003',route={key:`100000001/${group?'group':'private'}/${id}`,id,group};
    const session={id:group?'group-session':'private-session',route,blocked:false,transport:'native-v1'};
    initializeLife(session,now);bridge.state.sessions[bridge.scope(route)]=session;
    bridge.state.startups[route.key]={route,phase:'ready',historyThroughSeq:0};return session;
  });
  return {bridge,sessions,advance:ms=>{now+=ms;}};
}

test('idle timers use the same chat serializer, do not block other chats, and respect maintenance/stop',async t=>{
  const {bridge,sessions,advance}=fixture(t);const calls=[],release=[];
  bridge.handle=async route=>{calls.push(route);await new Promise(r=>release.push(r));};
  await bridge.tick();advance(60000);
  bridge.maintenance.set(sessions[0].route.key,{controller:new AbortController()});
  await bridge.tick();await Promise.resolve();assert.equal(calls.length,1);assert.equal(calls[0].group,false);
  bridge.maintenance.delete(sessions[0].route.key);await bridge.tick();await Promise.resolve();assert.equal(calls.length,2);
  assert.ok(calls.every(r=>r.worldSimulation&&r.messages.length===0));
  advance(600000);await bridge.tick();assert.equal(calls.length,2,'busy clocks must not enqueue duplicates');
  for(const done of release)done();await Promise.all([...bridge.queues.values()]);
  bridge.stop();await bridge.tick();assert.equal(calls.length,2);
});

test('an idle simulation has no QQ snapshot, no memory evidence and no consumed unread records',async t=>{
  const {bridge,sessions}=fixture(t),session=sessions[0],key=session.route.key;let prompt,tools;
  bridge.dsh={close(){},prompt:async(_id,text,options)=>{prompt=text;tools=options.nativeTools;return '';}};
  bridge.inbox(key).append({sourceId:'history',messageId:'1',sender:'100000004',text:'历史只作背景'});
  const before=bridge.inbox(key).read();
  await bridge.handle({...session.route,worldSimulation:true,messageId:'clock-only',messages:[]},1);
  assert.match(prompt,/"messages":\[\]/);assert.match(prompt,/真实世界模拟/);
  assert.equal(bridge.inbox(key).read().readThrough,before.readThrough);
  assert.equal(bridge.inbox(key).read().messages.length,before.messages.length);
  assert.equal(session.life.conversation.length,0);assert.equal(session.id,'group-session');
  assert.ok(!tools.allowed.includes('qq_no_reply'));
});

test('a parent yielded to a child receives simulation through its existing binding, never a parallel turn',async t=>{
  const {bridge,sessions,advance}=fixture(t),session=sessions[0],calls=[];
  const controller=new AbortController();session.blocked=true;
  bridge.jobs.set(session.route.key,{continuous:true,session,controller,conversationInbox:{pending:[]}});
  bridge.simulationClock(session).delivered();advance(60000);
  let release;bridge.dsh.awaitingChild=id=>id===session.id;
  bridge.dsh.steer=async(id,prompt)=>{calls.push({id,prompt});await new Promise(r=>release=r);return true;};
  await bridge.tick();assert.equal(calls.length,1);assert.equal(calls[0].id,session.id);
  assert.match(calls[0].prompt,/真实世界模拟/);assert.equal(bridge.queues.size,0);
  advance(60000);await bridge.tick();assert.equal(calls.length,1);release();
});
