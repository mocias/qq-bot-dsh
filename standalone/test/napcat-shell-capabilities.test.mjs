import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {Media} from '../lib/media.mjs';
import {verifyQQ} from '../lib/onebot.mjs';
import {probePacketBackend,probePacketQQ} from '../lib/packet-status.mjs';
import {defaults,validate} from '../lib/config.mjs';
import {resolveChatConfig} from '../lib/chat-policy.mjs';
import {Bridge} from '../lib/bridge.mjs';
import {MessageTools} from '../lib/message-tools.mjs';
import {SUPPORTED_QQ_FACE_IDS} from '../lib/qq-face.mjs';
import {DEFINITIONS} from '../../native-dsh-plugin/lib/schema.mjs';
import {faceToEmoji} from '../../dsh-onebot-source/lib/cq.js';

const privateRoute={key:'123456/private/234567',id:'234567',group:false,messageId:'fixture-message',text:'fixture'};
function temp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-napcat-fixture-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function oneBotSocket({login={user_id:'123456',nickname:'fixture'},status={online:true,good:true}}={}){
 const socket=new EventEmitter();socket.send=raw=>{
  const request=JSON.parse(raw),data=request.action==='get_login_info'?login:request.action==='get_status'?status:null;
  queueMicrotask(()=>socket.emit('message',Buffer.from(JSON.stringify({echo:request.echo,status:'ok',retcode:0,data}))));
 };return socket;
}

test('QQ system face uses fixed official QSid catalog and one current-chat send segment',async t=>{
 const root=temp(t),details=[];
 assert.equal(SUPPORTED_QQ_FACE_IDS.length,329);assert.ok(SUPPORTED_QQ_FACE_IDS.includes(14));assert.ok(!SUPPORTED_QQ_FACE_IDS.includes(138));
 const definition=DEFINITIONS.find(x=>x.name==='qq_send_message');
 assert.equal(definition.parameters.faceId.type,'number');assert.equal(definition.parameters.faceId.enum,undefined);
 assert.equal(definition.parameters.messages.required,undefined);
 const inbox={read:()=>({readThrough:0,messages:[]}),detail:query=>{details.push(query);return {messageId:String(query.messageId)};},list:()=>({readThroughSeq:0})};
 const tools=new MessageTools({route:privateRoute,config:{messageToolsEnabled:true,mentionSend:false,stickerSend:true},inbox,call:async()=>({}),continuous:false});
 assert.deepEqual(await tools.run('qq_send_message',{faceId:14}),{queued:true,count:1});
 assert.deepEqual(tools.outputs[0],{reply:'',memory:[],qq:{faceId:14}});
 const media=new Media(root,{call:async(action,params)=>{assert.equal(action,'get_msg');return {message_id:params.message_id,message_type:'private',user_id:'234567',sender:{user_id:'234567'},message:[{type:'face',data:{id:'14'}}]};},voice:{}});
 const plan=await media.outgoing({reply:'',qq:tools.outputs[0].qq},privateRoute,{workspace:root},{...defaults,stickerSend:true,qqImageSend:false});
 assert.equal(plan.action,'send_private_msg');assert.equal(plan.params.user_id,'234567');
 assert.deepEqual(plan.params.message,[{type:'face',data:{id:'14'}}]);
 await assert.rejects(tools.run('qq_send_message',{faceId:138}),/ID 无效/);
 await assert.rejects(tools.run('qq_send_message',{faceId:14.5}),/ID 无效/);
 await assert.rejects(tools.run('qq_send_message',{faceId:'14'}),/ID 无效/);
 await assert.rejects(tools.run('qq_send_message',{faceId:14,messages:['a','b']}),/只能附加到一条消息/);
 await assert.rejects(tools.run('qq_send_message',{faceId:14,user_id:'999999'}),/不能指定其他聊天/);
 await assert.rejects(media.outgoing({reply:'',qq:{faceId:138}},privateRoute,{workspace:root},defaults),/ID 无效/);
 assert.deepEqual(details,[]);
});

test('quoted face send validates the current peer and keeps quote, text and face in one bubble',async t=>{
 const root=temp(t),references=[];
 const inbox={read:()=>({readThrough:0,messages:[]}),detail:query=>({messageId:String(query.messageId)}),list:()=>({readThroughSeq:0})};
 const tools=new MessageTools({route:privateRoute,config:{messageToolsEnabled:true,stickerSend:true},inbox,call:async()=>({}),continuous:false});
 await tools.run('qq_send_message',{messages:'收到',replyToMessageId:'77',faceId:14});
 const media=new Media(root,{call:async(action,params)=>{references.push([action,params]);return {message_id:'77',message_type:'private',user_id:'234567',sender:{user_id:'234567'},message:[{type:'face',data:{id:'14'}}]};},voice:{}});
 const plan=await media.outgoing({reply:tools.outputs[0].reply,qq:tools.outputs[0].qq},privateRoute,{workspace:root},{...defaults,quoteMode:'auto',stickerSend:true,qqImageSend:false});
 assert.deepEqual(references,[['get_msg',{message_id:'77'}]]);
 assert.deepEqual(plan.params.message.map(part=>part.type),['reply','text','face']);
 assert.deepEqual(plan.params.message.at(-1),{type:'face',data:{id:'14'}});
});

