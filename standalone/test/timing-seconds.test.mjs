import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validate} from '../lib/config.mjs';
import {policyView,resolveChatConfig} from '../lib/chat-policy.mjs';
import {Proactive} from '../lib/proactive.mjs';
import {RecallSchedule} from '../../dsh-plugin-memory-source/lib/recall-policy.js';
import {ChatInbox} from '../lib/chat-inbox.mjs';
import {wakeSeconds} from '../lib/timing.mjs';

test('legacy minute defaults and per-chat overrides migrate once and preserve durations',()=>{
 const key='100000001/group/100000003';
 const c=validate({groupAmbientMinMinutes:5,recallMinMinutes:30,recallMaxMinutes:120,memoryIdleMinutes:60,
  chatPolicy:{private:{proactiveMinMinutes:2,proactiveMaxMinutes:3},group:{groupAmbientMinMinutes:4},overrides:{[key]:{groupAmbientMinMinutes:1}}}});
 assert.equal(c.groupAmbientMinSeconds,300);assert.equal(c.memoryIdleSeconds,3600);
 assert.equal(policyView(c,'private').effective.proactiveMinSeconds,120);
 assert.equal(policyView(c,'group').effective.groupAmbientMinSeconds,240);
 assert.equal(resolveChatConfig(c,key).groupAmbientMinSeconds,60);
 assert.deepEqual(validate(JSON.parse(JSON.stringify(c))),c);
 assert.equal(Object.keys(c).some(k=>k.endsWith('Minutes')),false);
 const changed=validate({groupAmbientMinSeconds:5},c);assert.equal(changed.groupAmbientMinSeconds,5);
 assert.equal(validate({groupAmbientMinSeconds:2,groupAmbientMinMinutes:5}).groupAmbientMinSeconds,2);
 assert.throws(()=>validate({recallMinSeconds:5,recallMaxSeconds:4}));
 assert.throws(()=>validate({groupAmbientMinSeconds:0}));
 assert.throws(()=>validate({chatPolicy:{group:{groupAmbientMinMinutes:-1}}}));
 assert.equal(policyView(c,'group').fields.groupAmbientMinSeconds.label.includes('（秒）'),true);
});
test('seconds schedule is due at seconds boundary and legacy schedule signature remains compatible',t=>{
 const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-seconds-'));t.after(()=>fs.rmSync(runtime,{recursive:true,force:true}));
 const p=new Proactive(runtime),config=validate({groupProactiveEnabled:true,groupProactiveMinSeconds:5,groupProactiveMaxSeconds:5,proactiveStart:'00:00',proactiveEnd:'00:00'});
 const schedule=new RecallSchedule(path.join(runtime,'cadence.json'),'group',()=>0),policy=p.policy(config,true),now=Date.now();
 assert.equal(schedule.due(now,policy,now-1),false);
 assert.equal(schedule.due(now+4999,policy,now-1),false);
 assert.equal(schedule.due(now+5000,policy,now-1),true);
 assert.equal(p.policy(validate({groupProactiveMinMinutes:30,groupProactiveMaxMinutes:120}),true).intervalMinMinutes,30);
});
test('wake seconds support short sleeps while older minutes requests keep their duration',t=>{
 const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-wake-seconds-'));t.after(()=>fs.rmSync(runtime,{recursive:true,force:true}));
 let now=1000000;const inbox=new ChatInbox(runtime,'100000001/group/100000003',()=>now);
 inbox.setWake('diving',wakeSeconds({seconds:3}));now+=2999;assert.ok(inbox.sleeping());now++;assert.equal(inbox.sleeping(),false);
 inbox.setWake('diving',wakeSeconds({minutes:30}));assert.equal(inbox.read().wake.until-now,1800000);
 assert.throws(()=>inbox.setWake('diving',0));
});
