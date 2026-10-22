import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {bindModelSettings} from '../../native-dsh-plugin/lib/model-settings.mjs';

// These checks only run against the installed DSH runtime, because the point is
// that the production per-agent wrapper keeps working with the real compaction
// class instead of only with the mock used by the unit tests.
const raw=process.env.QQ_RSI_DSH_SDK_ROOT?.replace(/[\\/]$/,'');
const root=raw?(raw.startsWith('file:')?raw:pathToFileURL(raw).href):'';
test('per-agent window wrapper survives the installed compaction class and restores it on dispose',{skip:!root},async()=>{
  const {default:BasicCompactionEngine}=await import(root+'/dsh-compaction-basic/lib/index.js');
  const real=BasicCompactionEngine.prototype.compactIfNeeded;
  assert.equal(typeof real,'function');
  let reached=null;
  const info={context:{contextWindow:1000000}};
  const llm={resolveModelInfo:async(provider,model)=>{reached={provider,model};return info;}};
  const ctx={llm,tokenMeter:{measure:()=>({totalTokens:1})},get:()=>undefined};
  const engine=Object.create(BasicCompactionEngine.prototype);
  engine.config={modelPolicies:[],thresholdRatio:0.8,headroomTokens:1000,retainRatio:0.2,summarizationProvider:''};
  engine.ctx=ctx;
  Object.defineProperty(engine,'hiddenOwn',{value:'kept',enumerable:false});
  const agent={session:{requestHeader:()=>({config:{provider:'p',model:'m'}})},ctx:{llm},prepareRequest:async()=>({preparedCall:{context:{contextWindow:1000000}}})};
  const controller={selectForNextRequest:()=>{},selectionFor:()=>({current:{provider:'p',model:'m'}})};
  const binding=await bindModelSettings(agent,engine,{contextWindow:400000},controller);
  assert.deepEqual(binding.warnings,[]);
  assert.notEqual(engine.compactIfNeeded,real);
  // The wrapper must hand the real class a receiver that still owns every field,
  // including non-enumerable ones, and whose ctx.llm lookup goes through the proxy.
  const result=await engine.compactIfNeeded(agent,'pressure',undefined);
  assert.ok(reached,'the real compaction body reached the per-agent model lookup');
  assert.equal(reached.provider,'p');assert.equal(reached.model,'m');
  assert.equal(result,null,'the fixture stays below the compaction threshold');
  assert.equal(Object.getOwnPropertyDescriptor(engine,'hiddenOwn').value,'kept');
  assert.ok(engine instanceof BasicCompactionEngine);
  binding.dispose();
  assert.equal(engine.compactIfNeeded,real);
});
