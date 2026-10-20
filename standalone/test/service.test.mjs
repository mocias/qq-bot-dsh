import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { defaults, validate, publicConfig } from '../lib/config.mjs';
import { routeMessage, Bridge } from '../lib/bridge.mjs';
import { DshClient } from '../lib/dsh.mjs';
import { LocalVoice } from '../lib/voice.mjs';
import { createApp } from '../server.mjs';

const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'qq-rsi-test-'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await wait(20);}throw Error('Condition timed out');}
const event=(extra={})=>({post_type:'message',message_type:'private',self_id:123456,user_id:234567,message_id:1,message:[{type:'text',data:{text:'你好'}}],...extra});

test('config preserves and redacts credentials, validates destinations and explicit reset',()=>{
  const config=validate({dshToken:'secret',qqToken:'qq-secret',privateUsers:['234567']});
  assert.equal(validate({dshToken:''},config).dshToken,'secret');
  assert.equal(validate({clearDshToken:true},config).dshToken,'');
  assert.equal(JSON.stringify(publicConfig(config)).includes('secret'),false);
  for(const dshUrl of ['https://example.com','http://127.0.0.1/?token=secret','http://name:pass@localhost','file:///etc/passwd'])assert.throws(()=>validate({dshUrl}));
  assert.throws(()=>validate({groups:['../private']}));
});
test('routing excludes self, non-allowlisted users, unmentioned groups, disabled audio; parses CQ strings',()=>{
  const config={...defaults,privateUsers:['234567'],groups:['345678']};
  assert.equal(routeMessage(event(),config).key,'123456/private/234567');
  assert.equal(routeMessage(event({user_id:123456}),config),null);
  assert.equal(routeMessage(event({user_id:987654}),config),null);
  assert.equal(routeMessage(event({message:'[CQ:at,qq=123456] hello'}),config).text,'hello');
  assert.equal(routeMessage(event({message:[{type:'record',data:{file:'x'}}]}),config).hasMedia,true);
  assert.equal(routeMessage(event({message:[{type:'record',data:{file:'x'}}]}),{...config,qqVoiceReceive:false}),null);
  assert.equal(routeMessage(event({message_type:'group',group_id:345678}),config),null);
  assert.equal(routeMessage(event({message_type:'group',group_id:345678,message:[{type:'at',data:{qq:'123456'}},{type:'text',data:{text:'hi'}}]}),config).key,'123456/group/345678');
});
test('HTTP panel authenticates, rejects cross-site writes and retains saved settings without exposing keys',async t=>{
  const runtime=temp();const app=createApp({runtime,voice:{status:()=>({asrReady:true}),audio:()=>Buffer.alloc(44)}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{app.bridge.stop();await new Promise(resolve=>app.server.close(resolve));fs.rmSync(runtime,{recursive:true,force:true});});
  const origin=new URL(app.loginUrl()).origin;
  assert.equal((await fetch(origin+'/api/status')).status,401);
  const welcome=await fetch(origin+'/');
  assert.equal(welcome.status,401);assert.match(welcome.headers.get('content-type'),/text\/html/);
  const welcomeText=await welcome.text();assert.match(welcomeText,/打开面板\.cmd/);assert.ok(!welcomeText.includes(app.token));
  assert.equal((await fetch(origin+'/welcome.css')).status,200);
  assert.equal((await fetch(origin+'/login?token=expired')).status,401);
  assert.equal((await fetch(origin+'/api/status',{headers:{cookie:'qqrsi=expired'}})).status,401);
  const login=await fetch(app.loginUrl(),{redirect:'manual'});assert.equal(login.status,303);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const headers={cookie,'Content-Type':'application/json','X-QQ-RSI':'panel',Origin:origin};
  assert.equal((await fetch(origin+'/api/config',{method:'POST',headers:{...headers,Origin:'https://evil.test'},body:'{}'})).status,403);
  assert.equal((await fetch(origin+'/api/config',{method:'POST',headers:{...headers,'X-QQ-RSI':''},body:'{}'})).status,403);
  const saved=await fetch(origin+'/api/config',{method:'POST',headers,body:JSON.stringify({dshToken:'hidden-secret',model:'small'})});assert.equal(saved.status,200);
  const status=await (await fetch(origin+'/api/status',{headers:{cookie}})).json();
  assert.equal(status.config.model,'small');assert.equal(status.config.dshTokenConfigured,true);assert.equal(JSON.stringify(status).includes('hidden-secret'),false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runtime,'config.private.json'))).dshToken,'hidden-secret');
  assert.equal((await fetch(origin+'/',{headers:{cookie}})).headers.get('content-type'),'text/html; charset=utf-8');
});
test('voice rejects malformed/oversized uploads and overlapping jobs before starting external tools',async()=>{
  const runtime=temp();try{const voice=new LocalVoice(runtime,runtime);
    await assert.rejects(voice.transcribe(Buffer.from('bad'),defaults),/WAV/);
    await assert.rejects(voice.synthesize('',defaults),/1–300/);
    voice.busy=true;await assert.rejects(voice.synthesize('hello',defaults),/正在运行/);
    assert.throws(()=>voice.audio('../../secret'));
  }finally{fs.rmSync(runtime,{recursive:true,force:true});}
});
test('panels on separate ports do not replace each others browser cookie',async t=>{
 const runtime=temp(),voice={status:()=>({})},apps=[createApp({runtime:path.join(runtime,'a'),voice}),createApp({runtime:path.join(runtime,'b'),voice})];
 t.after(async()=>{for(const app of apps){app.bridge.stop();await new Promise(r=>app.server.close(r));}fs.rmSync(runtime,{recursive:true,force:true});});
 for(const app of apps){app.server.listen(0,'127.0.0.1');await once(app.server,'listening');}
 const cookies=[];
 for(const app of apps){const login=await fetch(app.loginUrl(),{redirect:'manual'});cookies.push(login.headers.get('set-cookie').split(';')[0]);}
 assert.notEqual(cookies[0].split('=')[0],cookies[1].split('=')[0]);
 for(const app of apps)assert.equal((await fetch(new URL(app.loginUrl()).origin+'/api/status',{headers:{cookie:cookies.join('; ')}})).status,200);
 assert.equal((await fetch(new URL(apps[0].loginUrl()).origin+'/api/status',{headers:{cookie:cookies[1]}})).status,401);
});
async function mockDsh(t){
  let nextSession=0;const followers=new Map(), requests=[];
  const server=http.createServer(async(req,res)=>{
    if(req.url.startsWith('/?token=')){res.writeHead(302,{'Set-Cookie':'dsh-auth-test=mock; HttpOnly','Location':'/'});res.end();return;}
    assert.equal(req.headers.cookie,'dsh-auth-test=mock');
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks));requests.push(body);
    assert.equal(body.type,'client-request');assert.equal(req.url,'/api/'+body.method);
    const request=body.payload.args.request;let value={};
    if(body.method==='agentPresets/list')value={presets:[{id:'safe-chat'},{id:'private'},{id:'safe-group'}]};
    else if(body.method==='workspace/create')value={workspace:{workspaceId:request.path}};
    else if(body.method==='session/create')value={sessionId:'session-'+(++nextSession)};
    else if(body.method==='session/rename'){assert.match(request.title,/^\d{4}-\d{2}-\d{2}-(私聊|群聊)-\d+-\d+$/);}
    else if(body.method==='session/prompt'){
      assert.equal(request.mode,'queue');assert.ok(request.requestId);assert.equal(request.content[0].type,'text');
      const follower=followers.get(request.sessionId);assert.ok(follower,'follow snapshot must precede prompt');
      setTimeout(()=>{
        for(const event of [{type:'turn/start',data:{turn:1}},{type:'user/message',data:{source:{rpcId:body.rpcId},content:request.content}},{type:'assistant/chunk',data:{turn:1,text:'duplicate'}},{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'收到：'+request.content[0].text.split('\n').slice(1).join('\n')}]}}},{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}])follower.socket.send(JSON.stringify({type:'item',streamId:follower.streamId,value:{type:'event',event}}));
      },20);
    }else assert.fail('Unexpected method '+body.method);
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({type:'server-response',rpcId:body.rpcId,result:{ok:true,value}}));
  });
  const ws=new WebSocketServer({server,path:'/api/remote.mux'});
  ws.on('connection',socket=>socket.on('message',bytes=>{const frame=JSON.parse(bytes);assert.equal(frame.endpoint,'session/follow');const id=frame.payload.args.request.address.sessionId;followers.set(id,{socket,streamId:frame.streamId});socket.send(JSON.stringify({type:'item',streamId:frame.streamId,value:{type:'snapshot',messages:[{type:'turn/end',text:'HISTORICAL MUST NOT SEND'}]}}));}));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{for(const socket of ws.clients)socket.terminate();ws.close();await new Promise(resolve=>server.close(resolve));});
  return {url:'http://127.0.0.1:'+server.address().port,requests};
}
test('DSH client authenticates and waits for snapshot, ignores historical and chunk duplicates',async t=>{
  const mock=await mockDsh(t),client=new DshClient({...defaults,dshUrl:mock.url,dshToken:'launch-token'});t.after(()=>client.close());
  await client.probe();const id=await client.createSession('test-workspace','safe-chat');
  assert.equal(await client.prompt(id,'你好'),'收到：你好');
  const image={type:'image',data:'aGVsbG8=',mediaType:'image/png',name:'test.png'};
  assert.equal(await client.prompt(id,'看图',{images:[image]}),'收到：看图');
  assert.deepEqual(mock.requests.filter(r=>r.method==='session/prompt').at(-1).payload.args.request.content[1],image);
});
test('end-to-end OneBot to DSH: dedup, private/group separation, receipts and safe restart',async t=>{
  const mock=await mockDsh(t),runtime=temp();
  const qq=new WebSocketServer({port:0,host:'127.0.0.1'});await once(qq,'listening');
  let peer;const sent=[];qq.on('connection',socket=>{peer=socket;socket.on('message',bytes=>{const data=JSON.parse(bytes);
    if(data.action==='get_login_info'||data.action==='get_status'){socket.send(JSON.stringify({status:'ok',retcode:0,echo:data.echo,data:data.action==='get_login_info'?{user_id:123456}:{online:true,good:true}}));return;}
    sent.push(data);socket.send(JSON.stringify({status:'ok',retcode:0,echo:data.echo,data:{message_id:1000+sent.length}}));});});
  const bridge=new Bridge(runtime);t.after(async()=>{bridge.stop();for(const socket of qq.clients)socket.terminate();await new Promise(resolve=>qq.close(resolve));fs.rmSync(runtime,{recursive:true,force:true});});
  const config=validate({dshUrl:mock.url,dshToken:'launch-token',qqUrl:'ws://127.0.0.1:'+qq.address().port,privateUsers:['234567'],groups:['345678'],privatePreset:'private',groupPreset:'safe-group'});
  assert.equal(bridge.status.state,'stopped');assert.equal(sent.length,0);
  await bridge.start(config);const first=event();peer.send(JSON.stringify(first));peer.send(JSON.stringify(first));
  peer.send(JSON.stringify(event({message_type:'group',group_id:345678,message_id:2,message:[{type:'at',data:{qq:123456}},{type:'text',data:{text:'群聊'}}]})));
  await until(()=>sent.length===2 && bridge.status.active===0);
  assert.equal(sent.filter(x=>x.action==='send_private_msg').length,1);assert.equal(sent.filter(x=>x.action==='send_group_msg').length,1);
  const create=mock.requests.filter(x=>x.method==='session/create');assert.equal(create.length,2);assert.notEqual(create[0].payload.args.request.workspaceId,create[1].payload.args.request.workspaceId);
  assert.ok(bridge.state.deliveries.every(x=>x.state==='sent'));bridge.stop();
  const restored=new Bridge(runtime);assert.equal(restored.status.state,'stopped');assert.equal(restored.state.seen.length,2);assert.equal(Object.keys(restored.state.sessions).length,2);
});
test('in-flight interruption blocks the old DSH session and never sends a late reply',async t=>{
  const runtime=temp();let finish;
  class SlowDsh{async probe(){}async createSession(){return'old';}async rename(){}prompt(){return new Promise(resolve=>{finish=resolve;});}close(){}}
  const bridge=new Bridge(runtime,{Dsh:SlowDsh});bridge.config={...defaults,privatePreset:'test'};bridge.dsh=new SlowDsh();bridge.status.state='running';bridge.generation=1;
  bridge.socket={send(){assert.fail('late reply must not be sent');},close(){}};
  t.after(()=>fs.rmSync(runtime,{recursive:true,force:true}));
  const task=bridge.handle({key:'123456/private/234567',id:'234567',group:false,text:'test',messageId:'1'},1);
  await until(()=>finish);bridge.stop();finish('late');await task;
  assert.ok(Object.values(bridge.state.sessions)[0].blocked);
});
