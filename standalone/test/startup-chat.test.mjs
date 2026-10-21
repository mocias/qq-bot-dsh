import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {Bridge} from '../lib/bridge.mjs';
import {defaults} from '../lib/config.mjs';
import {initializeLife} from '../lib/lifecycle.mjs';
import {snapshotOf} from '../lib/message-snapshot.mjs';
import {startupSources,startupBatches} from '../lib/startup-chat.mjs';

const bot='100000001',peer='100000002';
const route=group=>({key:`${bot}/${group?'group':'private'}/${peer}`,id:peer,group});
const until=async predicate=>{for(let n=0;n<300;n++){if(predicate())return;await new Promise(r=>setImmediate(r));}assert.fail('condition timed out');};
function fixture(t){
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-startup-'));
  const b=new Bridge(runtime,{now:()=>1000000});
  b.config={...defaults,botQQ:bot,groups:[peer],privateUsers:[peer],privatePreset:'test',groupPreset:'test',
    memoryEnabled:true,dshNativeTools:true,groupAmbientEnabled:true,groupAmbientMinSeconds:0,groupMinReplyGapSeconds:0};
  b.status={state:'running',active:0,account:bot,channels:{private:true,group:true}};b.generation=1;
  const trace=[],prompts=[];let workerNumber=0;
  for(const group of [false,true]){
    const r=route(group),s={id:group?'group-session':'private-session',route:r,transport:'native-v1',workspace:runtime,preset:group?'group-test':'private-test',backend:b.config.dshUrl,blocked:false};
    initializeLife(s,0);b.state.sessions[b.scope(r)]=s;
    fs.writeFileSync(b.memory(r.key).safe('SOUL.md'),group?'群聊人设：简短活泼':'私聊人设：沉稳温和');
  }
  b.dsh={close(){},rename:async()=>{},createSession:async(_dir,preset)=>(preset==='group-test'?'group':'private')+'-worker-'+(++workerNumber),prompt:async(id,text,o)=>{
    prompts.push({id,text,o});
    if(o.nativeTools.allowed.includes('qq_memory_digest')){trace.push('digest/'+(id.startsWith('group-')?'group-session':'private-session'));await o.nativeTools.execute('qq_memory_digest',{summary:'已核对本聊天记录',updates:[]});return '';}
    assert.fail('startup must not generate a greeting');
  }};
  b.call=async(action,params)=>{trace.push('send/'+(action==='send_group_msg'?'group':'private'));return {message_id:'out-'+trace.length};};
  b.handle=async r=>{trace.push('handle/'+r.qqMessageId);b.inbox(r.key).consume([r.inboxSeq]);};
  t.after(async()=>{b.stop();await Promise.all([...b.startup.jobs.values()].map(j=>j.promise));await Promise.all([...b.deferredDrains.values()]);fs.rmSync(runtime,{recursive:true,force:true});});
  const event=(n,group=true,direct=true,text='message '+n)=>({post_type:'message',message_type:group?'group':'private',self_id:bot,user_id:peer,group_id:group?peer:undefined,message_id:String(n),message:[...(group&&direct?[{type:'at',data:{qq:bot}}]:[]),{type:'text',data:{text}}]});
  const seed=(n,group=true,text='old '+n)=>{
    const r={...route(group),messageId:route(group).key+'/'+n,qqMessageId:String(n),sender:peer,author:{qq:peer,nickname:'测试'},text,
      segments:[...(group?[{type:'at',data:{qq:bot}}]:[]),{type:'text',data:{text}}]};
    const m=b.inbox(r.key).append({sourceId:r.messageId,messageId:r.qqMessageId,sender:peer,text,snapshot:snapshotOf(r),segments:r.segments});
    b.memory(r.key).record({id:r.messageId,kind:'qq-input',snapshot:snapshotOf(r),segments:r.segments});return m;
  };
  return {b,runtime,trace,prompts,event,seed};
}

