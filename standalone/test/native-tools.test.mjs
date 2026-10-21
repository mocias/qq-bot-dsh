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
import {DELEGATION_POLICY,DELEGATION_POLICY_VERSION} from '../lib/delegation-policy.mjs';
import {policyView,resolveChatConfig} from '../lib/chat-policy.mjs';
import {selectedTools} from '../../native-dsh-plugin/lib/schema.mjs';
const defineTool=process.env.QQ_RSI_DSH_TOOLS_ENTRY?(await import(process.env.QQ_RSI_DSH_TOOLS_ENTRY)).defineTool:x=>x;

async function harness(t,respond){
  let peer,stream,seq=0,turn=0;const registered=new Map(),listeners=new Map(),requests=[],messages=[],contexts=new Map(),skills=new Map();
  const agent={status:'idle',session:{id:'session',log:[],surface:{nodes:[]},append(type,data,options={}){
    const event={type,seq:seq++,time:Date.now(),data,...options};this.log.push(event);
    if(options.surfaceOp==='append')this.surface.nodes.push(event.seq);
    else if(options.surfaceOp?.op==='replace')this.surface.nodes.splice(this.surface.nodes.indexOf(options.surfaceOp.startSeq),1,event.seq);
    listeners.get('session/event')?.(this,event);
    if(peer?.readyState===1)peer.send(JSON.stringify({type:'item',streamId:stream,value:{type:'event',event}}));return event;
  }},ctx:{
    systemPrompt:{context(value){contexts.set(value.name,value);return ()=>contexts.delete(value.name);}},
    skills:{register(value){skills.set(value.name,value);return ()=>skills.delete(value.name);}},
    tools:{presentAs(mode){assert.equal(mode,'native');return ()=>{};},register(def){registered.set(def.name,def);return ()=>registered.delete(def.name);}},
    on(name,fn){listeners.set(name,fn);return ()=>listeners.delete(name);}
  }};
  const runtime=new NativeRuntime({agents:{get:id=>id==='session'?agent:null}},defineTool);
  function emit(type,data){return agent.session.append(type,data,{surfaceOp:['assistant/message','user/message','tool/result'].includes(type)?'append':undefined});}
  agent.followup=message=>{
    messages.push(message);agent.status='running';turn++;
    emit('turn/start',{turn});listeners.get('agent/inbox/claimed')?.({message,turn});emit('user/message',message);
    queueMicrotask(async()=>{
      try{
        let concluded=false;
        const result=await respond({message,registered,agent,emit,turn,contexts,skills,call:async(name,args,id='call-1')=>{
          const def=registered.get(name);assert.ok(def,`missing native tool ${name}`);
          const value=await def.execute(args,{agent,callId:id,signal:new AbortController().signal,concludeTurn(){concluded=true;}});
          emit('tool/result',{turn,message:{id:'tool-'+seq,role:'tool',callId:id,content:def.output.render(args,value)}});
          return value;
        }});
        if(!concluded)for(const text of Array.isArray(result)?result:[result??''])emit('assistant/message',{turn,message:{id:'answer-'+seq,content:[{type:'text',text}]}});
        agent.status='idle';emit('turn/end',{turn,reason:{kind:'completed'}});
      }catch(error){t.diagnostic(error.stack??error.message);agent.status='idle';emit('turn/end',{turn,reason:{kind:'error',message:error.message}});}
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
  return {config,client,runtime,registered,requests,messages,agent,listeners,contexts,skills};
}
function bridgeFixture(t,config,client,{group=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-native-'));
  t.after(()=>{
    // Git objects are read-only on Windows; Electron's fs.rm wrapper needs the
    // fixture files writable. This walks only this freshly created test root.
    for(const name of fs.readdirSync(root,{recursive:true})){const file=path.join(root,name);if(fs.lstatSync(file).isFile())fs.chmodSync(file,0o666);}
    fs.rmSync(root,{recursive:true,force:true,maxRetries:3});
  });
  const bridge=new Bridge(root,{wait:async()=>{}}),route={key:`100000001/${group?'group':'private'}/100000002`,id:'100000002',group,text:'记住我喜欢茶',messageId:'m1',qqMessageId:'1',sender:'100000002',author:{qq:'100000002',nickname:'甲',card:''}};
  bridge.config=config;bridge.status.state='running';bridge.dsh=client;
  const session={id:'session',transport:'native-v1',route,workspace:root,preset:'test',blocked:false};
  initializeLife(session);bridge.state.sessions[bridge.scope(route)]=session;
  const sent=[];bridge.socket={send(bytes){const v=JSON.parse(bytes);sent.push(v);queueMicrotask(()=>bridge.pending.get(v.echo)?.({status:'ok',retcode:0,data:{message_id:String(sent.length)}}));}};
  return {root,bridge,route,session,sent};
}
const text=sent=>sent.map(x=>x.params.message.filter(m=>m.type==='text').map(m=>m.data.text).join(''));
for(const group of [false,true])test(`native ${group?'group':'private'} memory supports recall/update/forget with scoped runtime context`,async t=>{
  let f;
  const h=await harness(t,async({call,message,contexts,skills,agent})=>{
    const provider=contexts.get('qq-rsi-memory');assert.ok(provider);assert.ok(skills.has('qq-memory'));
    assert.equal(provider.text({agent:{}}),'');assert.match(provider.text({agent}),/qq_memory_search/);
    assert.doesNotMatch(message.content[0].text,/本机管理者设定的人设|长期记忆资料/);
    assert.match((await call('qq_memory_read',{page:'index.md'},'index')).result.text,/Memory Index/);
    const original=(await call('qq_memory_read',{page:'user/100000002.md'},'read')).result;
    const updates=[{action:'write',page:'user/100000002.md',text:'# 偏好\n喜欢茶',reason:'本人自述',evidence:['m1'],subjects:[{qq:'100000002',basis:'self',evidence:['m1']}],expectedRevision:original.revision}];
    const saved=await call('qq_memory_update',{updates},'save');assert.equal(saved.result.history.state,'ready');assert.equal(saved.memoryContext,undefined);
    assert.match(provider.text({agent}),/喜欢茶/);
    const hits=(await call('qq_memory_search',{query:'喜欢茶'},'search')).result;assert.equal(hits.total,1);
    assert.equal((await call('qq_memory_query',{type:'user',salience:2,query:'喜欢茶'},'query')).result.total,1);
    const diagnostic=(await call('qq_memory_diagnose',{},'diagnose')).result;
    const maintenance={operations:[{action:'sync_index',reason:'确认索引与页一致'}],expectedRevision:diagnostic.revision};
    assert.equal((await call('qq_memory_maintain',maintenance,'preview')).result.preview,true);
    assert.equal((await call('qq_memory_maintain',{...maintenance,preview:false},'sync')).result.saved,true);
    const page=(await call('qq_memory_read',{page:hits.results[0].page},'read-new')).result;assert.equal(page.attributionStatus,'source_recorded');
    await assert.rejects(call('qq_memory_update',{updates:[{...updates[0],expectedRevision:page.revision,evidence:['forged']}]},'bad-source'),/来源/);
    await assert.rejects(call('qq_memory_read',{page:'../index.md'},'cross-path'));
    await call('qq_memory_update',{updates:[{...updates[0],action:'forget',text:'',reason:'本轮测试遗忘',expectedRevision:page.revision}]},'forget');
    assert.equal((await call('qq_memory_search',{query:'喜欢茶'},'search-forgotten')).result.total,0);
    await call('qq_send_message',{messages:['完成']},'answer');return '内部说明';
  });
  f=bridgeFixture(t,{...h.config,groupToolsEnabled:false,knowledgeEnabled:false,messageToolsEnabled:false},h.client,{group});
  await f.bridge.handle(f.route,0);assert.deepEqual(text(f.sent),['完成']);
  assert.equal(h.contexts.size,0);assert.equal(h.skills.size,0);
});

test('native memory context refreshes next turn without duplicate documents in execution requests',async t=>{
  let round=0;
  const h=await harness(t,async({contexts,agent,message})=>{
    round++;assert.match(contexts.get('qq-rsi-memory').text({agent}),round===1?/初始人格/:/更新人格/);
    assert.doesNotMatch(message.content[0].text,/初始人格|更新人格/);return '回复';
  });
  const f=bridgeFixture(t,h.config,h.client),store=f.bridge.memory(f.route.key);
  fs.writeFileSync(store.safe('SOUL.md'),'初始人格');await f.bridge.handle(f.route,0);
  fs.writeFileSync(store.safe('SOUL.md'),'更新人格');await f.bridge.handle({...f.route,messageId:'m2'},0);
  assert.equal(round,2);assert.equal(f.session.id,'session');assert.equal(h.contexts.size,0);
});

for(const group of [false,true])test(`native ${group?'group':'private'} persona writes refresh scoped context even when memory is disabled`,async t=>{
  const h=await harness(t,async({call,contexts,agent,registered})=>{
    assert.equal(registered.has('qq_memory_update'),false);
    const current=(await call('qq_persona_read',{},'read-persona')).result;
    assert.deepEqual(current.eligibleSources,[{sourceId:'m1',speakerQQ:'100000002'}]);
    const args={text:'# SOUL\n名字：小雨\n风格：简短',expectedRevision:current.revision,bootstrap:'---\nstatus: in_progress\n---\n- [x] 名字',expectedBootstrapRevision:current.bootstrapRevision,reason:'当前对方指定',evidence:['m1']};
    const saved=await call('qq_persona_update',args,'save-persona');assert.equal(saved.result.saved,true);assert.equal(saved.memoryContext,undefined);
    assert.match(contexts.get('qq-rsi-memory').text({agent}),/名字：小雨/);
    await assert.rejects(call('qq_persona_update',{...args,evidence:['forged']},'bad-persona'),/来源/);
    await call('qq_send_message',{messages:['人设已保存']},'answer');return '内部说明';
  });
  const f=bridgeFixture(t,{...h.config,memoryEnabled:false,personaPolicy:'private-peer-group-admins',adminUsers:['100000002']},h.client,{group});
  f.route.text='请叫小雨，说话简短';await f.bridge.handle(f.route,0);
  assert.deepEqual(text(f.sent),['人设已保存']);assert.match(fs.readFileSync(f.bridge.memory(f.route.key).safe('SOUL.md'),'utf8'),/小雨/);
  assert.equal(h.contexts.size,0);
});

test('native memory disabled omits all memory tools and missing context service fails before input',async t=>{
  const h=await harness(t,async({registered,contexts,agent})=>{
    assert.equal(registered.has('qq_memory_read'),false);assert.equal(registered.has('qq_memory_update'),false);
    assert.match(contexts.get('qq-rsi-memory').text({agent}),/长期记忆已关闭/);return '正常回复';
  });
  const f=bridgeFixture(t,{...h.config,memoryEnabled:false},h.client);await f.bridge.handle(f.route,0);
  delete h.agent.ctx.systemPrompt;
  await assert.rejects(h.client.prompt('session','不应提交',{nativeTools:{allowed:[],execute:async()=>{},memoryContext:()=>({text:'',skill:''})}}),/未接受/);
  assert.equal(h.messages.length,1);assert.equal(h.runtime.bindings.size,0);
});
test('native DSH request saves memory and sends messages using tools without the JSON loop',async t=>{
  const h=await harness(t,async({call,message})=>{
    assert.equal(message.source.kind,'plugin:qq-rsi-native');
    const result=await call('qq_memory_update',{updates:[{action:'write',page:'user/100000002.md',text:'# 茶\n喜欢茶',reason:'本轮用户陈述',evidence:['m1'],subjects:[{qq:'100000002',basis:'self',evidence:['m1']}]}]});
    assert.equal(result.result.saved,true);
    await call('qq_send_message',{messages:['我记住你喜欢茶了。','后续回复可以直接用自然语言。']},'answer');
    return '内部说明不能作为回复';
  });
  const f=bridgeFixture(t,h.config,h.client);
  await h.client.probe();await f.bridge.handle(f.route,0);
  assert.deepEqual(text(f.sent),['我记住你喜欢茶了。','后续回复可以直接用自然语言。']);
  assert.match(f.bridge.memory(f.route.key).pages()[0].text,/喜欢茶/);
  assert.equal(h.requests.filter(x=>x.method==='qqRsiNative/submit').length,1);
  assert.equal(h.requests.some(x=>x.method==='session/prompt'),false);
  assert.equal(h.registered.size,0);assert.equal(h.runtime.bindings.size,0);
});
test('invalid memory arguments return a tool error; the parent can still send a reply',async t=>{
  const h=await harness(t,async({call})=>{
    await assert.rejects(call('qq_memory_update',{updates:{}}),/数量|格式|array|arguments/i);
    await call('qq_send_message',{messages:['这次记忆没有保存成功，但可以正常回答。']},'answer');return '';
  });
  const f=bridgeFixture(t,h.config,h.client);await f.bridge.handle(f.route,0);
  assert.deepEqual(text(f.sent),['这次记忆没有保存成功，但可以正常回答。']);
  assert.equal(f.bridge.memory(f.route.key).pages().length,0);
});
test('provider reuse of a tool call ID in a later conversation turn does not discard new memory',async t=>{
  let round=0;
  const h=await harness(t,async({call})=>{
    round++;
    await call('qq_memory_update',{updates:[{action:'write',page:'user/100000002.md',text:'# 偏好\n'+(round===1?'茶':'咖啡'),reason:'当前陈述',evidence:['m'+round],subjects:[{qq:'100000002',basis:'self',evidence:['m'+round]}]}]},'reused-call-id');
    await call('qq_send_message',{messages:['保存成功']},'answer');return '';
  });
  const f=bridgeFixture(t,h.config,h.client);
  await f.bridge.handle(f.route,0);
  await f.bridge.handle({...f.route,messageId:'m2',text:'现在改成咖啡'},0);
  assert.match(f.bridge.memory(f.route.key).pages()[0].text,/咖啡/);
  assert.equal(text(f.sent).length,2);
});
test('native sends are immediate, deduplicated by callId, and ordinary text is never forwarded',async t=>{
  let f;
  const h=await harness(t,async({call})=>{
    const args={messages:['第一条','第二条']};
    assert.equal((await call('qq_send_message',args)).result.sent,true);
    assert.equal(f.sent.length,2);
    await call('qq_send_message',args);
    await assert.rejects(call('qq_send_message',{messages:['不同参数']}),/重复/);
    return '第一条第二条';
  });
  f=bridgeFixture(t,h.config,h.client);await f.bridge.handle(f.route,0);
  assert.deepEqual(text(f.sent),['第一条','第二条']);
  assert.equal(h.agent.session.log.some(x=>x.type==='assistant/message'),true,'sending leaves the agent free to continue');
  const receipt=currentResults(h.agent).join('\n');
  assert.match(receipt,/"state":"sent"[\s\S]*第一条[\s\S]*"state":"sent"[\s\S]*第二条/);
});

function currentResults(agent){return agent.session.log.filter(e=>e.type==='tool/result'&&agent.session.surface.nodes.includes(e.seq)).map(e=>e.data.message.content.map(c=>c.text??'').join(''));}

test('continuous chat sends before turn end, accepts messages while waiting and never forwards ordinary output',async t=>{
  let f;
  const h=await harness(t,async({call,message})=>{
    assert.match(message.content[0].text,/持续对话规则/);
    const first=await call('qq_send_message',{messages:['我先查一下']},'send-1');
    assert.equal(first.result.sent,true);assert.equal(first.result.messages[0].state,'sent');
    assert.deepEqual(text(f.sent),['我先查一下']);
    await call('qq_send_message',{messages:['我先查一下']},'send-1');
    const wait=call('qq_wait_for_messages',{timeoutSeconds:300},'wait');
    f.bridge.accept({...f.route,messageId:'m2',qqMessageId:'2',text:'只看最近一年'},0);
    const latest=(await wait).result;
    assert.equal(latest.timeout,false);assert.match(JSON.stringify(latest.messages),/只看最近一年/);
    await call('qq_send_message',{messages:['好，只查最近一年']},'send-2');
    return '内部正文绝不能自动发QQ';
  });
  f=bridgeFixture(t,{...h.config,continuousChat:false,messageToolsEnabled:false},h.client);
  await f.bridge.handle(f.route,0);
  assert.deepEqual(text(f.sent),['我先查一下','好，只查最近一年']);
  assert.equal(h.messages.length,1);assert.equal(h.registered.size,0);
});

test('continuous child completion retains parent tools across turns and only parent chosen answer reaches QQ',async t=>{
  let f,completion;
  const h=await harness(t,async({call,emit,turn})=>{
    if(turn===1){
      emit('subagent/catalog',{version:2,childId:'research-child',mode:'external'});
      await call('qq_send_message',{messages:['搜索已经开始']},'reused-provider-id');
      completion=setTimeout(()=>h.agent.followup({id:'child-result',role:'user',source:{kind:'subagent-settled',senderSessionId:'research-child'},content:[{type:'text',text:'子任务原始研究材料'}]}),30);
      return '主智能体暂时让出执行';
    }
    assert.deepEqual(text(f.sent),['搜索已经开始']);
    await call('qq_send_message',{messages:['这是主智能体核对后的结论']},'reused-provider-id');
    return '不要转发这段内部正文';
  });
  t.after(()=>clearTimeout(completion));
  f=bridgeFixture(t,h.config,h.client);
  await f.bridge.handle(f.route,0);
  assert.deepEqual(text(f.sent),['搜索已经开始','这是主智能体核对后的结论']);
  assert.equal(h.messages.length,2);assert.equal(h.runtime.bindings.size,0);
});

test('child inbox insertion interrupts a long wait before DSH claims progress or completion',async t=>{
  let f;
  const h=await harness(t,async({call,emit,agent})=>{
    emit('subagent/catalog',{version:2,childId:'waiting-child',mode:'external'});
    const deadline=setTimeout(()=>f.bridge.jobs.get(f.route.key)?.controller.abort(),3000);
    try{
      for(const kind of ['agent-message','subagent-settled']){
        const waiting=call('qq_wait_for_messages',{timeoutSeconds:300},'wait-'+kind);
        const inbox=f.bridge.jobs.get(f.route.key).conversationInbox;
        for(let i=0;i<200&&!inbox.wake;i++)await new Promise(r=>setTimeout(r,5));
        assert.ok(inbox.wake,'waiting tool is active');
        const notice={id:'notice-'+kind,role:'user',source:{kind,senderSessionId:'waiting-child'},content:[{type:'text',text:'子任务原文不能自动发QQ'}]};
        emit('agent/inbox/spliced',{target:'next-step',start:0,inserted:[{...notice,id:'unrelated',source:{kind,senderSessionId:'other-child'}}]});
        await new Promise(r=>setTimeout(r,20));
        assert.ok(inbox.wake,'unrelated child cannot wake this wait');
        emit('agent/inbox/spliced',{target:'next-step',start:0,inserted:[notice]});
        const result=(await waiting).result;
        assert.equal(result.timeout,false);assert.equal(result.reason,'subagent');
        assert.deepEqual(result.notifications,[{messageId:notice.id,childId:'waiting-child',kind}]);
        assert.deepEqual(result.messages,[]);assert.doesNotMatch(JSON.stringify(result),/子任务原文/);
        assert.equal(agent.session.log.some(e=>e.type==='user/message'&&e.data.id===notice.id),false);
        agent.steer(notice); // DSH claims this only after the waiting tool returns.
      }
      await call('qq_send_message',{messages:['主智能体选择的结论']},'chosen-result');
    }finally{clearTimeout(deadline);}
    return '内部正文';
  });
  f=bridgeFixture(t,h.config,h.client);
  await f.bridge.handle(f.route,0);
  assert.deepEqual(text(f.sent),['主智能体选择的结论']);
  assert.equal(h.runtime.bindings.size,0);
});

test('continuous failed or unknown send is reported once and blocks further automatic sends',async t=>{
  let f,attempts=0;
  const h=await harness(t,async({call})=>{
    const args={messages:['这条可能已发出']};
    const result=(await call('qq_send_message',args,'uncertain')).result;
    assert.equal(result.sent,false);assert.equal(result.messages[0].state,'unknown');
    await call('qq_send_message',args,'uncertain');
    await assert.rejects(call('qq_send_message',{messages:['再发一次']},'retry'),/不能继续自动发送/);
    return '普通回答不能成为失败回退';
  });
  f=bridgeFixture(t,h.config,h.client);
  f.bridge.call=async()=>{attempts++;throw Error('transport lost');};
  await f.bridge.handle(f.route,0);assert.equal(attempts,1);assert.equal(f.sent.length,0);
});

test('continuous parent accepts new QQ input while idle awaiting a child, then handles child progress and result',async t=>{
  let f,started,progress;
  const ready=new Promise(resolve=>started=resolve),heard=new Promise(resolve=>progress=resolve);
  const h=await harness(t,async({call,emit,turn,message})=>{
    if(turn===1){emit('subagent/catalog',{version:0,childId:'child',mode:'continuable'});started();return '';}
    if(turn===2){assert.match(message.content[0].text,/新的搜索条件/);await call('qq_send_message',{messages:['收到新条件']},'new-condition');return '';}
    if(turn===3){await call('qq_send_message',{messages:['我核对了阶段性发现']},'progress');progress();return '';}
    await call('qq_send_message',{messages:['最终结论']},'result');return '';
  });
  f=bridgeFixture(t,h.config,h.client);
  const run=f.bridge.handle(f.route,0);await ready;
  const idle=async()=>{for(let i=0;i<200&&!h.client.awaitingChild('session');i++)await new Promise(r=>setTimeout(r,5));assert.equal(h.client.awaitingChild('session'),true);};
  await idle();f.bridge.accept({...f.route,messageId:'m2',qqMessageId:'2',text:'新的搜索条件'},0);
  for(let i=0;i<200&&f.sent.length<1;i++)await new Promise(r=>setTimeout(r,5));
  await idle();h.agent.followup({id:'child-progress',role:'user',source:{kind:'agent-message',senderSessionId:'child'},content:[{type:'text',text:'仅供主智能体参考的进展'}]});
  await heard;await idle();
  h.agent.followup({id:'child-final',role:'user',source:{kind:'subagent-settled',senderSessionId:'child'},content:[{type:'text',text:'原始结论'}]});
  await run;assert.deepEqual(text(f.sent),['收到新条件','我核对了阶段性发现','最终结论']);
});

test('continuous scope rejects unrelated child messages and cannot be inherited by a child executor',async t=>{
  let f;
  const h=await harness(t,async({registered,listeners})=>{
    const def=registered.get('qq_send_message');
    await assert.rejects(def.execute({messages:['越权']},{agent:{},callId:'other',signal:new AbortController().signal}),/有效的QQ执行回合/);
    h.listeners.get('agent/inbox/claimed')({message:{source:{kind:'subagent-settled',senderSessionId:'unrelated'}}});
    await assert.rejects(def.execute({messages:['伪造子任务']},{agent:h.agent,callId:'unknown-child',signal:new AbortController().signal}),/有效的QQ执行回合/);
    return '';
  });
  f=bridgeFixture(t,h.config,h.client);await f.bridge.handle(f.route,0);
  assert.equal(f.sent.length,0);
});

test('input arriving just before the parent yields to a child is resumed without waiting for that child',async t=>{
  let f,finish;
  const h=await harness(t,async({call,emit,turn,message})=>{
    if(turn===1){
      emit('subagent/catalog',{version:2,childId:'race-child',mode:'external'});
      f.bridge.accept({...f.route,messageId:'m2',qqMessageId:'2',text:'我还有一个问题'},0);
      return '';
    }
    if(turn===2){
      assert.match(message.content[0].text,/我还有一个问题/);
      await call('qq_send_message',{messages:['我在，继续说']},'race-reply');
      finish=setTimeout(()=>h.agent.followup({id:'race-done',role:'user',source:{kind:'subagent-settled',senderSessionId:'race-child'},content:[{type:'text',text:'完成'}]}),20);
    }
    return '';
  });
  t.after(()=>clearTimeout(finish));f=bridgeFixture(t,h.config,h.client);
  await f.bridge.handle(f.route,0);assert.deepEqual(text(f.sent),['我在，继续说']);assert.equal(h.messages.length,3);
});

test('retired continuous mode switches are removed at all configuration scopes',()=>{
  const key='100000001/private/100000002';
  const previous={...defaults,continuousChat:false,chatPolicy:{private:{continuousChat:false},group:{continuousChat:true},overrides:{[key]:{continuousChat:false,messageToolsEnabled:false}}}};
  const config=validate({continuousChat:false},previous);
  assert.equal(Object.hasOwn(defaults,'continuousChat'),false);
  assert.equal(Object.hasOwn(config,'continuousChat'),false);
  for(const scope of ['private','group',key]){
    const view=policyView(config,scope);
    assert.equal(Object.hasOwn(view.fields,'continuousChat'),false);
    assert.equal(Object.hasOwn(view.effective,'continuousChat'),false);
  }
  const effective=resolveChatConfig(config,key),allowed=selectedTools(effective,{group:false});
  for(const name of ['qq_send_message','qq_reply','qq_wait_for_messages'])assert.ok(allowed.includes(name));
  assert.equal(allowed.includes('qq_get_recent_messages'),false);
  assert.equal(effective.messageToolsEnabled,false);
});

test('continuous cancellation wakes a waiting tool and releases the QQ scope',async t=>{
  let f,started;
  const ready=new Promise(resolve=>started=resolve);
  const h=await harness(t,async({call})=>{
    const wait=call('qq_wait_for_messages',{timeoutSeconds:300},'wait-stop');started();
    await assert.rejects(wait);return '';
  });
  f=bridgeFixture(t,h.config,h.client);
  const run=f.bridge.handle(f.route,0);await ready;f.bridge.jobs.get(f.route.key).controller.abort();
  await assert.rejects(run);assert.equal(f.sent.length,0);assert.equal(h.runtime.bindings.size,0);
});

test('continuous lifetime expiry releases parent scope even when a child never completes',async t=>{
  const h=await harness(t,async({emit})=>{emit('subagent/catalog',{version:2,childId:'unfinished',mode:'external'});return '';});
  await assert.rejects(h.client.prompt('session','bounded window',{timeoutMs:100,nativeTools:{continuous:true,allowed:[],execute:async()=>({})}}),error=>error.cancelled===true);
  assert.equal(h.runtime.bindings.size,0);assert.equal(h.client.runs.size,0);
});
function audioBytes(){
  const b=Buffer.alloc(364);b.write('RIFF');b.writeUInt32LE(356,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(320,40);return b;
}
test('quoted voice uses two real outbox plans and DSH receipt contains the exact spoken text',async t=>{
  let f;
  const h=await harness(t,async({call})=>{
    await call('qq_send_media',{voice:'这是实际朗读的原句。',replyToMessageId:'1'});
    assert.equal(f.sent.length,2);return '不能自动投递的另一版措辞';
  });
  f=bridgeFixture(t,{...h.config,qqVoiceSend:true,voiceQuietMode:'never'},h.client);
  f.bridge.media.voice={synthesize:async text=>{assert.equal(text,'这是实际朗读的原句。');return {id:'audio'};},audio:audioBytes};
  f.bridge.media.reference=async()=>{};
  f.bridge.inbox(f.route.key).append({messageId:'1',sourceId:'m1',sender:'100000002',text:'你好'});
  await f.bridge.handle(f.route,0);
  assert.deepEqual(f.sent.map(x=>x.params.message.map(m=>m.type)),[['reply','text'],['record']]);
  assert.equal(f.bridge.state.deliveries.length,2);
  assert.match(currentResults(h.agent).join('\n'),/"state":"sent"[\s\S]*语音回复：[\s\S]*"state":"sent"[\s\S]*这是实际朗读的原句。/);
  assert.equal(h.agent.session.log.some(e=>e.type==='assistant/message'),true);
});
test('explicit silence concludes the turn; fallback markers do not become text or voice',async t=>{
  const h=await harness(t,async({call})=>{await call('qq_no_reply',{});return '（无回复）';});
  const f=bridgeFixture(t,h.config,h.client);await f.bridge.handle(f.route,0);
  assert.equal(f.sent.length,0);assert.equal(h.agent.session.log.some(e=>e.type==='assistant/message'),false);
  const h2=await harness(t,()=>['（无回复）',' ( 无需回复 ) ','[[QQ_SILENT]]']);
  const f2=bridgeFixture(t,{...h2.config,qqVoiceSend:true,voiceReplyMode:'voice',voiceQuietMode:'never'},h2.client);
  f2.bridge.media.voice={synthesize:async()=>{assert.fail('silence must not reach TTS');}};
  await f2.bridge.handle(f2.route,0);assert.equal(f2.sent.length,0);
});
test('silence detection preserves real prose and blocks placeholder send tools',async t=>{
  const h=await harness(t,async({call})=>{
    await assert.rejects(call('qq_send_message',{messages:['（无回复）']},'a'),/无回复/);
    await assert.rejects(call('qq_send_media',{voice:'(无回复)'},'b'),/无回复/);
    await call('qq_send_message',{messages:['你看到的“（无回复）”是占位文字。']},'c');return '';
  });
  const f=bridgeFixture(t,h.config,h.client);await f.bridge.handle(f.route,0);
  assert.deepEqual(text(f.sent),['你看到的“（无回复）”是占位文字。']);
});
test('no-reply ends the speaking phase without erasing messages already delivered',async t=>{
  const h=await harness(t,async({call})=>{
    await call('qq_send_message',{messages:['保留原句']},'a');
    await call('qq_no_reply',{},'b');return '额外正文';
  });
  const f=bridgeFixture(t,h.config,h.client);await f.bridge.handle(f.route,0);
  assert.deepEqual(text(f.sent),['保留原句']);
  assert.equal(h.agent.session.log.some(e=>e.type==='assistant/message'),false);
});
test('partial and unknown delivery receipts never claim success or resend messages',async t=>{
  const h=await harness(t,async({call})=>{
    const args={messages:['成功的一条','结果未知的一条','未发送的一条']};
    const receipt=(await call('qq_send_message',args)).result;
    assert.equal(receipt.sent,false);
    assert.deepEqual(receipt.messages.map(m=>m.state),['sent','unknown','not_sent']);
    await call('qq_send_message',args);
    await assert.rejects(call('qq_send_message',{messages:['不能重试']},'retry'),/不能继续自动发送/);
  });
  const f=bridgeFixture(t,h.config,h.client);let count=0;
  f.bridge.call=async()=>{if(++count===2)throw Object.assign(Error('disconnect'),{deliveryState:'unknown'});return {message_id:'101'};};
  await f.bridge.handle(f.route,0);
  assert.equal(count,2);
  const receipt=currentResults(h.agent).join('\n');
  assert.match(receipt,/"state":"sent"[\s\S]*成功的一条[\s\S]*"state":"unknown"[\s\S]*结果未知的一条[\s\S]*"state":"not_sent"[\s\S]*未发送的一条/);
  assert.equal(h.requests.some(r=>r.method==='qqRsiNative/release'&&r.payload.args.request.results),false);
  assert.equal(count,2);
});
test('immediate receipts do not depend on legacy UI receipt replacement',async t=>{
  const h=await harness(t,async({call})=>{await call('qq_send_message',{messages:['只发一次']});});
  h.runtime.delivery=()=>{throw Error('view unavailable');};
  const f=bridgeFixture(t,h.config,h.client),logs=[];f.bridge.systemLog={record:(...args)=>logs.push(args)};
  await f.bridge.handle(f.route,0);assert.deepEqual(text(f.sent),['只发一次']);
  assert.equal(logs.some(x=>x[0]==='delivery.receipt.failed'),false);
  assert.match(currentResults(h.agent).join('\n'),/"state":"sent"/);
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
    const diagnostic=(await call('qq_memory_diagnose',{},'diagnose')).result;
    await call('qq_memory_read',{page:'concepts/old.md'},'read');
    const maintenance={operations:[{action:'downgrade',page:'concepts/old.md',reason:'超过180天未访问'}],expectedRevision:diagnostic.revision};
    assert.equal((await call('qq_memory_maintain',maintenance,'preview')).result.preview,true);
    await call('qq_memory_digest',{summary:'降级温记忆',updates:[],maintenance},'digest');return '完成';
  });
  const f=bridgeFixture(t,h.config,h.client),life=f.session.life;
  fs.writeFileSync(f.bridge.memory(f.route.key).safe('concepts/old.md'),'---\ntype: concept\nsalience: 2\nlast_access: 2000-01-01\n---\n# 旧记忆\n原文');
  life.lastAt=0;life.compactions=[{id:'c1',sourceId:'source-c1'}];
  await maintain({session:f.session,config:h.config,store:f.bridge.memory(f.route.key),dsh:h.client,persist:()=>{},now:()=>Date.now(),isCurrent:()=>true,signal:new AbortController().signal,rotate:async()=>{}});
  assert.deepEqual(life.digestedIds,['c1']);assert.ok(life.receipt);assert.equal(f.sent.length,0);
  assert.match(fs.readFileSync(f.bridge.memory(f.route.key).safe('concepts/old.md'),'utf8'),/salience: 3/);
});
test('transport upgrade preserves old session and workspace but does not reuse JSON instructions',async t=>{
  const config={...defaults,dshNativeTools:true,privatePreset:'test',qqVoiceSend:false};
  const client={createSession:async()=> 'new-native',rename:async()=>{},prompt:async(_id,_text,{nativeTools})=>{await nativeTools.execute('qq_send_message',{messages:['原生回复']},'answer');return ['不应投递的正文'];}};
  const f=bridgeFixture(t,config,client);delete f.session.transport;f.session.promptVersion=1;
  await f.bridge.handle(f.route,0);
  assert.equal(f.bridge.state.retired[0].reason,'transport-upgrade');
  const current=f.bridge.state.sessions[f.bridge.scope(f.route)];
  assert.equal(current.id,'new-native');assert.equal(current.workspace,f.root);
  assert.equal(current.promptVersion,2);assert.deepEqual(text(f.sent),['原生回复']);
});
test('existing native conversation receives delegation policy once and only parent reply is delivered',async t=>{
  const h=await harness(t,async({message,turn,emit,call})=>{
    assert.equal(message.content[0].text.includes(DELEGATION_POLICY),turn===1);
    assert.equal(message.content[0].text.includes('持续对话规则'),turn===1);
    // Research/tool output is material for the parent, never a QQ reply itself.
    emit('tool/result',{turn,message:{id:'research-'+turn,role:'tool',callId:'research',content:[{type:'text',text:'子任务原始资料'}]}});
    await call('qq_send_message',{messages:['主智能体选择的答复'+turn]},'answer');return '内部说明';
  });
  const f=bridgeFixture(t,h.config,h.client);
  f.session.promptVersion=2;f.session.replyPolicyVersion=1;
  await f.bridge.handle(f.route,0);
  assert.equal(f.session.delegationPolicyVersion,DELEGATION_POLICY_VERSION);
  await f.bridge.handle({...f.route,messageId:'m2',qqMessageId:'2',text:'继续'},0);
  assert.equal(f.bridge.state.sessions[f.bridge.scope(f.route)].id,'session');
  assert.deepEqual(text(f.sent),['主智能体选择的答复1','主智能体选择的答复2']);
  assert.equal(h.messages.length,2);
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
