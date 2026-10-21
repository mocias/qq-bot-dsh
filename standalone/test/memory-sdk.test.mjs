import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeRuntime} from '../../native-dsh-plugin/lib/runtime.mjs';
import {VERSION,PROTOCOL,BUILD_ID} from '../../native-dsh-plugin/lib/schema.mjs';

// Optional installed-host contract test; only in-memory registries, no profile,
// model, OneBot connection, or private memory is read or written.
test('installed DSH SDK scopes and refreshes memory context and disposes the skill',{
  skip:!process.env.QQ_RSI_DSH_SDK_ROOT
},async()=>{
  const base=process.env.QQ_RSI_DSH_SDK_ROOT.replace(/\/$/,'');
  const [{Context},{createScope},{SystemPrompt},{SkillRegistry}]=await Promise.all(
    ['cordis','dsh-scope','dsh-system-prompt','dsh-skill'].map(name=>import(base+'/'+name+'/lib/index.js')));
  const ctx=new Context();await ctx.plugin(SystemPrompt,{});await ctx.plugin(SkillRegistry,{});
  const agent={status:'idle'},other={status:'idle'};
  let scope;await ctx.inject(['systemPrompt'],inner=>{scope=createScope(inner,agent);});
  let otherScope;await ctx.inject(['systemPrompt'],inner=>{otherScope=createScope(inner,other);});
  const listeners=new Map();
  assert.throws(()=>scope.ctx.skills,/without inject/);
  agent.ctx={systemPrompt:scope.ctx.systemPrompt,inject:(...args)=>scope.ctx.inject(...args),
    get skills(){return scope.ctx.skills;},
    tools:{presentAs:()=>()=>{},register:()=>()=>{}},on:(name,fn)=>{listeners.set(name,fn);return ()=>listeners.delete(name);}};
  agent.followup=agent.steer=message=>listeners.get('agent/inbox/claimed')({message});
  const runtime=new NativeRuntime({agents:{get:id=>id==='memory-test'?agent:null}},x=>x);
  const request={sessionId:'memory-test',runId:'run',requestId:'input-1',mode:'queue',content:[{type:'text',text:'本轮消息'}],
    callback:{url:'http://127.0.0.1:12345/tool',token:'a'.repeat(64)},allowed:[],version:VERSION,protocol:PROTOCOL,buildId:BUILD_ID,
    memoryContext:{text:'记忆版本一 {{literal}}',skill:'通过当前聊天工具读写记忆'}};
  try{
    assert.equal((await runtime.submit({...request,memoryContext:undefined})).accepted,true);
    runtime.release({sessionId:'memory-test',runId:'run'});
    assert.equal((await runtime.submit({...request,memoryContext:{text:'上线人设',skill:''}})).accepted,true);
    runtime.release({sessionId:'memory-test',runId:'run'});
    assert.equal((await runtime.submit(request)).accepted,true);
    const initial=await scope.ctx.systemPrompt.assemble({scope:agent,agent});
    assert.equal(initial.contexts.find(x=>x.name==='qq-rsi-memory').text,'记忆版本一 {{literal}}');
    assert.equal(initial.contexts.find(x=>x.name==='qq-rsi-memory').interpolate,false);
    assert.equal((await ctx.skills.get('qq-memory',{scope:agent})).content,request.memoryContext.skill);
    assert.equal(await ctx.skills.get('qq-memory',{scope:other}),undefined);
    assert.equal((await otherScope.ctx.systemPrompt.assemble({scope:other,agent:other})).contexts.some(x=>x.name==='qq-rsi-memory'),false);
    await runtime.submit({...request,requestId:'input-2',mode:'steer',memoryContext:{...request.memoryContext,text:'记忆版本二'}});
    const refreshed=scope.ctx.systemPrompt.refreshContext(initial,{scope:agent,agent});
    assert.equal(refreshed.contexts.filter(x=>x.name==='qq-rsi-memory').length,1);
    assert.equal(refreshed.contexts.find(x=>x.name==='qq-rsi-memory').text,'记忆版本二');
    listeners.get('agent/inbox/claimed')({message:{source:{kind:'user'}}});
    assert.equal(scope.ctx.systemPrompt.refreshContext(initial,{scope:agent,agent}).contexts.find(x=>x.name==='qq-rsi-memory').text,'');
    runtime.release({sessionId:'memory-test',runId:'run'});
    assert.equal(await ctx.skills.get('qq-memory',{scope:agent}),undefined);
    assert.equal((await scope.ctx.systemPrompt.assemble({scope:agent,agent})).contexts.some(x=>x.name==='qq-rsi-memory'),false);
  }finally{runtime.dispose();await scope.dispose();await otherScope.dispose();}
});
