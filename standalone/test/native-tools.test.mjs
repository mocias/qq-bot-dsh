import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {NativeRuntime} from '../../native-dsh-plugin/lib/runtime.mjs';
import {VERSION,PROTOCOL,BUILD_ID} from '../../native-dsh-plugin/lib/schema.mjs';
import {nativeCallback} from '../lib/native-callback.mjs';
import {DshClient} from '../lib/dsh.mjs';
import {Bridge} from '../lib/bridge.mjs';
import {defaults,validate} from '../lib/config.mjs';
import {initializeLife,maintain} from '../lib/lifecycle.mjs';
import {MemoryStore} from '../lib/memory.mjs';
const defineTool=process.env.QQ_RSI_DSH_TOOLS_ENTRY?(await import(process.env.QQ_RSI_DSH_TOOLS_ENTRY)).defineTool:x=>x;

async function harness(t,respond){
  let peer,stream,seq=0,turn=0;const registered=new Map(),listeners=new Map(),requests=[],messages=[];
  const agent={status:'idle',session:{id:'session'},ctx:{
    tools:{presentAs(mode){assert.equal(mode,'native');return ()=>{};},register(def){registered.set(def.name,def);return ()=>registered.delete(def.name);}},
    on(name,fn){listeners.set(name,fn);return ()=>listeners.delete(name);}
  }};
  const runtime=new NativeRuntime({agents:{get:id=>id==='session'?agent:null}},defineTool);
  function emit(type,data){peer.send(JSON.stringify({type:'item',streamId:stream,value:{type:'event',event:{type,seq:seq++,time:Date.now(),data}}}));}
  agent.followup=message=>{
    messages.push(message);agent.status='running';turn++;
    emit('turn/start',{turn});listeners.get('agent/inbox/claimed')?.({message,turn});emit('user/message',message);
    queueMicrotask(async()=>{
      try{
        const result=await respond({message,registered,agent,emit,turn,call:async(name,args,id='call-1')=>{
          const def=registered.get(name);assert.ok(def,`missing native tool ${name}`);
          return def.execute(args,{agent,callId:id,signal:new AbortController().signal});
        }});
        for(const text of Array.isArray(result)?result:[result??''])emit('assistant/message',{turn,message:{id:'answer-'+seq,content:[{type:'text',text}]}});
        agent.status='idle';emit('turn/end',{turn,reason:{kind:'completed'}});
      }catch(error){agent.status='idle';emit('turn/end',{turn,reason:{kind:'error',message:error.message}});}
    });
  };
  agent.steer=message=>{messages.push(message);listeners.get('agent/inbox/claimed')?.({message,turn});emit('user/message',message);};
  const server=http.createServer(async(req,res)=>{
    if(req.url.startsWith('/?token=')){res.writeHead(302,{'Set-Cookie':'dsh-auth-test=ok'});res.end();return;}
    let body='';for await(const chunk of req)body+=chunk;
    const request=JSON.parse(body);requests.push(request);
    let result;
    try{
      const args=request.payload.args.request;
      if(request.method==='agentPresets/list')result=['test'];
      else if(request.method==='qqRsiNative/probe')result=runtime.probe();
      else if(request.method==='qqRsiNative/submit')result=await runtime.submit(args);
      else if(request.method==='qqRsiNative/release')result=runtime.release(args);
      else if(request.method==='session/cancel'){agent.status='idle';emit('turn/end',{turn,reason:{kind:'cancelled'}});result={accepted:true};}
      else throw Error('unexpected endpoint '+request.method);
      res.end(JSON.stringify({type:'server-response',rpcId:request.rpcId,result:{ok:true,value:result}}));
    }catch(error){res.end(JSON.stringify({type:'server-response',rpcId:request.rpcId,result:{ok:false,error:error.message}}));}
  });
  const ws=new WebSocketServer({server,path:'/api/remote.mux'});
  ws.on('connection',socket=>{peer=socket;socket.on('message',bytes=>{stream=JSON.parse(bytes).streamId;socket.send(JSON.stringify({type:'item',streamId:stream,value:{type:'snapshot'}}));});});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const config={...defaults,dshNativeTools:true,dshToken:'test',privatePreset:'test',groupPreset:'test',qqVoiceSend:false,qqImages:true,dshUrl:`http://127.0.0.1:${server.address().port}`};
  const client=new DshClient(config);
  t.after(async()=>{client.close();runtime.dispose();for(const socket of ws.clients)socket.terminate();ws.close();await new Promise(r=>server.close(r));});
  return {config,client,runtime,registered,requests,messages,agent,listeners};
}
function bridgeFixture(t,config,client,{group=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-native-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bridge=new Bridge(root,{wait:async()=>{}}),route={key:`100000001/${group?'group':'private'}/100000002`,id:'100000002',group,text:'记住我喜欢茶',messageId:'m1',qqMessageId:'1'};
  bridge.config=config;bridge.status.state='running';bridge.dsh=client;
  const session={id:'session',transport:'native-v1',route,workspace:root,preset:'test',blocked:false};
  initializeLife(session);bridge.state.sessions[bridge.scope(route)]=session;
  const sent=[];bridge.socket={send(bytes){const v=JSON.parse(bytes);sent.push(v);queueMicrotask(()=>bridge.pending.get(v.echo)?.({status:'ok',retcode:0,data:{message_id:String(sent.length)}}));}};
  return {root,bridge,route,session,sent};
}
const text=sent=>sent.map(x=>x.params.message.filter(m=>m.type==='text').map(m=>m.data.text).join(''));
test('native DSH request calls a real host memory tool and returns ordinary text without the JSON loop',async t=>{
  const h=await harness(t,async({call,message})=>{
    assert.equal(message.source.kind,'plugin:qq-rsi-native');
    const result=await call('qq_memory_update',{updates:[{action:'write',page:'user/tea.md',text:'# 茶\n喜欢茶',reason:'本轮用户陈述',evidence:['m1']}]});
    assert.equal(result.result.saved,true);
    return ['我记住你喜欢茶了。','后续回复可以直接用自然语言。'];
  });
  const f=bridgeFixture(t,h.config,h.client);
  await h.client.probe();await f.bridge.handle(f.route,0);
  assert.deepEqual(text(f.sent),['我记住你喜欢茶了。','后续回复可以直接用自然语言。']);
  assert.match(f.bridge.memory(f.route.key).pages()[0].text,/喜欢茶/);
  assert.equal(h.requests.filter(x=>x.method==='qqRsiNative/submit').length,1);
  assert.equal(h.requests.some(x=>x.method==='session/prompt'),false);
  assert.equal(h.registered.size,0);assert.equal(h.runtime.bindings.size,0);
});
test('invalid memory arguments return a tool error; a later natural reply still reaches QQ',async t=>{
  const h=await harness(t,async({call})=>{
    await assert.rejects(call('qq_memory_update',{updates:{}}),/数量|格式|array|arguments/i);
    return '这次记忆没有保存成功，但可以正常回答。';
  });
  const f=bridgeFixture(t,h.config,h.client);await f.bridge.handle(f.route,0);
  assert.deepEqual(text(f.sent),['这次记忆没有保存成功，但可以正常回答。']);
  assert.equal(f.bridge.memory(f.route.key).pages().length,0);
});
test('provider reuse of a tool call ID in a later conversation turn does not discard new memory',async t=>{
  let round=0;
  const h=await harness(t,async({call})=>{
    round++;
    await call('qq_memory_update',{updates:[{action:'write',page:'user/tea.md',text:'# 偏好\n'+(round===1?'茶':'咖啡'),reason:'当前陈述',evidence:['m'+round]}]},'reused-call-id');
    return '保存成功';
  });
  const f=bridgeFixture(t,h.config,h.client);
  await f.bridge.handle(f.route,0);
  await f.bridge.handle({...f.route,messageId:'m2',text:'现在改成咖啡'},0);
  assert.match(f.bridge.memory(f.route.key).pages()[0].text,/咖啡/);
  assert.equal(text(f.sent).length,2);
});
test('native sends are queued, deduplicated by callId, and final text is not sent twice',async t=>{
  let f;
  const h=await harness(t,async({call})=>{
    const args={messages:['第一条','第二条']};
    assert.equal((await call('qq_send_message',args)).result.queued,true);
    assert.equal(f.sent.length,0);
    await call('qq_send_message',args);
    await assert.rejects(call('qq_send_message',{messages:['不同参数']}),/重复/);
    return '第一条第二条';
  });
  f=bridgeFixture(t,h.config,h.client);await f.bridge.handle(f.route,0);
  assert.deepEqual(text(f.sent),['第一条','第二条']);
});
test('host rejects wrong evidence and callbacks after channel stop',async t=>{
  let f;
  const h=await harness(t,async({call})=>{
    await assert.rejects(call('qq_memory_update',{updates:[{action:'write',page:'user/a.md',text:'x',reason:'x',evidence:['another-chat']}]}),/来源/);
    f.bridge.status.channels={private:false};
    await assert.rejects(call('qq_send_message',{messages:['不能发送']},'call-2'),/停止/);
    return '不能发送';
  });
  f=bridgeFixture(t,h.config,h.client);await f.bridge.handle(f.route,0);assert.equal(f.sent.length,0);
});
test('native callbacks reject wrong token, cross-session, arbitrary tool and late calls',async t=>{
  let count=0;const controller=new AbortController();
  const callback=await nativeCallback({sessionId:'s',runId:'r',allowed:['one'],execute:()=>{count++;return {result:'ok'};},signal:controller.signal});
  t.after(()=>callback.close());
  const call=(value,token=callback.token)=>fetch(callback.url,{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify(value)});
  const payload={sessionId:'s',runId:'r',tool:'one',callId:'1',args:{}};
  assert.equal((await call(payload,'wrong')).status,403);
  assert.equal((await call({...payload,sessionId:'other'})).status,400);
  assert.equal((await call({...payload,tool:'shell'})).status,400);
  assert.equal((await call(payload)).status,200);
  assert.equal((await call(payload)).status,200);assert.equal(count,1);
  controller.abort();assert.equal((await call(payload)).status,403);
});
test('plugin rejects version mismatch before submitting and never falls back to prompt',async t=>{
  const h=await harness(t,()=>''),callback={url:'http://127.0.0.1:1234/tool',token:'a'.repeat(64)};
  await assert.rejects(h.runtime.submit({sessionId:'session',runId:'r',requestId:'m',mode:'queue',content:[{type:'text',text:'x'}],callback,allowed:[],version:'0.15.0',protocol:PROTOCOL}),/版本/);
  assert.equal(h.messages.length,0);
  h.client.rpc=async method=>{assert.equal(method,'qqRsiNative/probe');return {version:'old',protocol:PROTOCOL};};
  await assert.rejects(h.client.probe(),/版本/);
});
test('native maintenance commits via a tool and does not parse assistant JSON or deliver messages',async t=>{
  const h=await harness(t,async({call})=>{
    await call('qq_memory_digest',{summary:'无新增',updates:[]});return '完成';
  });
  const f=bridgeFixture(t,h.config,h.client),life=f.session.life;
  life.lastAt=0;life.compactions=[{id:'c1',sourceId:'source-c1'}];
  await maintain({session:f.session,config:h.config,store:f.bridge.memory(f.route.key),dsh:h.client,persist:()=>{},now:()=>Date.now(),isCurrent:()=>true,signal:new AbortController().signal,rotate:async()=>{}});
  assert.deepEqual(life.digestedIds,['c1']);assert.ok(life.receipt);assert.equal(f.sent.length,0);
});
test('transport upgrade preserves old session and workspace but does not reuse JSON instructions',async t=>{
  const config={...defaults,dshNativeTools:true,privatePreset:'test',qqVoiceSend:false};
  const client={createSession:async()=> 'new-native',rename:async()=>{},prompt:async()=>['原生回复']};
  const f=bridgeFixture(t,config,client);delete f.session.transport;f.session.promptVersion=1;
  await f.bridge.handle(f.route,0);
  assert.equal(f.bridge.state.retired[0].reason,'transport-upgrade');
  const current=f.bridge.state.sessions[f.bridge.scope(f.route)];
  assert.equal(current.id,'new-native');assert.equal(current.workspace,f.root);
  assert.equal(current.promptVersion,2);assert.deepEqual(text(f.sent),['原生回复']);
});
test('native mode is explicit and rejects invalid config types',()=>{
  assert.equal(validate({dshNativeTools:true}).dshNativeTools,true);
  assert.throws(()=>validate({dshNativeTools:'yes'}),/开关/);
});
test('native steering remains a plugin input and is acknowledged before completion',async t=>{
  let ready,finish;
  const started=new Promise(r=>ready=r),done=new Promise(r=>finish=r);
  const h=await harness(t,async()=>{ready();await done;return '插话后的答复';});
  const answer=h.client.prompt('session','初始输入',{nativeTools:{allowed:[],execute:async()=>{throw Error('no tools');}}});
  await started;
  assert.equal(await h.client.steer('session','补充输入'),true);finish();
  assert.equal(await answer,'插话后的答复');
  assert.equal(h.messages.length,2);
  assert.ok(h.messages.every(m=>m.source.kind==='plugin:qq-rsi-native'));
  assert.equal(h.requests.some(x=>x.method==='session/prompt'),false);
});
test('native cancellation waits for turn acknowledgement and releases scoped tools',async t=>{
  let ready;const started=new Promise(r=>ready=r);
  const h=await harness(t,async()=>{ready();return new Promise(()=>{});}),controller=new AbortController();
  const answer=h.client.prompt('session','慢回合',{signal:controller.signal,nativeTools:{allowed:['qq_memory_update'],execute:async()=>({result:{saved:true}})}});
  await started;controller.abort();
  await assert.rejects(answer,error=>error.cancelled&&error.acknowledged);
  assert.equal(h.registered.size,0);assert.equal(h.runtime.bindings.size,0);
});
test('same version but different build is rejected before input submission',async t=>{
  const h=await harness(t,()=>''),callback={url:'http://127.0.0.1:1234/tool',token:'a'.repeat(64)};
  await assert.rejects(h.runtime.submit({sessionId:'session',runId:'r',requestId:'m',mode:'queue',content:[{type:'text',text:'x'}],callback,allowed:[],version:VERSION,protocol:PROTOCOL,buildId:BUILD_ID+'-other'}),/构建/);
  assert.equal(h.messages.length,0);
});
test('native tool authority is lost if an unrelated local user input claims the agent',async t=>{
  let executed=false;
  const h=await harness(t,async({call,agent})=>{
    h.listeners.get('agent/inbox/claimed')({message:{source:{kind:'user'}},turn:1});
    await assert.rejects(call('qq_memory_update',{updates:[]}),/有效的QQ/);
    return '结束';
  });
  await h.client.prompt('session','QQ输入',{nativeTools:{allowed:['qq_memory_update'],execute:async()=>{executed=true;return {};}}});
  assert.equal(executed,false);
});
