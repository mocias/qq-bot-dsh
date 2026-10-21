import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeRuntime} from '../../native-dsh-plugin/lib/runtime.mjs';
import {VERSION,PROTOCOL,BUILD_ID} from '../../native-dsh-plugin/lib/schema.mjs';

test('installed DSH dispatches the scoped pre-stop hook and preserves cancellation', {skip:!process.env.QQ_RSI_DSH_SDK_ROOT},async()=>{
 const base=process.env.QQ_RSI_DSH_SDK_ROOT.replace(/\/$/,'');
 const [{Context},{createScope},{SystemPrompt},{agentEvents}]=await Promise.all(['cordis','dsh-scope','dsh-system-prompt','dsh-agent'].map(n=>import(base+'/'+n+'/lib/index.js')));
 const ctx=new Context();await ctx.plugin(SystemPrompt,{});
 const agent={status:'idle',session:{}},messages=[];let scope;
 await ctx.inject(['systemPrompt'],inner=>{scope=createScope(inner,agent);});
 agent.ctx={on:(...args)=>scope.ctx.on(...args),tools:{presentAs:()=>()=>{},register:()=>()=>{}}};
 const dispatch=agentEvents(scope.ctx,agent);
 agent.followup=message=>{agent.status='running';dispatch.emit('agent/inbox/claimed',{message});};
 agent.steer=message=>{messages.push(message);dispatch.emit('agent/inbox/claimed',{message});};
 const runtime=new NativeRuntime({agents:{get:()=>agent}},x=>x);
 try{
  const result=await runtime.submit({sessionId:'test',runId:'run',requestId:'input',mode:'queue',content:[{type:'text',text:'test'}],callback:{url:'http://127.0.0.1:12345/tool',token:'a'.repeat(64)},allowed:['qq_wait_for_messages'],version:VERSION,protocol:PROTOCOL,buildId:BUILD_ID,continuous:true});
  assert.equal(result.accepted,true);
  const controller=new AbortController();await dispatch.serial('agent/turn-stopping',{turn:1,signal:controller.signal});
  assert.equal(messages.length,1);assert.equal(messages[0].source.continuation,true);
  controller.abort();await dispatch.serial('agent/turn-stopping',{turn:1,signal:controller.signal});assert.equal(messages.length,1);
  assert.equal(runtime.bindings.get('test').claimed,true);
 }finally{runtime.dispose();await scope.dispose();}
});