test('unknown QQ face delivery is reported once and never retried',async t=>{
 const root=temp(t),route=privateRoute,media=new Media(root,{call:async()=>{},voice:{}});
 const plan=await media.outgoing({reply:'',qq:{faceId:14}},route,{workspace:root},{...defaults,stickerSend:true,qqImageSend:false});
 const bridge=new Bridge(root,{media});bridge.config={...defaults,qqBackend:'external',botQQ:'123456',privateUsers:['234567']};
 bridge.status.state='running';bridge.status.account='123456';bridge.enabled=()=>true;
 let sends=0,receipt;
 bridge.socket={send(raw){sends++;const request=JSON.parse(raw);queueMicrotask(()=>{bridge.generation++;bridge.pending.get(request.echo)?.(null);bridge.pending.delete(request.echo);});}};
 await assert.rejects(bridge.sendPlan(route,plan,{onDelivery:value=>{receipt=value;}}),/不会自动重试/);
 assert.equal(sends,1);assert.equal(receipt.state,'unknown');assert.equal(bridge.state.deliveries.at(-1).state,'unknown');
});

test('QQ system face obeys per-chat stickerSend policy in native tools and payload preparation',async t=>{
 const root=temp(t),inbox={read:()=>({readThrough:0,messages:[]}),detail:()=>({messageId:'fixture'}),list:()=>({readThroughSeq:0})};
 const privateKey=privateRoute.key,otherKey='123456/private/345678';
 const config=validate({botQQ:'123456',privateUsers:['234567','345678'],chatPolicy:{private:{stickerSend:false,imageSend:false},overrides:{[privateKey]:{stickerSend:true}}}});
 const enabled=resolveChatConfig(config,privateKey),disabled=resolveChatConfig(config,otherKey);
 assert.equal(enabled.stickerSend,true);assert.equal(disabled.stickerSend,false);assert.equal(enabled.qqImageSend,false);
 const tools=new MessageTools({route:privateRoute,config:enabled,inbox,call:async()=>({}),continuous:false});
 assert.deepEqual(await tools.run('qq_send_message',{faceId:14}),{queued:true,count:1});
 const media=new Media(root,{call:async()=>{},voice:{}});
 const plan=await media.outgoing({reply:'',qq:{faceId:14}},privateRoute,{workspace:root},enabled);
 assert.deepEqual(plan.params.message,[{type:'face',data:{id:'14'}}]);
 const foreignRoute={...privateRoute,key:otherKey,id:'345678'};
 const blockedTools=new MessageTools({route:foreignRoute,config:disabled,inbox,call:async()=>({}),continuous:false});
 await assert.rejects(blockedTools.run('qq_send_message',{faceId:14}),/未开启表情发送/);
 await assert.rejects(media.outgoing({reply:'',qq:{faceId:14}},foreignRoute,{workspace:root},disabled),/未开启表情发送/);
});

test('login requires a valid configured account and online state; good is only a veto',async()=>{
 const config={botQQ:'123456'};
 assert.equal((await verifyQQ(oneBotSocket(),config)).account,'123456');
 assert.equal((await verifyQQ(oneBotSocket({status:{online:true}}),config)).online,true);
 await assert.rejects(verifyQQ(oneBotSocket({status:{online:true,good:false}}),config),/离线/);
 await assert.rejects(verifyQQ(oneBotSocket({login:{user_id:'999999'}}),config),/不匹配/);
 await assert.rejects(verifyQQ(oneBotSocket({status:{online:false,good:true}}),config),/离线/);
});

