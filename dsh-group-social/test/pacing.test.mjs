import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {readPolicy,replyLimitReached,eventDelay,groupEventAllowed,BOT} from '../lib/core.mjs';

test('zero cooldown and output quotas permit high participation without requiring a mention', t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'qq-pacing-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(base)),path.resolve(os.tmpdir()));assert.ok(path.basename(base).startsWith('qq-pacing-'));fs.rmSync(base,{recursive:true,force:true});});
  const file=path.join(base,'policy.json');
  const p={enabled:true,proactiveEnabled:false,timeZone:'Asia/Shanghai',activeHours:{start:'09:00',end:'23:00'},
    minReplyGapSeconds:0,ambientCheckMinutes:0,maxRepliesPerHour:0,maxAmbientPerHour:0,maxProactivePerDay:1,
    proactiveMinMinutes:120,proactiveMaxMinutes:360,directDebounceMs:250,ambientDebounceMs:500};
  fs.writeFileSync(file,JSON.stringify(p));
  const actual=readPolicy(file);
  assert.equal(replyLimitReached(10000,actual.maxRepliesPerHour),false);
  assert.equal(replyLimitReached(10000,actual.maxAmbientPerHour),false);
  assert.equal(eventDelay(actual,true),250);assert.equal(eventDelay(actual,false),500);
  assert.equal(groupEventAllowed({post_type:'message',message_type:'group',group_id:'100000003',self_id:BOT,user_id:'123',message:[{type:'text',data:{text:'来聊电竞'}}]}),true);
  fs.writeFileSync(file,JSON.stringify({...p,ambientDebounceMs:-1}));assert.throws(()=>readPolicy(file),/ambientDebounceMs/);
});

test('positive quotas still stop writes at their configured limit',()=>{
  assert.equal(replyLimitReached(19,20),false);assert.equal(replyLimitReached(20,20),true);
  assert.equal(replyLimitReached(21,20),true);assert.equal(replyLimitReached(0,0),false);
});
