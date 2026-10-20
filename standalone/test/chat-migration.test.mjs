import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {ChatInbox,Participation} from '../lib/chat-inbox.mjs';
import {MessageTools} from '../lib/message-tools.mjs';
import {Bridge} from '../lib/bridge.mjs';
import {Media} from '../lib/media.mjs';
import {defaults,validate,writeJson} from '../lib/config.mjs';
import {resolveChatConfig} from '../lib/chat-policy.mjs';
import {resetMemories} from '../lib/reset-memory.mjs';
import {createApp} from '../server.mjs';
const key='100000001/group/100000003',other='100000001/private/100000002';
const conf={...defaults,botQQ:'100000001',groups:['100000003'],privateUsers:['100000002'],groupPreset:'test',privatePreset:'test',qqVoiceSend:false,memoryEnabled:false};
const route={key,id:'100000003',group:true,sender:'100000002',text:'你好',messageId:key+'/1',qqMessageId:'1',inboxSeq:1};
const env=(reply='',actions=[])=>JSON.stringify({reply,memory:[],actions});
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-v012-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function fixture(t,extra={}){
  const runtime=temp(t),bridge=new Bridge(runtime);bridge.config={...conf,...extra};bridge.status.state='running';
  bridge.inbox(key).append({messageId:'1',sourceId:route.messageId,sender:route.sender,text:'你好'});
  bridge.dsh={createSession:async()=> 's1',rename:async()=>{},close(){}};
  const sent=[];bridge.socket={close(){},send(raw){
    const frame=JSON.parse(raw);sent.push(frame);
    const data=frame.action==='get_group_member_info'?{user_id:frame.params.user_id,group_id:frame.params.group_id}:
      frame.action==='get_msg'?{message_type:'group',group_id:route.id,sender:{user_id:route.sender},message:[]}:{message_id:100+sent.length};
    queueMicrotask(()=>{bridge.pending.get(frame.echo)?.({status:'ok',retcode:0,data});bridge.pending.delete(frame.echo);});
  }};t.after(()=>bridge.stop());return {bridge,sent,runtime};
}
test('inbox isolates chats, persists cursors, retains negative IDs and reports retention gaps',t=>{
  const dir=temp(t),inbox=new ChatInbox(dir,key);
  for(let n=1;n<=502;n++)inbox.append({messageId:String(-n),sourceId:'m'+n,sender:'100000002',text:'t'+n});
  assert.equal(inbox.read().messages.length,500);
  const page=inbox.list({unread:true,limit:2});assert.deepEqual(page.messages.map(m=>m.seq),[3,4]);assert.equal(page.truncatedBeforeSeq,3);
  assert.equal(new ChatInbox(dir,key).detail({messageId:'-3'}).seq,3);
  assert.equal(new ChatInbox(dir,other).list().messages.length,0);
  assert.equal(inbox.append({sourceId:'m502'}).seq,502);
});
test('unread marking cannot skip undisplayed records or consume arrivals after a queried page',async t=>{
  const inbox=new ChatInbox(temp(t),key);
  for(let i=1;i<=4;i++)inbox.append({messageId:String(i),sourceId:'m'+i,text:'hello'});
  const tools=new MessageTools({route,config:defaults,inbox});
  await assert.rejects(tools.run('qq_mark_read',{throughSeq:4}));
  await tools.run('qq_get_recent_messages',{limit:1});
  await assert.rejects(tools.run('qq_mark_read',{throughSeq:4}));
  await tools.run('qq_get_unread_messages',{limit:2});
  inbox.append({messageId:'5',sourceId:'m5',text:'new'});
  await assert.rejects(tools.run('qq_mark_read',{throughSeq:5}));
  await tools.run('qq_mark_read',{throughSeq:2});
  assert.deepEqual(inbox.list({unread:true}).messages.map(m=>m.seq),[3,4,5]);
  inbox.consume([4]);assert.deepEqual(inbox.list({unread:true}).messages.map(m=>m.seq),[3,5]);
  inbox.consume([3]);assert.equal(inbox.read().readThrough,4);
});
test('bounded message pages expose truncation and do not advance beyond visible records',async t=>{
  const inbox=new ChatInbox(temp(t),key);for(let i=1;i<=20;i++)inbox.append({messageId:String(i),sourceId:'m'+i,text:'x'.repeat(12000)});
  const tools=new MessageTools({route,config:defaults,inbox}),page=await tools.run('qq_get_unread_messages',{limit:100});
  assert.ok(page.messages.length<20);assert.equal(page.hasMore,true);assert.equal(page.messages[0].textTruncated,true);
  await assert.rejects(tools.run('qq_mark_read',{throughSeq:20}));
  assert.ok(JSON.stringify(page).length<6500);
  const recent=inbox.list({limit:100}),older=inbox.list({limit:100,offset:recent.messages.length});
  assert.equal(recent.messages.at(-1).seq,20);
  assert.equal(older.messages.at(-1).seq,recent.messages[0].seq-1);
});
test('message tools reject cross-chat arguments, absent quotes, invalid members and disabled capabilities',async t=>{
  const inbox=new ChatInbox(temp(t),key),tools=new MessageTools({route,config:defaults,inbox,call:async()=>({user_id:'999999999'})});
  await assert.rejects(tools.run('qq_get_recent_messages',{key:other}));
  await assert.rejects(tools.run('qq_reply',{replyToMessageId:'22',message:'hi'}));
  await assert.rejects(tools.run('qq_send_message',{messages:'hi',atUserId:'100000002'}),/未启用/);
  await assert.rejects(tools.run('qq_send_poke',{targetUserId:'100000002'}),/未启用/);
  tools.config={...defaults,mentionSend:true,pokeSend:true};
  await assert.rejects(tools.run('qq_send_message',{messages:'hi',atUserId:'100000002'}),/无法确认/);
});
test('unified tools queue quote + mention once; normal final reply is not sent twice',async t=>{
  const {bridge,sent}=fixture(t,{mentionSend:true});let round=0;
  const action={tool:'qq_send_message',args:{messages:'回答原消息',replyToMessageId:'1',atUserId:'100000002'}};
  bridge.dsh.prompt=async()=>round++<2?env('不能重复发送的普通输出',[action]):env('不能再次转发的发送汇报');
  await bridge.handle({...route},0);
  const messages=sent.filter(f=>f.action==='send_group_msg');assert.equal(messages.length,1);
  assert.deepEqual(messages[0].params.message.map(s=>s.type),['reply','at','text']);
  assert.equal(messages[0].params.message.at(-1).data.text,'回答原消息');
  assert.equal(bridge.inbox(key).list({mine:true}).messages.length,1);
});
test('a failed model continuation sends no queued messages',async t=>{
  const {bridge,sent}=fixture(t);let n=0;
  bridge.dsh.prompt=async()=>{if(n++)throw Error('model failed');return env('',[{tool:'qq_send_message',args:{messages:'queued'}}]);};
  await assert.rejects(bridge.handle({...route},0),/model failed/);assert.equal(sent.length,0);
});
test('commands, reply batches and poke share serial output receipts and stop invalidates queued sends',async t=>{
  const {bridge,sent}=fixture(t,{pokeSend:true});let release;
  bridge.socket.send=raw=>{const f=JSON.parse(raw);sent.push(f);release=()=>bridge.pending.get(f.echo)?.({status:'ok',retcode:0,data:{message_id:42}});};
  const a=bridge.sendText(route,'第一条','command');
  const b=bridge.sendPlan(route,{action:'group_poke',params:{group_id:route.id,user_id:route.sender}});
  await new Promise(r=>setImmediate(r));assert.equal(sent.length,1);
  release();await a;await new Promise(r=>setImmediate(r));assert.equal(sent.length,2);
  release();await b;
  assert.deepEqual(bridge.state.deliveries.map(x=>x.state),['sent','sent']);
  const c=bridge.sendText(route,'pending','command'),d=bridge.sendText(route,'must not send','reply');
  await new Promise(r=>setImmediate(r));bridge.stop();
  await assert.rejects(c,/不会自动重试/);assert.equal(await d,false);assert.equal(sent.length,3);
});
test('private and group poke use scoped OneBot actions and persistent cooldown',async t=>{
  const {bridge,sent}=fixture(t,{pokeSend:true});let n=0;
  bridge.dsh.prompt=async()=>n++===0?env('',[{tool:'qq_send_poke',args:{targetUserId:route.sender}}]):env('');
  await bridge.handle({...route},0);
  assert.equal(sent.filter(f=>f.action==='group_poke').length,1);
  await assert.rejects(bridge.sendPlan(route,{action:'group_poke',params:{group_id:route.id,user_id:route.sender}}),/冷却/);
  const privateRoute={...route,key:other,id:'100000002',group:false};
  await bridge.sendPlan(privateRoute,{action:'send_poke',params:{user_id:privateRoute.id}});
  assert.equal(sent.at(-1).action,'send_poke');
});
test('poke notice only accepts current-account target, fresh notices, configured peers and deduplicates',t=>{
  const {bridge}=fixture(t,{pokeReceive:true});let received=0;bridge.accept=()=>received++;
  const event={post_type:'notice',notice_type:'notify',sub_type:'poke',self_id:100000001,user_id:100000002,target_id:100000001,group_id:100000003,time:Math.floor(Date.now()/1000)};
  bridge.receive({...event,target_id:100000009},0);bridge.receive({...event,time:1},0);bridge.receive({...event,self_id:100000099},0);
  assert.equal(received,0);bridge.receive(event,0);bridge.receive(event,0);assert.equal(received,1);
});
test('sleep persists; passive and timed participation stop; direct, keyword, speaker and expiry wake without widening allowlists',t=>{
  let now=1000000;const inbox=new ChatInbox(temp(t),key,()=>now),p=new Participation(inbox),config={...defaults,wakeEnabled:true,wakeKeywords:'小助手',wakeSpeakers:['100000004']};
  inbox.setWake('diving',1);assert.equal(p.onInput({...route,ambient:true},config),false);assert.equal(p.allowsBackground(config),false);
  assert.equal(p.onInput({...route,ambient:true,text:'小助手你好'},config),true);
  inbox.setWake('diving',1);assert.equal(p.onInput({...route,ambient:true,sender:'100000004'},config),true);
  inbox.setWake('diving',1);assert.equal(p.onInput({...route,ambient:false},config),true);
  inbox.setWake('diving',1);now+=60001;assert.equal(p.allowsBackground(config),true);
});
test('passive indexing retains unread without invoking agent; direct mention wakes same scheduler',async t=>{
  const {bridge}=fixture(t,{wakeEnabled:true,groupAmbientEnabled:true});bridge.inbox(key).setWake('diving');let accepted=0;bridge.accept=()=>accepted++;
  const event={post_type:'message',message_type:'group',self_id:100000001,user_id:100000002,group_id:100000003,message_id:2,message:[{type:'text',data:{text:'路过'}}]};
  bridge.receive(event,0);assert.equal(accepted,0);assert.equal(bridge.ambient.size,0);assert.equal(bridge.inbox(key).list({unread:true}).unreadCount,2);
  bridge.receive({...event,message_id:3,message:[{type:'at',data:{qq:'100000001'}},...event.message]},0);
  assert.equal(accepted,1);assert.equal(bridge.inbox(key).sleeping(),false);
});
test('sleep gates proactive ticks and a new input prevents stale tool from putting chat back to sleep',async t=>{
  const {bridge}=fixture(t,{wakeEnabled:true,groupProactiveEnabled:true});bridge.dsh.prompt=async()=>env('');await bridge.handle({...route},0);
  bridge.inbox(key).setWake('diving');let candidates=0;bridge.proactive.candidate=async()=>{candidates++;return null;};
  await bridge.tick();assert.equal(candidates,0);
  const tools=new MessageTools({route,config:{...defaults,wakeEnabled:true},inbox:bridge.inbox(key)});
  bridge.inbox(key).append({sourceId:'later',messageId:'2',text:'新问题'});
  await assert.rejects(tools.run('qq_set_wake_config',{mode:'diving'}),/更新/);
});
test('quote policy and mention permission apply to legacy output too',async t=>{
  const media=new Media(temp(t),{call:async(action,p)=>action==='get_msg'?{message_type:'group',group_id:route.id,message:[]}:{user_id:p.user_id,group_id:route.id}});
  const config={...conf,quoteMode:'always'},session={workspace:temp(t)};
  assert.equal((await media.outgoing({reply:'hi'},route,session,config)).params.message[0].type,'reply');
  assert.equal((await media.outgoing({reply:'hi',qq:{replyTo:'1'}},route,session,{...config,quoteMode:'never'})).params.message[0].type,'text');
  await assert.rejects(media.outgoing({reply:'hi',qq:{at:route.sender}},route,session,config),/不允许/);
});
test('new configuration inherits per scope and memory reset archives chat index/wake state',t=>{
  const config=validate({chatPolicy:{group:{wakeEnabled:true,pokeSend:true},private:{quoteMode:'never'},overrides:{[key]:{pokeSend:false}}}},conf);
  assert.equal(resolveChatConfig(config,route).pokeSend,false);assert.equal(resolveChatConfig(config,route).wakeEnabled,true);
  assert.equal(resolveChatConfig(config,other).quoteMode,'never');assert.equal(resolveChatConfig(config,other).wakeEnabled,false);
  const runtime=temp(t),bridge=new Bridge(runtime);bridge.inbox(key).append({sourceId:'a',text:'secret'});bridge.inbox(key).setWake('diving');
  resetMemories(runtime,bridge,[key]);assert.equal(bridge.inbox(key).list().messages.length,0);assert.equal(bridge.inbox(key).sleeping(),false);
});
test('panel chat-state and wake require auth, origin and allowed scope; saved state survives reread',async t=>{
  const runtime=temp(t);writeJson(path.join(runtime,'config.private.json'),{...conf,wakeEnabled:true});
  const app=createApp({runtime});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>{app.bridge.stop();app.server.close();});
  const base='http://127.0.0.1:'+app.server.address().port;
  assert.equal((await fetch(base+'/api/chat-state?key='+key)).status,401);
  const login=await fetch(app.loginUrl(),{redirect:'manual'}),cookie=login.headers.get('set-cookie').split(';')[0];
  const headers={cookie,origin:base,'x-qq-rsi':'panel','content-type':'application/json'};
  assert.equal((await fetch(base+'/api/chat-state?key='+key,{headers})).status,200);
  assert.equal((await fetch(base+'/api/chat-wake',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({key,mode:'diving'})})).status,403);
  const post=body=>fetch(base+'/api/chat-wake',{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal((await post({key:'100000001/group/999999999',mode:'diving'})).status,400);
  assert.equal((await post({key,mode:'diving',minutes:30})).status,200);
  assert.equal((await (await fetch(base+'/api/chat-state?key='+key,{headers})).json()).sleeping,true);
});
