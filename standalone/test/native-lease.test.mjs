import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeRuntime} from '../../native-dsh-plugin/lib/runtime.mjs';
import {VERSION,PROTOCOL,BUILD_ID} from '../../native-dsh-plugin/lib/schema.mjs';

async function fixture(t){
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
  const registered=new Map(),listeners=new Map();let cancels=0;
  const agent={status:'idle',session:{},cancel(){cancels++;},ctx:{tools:{presentAs:()=>()=>{},register(t){registered.set(t.name,t);return ()=>registered.delete(t.name);}},on(name,fn){listeners.set(name,fn);return ()=>listeners.delete(name);}}};
  agent.followup=message=>{agent.status='running';listeners.get('session/event')(agent.session,{type:'turn/start',data:{turn:1}});listeners.get('agent/inbox/claimed')({message});};
  const runtime=new NativeRuntime({agents:{get:()=>agent}},x=>x);t.after(()=>runtime.dispose());
  const request={sessionId:'session',runId:'run',requestId:'input',mode:'queue',content:[{type:'text',text:'digest'}],callback:{url:'http://127.0.0.1:12345/tool',token:'a'.repeat(64)},allowed:['qq_memory_read','qq_memory_digest'],version:VERSION,protocol:PROTOCOL,buildId:BUILD_ID};
  await runtime.submit(request);
  const control=action=>runtime.release({sessionId:'session',runId:'run',token:request.callback.token,action});
  const end=()=>{agent.status='idle';listeners.get('session/event')?.(agent.session,{type:'turn/end',data:{turn:1,reason:'cancelled'}});};
  return {runtime,registered,agent,control,end,cancels:()=>cancels};
}

test('renewed tools remain registered after both 180 and 240 seconds',async t=>{
  const f=await fixture(t);
  for(let n=0;n<12;n++){t.mock.timers.tick(30000);assert.equal(f.control('renew').renewed,true);}
  assert.equal(f.registered.size,2);assert.equal(f.runtime.bindings.get('session').invalidated,undefined);
  f.end();assert.equal(f.control('finish').released,true);assert.equal(f.registered.size,0);
});

test('lost lease revokes execution but retains tool names until cancellation ends',async t=>{
  const f=await fixture(t);t.mock.timers.tick(240001);
  assert.equal(f.registered.size,2);assert.ok(f.runtime.bindings.get('session').invalidated);
  await assert.rejects(f.registered.get('qq_memory_digest').execute({}, {agent:f.agent,signal:new AbortController().signal}),/失效/);
  assert.throws(()=>f.control('renew'),/失效/);
  f.end();assert.equal(f.registered.size,0);assert.equal(f.runtime.bindings.size,0);
});

test('early release never removes tools from a live agent; renewal cannot revive revoked authority',async t=>{
  const f=await fixture(t);assert.equal(f.control('finish').released,false);assert.equal(f.registered.size,2);
  assert.throws(()=>f.control('renew'),/失效/);f.end();assert.equal(f.registered.size,0);
});

test('lease control requires the current capability and cannot affect another run',async t=>{
  const f=await fixture(t);
  assert.throws(()=>f.runtime.release({sessionId:'session',runId:'run',action:'renew',token:'b'.repeat(64)}),/授权/);
  assert.throws(()=>f.runtime.release({sessionId:'session',runId:'other',action:'invalidate',token:'a'.repeat(64)}),/不匹配/);
  assert.equal(f.registered.size,2);assert.equal(f.runtime.bindings.get('session').invalidated,undefined);
});
