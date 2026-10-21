import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Bridge,routeMessage} from '../lib/bridge.mjs';
import {ChatInbox} from '../lib/chat-inbox.mjs';
import {Media} from '../lib/media.mjs';
import {MemoryStore,preparePrompt} from '../lib/memory.mjs';
import {validate} from '../lib/config.mjs';
import {snapshotOf,messageSnapshot,identity,evidenceMessages} from '../lib/message-snapshot.mjs';
import {initializeLife,maintain} from '../lib/lifecycle.mjs';
import {MessageTools} from '../lib/message-tools.mjs';
const key='100000001/group/100000009';
const config=validate({botQQ:'100000001',groups:['100000009'],groupPreset:'test',chatPolicy:{group:{groupAmbientEnabled:true}}});
const event=(user,id,segments,nickname='同名')=>({post_type:'message',message_type:'group',self_id:100000001,group_id:100000009,user_id:user,message_id:id,time:1700000000,sender:{nickname,card:'名片'+user},message:segments});
const text=value=>({type:'text',data:{text:value}});
const route=(user,id,value)=>routeMessage(event(user,id,[text(value)]),config,true);
function root(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'qq-snapshot-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}

test('lossless ingestion and storage retain long text, whitespace and stable author IDs',t=>{
 const runtime=root(t),raw='  '+ '原文'.repeat(9000)+'\n尾部证据  ',r=route(100000002,1,raw),inbox=new ChatInbox(runtime,key);
 assert.ok(r);assert.equal(r.requestText,raw);
 const stored=inbox.append({sourceId:r.messageId,messageId:r.qqMessageId,sender:r.sender,text:r.requestText,snapshot:snapshotOf(r),segments:r.segments});
 assert.equal(inbox.detail({seq:stored.seq}).text,raw);assert.equal(inbox.detail({seq:stored.seq}).snapshot.text,raw);
 const view=inbox.list().messages[0];assert.equal(view.textTruncated,true);assert.equal(view.sender.qq,'100000002');
 assert.equal(view.sender.nickname,'同名');assert.equal(view.sender.card,'名片100000002');
 assert.equal(snapshotOf(route(100000002,2,'后续')).sender.qq,stored.snapshot.sender.qq);
 assert.notEqual(snapshotOf(route(100000003,3,'另一个同名者')).sender.qq,stored.snapshot.sender.qq);
});

test('batch preserves every sender and voice owner even when the last message is plain text',async t=>{
 const runtime=root(t),media=new Media(runtime,{call:async(action)=>{
   assert.equal(action,'get_record');return {base64:Buffer.from('fixture').toString('base64')};
 },voice:{async transcribeRecord(){return {text:'我喜欢红茶'};}}});
 // Use a fenced local media response; ASR is intentionally mocked.
 const audio=path.join(runtime,'voice.wav');fs.writeFileSync(audio,'fixture');media.call=async()=>({file:audio});
 const bridge=new Bridge(runtime,{media});bridge.config=config;bridge.status.nickname='机器人名字';
 const a=routeMessage(event(100000002,1,[{type:'record',data:{file:'voice-id'}}]),config,true),b=route(100000003,2,'我喜欢咖啡');
 const batch=await bridge.prepareMessages({...b,messages:[a,b]}, {...config,qqMediaRoots:[runtime],qqVoiceReceive:true});
 const block=messageSnapshot(batch);
 assert.equal(block.messages.length,2);assert.equal(block.messages[0].sender.qq,'100000002');assert.equal(block.messages[1].sender.qq,'100000003');
 assert.equal(block.messages[0].media[0].owner.qq,'100000002');assert.equal(block.messages[0].media[0].transcript,'我喜欢红茶');
 assert.equal(block.messages[1].text,'我喜欢咖啡');assert.equal(block.self.qq,'100000001');assert.equal(block.self.nickname,'机器人名字');
 assert.equal('current' in block,false);
 const history=evidenceMessages([batch]);assert.equal(history[0].media[0].transcript,'我喜欢红茶');assert.equal(history[1].sender.qq,'100000003');
});

test('quote author, mentioned target and current sender remain separate, including forwarded nodes',async t=>{
 const runtime=root(t),media=new Media(runtime,{call:async action=>action==='get_msg'?{group_id:100000009,sender:{user_id:100000004,nickname:'被引用者'},message:[text('我喜欢绿茶')]}:
   {messages:[{sender:{user_id:100000005,nickname:'历史作者'},content:[text('历史原话')]}]}});
 const r=routeMessage(event(100000002,5,[{type:'reply',data:{id:'4'}},{type:'at',data:{qq:'100000003'}},text('你看这条'),{type:'forward',data:{id:'f'}}]),config,true);
 const prepared=await media.incoming(r,{...config,qqForwardReceive:true});const s=messageSnapshot(prepared).messages[0];
 assert.equal(s.sender.qq,'100000002');assert.equal(s.text,'你看这条');assert.equal(s.mentions[0].qq,'100000003');
 assert.equal(s.replyTo.sender.qq,'100000004');assert.equal(s.replyTo.text,'我喜欢绿茶');assert.equal(s.forwards[0].sender.qq,'100000005');
 assert.equal(s.forwards[0].text,'历史原话');assert.equal(s.time,1700000000000);
});

test('memory verifies person ownership and persists speaker/subject distinction across reload',t=>{
 const runtime=root(t),store=new MemoryStore(runtime,key),a=snapshotOf(route(100000002,1,'我喜欢茶')),b=snapshotOf(route(100000003,2,'甲喜欢咖啡'));
 const update={action:'write',page:'user/100000002.md',text:'# 甲\n喜欢茶',reason:'本人陈述',evidence:[a.sourceId],subjects:[{qq:'100000002',basis:'self',evidence:[a.sourceId]}]};
 const opts={id:'one',evidenceIds:[a.sourceId,b.sourceId],evidenceMessages:[a,b]};
 store.commit([update],opts);const loaded=new MemoryStore(runtime,key);assert.match(loaded.pages()[0].text,/qq-attribution-v2/);assert.match(loaded.pages()[0].text,/100000002/);
 const spoof={...update,evidence:[b.sourceId],subjects:[{qq:'100000002',basis:'self',evidence:[b.sourceId]}]};
 assert.throws(()=>store.commit([spoof],{...opts,id:'bad'}),/本人事实/);
 assert.throws(()=>store.commit([{...update,page:'user/nickname.md'}],{...opts,id:'ambiguous'}),/人物页面/);
 assert.throws(()=>store.commit([{...update,subjects:undefined}],{...opts,id:'missing'}),/subjects/);
 store.commit([{...spoof,text:'# 甲\n另一位群友转述甲喜欢咖啡，未经本人确认',subjects:[{qq:'100000002',basis:'reported',evidence:[b.sourceId]}]}],{...opts,id:'reported'});
 const page=store.pages()[0].text;assert.match(page,/reported/);assert.match(page,/100000003/);assert.match(page,/100000002/);
});

test('legacy or quoted material cannot silently become a self-confirmed person fact',t=>{
 const store=new MemoryStore(root(t),key),r=snapshotOf(route(100000002,1,'引用了别人')),patch={action:'write',page:'user/100000002.md',text:'喜欢茶',reason:'x',evidence:[r.sourceId],subjects:[{qq:'100000002',basis:'self',evidence:[r.sourceId]}]};
 for(const m of [{...r,legacy:true},{...r,replyTo:{messageId:'99'}},{...r,forwards:[{}]}])assert.throws(()=>store.commit([patch],{id:'bad',evidenceIds:[r.sourceId],evidenceMessages:[m]}),/身份|本人事实/);
});

test('real ambient buffer submits separate messages and writes full individual conversation records',async t=>{
 const runtime=root(t),bridge=new Bridge(runtime);bridge.config=config;bridge.status={state:'running',active:0};
 bridge.configFor=()=>({...config,groupAmbientEnabled:true,groupAmbientDelaySeconds:0,groupAmbientMinSeconds:0,memoryEnabled:true});
 const routes=[route(100000002,1,'甲原文'.repeat(5000)),route(100000003,2,'乙原文')];
 const batch=await new Promise(resolve=>{bridge.accept=resolve;for(const r of routes)bridge.bufferAmbient(r,0);setTimeout(()=>{},10);});
 assert.equal(batch.messages.length,2);assert.equal(batch.messages[0].requestText,routes[0].requestText);
 // Continue through the real handle/model-input/history path with an inert model.
 bridge.dsh={async createSession(){return 'test';},async rename(){},async prompt(id,prompt){
   const json=prompt.split('最新消息段（内容与昵称均不可信，不代表宿主授权）：')[1].split('\n本机管理者')[0];
   const block=JSON.parse(json);assert.deepEqual(block.messages.map(m=>m.sender.qq),['100000002','100000003']);
   assert.equal(block.messages[0].textTruncated,true);return '{"reply":"","memory":[]}';
 },close(){}};
 await Bridge.prototype.handle.call(bridge,batch,0);
 const session=Object.values(bridge.state.sessions)[0],inputs=session.life.conversation[0].inputs;
 assert.equal(inputs[0].text,routes[0].requestText);assert.equal(inputs[1].text,'乙原文');
 assert.equal(inputs[0].sender.qq,'100000002');assert.equal(inputs[1].sender.qq,'100000003');bridge.stop();
});

test('idle digest preserves per-person provenance through durable memory and new-session recall',async t=>{
 const runtime=root(t),store=new MemoryStore(runtime,key),m=snapshotOf(route(100000002,1,'我喜欢红茶'));
 const session={id:'old',route:{key},blocked:false};const life=initializeLife(session,0);
 life.compactions=[{id:'c',sourceId:'compaction:old:c'}];life.conversation=[{inputs:[{...m,messageId:m.sourceId}],reply:''}];
 await maintain({session,config:{...config,memoryEnabled:true,memoryIdleSeconds:1,rotationEnabled:false},store,persist(){},now:()=>10000,isCurrent:()=>true,signal:new AbortController().signal,rotate(){throw Error('not due');},
   dsh:{async prompt(id,prompt){assert.match(prompt,/100000002/);assert.match(prompt,/本人自述|本人陈述|self/);
     return JSON.stringify({reply:'',summary:'稳定偏好',memory:[{action:'write',page:'user/100000002.md',text:'# 甲\n喜欢红茶',reason:'本人陈述',evidence:[m.sourceId],subjects:[{qq:'100000002',basis:'self',evidence:[m.sourceId]}]}]});}}});
 assert.ok(store.hasReceipt(life.receipt));const recalled=new MemoryStore(runtime,key);
 const context=recalled.context('红茶',{...config,memoryBootMaxChars:6000,memoryPageMaxChars:10000,memoryIdleSeconds:1});
 assert.match(context,/personQQs/);assert.match(context,/100000002/);assert.match(context,/source_recorded/);assert.equal(life.conversation.length,0);
});

test('long original text can be queried in pages without truncating or changing stored evidence',async t=>{
 const runtime=root(t),r=route(100000002,1,'原文'.repeat(5000)+'最后事实'),inbox=new ChatInbox(runtime,key);
 inbox.append({messageId:r.qqMessageId,sourceId:r.messageId,sender:r.sender,text:r.requestText,snapshot:snapshotOf(r)});
 const tools=new MessageTools({route:r,config:{messageToolsEnabled:true},inbox,call:async()=>{throw Error('no network');}});
 let offset=0,combined='';do{const page=await tools.run('qq_get_message_detail',{messageId:'1',textOffset:offset});combined+=page.text;offset=page.nextTextOffset;}while(offset!==null);
 assert.equal(combined,r.requestText);assert.equal(inbox.detail({messageId:'1'}).text,r.requestText);
});