test('startup retains existing backlog as history and excludes it from new message context',async t=>{
  const {b,seed,event,trace}=fixture(t),key=route(true).key;
  const old=seed(100);b.deferForMaintenance({...route(true),messageId:old.sourceId,qqMessageId:'100',inboxSeq:old.seq,text:old.text,epoch:0});
  b.startup.begin(['group']);b.receive(event(101),1);
  await b.startup.jobs.get(key).promise;await b.deferredDrains.get(key);
  assert.deepEqual(trace.filter(x=>x.startsWith('handle/')),['handle/101']);
  assert.equal(b.state.maintenanceInbox[key][0].state,'history');
  assert.equal(b.inbox(key).read().messages.find(m=>m.messageId==='100').text,old.text);
  const input=b.messageInput({...route(true),messageId:key+'/102',inboxSeq:old.seq+2},{});
  assert.equal(input.contextMessages.some(m=>m.sourceId===old.sourceId),false);
  assert.equal(input.replyPolicy.historyThroughSeq,old.seq);
});

test('unavailable queued quote falls back once and cannot block later mentions',async t=>{
  const {b,event,trace}=fixture(t),key=route(true).key;
  b.state.startups[key]={route:route(true),phase:'digesting'};
  const quoted=event(110,true,false);quoted.message.unshift({type:'reply',data:{id:'734174288'}});
  b.receive(quoted,1);b.receive(event(111),1);
  let lookups=0;b.media.reference=async()=>{lookups++;throw Error('QQ 请求失败：get_msg');};
  b.config.groupAmbientMinSeconds=20;b.ambientAttempts[key]=b.now();
  b.state.startups[key].phase='ready';await b.drainDeferred(key);
  assert.deepEqual(trace,['handle/111']);assert.equal(lookups,1);
  const saved=b.state.maintenanceInbox[key][0];
  assert.equal(saved.route.needsReplyCheck,false);assert.equal(saved.route.referenceUnavailable,true);
  assert.equal(saved.route.segments[0].data.id,'734174288');
  const prepared=await b.media.incoming(saved.route,b.config);
  assert.match(prepared.text,/引用内容不可读取/);assert.equal(lookups,1);
  b.now=()=>1021000;await b.drainDeferred(key);
  assert.deepEqual(trace,['handle/111','handle/110']);assert.equal(lookups,1);
});

test('fresh failed quote is retained through the same queue path and stop stays respected',async t=>{
  const {b,event,trace}=fixture(t),key=route(true).key;
  let release;b.media.reference=()=>new Promise((_resolve,reject)=>{release=()=>reject(Error('missing'));});
  const quoted=event(120,true,false);quoted.message.unshift({type:'reply',data:{id:'734174288'}});
  b.receive(quoted,1);await until(()=>release);b.stop('group');release();
  await b.deferredDrains.get(key);
  assert.deepEqual(trace,[]);assert.equal(b.state.maintenanceInbox[key][0].state,'cancelled');
  assert.equal(b.inbox(key).read().messages[0].messageId,'120');
});

test('startup digests read-but-undigested and unread records, then silently drains arrivals',async t=>{
  const {b,trace,prompts,event,seed}=fixture(t),key=route(true).key;
  const read=seed(1);b.inbox(key).consume([read.seq]);seed(2);
  let release,entered=false;const original=b.dsh.prompt;
  b.dsh.prompt=async(id,text,o)=>{if(o.nativeTools.allowed.includes('qq_memory_digest')){entered=true;await new Promise(r=>release=r);}return original(id,text,o);};
  b.startup.begin(['group']);await until(()=>entered);
  b.receive(event(3),1);b.receive(event(3),1);b.receive(event(4),1);
  assert.equal(b.inbox(key).list({unread:true}).unreadCount,3);assert.deepEqual(trace,[]);
  const oldCall=b.call;b.call=async(...args)=>{
    assert.equal(b.inbox(key).list({unread:true}).unreadCount,3);
    assert.ok(b.memory(key).hasReceipt(b.state.startups[key].id+'/digest/0'));return oldCall(...args);
  };
  let finishFirst,handling=false;
  b.handle=async r=>{assert.equal(b.state.startups[key].phase,'ready');assert.equal(handling,false);handling=true;
    trace.push('handle/'+r.qqMessageId);if(r.qqMessageId==='3')await new Promise(r=>finishFirst=r);
    b.inbox(key).consume([r.inboxSeq]);handling=false;};
  release();await b.startup.jobs.get(key).promise;await until(()=>finishFirst);
  b.receive(event(5),1);const beforeRelease=[...trace];
  finishFirst();await b.deferredDrains.get(key);
  assert.deepEqual(beforeRelease,['digest/group-session','handle/3']);
  assert.deepEqual(trace.slice(1),['handle/3','handle/4','handle/5']);
  assert.equal(b.inbox(key).read().messages.find(m=>m.messageId==='2').read,undefined);
  const snapshot=JSON.parse(prompts[0].text.split('\n\n').at(-1));
  assert.deepEqual(snapshot.conversation.flatMap(c=>c.inputs.map(m=>m.messageId)).sort(),[key+'/1',key+'/2']);
  assert.deepEqual(startupSources(b.memory(key),b.inbox(key)).conversation.flatMap(c=>c.inputs.map(m=>m.messageId)).sort(),[key+'/3',key+'/4',key+'/5']);
});

