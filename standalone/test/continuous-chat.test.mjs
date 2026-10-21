import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationInbox} from '../lib/continuous-chat.mjs';

const notice={id:'result-1',source:{kind:'subagent-settled',senderSessionId:'child-1'}};
const prepare=async route=>route;

test('reply wait batches consecutive messages until quiet, including time already spent reading',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});
  const inbox=new ConversationInbox(new AbortController().signal,()=>true,{lastArrivalAt:Date.now()});
  let done=false;const waiting=inbox.take({purpose:'reply',quietSeconds:10,timeoutSeconds:30},prepare).then(x=>{done=true;return x;});
  t.mock.timers.tick(5000);inbox.push({text:'还有第一句'});await Promise.resolve();
  t.mock.timers.tick(5000);inbox.push({text:'补充第二句'});await Promise.resolve();
  t.mock.timers.tick(9000);await Promise.resolve();assert.equal(done,false);
  t.mock.timers.tick(1000);const result=await waiting;
  assert.equal(result.quiet,true);assert.equal(result.messages.length,2);assert.equal(inbox.pending.length,0);
  t.mock.timers.tick(10000);assert.equal((await inbox.take({purpose:'reply',quietSeconds:10},prepare)).quiet,true);
});

test('reply deadline is not quiet and does not silently lose pending input',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});
  const inbox=new ConversationInbox(new AbortController().signal,()=>true,{lastArrivalAt:Date.now()});
  const waiting=inbox.take({purpose:'reply',quietSeconds:10,timeoutSeconds:1},prepare);
  t.mock.timers.tick(1000);const result=await waiting;
  assert.equal(result.quiet,false);assert.equal(result.timeout,true);
});

test('waiting validates the expanded range and retains a notification arriving before the call',async()=>{
  const inbox=new ConversationInbox(new AbortController().signal);
  for(const timeoutSeconds of [0,301,-1,1.5,'60',Infinity])await assert.rejects(inbox.take({timeoutSeconds},prepare),/1～300/);
  inbox.childNotice(notice);
  const result=await inbox.take({timeoutSeconds:300},prepare);
  assert.equal(result.reason,'subagent');assert.equal(result.timeout,false);
  assert.equal(result.notifications[0].childId,'child-1');assert.equal(inbox.children.size,0);
});

test('already claimed child notices do not wake a later wait, and silence is a real timeout',async()=>{
  const inbox=new ConversationInbox(new AbortController().signal);
  inbox.childNotice(notice);inbox.childNotice(notice,true);
  const result=await inbox.take({timeoutSeconds:1},prepare);
  assert.equal(result.reason,'timeout');assert.equal(result.timeout,true);
  assert.deepEqual(result.notifications,[]);assert.equal(inbox.wake,null);
});

test('simultaneous user input and child notice are both retained and abort releases a long wait',async()=>{
  const controller=new AbortController(),inbox=new ConversationInbox(controller.signal);
  const waiting=inbox.take({timeoutSeconds:300},prepare);
  inbox.push({text:'最新要求',messageId:'m2',sender:'123'});inbox.childNotice(notice);
  const result=await waiting;
  assert.equal(result.reason,'messages');assert.equal(result.messages.length,1);assert.equal(result.notifications.length,1);
  const stopped=inbox.take({timeoutSeconds:300},prepare);controller.abort();
  await assert.rejects(stopped,/已停止/);assert.equal(inbox.wake,null);
});
