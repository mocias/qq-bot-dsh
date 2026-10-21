import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeRuntime} from '../../native-dsh-plugin/lib/runtime.mjs';
import {VERSION,PROTOCOL,BUILD_ID} from '../../native-dsh-plugin/lib/schema.mjs';
import {nativeCallback} from '../lib/native-callback.mjs';

for(const isolated of [false,true])test('installed Cordis '+(isolated?'isolated preset':'global')+' compaction supports reversible QQ handoff hooks', {skip:!process.env.QQ_RSI_DSH_SDK_ROOT},async()=>{
  const base=process.env.QQ_RSI_DSH_SDK_ROOT.replace(/\/$/,'');
  const [{Context},{createScope},{SystemPrompt},{CompactionEngine},{BasicCompactionEngine},{AgentPresetRegistry}]=await Promise.all(
    ['cordis','dsh-scope','dsh-system-prompt','dsh-compaction','dsh-compaction-basic','dsh-agent-preset-registry'].map(name=>import(base+'/'+name+'/lib/index.js')));
  assert.equal(typeof BasicCompactionEngine.prototype.compactRegion,'function');assert.equal(typeof BasicCompactionEngine.prototype.summarize,'function');
  class FakeCompaction extends CompactionEngine{
    async summarize(input){assert.match(input.messages.at(-1).content[0].text,/未完成事项/);return [{type:'text',text:'未完成：等待地址'}];}
    async compactRegion(start,end,agent,signal){return {compactionId:'sdk-compact',summary:await this.summarize({messages:[]},agent,signal)};}
  }
  const ctx=new Context();await ctx.plugin(SystemPrompt,{});const provider=await (isolated?ctx.isolate('compaction'):ctx).plugin(FakeCompaction);
  // Real host serviceFor walks the isolated preset mount, not agent.ctx.inject.
  const presets={owner:ctx,generationFor:()=>({mount:{fiber:provider}}),serviceFor:AgentPresetRegistry.prototype.serviceFor};
  const agent={status:'idle',session:{id:'sdk-agent',log:[]}},listeners=new Map(),registered=new Map();
  let scope;await ctx.inject(['systemPrompt'],inner=>{scope=createScope(inner,agent);});
  agent.ctx={systemPrompt:scope.ctx.systemPrompt,inject:(...args)=>scope.ctx.inject(...args),
    tools:{presentAs:()=>()=>{},register:def=>{registered.set(def.name,def);return ()=>registered.delete(def.name);}},
    on:(name,fn)=>{listeners.set(name,fn);return ()=>listeners.delete(name);}};
  agent.followup=message=>listeners.get('agent/inbox/claimed')({message});
  const calls=[],controller=new AbortController();
  const callback=await nativeCallback({sessionId:'sdk-agent',runId:'run',allowed:[],execute:()=>{},signal:controller.signal,continuous:true,control:async(action,args)=>{calls.push({action,args});return {saved:true};}});
  const runtime=new NativeRuntime({agents:{get:()=>agent},...(isolated?{agentPresets:presets}:{})},x=>x);
  try{
    if(isolated){assert.equal(runtime.probe({sessionId:'sdk-agent'}).presetCompaction,'available');assert.equal(runtime.bindings.size,0);}
    assert.equal((await runtime.submit({sessionId:'sdk-agent',runId:'run',requestId:'input',mode:'queue',content:[{type:'text',text:'QQ test'}],
      callback:{url:callback.url,token:callback.token},allowed:['qq_wait_for_messages','qq_handoff'],version:VERSION,protocol:PROTOCOL,buildId:BUILD_ID,continuous:true,handoff:true})).accepted,true);
    const engine=presets.serviceFor(agent,'compaction');
    assert.ok(engine);if(isolated)assert.equal(scope.ctx.get('compaction'),undefined);
    await engine.compactRegion(0,0,agent,new AbortController().signal);
    assert.deepEqual(calls.map(x=>x.action),['begin','part','commit']);assert.equal(calls.at(-1).args.compactionId,'sdk-compact');
    const assembled=await scope.ctx.systemPrompt.assemble({scope:agent,agent});assert.match(assembled.contexts.find(x=>x.name==='qq-rsi-handoff').text,/交接恢复待办/);
    runtime.release({sessionId:'sdk-agent',runId:'run'});assert.equal(registered.size,0);
  }finally{runtime.dispose();await callback.close();await scope.dispose();}
});
