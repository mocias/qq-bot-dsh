import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ChatWindow,ANTI_AI} from '../lib/chat-window.mjs';
import {ChatInbox} from '../lib/chat-inbox.mjs';
import {snapshotOf} from '../lib/message-snapshot.mjs';
import {ConversationInbox} from '../lib/continuous-chat.mjs';
import {nativePrompt} from '../lib/native-turn.mjs';
import {Bridge} from '../lib/bridge.mjs';
import {defaults} from '../lib/config.mjs';
import {initializeLife} from '../lib/lifecycle.mjs';
const key='100000001/group/100000002';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-window-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const window=new ChatWindow(root,key),inbox=new ChatInbox(root,key);const add=(i,text='发言'+i,qq='100000003',extra={})=>{
    const route={key,messageId:key+'/'+i,qqMessageId:String(i),author:{qq,nickname:'同名'},text,receivedAt:100000+i,...extra};
    const row=inbox.append({sourceId:route.messageId,messageId:route.qqMessageId,sender:qq,text,snapshot:snapshotOf(route),outgoing:qq==='100000001'});
    window.sync([row]);return {...route,inboxSeq:row.seq};};return {root,window,inbox,add};}
test('stable aliases preserve distinct people, quotes and validated tool arguments without replacing prose',t=>{
  const {window,add}=fixture(t);const a=add(1),b=add(2,'反驳','100000004',{replyId:'1'});
  const view=window.attach(b,{},{}).compactView;assert.notEqual(view.background[0].speaker,view.messages[0].speaker);
  assert.equal(view.messages[0].replyTo.id,'M1');assert.equal(window.decode({replyToMessageId:'M1',atUserId:'U2',text:'U2 M1'}).atUserId,'100000004');
  assert.deepEqual(window.decode({updates:[{page:'user/U1.md',evidence:['M1'],subjects:[{qq:'U1',evidence:['M1']}]}]}).updates[0],
    {page:'user/100000003.md',evidence:[a.messageId],subjects:[{qq:'100000003',evidence:[a.messageId]}]});
  assert.throws(()=>window.decode({replyToMessageId:'M999'}),/未知/);
  assert.equal(window.decode({text:'U2 M1'}).text,'U2 M1');assert.doesNotMatch(JSON.stringify(view),/inboxSeq|sourceId|"version"|"chat"/);
});
test('read messages and actual bot replies remain recent context; startup history is background only',t=>{
  const {window,inbox,add}=fixture(t);add(1,'旧问题');add(2,'今天说的');add(3,'确实发过的回复','100000001');const latest=add(4,'接着说');
  inbox.consume([1,2,3]);window.sync(inbox.read().messages);
  const view=window.attach({...latest,replyPolicy:{historyThroughSeq:1}},{},{initial:true}).compactView;
  assert.deepEqual(view.background.map(m=>m.text),['今天说的','确实发过的回复']);assert.equal(view.background[1].sentByMe,true);
});
test('sliding saves source receipt and bounded attributed excerpts; full originals survive restart',t=>{
  const {window,root,add}=fixture(t);for(let i=1;i<=75;i++)add(i,i===30?'更正：不是商场，是景区':'原文'+i+'长'.repeat(300));
  const original=fs.readFileSync(path.join(window.dir,'messages.private.jsonl'),'utf8');window.slide(76);
  assert.ok(window.data.through>0);assert.ok(window.data.rows.length<=40);assert.ok(JSON.stringify(window.data.summary).length<=12000);
  assert.ok(window.data.summary.some(x=>x.text.includes('更正')));assert.equal(fs.readFileSync(path.join(window.dir,'messages.private.jsonl'),'utf8'),original);
  const restored=new ChatWindow(root,key);assert.equal(restored.data.through,window.data.through);assert.equal(restored.decode({messageId:'M1'}).messageId,'1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(window.dir,'receipts','1.json'))).through,window.data.through);
});
test('receipt failure cannot discard raw window; later arrivals are outside a frozen slide',t=>{
  const {window,add}=fixture(t);for(let i=1;i<=65;i++)add(i);
  fs.writeFileSync(path.join(window.dir,'receipts'),'blocked');assert.throws(()=>window.slide(61));assert.equal(window.data.rows.length,65);assert.equal(window.data.through,0);
  fs.unlinkSync(path.join(window.dir,'receipts'));window.slide(61);assert.equal(window.data.rows.filter(x=>x.seq>=61).length,5);
});

test('a continuous conversation slides its durable projection without ending the DSH session',t=>{
  const {window,add}=fixture(t);let route;
  for(let i=1;i<=75;i++)route=add(i);
  window.attach(route,{windowThroughSeq:74});
  assert.equal(window.data.rows.length,41);assert.ok(window.data.summary.length>0);
  assert.ok(window.data.rows.some(r=>r.seq===75));
});
test('continuous admission limit retains every unexposed input for next window',async()=>{
  let admitted=0;const inbox=new ConversationInbox(new AbortController().signal,()=>admitted<2);
  for(let i=1;i<=4;i++)inbox.push({text:String(i),key});
  const result=await inbox.take({timeoutSeconds:1},async r=>{admitted++;return {...r,compactView:{text:r.text}};});
  assert.equal(result.messages.length,2);assert.equal(inbox.pending.length,2);
  const closed=await inbox.take({timeoutSeconds:1},()=>assert.fail());assert.equal(closed.reason,'window-full');assert.equal(inbox.pending.length,2);
});
test('new windows include full persona and project group rules; incremental input stays concise',()=>{
  const route={key,group:true,compactView:{messages:[{id:'M1',speaker:'U1',text:'来'}]}};
  const initial=nativePrompt(null,route,{}, {bootstrap:true,persona:'完整人设\n嘴欠但不乱认人'});
  assert.match(initial,/群聊不是客服队列/);assert.match(initial,/完整人设/);
  const next=nativePrompt(null,route,{}, {bootstrap:false,persona:'完整人设'});assert.match(next,/当前是群聊/);assert.doesNotMatch(next,/完整人设|sourceId|inboxSeq/);
  const upgrade=nativePrompt(null,route,{}, {bootstrap:false,conversationPolicyUpdate:true});
  assert.match(upgrade,/群聊不是客服队列/);assert.match(upgrade,/保持主体性/);assert.match(upgrade,/首答前/);assert.match(upgrade,/回复后/);
});
test('maintenance keeps the chat session, and uncertain cancellation confirms that same session',async t=>{
  const {root}=fixture(t),b=new Bridge(root);b.config={...defaults,botQQ:'100000001',groups:['100000002']};b.status={state:'running',channels:{group:true}};
  const session={id:'main',route:{key,id:'100000002',group:true},workspace:root,preset:'test'};initializeLife(session,0);
  let confirmed;b.dsh={createSession:async()=>assert.fail('must not create a maintenance session'),prompt:async id=>{assert.equal(id,'main');throw Object.assign(Error('lost'),{exitUnconfirmed:{lease:'private'}});},confirmExit:async id=>{confirmed=id;return true;}};
  await assert.rejects(b.maintenanceDsh(session).prompt('main','history',{signal:new AbortController().signal}),e=>{session.exitUnconfirmed=e.exitUnconfirmed;return true;});
  await b.confirmSessionExit(session);assert.equal(confirmed,'main');assert.equal(session.id,'main');
});
test('sliding and upgrading projection preserve the DSH session even after many messages and turns',async t=>{
  const {root,add}=fixture(t);for(let i=1;i<=65;i++)add(i);const latest=add(66);
  const b=new Bridge(root);b.config={...defaults,dshNativeTools:true,botQQ:'100000001',groups:['100000002'],groupPreset:'test'};
  b.status={state:'running',channels:{group:true}};
  const route={...latest,id:'100000002',group:true},old={id:'old',promptVersion:2,route,workspace:root,preset:'test',backend:b.config.dshUrl};initializeLife(old,0);
  old.life.conversation.push({id:'undigested',inputs:[],reply:'reply'});b.state.sessions[b.scope(route)]=old;
  b.deferForMaintenance({...route,messageId:'still-pending'});
  let creates=0;b.dsh={createSession:async()=> 'new-'+(++creates),rename:async()=>{}};
  const next=await b.prepareChatWindow(route,old);assert.equal(next.id,'old');assert.equal(next.promptVersion,2);
  assert.equal(next.windowInitial,true);assert.deepEqual(next.life.conversation,old.life.conversation);assert.equal(b.state.retired.length,0);assert.equal(b.hasDeferred(key),true);
  const window=b.chatWindow(key),view=window.attach({...route,replyPolicy:{historyThroughSeq:0}},next,{initial:true}).compactView;
  assert.ok(view.summary.length);assert.equal(view.background.length,40);assert.equal(view.messages.length,1);
  next.promptVersion=2;next.windowInitial=false;next.windowTurns=80;next.windowChars=200000;next.windowMessages=600;
  const again=await b.prepareChatWindow(route,next);assert.equal(again.id,'old');assert.equal(again.windowInitial,false);assert.equal(creates,0);
});
test('multimedia projection preserves transcription, attached images and quoted speakers without internal snapshots',t=>{
  const {window}=fixture(t);
  const view=window.view({sourceId:key+'/voice',sender:{qq:'100000003'},text:'',media:[{kind:'record',status:'transcribed',transcript:'明天下午三点'},
    {kind:'image',status:'attached',attachmentName:'a.png'}],replyTo:{sourceId:key+'/q',messageId:'5',resolved:true,sender:{qq:'100000004'},text:'几点？'}});
  assert.equal(view.media[0].transcript,'明天下午三点');assert.equal(view.media[1].attachment,'a.png');assert.notEqual(view.speaker,view.replyTo.speaker);
  assert.doesNotMatch(JSON.stringify(view),/sourceId|inboxSeq|"version"/);
});
test('failure before window submission preserves the direct input for explicit recovery',async t=>{
  const {root}=fixture(t),b=new Bridge(root);b.config={...defaults,dshNativeTools:true,botQQ:'100000001',groups:['100000002']};
  b.status={state:'running',channels:{group:true}};const route={key,id:'100000002',group:true,messageId:key+'/new',text:'不能丢掉'};
  const session={id:'main',route,transport:'native-v1',workspace:root,preset:'test',backend:b.config.dshUrl};initializeLife(session,0);b.state.sessions[b.scope(route)]=session;
  b.dsh={};b.prepareChatWindow=async()=>{throw Error('receipt disk error');};
  await assert.rejects(b.handle(route,0),e=>e.notSubmitted&&/receipt/.test(e.message));
  assert.equal(b.state.maintenanceInbox[key][0].state,'pending');assert.equal(b.state.maintenanceInbox[key][0].route.text,'不能丢掉');
});