test('PacketBackend read-only probe distinguishes ready, unavailable, unsupported, timeout and unknown',async()=>{
 const observedAt=Date.parse('2026-10-22T01:02:03.000Z'),calls=[];
 const ready=await probePacketBackend(async(action,params)=>{calls.push([action,params]);return null;},{now:()=>observedAt});
 assert.deepEqual(calls,[['nc_get_packet_status',{}]]);assert.equal(ready.state,'ready');assert.equal(ready.probe,'nc_get_packet_status');
 assert.equal(ready.observedAt,new Date(observedAt).toISOString());assert.match(ready.message,/实际投递仍未验证/);
 const unavailable=await probePacketBackend(async()=>{throw Object.assign(Error('failed'),{code:'ONEBOT_REJECTED',retcode:1400,responseMessage:'packetBackend不可用'});},{now:()=>observedAt});
 assert.equal(unavailable.state,'unavailable');
 const unsupported=await probePacketBackend(async()=>{throw Object.assign(Error('rejected'),{code:'ONEBOT_REJECTED',retcode:1400,responseMessage:'API action not found'});},{now:()=>observedAt});
 assert.equal(unsupported.state,'unsupported');
 const timeout=await probePacketBackend(async()=>{throw Object.assign(Error('timeout'),{code:'ONEBOT_TIMEOUT'});},{now:()=>observedAt});assert.equal(timeout.state,'timeout');
 const unknown=await probePacketBackend(async()=>({status:'ok'}),{now:()=>observedAt});assert.equal(unknown.state,'unknown');
 await assert.rejects(probePacketBackend(null),/调用函数/);
});

test('PacketBackend status adapter verifies account and uses one read-only websocket fixture',async()=>{
 const socket=oneBotSocket({status:{online:true,good:true}});socket.close=()=>{};
 const result=await probePacketQQ({qqUrl:'ws://127.0.0.1:3001',botQQ:'123456'},{
  socketFactory:()=>{queueMicrotask(()=>socket.emit('open'));return socket;},
  now:()=>Date.parse('2026-10-22T01:02:03.000Z'),
 });
 assert.equal(result.state,'ready');assert.equal(result.probe,'nc_get_packet_status');
 assert.equal(result.observedAt,'2026-10-22T01:02:03.000Z');
});

test('Shell poke is gated by a fresh PacketBackend check while base OneBot remains available',async t=>{
 const root=temp(t),actions=[],b=new Bridge(root);b.config={...defaults,botQQ:'123456',groups:['345678'],qqBackend:'shell',pokeSend:true};
 b.status.state='running';b.status.account='123456';b.enabled=()=>true;
 b.socket={send(raw){
  const request=JSON.parse(raw);actions.push(request.action);
  const failed=request.action==='nc_get_packet_status';
  queueMicrotask(()=>{b.pending.get(request.echo)?.({status:failed?'failed':'ok',retcode:failed?1400:0,data:failed?null:{message_id:'fixture-1'}});b.pending.delete(request.echo);});
 }};
 const group={...privateRoute,key:'123456/group/345678',id:'345678',group:true};
 await assert.rejects(b.sendPlan(group,{action:'group_poke',params:{group_id:'345678',user_id:'234567'}}),/PacketBackend 未就绪/);
 assert.deepEqual(actions,['nc_get_packet_status']);
 actions.length=0;b.config={...b.config,qqBackend:'external'};
 await b.sendPlan(group,{action:'group_poke',params:{group_id:'345678',user_id:'234567'}});
 assert.deepEqual(actions,['group_poke']);
});

test('private and group text, quote and mention plans keep destinations scoped',async t=>{
 const root=temp(t),media=new Media(root,{call:async(action,params)=>{
  if(action==='get_msg')return {message_id:params.message_id,message_type:'private',user_id:'234567',sender:{user_id:'234567',nickname:'fixture'},message:[{type:'text',data:{text:'quoted'}}]};
  if(action==='get_group_member_info')return {group_id:'345678',user_id:'456789'};
  throw Error('unexpected action '+action);
 },voice:{}});
 const privatePlan=await media.outgoing({reply:'hello',qq:{replyTo:'77'}},privateRoute,{workspace:root},{...defaults,quoteMode:'auto'});
 assert.equal(privatePlan.action,'send_private_msg');assert.equal(privatePlan.params.user_id,'234567');
 assert.equal(privatePlan.params.message[0].type,'reply');
 const group={...privateRoute,key:'123456/group/345678',id:'345678',group:true};
 const groupPlan=await media.outgoing({reply:'hello',qq:{at:'456789'}},group,{workspace:root},{...defaults,mentionSend:true});
 assert.equal(groupPlan.action,'send_group_msg');assert.equal(groupPlan.params.group_id,'345678');
 assert.deepEqual(groupPlan.params.message.slice(0,2).map(x=>x.type),['at','text']);
 await assert.rejects(media.outgoing({reply:'hello',qq:{at:'999999'}},group,{workspace:root},{...defaults,mentionSend:true}),/无法确认/);
});

test('animated image bytes retain GIF media type and face segments retain their source kind',async t=>{
 const root=temp(t),gif=Buffer.from('GIF89a'+String.fromCharCode(1,0,1,0,0,0,0,0,0,0,0,0));
 const media=new Media(root,{call:async()=>({base64:gif.toString('base64')}),voice:{}});
 const result=await media.incoming({...privateRoute,segments:[
  {type:'image',data:{file:'fixture-gif',sub_type:1}},
  {type:'face',data:{id:'14'}},
 ]},{...defaults,qqImages:true});
 assert.equal(result.images[0].mediaType,'image/gif');assert.match(result.images[0].name,/\.gif$/);
 assert.ok(result.text.includes(faceToEmoji('14')));
 assert.deepEqual(result.snapshot.parts.map(x=>x.kind),['image','face']);
 assert.deepEqual(result.snapshot.media.map(x=>x.kind),['image','face']);
});

