import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { DshClient } from '../lib/dsh.mjs';
import { defaults } from '../lib/config.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Bridge} from '../lib/bridge.mjs';
import {initializeLife} from '../lib/lifecycle.mjs';

async function fixture(t,handler){
  let peer,stream,seq=0;const calls=[];
  const server=http.createServer(async(req,res)=>{
    if(req.url.startsWith('/?token=')){res.writeHead(302,{'Set-Cookie':'dsh-auth-mock=ok','Location':'/'});res.end();return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));calls.push(body);
    const respond=(value={accepted:true})=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({type:'server-response',rpcId:body.rpcId,result:{ok:true,value}}));};
    await handler(body,respond,emit);
  });
  function emit(type,data,eventSeq=seq++){peer.send(JSON.stringify({type:'item',streamId:stream,value:{type:'event',event:{type,seq:eventSeq,time:Date.now(),data}}}));}
  const ws=new WebSocketServer({server,path:'/api/remote.mux'});
  ws.on('connection',socket=>{peer=socket;socket.on('message',bytes=>{const request=JSON.parse(bytes);stream=request.streamId;socket.send(JSON.stringify({type:'item',streamId:stream,value:{type:'snapshot'}}));});});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const client=new DshClient({...defaults,dshToken:'test',dshUrl:'http://127.0.0.1:'+server.address().port});
  t.after(async()=>{client.close();for(const socket of ws.clients)socket.terminate();ws.close();await new Promise(resolve=>server.close(resolve));});
  return {client,calls,emit};
}
const user=(body)=>({source:{rpcId:body.rpcId},content:body.payload.args.request.content});
const assistant=(turn,text)=>({turn,message:{content:[{type:'text',text}]}});

for(const group of [false,true])test(`QQ ${group?'group':'private'} receives every complete assistant reply around native DSH tool calls in order`,async t=>{
  const {client}=await fixture(t,async(body,respond,emit)=>{
    respond();emit('turn/start',{turn:1});emit('user/message',user(body));
    emit('assistant/message',assistant(1,'第一段正式回答'));
    emit('tool/result',{turn:1,result:'INTERNAL_TOOL_RESULT'});
    emit('assistant/message',assistant(1,'第二段正式回答'));
    emit('tool/result',{turn:1,result:'INTERNAL_TOOL_RESULT_2'});
    emit('assistant/message',assistant(1,'最后一段正式回答'));
    emit('turn/end',{turn:1,reason:{kind:'completed'}});
  });
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-multiple-replies-'));
  t.after(()=>fs.rmSync(runtime,{recursive:true,force:true}));
  let clock=Date.now();const bridge=new Bridge(runtime,{now:()=>clock,wait:async ms=>{clock+=ms;}}),route={key:`100000001/${group?'group':'private'}/100000002`,id:'100000002',group,text:'你好',messageId:'m1'};
  bridge.config={...defaults,privatePreset:'test',groupPreset:'test',qqVoiceSend:false,groupMinReplyGapSeconds:60,groupMaxRepliesPerHour:4};bridge.dsh=client;bridge.status.state='running';
  const session={id:'session',route,workspace:runtime,preset:'test',blocked:false};initializeLife(session);bridge.state.sessions[bridge.scope(route)]=session;
  const sent=[];
  bridge.socket={send(bytes){const message=JSON.parse(bytes);sent.push(message.params.message.map(x=>x.data.text??'').join(''));
    queueMicrotask(()=>bridge.pending.get(message.echo)?.({status:'ok',retcode:0,data:{message_id:sent.length}}));}};
  await bridge.handle(route,bridge.generation);
  assert.deepEqual(sent,['第一段正式回答','第二段正式回答','最后一段正式回答']);
  assert.equal(bridge.state.deliveries.length,3);
});