test('private and group with the same numeric ID start independently; stopping group does not stop private',async t=>{
  const {b,trace,event}=fixture(t);let release,entered=false;const original=b.dsh.prompt;
  b.dsh.prompt=async(id,text,o)=>{if(id.startsWith('group-')&&o.nativeTools.allowed.includes('qq_memory_digest')){entered=true;await new Promise(r=>release=r);if(o.signal.aborted)throw Object.assign(Error('stopped'),{cancelled:true,acknowledged:true});}return original(id,text,o);};
  b.startup.begin(['group','private']);await until(()=>entered&&b.state.startups[route(false).key].phase==='ready');
  b.receive(event(8,false),1);await b.queues.get(route(false).key);assert.ok(trace.includes('handle/8'));assert.ok(!trace.includes('send/group'));
  b.stop('group');release();await b.startup.jobs.get(route(true).key).promise;
  assert.equal(b.state.startups[route(true).key].phase,'cancelled');assert.equal(b.status.channels.private,true);
});

test('failed digest without receipt never greets or consumes pending reply',async t=>{
  const {b,trace,seed}=fixture(t),key=route(true).key;seed(9);
  b.dsh.prompt=async()=>'';b.startup.begin(['group']);await b.startup.jobs.get(key).promise;
  assert.equal(b.state.startups[key].phase,'failed');assert.match(b.status.lastError,/没有通过原生工具提交/);
  assert.deepEqual(trace,[]);assert.equal(b.inbox(key).list({unread:true}).unreadCount,1);
  assert.equal(!!b.hasDeferred(key),false);await b.sweep();assert.deepEqual(trace,[]);
});

test('unconfirmed DSH exit survives restart and preserves queued inputs until explicit confirmation',async t=>{
  const {b,runtime,seed,event}=fixture(t),key=route(true).key;seed(60);
  b.dsh.prompt=async()=>{throw Object.assign(Error('stream lost'),{exitUnconfirmed:{runId:'failed-run',token:'test-token'}});};
  b.startup.begin(['group']);await b.startup.jobs.get(key).promise;b.receive(event(61),1);
  const session=b.state.sessions[b.scope(route(true))];assert.equal(session.exitUnconfirmed.runId,'failed-run');
  const restored=new Bridge(runtime);restored.config=b.config;restored.status={...b.status};restored.generation=1;
  restored.dsh={confirmExit:async()=>false,createSession:()=>assert.fail('no replacement'),close(){}};
  await assert.rejects(restored.ensureStartupSession(route(true)),/结束状态未确认/);
  restored.handle=()=>assert.fail('no input before confirmation');await restored.drainDeferred(key);
  assert.equal(restored.state.maintenanceInbox[key].filter(r=>r.state==='pending').length,1);
  assert.equal(restored.inbox(key).list({unread:true}).unreadCount,2);
  restored.dsh.confirmExit=async()=>true;await restored.confirmSessionExit(restored.state.sessions[restored.scope(route(true))]);
  assert.equal(restored.awaitingExit(key),false);
});