test('voice plan keeps a record bubble and an unknown post-dispatch result is never replayed',async t=>{
 const root=temp(t),workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
 const audio=Buffer.alloc(364);audio.write('RIFF');audio.writeUInt32LE(356,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(16000,24);audio.writeUInt32LE(32000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(320,40);
 const media=new Media(root,{call:async()=>{},voice:{synthesize:async()=>({id:'fixture'}),audio:()=>audio}});
 const plan=await media.outgoing({reply:'',qq:{voice:'你好'}},privateRoute,{workspace},{...defaults,qqVoiceSend:true,voiceReplyMode:'voice',voiceQuietMode:'never'});
 assert.deepEqual(plan.params.message.map(x=>x.type),['record']);
 const bridge=new Bridge(root,{media});bridge.config={...defaults,qqBackend:'external',botQQ:'123456',privateUsers:['234567']};
 bridge.status.state='running';bridge.enabled=()=>true;let sends=0;
 bridge.socket={send(raw){sends++;const request=JSON.parse(raw);queueMicrotask(()=>{bridge.generation++;bridge.pending.get(request.echo)?.(null);bridge.pending.delete(request.echo);});}};
 await assert.rejects(bridge.sendPlan(privateRoute,plan),/不会自动重试/);
 assert.equal(sends,1);assert.equal(bridge.state.deliveries.at(-1).state,'unknown');
});

test('file and video receive use scoped IDs, bounded bytes and isolated local archives',async t=>{
 const root=temp(t),calls=[];const payload=Buffer.from('fixture attachment');
 const media=new Media(root,{call:async(action,params)=>{calls.push({action,params});return {file_name:'fixture.bin',base64:payload.toString('base64')};},voice:{}});
 const result=await media.incoming({...privateRoute,segments:[
  {type:'file',data:{file_id:'private-file-id',name:'memo.txt'}},
  {type:'video',data:{file_id:'private-video-id',name:'clip.mp4'}},
 ]},{...defaults,qqFiles:true});
 assert.equal(calls.length,2);assert.ok(calls.every(x=>x.action==='get_file'));
 assert.ok(calls.every(x=>x.params.file_id===x.params.file));
 assert.match(result.text,/已接收文件/);assert.match(result.text,/已接收视频/);
 const paths=[...result.text.matchAll(/当前聊天路径：([^\]]+)/g)].map(x=>x[1]);
 assert.equal(paths.length,2);assert.notEqual(paths[0],paths[1]);
 assert.ok(paths.every(file=>fs.readFileSync(file).equals(payload)));
 const chatDir=path.join(root,'media',createHash('sha256').update(privateRoute.key).digest('hex'));
 assert.ok(paths.every(file=>path.dirname(file)===chatDir));
});

test('outgoing file, video and merged forward preserve OneBot action boundaries',async t=>{
 const root=temp(t),workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
 fs.writeFileSync(path.join(workspace,'note.txt'),'file bytes');fs.writeFileSync(path.join(workspace,'clip.mp4'),'video bytes');
 const media=new Media(root,{call:async()=>{},voice:{}}),route=privateRoute,session={workspace};
 const config={...defaults,qqFiles:true,qqForward:true};
 const file=await media.outgoing({reply:'',qq:{file:'note.txt'}},route,session,config);
 assert.equal(file.action,'upload_private_file');assert.equal(file.params.user_id,route.id);assert.match(file.params.file,/^base64:\/\//);
 const video=await media.outgoing({reply:'',qq:{video:'clip.mp4'}},route,session,config);
 assert.equal(video.action,'send_private_msg');assert.equal(video.params.user_id,route.id);assert.equal(video.params.message[0].type,'video');
 const forward=await media.outgoing({reply:'',qq:{forward:[{name:'fixture',content:'one node'}]}},route,session,config);
 assert.equal(forward.action,'send_private_forward_msg');assert.equal(forward.params.user_id,route.id);assert.equal(forward.params.messages[0].type,'node');
 const group={...route,key:'123456/group/345678',id:'345678',group:true};
 const groupFile=await media.outgoing({reply:'',qq:{file:'note.txt'}},group,session,config);
 assert.equal(groupFile.action,'upload_group_file');assert.equal(groupFile.params.group_id,'345678');
 const groupForward=await media.outgoing({reply:'',qq:{forward:[{content:'node'}]}},group,session,config);
 assert.equal(groupForward.action,'send_forward_msg');assert.equal(groupForward.params.group_id,'345678');
});