for(const collectMessages of [false,true])for(const race of [false,true])test(`${collectMessages?'multi-reply':'single-reply'} native steer ${race?'racing turn/end waits for its next turn':'suppresses only superseded answers'}`,async t=>{
  let first,resolveInitial;const initial=new Promise(resolve=>resolveInitial=resolve);
  const {client,calls}=await fixture(t,async(body,respond,emit)=>{
    const request=body.payload.args.request;
    if(request.mode==='queue'){
      first=body;respond();emit('turn/start',{turn:1});emit('user/message',user(body));emit('assistant/message',assistant(1,'旧回答'));resolveInitial();return;
    }
    assert.equal(request.mode,'steer');
    if(race){emit('turn/end',{turn:1,reason:{kind:'completed'}});emit('turn/start',{turn:2});}
    emit('user/message',user(body));respond();emit('assistant/message',assistant(race?2:1,'补充后的第一段'));emit('assistant/message',assistant(race?2:1,'根据补充信息的新回答'));emit('turn/end',{turn:race?2:1,reason:{kind:'completed'}});
  });
  const answer=client.prompt('session','原始问题',{collectMessages});await initial;
  assert.equal(await client.steer('session','补充信息'),true);
  assert.deepEqual(await answer,collectMessages?['补充后的第一段','根据补充信息的新回答']:'根据补充信息的新回答');assert.equal(calls.length,2);assert.ok(first.rpcId);
  assert.equal(await client.steer('session','结束后的补充'),false);
});
test('complete messages deduplicate by identity, retain distinct repeated text and ignore chunks/tool/reasoning content',async t=>{
  const {client}=await fixture(t,async(body,respond,emit)=>{
    respond();emit('turn/start',{turn:1});emit('user/message',user(body));
    emit('assistant/chunk',{turn:1,text:'STREAM_SECRET'});
    const message={id:'answer-1',content:[{type:'text',text:'第一段'},{type:'reasoning',text:'REASONING_SECRET'},{type:'tool-call',args:{secret:'TOOL_SECRET'}}]};
    emit('assistant/message',{turn:1,message});
    emit('assistant/message',{turn:1,message:{...message,content:[{type:'text',text:'第一段完整版本'}]}});
    emit('tool/result',{turn:1,result:'TOOL_RESULT_SECRET'});
    emit('assistant/message',{turn:1,message:{id:'answer-2',content:[{type:'text',text:'第二段'}]}});
    emit('assistant/message',{turn:1,message:{id:'answer-3',content:[{type:'text',text:'第二段'}]}});
    emit('turn/end',{turn:1,reason:{kind:'completed'}});
  });
  assert.deepEqual(await client.prompt('session','hello',{collectMessages:true}),['第一段完整版本','第二段','第二段']);
});
test('event replays do not duplicate replies or treat a replayed input as a new steer',async t=>{
  const {client}=await fixture(t,async(body,respond,emit)=>{
    respond();emit('turn/start',{turn:1},0);emit('user/message',user(body),1);
    emit('assistant/message',assistant(1,'第一段'),2);
    emit('turn/start',{turn:1},0);emit('user/message',user(body),1);
    emit('assistant/message',assistant(1,'第一段'),2);
    emit('assistant/message',assistant(1,'第二段'),3);emit('turn/end',{turn:1,reason:{kind:'completed'}},4);
  });
  assert.deepEqual(await client.prompt('session','hello',{collectMessages:true}),['第一段','第二段']);
});
test('structured error reason rejects rather than forwarding partial assistant text',async t=>{
  const {client}=await fixture(t,async(body,respond,emit)=>{respond();emit('turn/start',{turn:1});emit('user/message',user(body));emit('assistant/message',assistant(1,'部分内容'));emit('turn/end',{turn:1,reason:{kind:'error',error:{message:'failed'}}});});
  await assert.rejects(client.prompt('session','hello'),/未正常完成/);
});
test('cancelling maintenance waits for acknowledged turn end, with no user prompt submitted',async t=>{
  let start;const started=new Promise(resolve=>start=resolve);let cancels=0;
  const {client,calls}=await fixture(t,async(body,respond,emit)=>{
    if(body.method==='session/cancel'){cancels++;respond();emit('turn/end',{turn:1,reason:{kind:'aborted'}});return;}
    respond();emit('turn/start',{turn:1});emit('user/message',user(body));start();
  });
  const controller=new AbortController();const task=client.prompt('session','内部整理',{signal:controller.signal});await started;controller.abort();
  await assert.rejects(task,error=>error.cancelled===true&&error.acknowledged===true);
  assert.ok(cancels>=1);assert.equal(calls.filter(x=>x.method==='session/prompt').length,1);
});
