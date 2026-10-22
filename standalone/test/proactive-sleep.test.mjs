import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Bridge} from '../lib/bridge.mjs';
import {Proactive} from '../lib/proactive.mjs';
import {defaults} from '../lib/config.mjs';
import {initializeLife} from '../lib/lifecycle.mjs';
import {AbsenceClock,resumeAfterMaintenance} from '../lib/absence.mjs';
import {ConversationInbox} from '../lib/continuous-chat.mjs';
import {WorldSimulationClock} from '../lib/world-simulation.mjs';
import {nativePrompt} from '../lib/native-turn.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-proactive-sleep-'));let now=Date.parse('2026-10-22T02:00:00Z');
  const b=new Bridge(root,{now:()=>now,proactive:new Proactive(root,{now:()=>now,random:()=>0})});
  t.after(()=>{b.stop();fs.rmSync(root,{recursive:true,force:true});});
  b.config={...defaults,botQQ:'100000001',privateUsers:['100000002'],dshNativeTools:true,recallEnabled:true,recallMinSeconds:60,recallMaxSeconds:60,recallMaxPerDay:2};
  b.status={state:'running',channels:{private:true,group:false},active:0};
  const route={key:'100000001/private/100000002',id:'100000002',group:false,prepared:true,text:'',segments:[]};
  const session={id:'same-session',route,workspace:root,transport:'native-v1',lastUserAt:now-3600000,lastHumanMessageAt:now-3600000,absence:{phase:'asleep',sleptAt:now-1000,memorySaved:true}};
  initializeLife(session,now);b.state.sessions[b.scope(route)]=session;b.state.lastActiveKey=route.key;
  b.state.startups[route.key]={route,phase:'ready'};
  b.media.prune=()=>{};b.syncReminders=()=>{};b.sweep=async()=>{};
  const store=b.memory(route.key);
  store.commit([{action:'write',page:'user/tea.md',text:'# 茶\n喜欢红茶',reason:'直接陈述',evidence:['m']}],{id:'m',evidenceIds:['m'],summary:'喜欢红茶'});
  b.sessions.ensure=async()=>session;
  const calls=[],sent=[];
  b.dsh={close(){},prompt:async(id,text)=>{calls.push({id,text});return '想起你上次说的红茶';}};
  b.sendPlan=async(_route,plan)=>{sent.push(plan);return true;};
  return {b,session,route,calls,sent,advance:ms=>{now+=ms;}};
}

test('sleeping private session makes bounded proactive attempts, stays asleep and preserves human clock',async t=>{
  const {b,session,calls,sent,advance}=fixture(t),before=session.lastHumanMessageAt;
  await b.tick();assert.equal(calls.length,0);
  advance(60001);await b.tick();assert.equal(calls.length,1);assert.equal(sent.length,1);
  assert.equal(calls[0].id,'same-session');assert.equal(session.absence.phase,'asleep');assert.equal(session.lastHumanMessageAt,before);
  advance(60001);await b.tick();assert.equal(calls.length,2);
  advance(60001);await b.tick();assert.equal(calls.length,2);
  assert.equal(session.proactiveAttempts,2);
  b.proactive=new Proactive(b.runtime,{now:b.now,random:()=>0});advance(60001);await b.tick();assert.equal(calls.length,2);
});

test('zero quota, disabled receive, unfinished handoff and paused participation never wake sleeping sessions',async t=>{
  const {b,session,calls,advance}=fixture(t);
  b.config.recallMaxPerDay=0;await b.tick();advance(120000);await b.tick();assert.equal(calls.length,0);
  b.config.recallMaxPerDay=2;b.status.channels.private=false;await b.tick();assert.equal(calls.length,0);
  b.status.channels.private=true;session.absence.phase='digest';await b.tick();advance(120000);await b.tick();assert.equal(calls.length,0);
  session.absence.phase='handoff';await b.tick();assert.equal(calls.length,0);
  session.absence.phase='asleep';b.participation=()=>({allowsBackground:()=>false});await b.tick();assert.equal(calls.length,0);
});

test('silence consumes an attempt and never restarts minute simulations; daily quota resets next day',async t=>{
  const {b,session,calls,sent,advance}=fixture(t);
  b.config.recallMaxPerDay=1;
  b.dsh.prompt=async(id,text)=>{calls.push({id,text});return '';};
  await b.tick();advance(60001);await b.tick();
  assert.equal(calls.length,1);assert.equal(sent.length,0);assert.equal(session.absence.phase,'asleep');
  for(let i=0;i<10;i++){advance(60000);await b.tick();}
  assert.equal(calls.length,1);
  advance(86400000);await b.tick();assert.equal(calls.length,2);assert.equal(session.absence.phase,'asleep');
});

test('uncertain send is not retried and new input during candidate preparation cancels the obsolete opportunity',async t=>{
  const {b,session,calls,advance}=fixture(t);let sends=0;
  b.sendPlan=async()=>{sends++;throw Error('发送结果未知');};
  await b.tick();advance(60001);await assert.rejects(b.tick(),/发送结果未知/);
  await b.tick();assert.equal(calls.length,1);assert.equal(sends,1);assert.equal(session.absence.phase,'asleep');
  const original=b.proactive.candidate.bind(b.proactive);
  b.proactive.candidate=async(...args)=>{const result=await original(...args);if(result)session.life.version++;return result;};
  advance(60001);await b.tick();assert.equal(calls.length,1);assert.equal(sends,1);
});

test('quiet hours and an active job block background work without changing the sleeping state',async t=>{
  const {b,session,route,calls,advance}=fixture(t);
  b.config.proactiveStart='12:00';b.config.proactiveEnd='13:00';
  await b.tick();advance(60001);await b.tick();assert.equal(calls.length,0);
  b.config.proactiveStart='09:00';b.config.proactiveEnd='23:00';
  b.jobs.set(route.key,{});await b.tick();assert.equal(calls.length,0);b.jobs.delete(route.key);
  await b.tick();assert.equal(calls.length,1);assert.equal(session.absence.phase,'asleep');
});

test('receipt completion resumes the same session once; wait -> simulate -> wait does not repeat absence',async t=>{
  const {b,session,advance}=fixture(t),received=session.lastHumanMessageAt;
  resumeAfterMaintenance(session,b.now(),true);
  const absence=new AbsenceClock(session,{now:b.now,config:b.config});
  assert.equal(absence.remaining(),Infinity);assert.equal(session.lastHumanMessageAt,received);
  const routes=[];b.handle=async r=>{routes.push(r);};
  await b.tick();await b.queues.get(session.route.key);
  assert.equal(routes.length,1);assert.equal(routes[0].loopResume,true);assert.equal(session.id,'same-session');
  await b.tick();assert.equal(routes.length,1);
  const prompt=nativePrompt(null,routes[0],b.configFor(session.route),{bootstrap:true,persona:'测试人格'});
  assert.match(prompt,/先调用qq_wait_for_messages等待消息/);
  const clock=new WorldSimulationClock(session,{now:b.now}),box=new ConversationInbox(new AbortController().signal,()=>true,{now:b.now,absence,simulation:clock});
  advance(60000);const event=await box.take({timeoutSeconds:1},async x=>x);assert.equal(event.reason,'world-simulation');
  advance(60000);assert.equal((await box.take({timeoutSeconds:1},async x=>x)).reason,'world-simulation');
  session.lastHumanMessageAt=b.now();assert.equal(absence.remaining(),1800000);
  advance(1800001);assert.equal(absence.remaining(),0);
});