for(const phase of ['greeting','publishing','uncertain','failed'])test('legacy '+phase+' greeting cannot block silent startup or be retried',async t=>{
  const {b,trace,seed}=fixture(t),key=route(true).key;seed(10);
  const previous={id:'old-startup',route:route(true),phase,...(phase==='failed'?{error:'招呼生成失败'}:{greeting:'旧招呼',delivery:{state:'unknown'}})};
  b.state.startups[key]=previous;b.state.deliveries.push({key,messageId:'old-startup',state:'unknown'});
  b.call=async()=>assert.fail('must not send or retry startup greeting');
  b.startup.begin(['group']);await b.startup.jobs.get(key).promise;
  assert.equal(b.state.startups[key].phase,'ready');assert.equal(b.state.startupHistory[0],previous);
  assert.equal(b.state.deliveries[0].state,'unknown');assert.deepEqual(trace,['digest/group-session']);
});

test('startup keeps historical commands and already-sent requests as history, not executable backlog',async t=>{
  const {b,seed,trace}=fixture(t),key=route(true).key;
  seed(11,true,'/stop');const old=seed(12);seed(13);
  b.state.deliveries.push({key,messageId:old.sourceId,state:'sent',qqMessageId:'prior'});
  b.startup.begin(['group']);await b.startup.jobs.get(key).promise;await b.deferredDrains.get(key);
  assert.deepEqual(trace.filter(x=>x.startsWith('handle/')),[]);assert.equal(b.state.startups[key].phase,'ready');
});

test('mentions bypass ambient cooldown and do not consume queued ambient messages as context',async t=>{
  const {b,event,trace}=fixture(t),key=route(true).key;b.config.groupAmbientMinSeconds=20;b.ambientAttempts[key]=b.now();
  b.state.startups[key]={route:route(true),phase:'digesting'};
  b.receive(event(20,true,false),1);const reply=event(21,true,false);reply.message.unshift({type:'reply',data:{id:'someone-else'}});b.receive(reply,1);
  b.receive(event(22),1);b.state.startups[key].phase='ready';b.media.reference=async()=>({fromBot:false});
  const session=b.state.sessions[b.scope(route(true))];
  b.handle=async r=>{const input=b.messageInput(r,session);assert.equal(input.contextMessages.length,0);trace.push('handle/'+r.qqMessageId);b.inbox(key).consume(input.inboxSeqs);};
  await b.drainDeferred(key);assert.deepEqual(trace,['handle/22']);
  assert.deepEqual(b.state.maintenanceInbox[key].map(r=>r.route.qqMessageId),['20','21']);
  assert.equal(b.inbox(key).list({unread:true}).unreadCount,2);
  b.now=()=>1021000;await b.drainDeferred(key);assert.deepEqual(trace,['handle/22','handle/20']);
  b.now=()=>1042000;await b.drainDeferred(key);assert.deepEqual(trace,['handle/22','handle/20','handle/21']);
});

test('receipt coverage handles raw and session compactions, enriched sources, and bounded batches without truncation',async t=>{
  const {b,seed}=fixture(t),key=route(true).key,store=b.memory(key),m=seed(30),session=b.state.sessions[b.scope(route(true))];
  const enriched={...snapshotOf({messageId:m.sourceId,text:'expanded',author:{qq:peer}}),expanded:true};
  store.record({id:'snapshot-v2-'+m.sourceId,kind:'qq-snapshot',snapshot:enriched});b.inbox(key).enrich(m.sourceId,enriched);
  const cp={id:'cp1',sourceId:'compaction:group-session:cp1',summary:'summary'};session.life.compactions.push(cp);store.record({...cp,id:cp.sourceId,kind:'compaction'});
  const sources=startupSources(store,b.inbox(key),[session]);assert.equal(sources.compactions.length,1);assert.equal(sources.conversation[0].inputs[0].text,'expanded');
  store.record({id:'successful',kind:'digest-source',...sources});store.commit([],{id:'successful',evidenceIds:[],summary:'done',digest:true});
  assert.deepEqual(startupSources(store,b.inbox(key),[session]),{conversation:[],compactions:[]});
  assert.equal(b.inbox(key).list({unread:true}).unreadCount,1);
  const large={conversation:[{id:'a',inputs:[],reply:'x'.repeat(100000)},{id:'b',inputs:[],reply:'y'.repeat(100000)}],compactions:[]};
  const batches=startupBatches(large);assert.equal(batches.length,2);assert.deepEqual(batches.flatMap(b=>b.conversation),large.conversation);
  assert.throws(()=>startupBatches({conversation:[{reply:'x'.repeat(190000)}],compactions:[]}),/已保留原文/);
});

