import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { DshClient } from '../lib/dsh.mjs';
import { defaults } from '../lib/config.mjs';

async function fixture(t,handler){
  let peer,stream,seq=0;const calls=[];
  const server=http.createServer(async(req,res)=>{
    if(req.url.startsWith('/?token=')){res.writeHead(302,{'Set-Cookie':'dsh-auth-mock=ok','Location':'/'});res.end();return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));calls.push(body);
    const respond=(value={accepted:true})=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({type:'server-response',rpcId:body.rpcId,result:{ok:true,value}}));};
    await handler(body,respond,emit);
  });
  function emit(type,data){peer.send(JSON.stringify({type:'item',streamId:stream,value:{type:'event',event:{type,seq:seq++,time:Date.now(),data}}}));}
  const ws=new WebSocketServer({server,path:'/api/remote.mux'});
  ws.on('connection',socket=>{peer=socket;socket.on('message',bytes=>{const request=JSON.parse(bytes);stream=request.streamId;socket.send(JSON.stringify({type:'item',streamId:stream,value:{type:'snapshot'}}));});});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const client=new DshClient({...defaults,dshToken:'test',dshUrl:'http://127.0.0.1:'+server.address().port});
  t.after(async()=>{client.close();for(const socket of ws.clients)socket.terminate();ws.close();await new Promise(resolve=>server.close(resolve));});
  return {client,calls,emit};
}
const user=(body)=>({source:{rpcId:body.rpcId},content:body.payload.args.request.content});
const assistant=(turn,text)=>({turn,message:{content:[{type:'text',text}]}});

for(const race of [false,true])test(race?'native steer racing turn/end waits for its own next turn':'native steer stays in current turn and suppresses the superseded answer',async t=>{
  let first,resolveInitial;const initial=new Promise(resolve=>resolveInitial=resolve);
  const {client,calls}=await fixture(t,async(body,respond,emit)=>{
    const request=body.payload.args.request;
    if(request.mode==='queue'){
      first=body;respond();emit('turn/start',{turn:1});emit('user/message',user(body));emit('assistant/message',assistant(1,'旧回答'));resolveInitial();return;
    }
    assert.equal(request.mode,'steer');
    if(race){emit('turn/end',{turn:1,reason:{kind:'completed'}});emit('turn/start',{turn:2});}
    emit('user/message',user(body));respond();emit('assistant/message',assistant(race?2:1,'根据补充信息的新回答'));emit('turn/end',{turn:race?2:1,reason:{kind:'completed'}});
  });
  const answer=client.prompt('session','原始问题');await initial;
  assert.equal(await client.steer('session','补充信息'),true);
  assert.equal(await answer,'根据补充信息的新回答');assert.equal(calls.length,2);assert.ok(first.rpcId);
  assert.equal(await client.steer('session','结束后的补充'),false);
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