for(const group of [true,false])test(`${group?'group':'private'} startup batches and normal chat share one session without any greeting`,async t=>{
  const {b,event,trace,prompts}=fixture(t),key=route(group).key,original=b.dsh.prompt;
  const session=b.state.sessions[b.scope(route(group))];
  session.life.conversation=[{id:'large1',inputs:[],reply:'a'.repeat(100000),at:1},{id:'large2',inputs:[],reply:'b'.repeat(100000),at:2}];
  b.dsh.createSession=async()=>assert.fail('must reuse current conversation');
  b.handle=Bridge.prototype.handle.bind(b);let normal=0;
  b.dsh.prompt=async(id,text,o)=>{
    assert.equal(id,session.id);
    if(o.nativeTools.continuous){assert.equal(b.state.startups[key].phase,'ready');assert.ok(!trace.some(x=>x.startsWith('send/')));assert.equal(b.state.startups[key].completedBatches,2);assert.ok(b.memory(key).hasReceipt(session.life.receipt));assert.match(text,/普通对话阶段/);assert.ok(o.nativeTools.allowed.includes('qq_wait_for_messages'));assert.ok(!o.nativeTools.allowed.includes('qq_memory_digest'));normal++;return [];}
    if(o.nativeTools.allowed.includes('qq_memory_digest')){assert.match(text,/记忆整合阶段/);assert.ok(!o.nativeTools.allowed.includes('qq_send_message'));assert.ok(!o.nativeTools.allowed.includes('qq_wait_for_messages'));}
    return original(id,text,o);
  };
  b.startup.begin([group?'group':'private']);b.receive(event(40,group),1);b.receive(event(41,group),1);
  await b.startup.jobs.get(key).promise;await b.deferredDrains.get(key);
  assert.deepEqual(prompts.map(p=>p.id),[session.id,session.id]);
  assert.equal(session.maintenanceSessions,undefined);
  assert.equal(normal,2,b.status.lastError);assert.equal(b.inbox(key).list({unread:true}).unreadCount,0);assert.equal(b.state.deliveries.length,0);
});

test('background maintenance in one chat does not serialize maintenance in another chat',async t=>{
  const {b}=fixture(t);b.config.memoryIdleSeconds=1;b.config.memoryMinTurns=1;b.config.memoryConversationIdleEnabled=true;
  for(const s of Object.values(b.state.sessions))s.life.conversation=[{id:'turn/'+s.id,inputs:[],reply:'old',at:0}];
  let release,entered=false;const original=b.dsh.prompt;
  b.dsh.prompt=async(id,text,o)=>{if(id.startsWith('private-')){entered=true;await new Promise(r=>release=r);}return original(id,text,o);};
  const operation=b.sweep();await until(()=>entered&&b.state.sessions[b.scope(route(true))].life.receipt);
  assert.equal(b.state.sessions[b.scope(route(false))].life.receipt,null);
  release();await operation;assert.ok(b.state.sessions[b.scope(route(false))].life.receipt);
});

test('failed second startup batch preserves uncommitted work and retries only missing receipt coverage',async t=>{
  const {b,trace}=fixture(t),key=route(true).key,store=b.memory(key),session=b.state.sessions[b.scope(route(true))];
  session.life.conversation=[{id:'large1',inputs:[],reply:'a'.repeat(100000),at:1},{id:'large2',inputs:[],reply:'b'.repeat(100000),at:2}];
  for(const c of session.life.conversation)store.record({...c,kind:'conversation'});
  const original=b.dsh.prompt;let calls=0;
  b.dsh.prompt=async(...args)=>{if(++calls===2)return '';return original(...args);};
  b.startup.begin(['group']);await b.startup.jobs.get(key).promise;
  assert.equal(b.state.startups[key].phase,'failed');assert.equal(b.state.startups[key].completedBatches,1);
  assert.deepEqual(session.life.conversation.map(c=>c.id),['large2']);assert.ok(!trace.includes('send/group'));
  assert.deepEqual(startupSources(store,b.inbox(key),[session]).conversation.map(c=>c.id),['large2']);
  b.dsh.prompt=original;b.startup.begin(['group']);await b.startup.jobs.get(key).promise;
  assert.equal(b.state.startups[key].phase,'ready');assert.equal(b.state.startups[key].batches,1);assert.equal(trace.filter(x=>x==='send/group').length,0);
});

test('stopping one startup blocks immediate restart until its cancellation is confirmed',async t=>{
  const {b}=fixture(t);let release,entered=false;
  b.dsh.probe=async()=>({presets:[{id:'test'}]});
  b.dsh.prompt=async(_id,_text,o)=>{entered=true;await new Promise(r=>release=r);if(o.signal.aborted)throw Object.assign(Error('cancelled'),{cancelled:true,acknowledged:true});return '';};
  b.startup.begin(['group']);await until(()=>entered);b.stop('group');
  await assert.rejects(b.start(b.config,'group'),/上一轮任务正在退出/);assert.equal(b.status.channels.group,false);
  release();await b.startup.jobs.get(route(true).key).promise;
});

test('Bridge.start wires selected startup once, reusing connection without repeating greetings for active channels',async t=>{
  const {b,trace}=fixture(t);b.stop();
  const qq=new WebSocketServer({port:0,host:'127.0.0.1'});await once(qq,'listening');
  qq.on('connection',s=>s.on('message',bytes=>{const v=JSON.parse(bytes);s.send(JSON.stringify({echo:v.echo,status:'ok',retcode:0,data:v.action==='get_login_info'?{user_id:bot}:{online:true,good:true}}));}));
  t.after(async()=>{b.stop();for(const s of qq.clients)s.terminate();await new Promise(r=>qq.close(r));});
  const prompt=b.dsh.prompt;b.Dsh=class {async probe(){return {presets:[{id:'test'}]};}createSession(_dir,preset){return Promise.resolve((preset==='group-test'?'group':'private')+'-worker-'+Math.random());}createSession(_dir,preset){return Promise.resolve(preset==='group-test'?'group-memory-worker':'private-memory-worker');}rename(){}prompt(...args){return prompt(...args);}close(){}};
  b.config.qqUrl='ws://127.0.0.1:'+qq.address().port;
  // Keep the real socket for verification, and use a local capture for delivery.
  const capture=b.call;b.call=async(action,params)=>['get_login_info','get_status'].includes(action)?Bridge.prototype.call.call(b,action,params):capture(action,params);
  await b.start(b.config,'private');await b.startup.jobs.get(route(false).key).promise;
  await b.start(b.config,'private');assert.equal(trace.filter(x=>x==='send/private').length,0);
  await b.start(b.config,'group');await b.startup.jobs.get(route(true).key).promise;
  assert.equal(trace.filter(x=>x==='send/group').length,0);assert.equal(trace.filter(x=>x==='send/private').length,0);
  assert.equal(trace.filter(x=>x==='digest/group-session').length,1);assert.equal(trace.filter(x=>x==='digest/private-session').length,1);
});

test('explicit deployment resume drains saved queue without repeating successful startup',async t=>{
  const {b,trace,event}=fixture(t),key=route(true).key;
  b.startup.begin(['group']);await b.startup.jobs.get(key).promise;
  const original=b.state.startups[key];assert.equal(original.phase,'ready');assert.equal(original.delivery,undefined);
  trace.length=0;
  b.maintenance.set(key,{});b.receive(event(92),b.generation);b.maintenance.delete(key);
  b.startup.begin(['group'],{resumeCompleted:true});await b.deferredDrains.get(key);
  assert.equal(b.state.startups[key],original);assert.deepEqual(trace,['handle/92']);
});
