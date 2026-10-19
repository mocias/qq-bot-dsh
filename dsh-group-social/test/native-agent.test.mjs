import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as core from '../lib/core.mjs';
import * as security from '../lib/security.mjs';

function assertJsonData(value){
  if(value===null||typeof value==='string'||typeof value==='boolean')return;
  if(typeof value==='number'){assert.equal(Number.isFinite(value),true);return;}
  assert.equal(typeof value,'object','native durable events cannot contain undefined values');
  for(const child of Object.values(value))assertJsonData(child);
}

async function moduleUnderTest(){
  const context=vm.createContext({process,Set,Map,Promise,Date,Error,JSON});let n=0;
  const deps={'node:path':{default:path},'./core.mjs':core,'./security.mjs':security,
    '@deepseek-ai/dsh-llm':{createUserMessage:input=>({id:'native-message-'+(++n),role:'user',...input})},
    '@deepseek-ai/dsh-agent':{installModelSelection:(scope,ref)=>{scope.selection=ref;}}};
  const m=new vm.SourceTextModule(readFileSync(new URL('../lib/native-agent.mjs',import.meta.url),'utf8'),{context});
  await m.link(specifier=>new vm.SyntheticModule(Object.keys(deps[specifier]),function(){for(const [key,value]of Object.entries(deps[specifier]))this.setExport(key,value);},{context}));
  await m.evaluate();return m.namespace;
}
function host(){
  const listeners=new Map(),scoped=new Map(),settings={},received=[],attached=[];let turn=0,seq=0;
  const on=(map,name,fn)=>{const list=map.get(name)??[];list.push(fn);map.set(name,list);return()=>map.set(name,list.filter(f=>f!==fn));};
  const emit=(name,...args)=>{for(const fn of listeners.get(name)??[])fn(...args);};
  const h={settings,received,attached,reply:'native answer',tools:[],reason:{kind:'completed'}};
  const scope={tools:{presentAs:v=>{settings.mode=v;},restrict:v=>{settings.restriction=v;},guard:fn=>{settings.guard=fn;}},
    systemPrompt:{section:v=>{settings.section=v;}},on:(name,fn)=>on(scoped,name,fn)};
  const ctx={on:(name,fn)=>on(listeners,name,fn),
    llm:{prepareCall(){throw Error('CUSTOM_LLM_CALL_FORBIDDEN');}},
    sessionPersistence:{stat:async()=>h.metadata,open:async()=>({read:async()=>({events:[]}),close:async()=>{}})},
    sessions:{flush:async()=>true},sessionTitle:{rename:(_s,title)=>{settings.title=title;}},
    agents:{get:()=>undefined,create:async args=>{settings.created=args;await args.setup(scope);h.agent=makeAgent(args);return {agent:h.agent,dispose:async()=>{settings.disposed=true;}};},
      resume:async args=>{settings.resumed=args;await args.setup(scope);h.agent=makeAgent(args);return {agent:h.agent,dispose:async()=>{settings.disposed=true;}};}}};
  function makeAgent(args){const agent={id:args.sessionId??args.resumeSessionId,session:{id:args.sessionId??args.resumeSessionId,header:{cwd:args.meta?.cwd??path.resolve('group-native')}},
    inbox:{remove:()=>true},whenIdle:async()=>{},cancel:()=>{settings.canceled=true;},followup:message=>{
      assertJsonData(message);received.push(message);queueMicrotask(async()=>{
        const t=++turn,send=(type,data)=>emit('session/event',agent.session,{type,data,seq:seq++});
        send('turn/start',{turn:t});for(const fn of scoped.get('agent/inbox/claimed')??[])fn({agent,message,turn:t});
        if(h.steer)for(const fn of scoped.get('agent/inbox/claimed')??[])fn({agent,message:h.steer,turn:t});
        send('request/header',{header:{config:args.agentOptions,tools:security.GROUP_TOOLS.map(name=>({name}))},reason:'initial'});
        await h.onTool?.(agent,t);
        for(const name of h.tools)send('tool/call',{turn:t,step:1,name});
        send('assistant/message',{turn:t,step:1,message:{content:[{type:'reasoning',text:'not public'},{type:'text',text:h.reply}]}});
        send('turn/end',{turn:t,reason:h.reason});
      });
    }};return agent;}
  h.ctx=ctx;h.workspace={attachSession:async id=>attached.push(id)};h.scope=scope;
  h.assemble=async()=>{
    let value={sections:[{text:'PRIVATE_PERSONA_CANARY'}],contexts:[{name:'memory-boot',text:'PRIVATE_MEMORY_CANARY'}],variables:{SECRET:'private'},tools:[...security.GROUP_TOOLS.map(name=>({name})),{name:'exec'},{name:'read_file'}]};
    for(const fn of scoped.get('system-prompt/assemble')??[]){const prior=value;value=await fn(value,{},async()=>prior);}
    return value;
  };
  return h;
}
test('real group controller creates the native Agent with scoped Qoder, a complete prompt and only native safe tools',async()=>{
  const {NativeGroupAgent,NATIVE_AGENT_ID}=await moduleUnderTest(),h=host(),updates=[];
  const a=new NativeGroupAgent(h.ctx,path.resolve('group-native'),{selection:{provider:'qoder-cn',model:'DeepSeek-Flash',reasoningEffort:'high'},getPrompt:()=> 'GROUP_ONLY_PERSONA',onStatus:v=>updates.push(v)});
  await a.start(h.workspace);
  assert.equal(h.settings.created.sessionId,NATIVE_AGENT_ID);assert.equal(h.settings.created.agentOptions.provider,'qoder-cn');
  assert.equal(h.settings.mode,'native');assert.deepEqual(Array.from(h.settings.restriction.allow),security.GROUP_TOOLS);
  assert.equal(h.settings.section.complete,true);assert.equal(h.settings.section.text(),'GROUP_ONLY_PERSONA');
  const assembled=await h.assemble();assert.equal(assembled.contexts.length,0);assert.equal(Object.keys(assembled.variables).length,0);
  assert.deepEqual(assembled.tools.map(t=>t.name),security.GROUP_TOOLS);
  assert.match(h.settings.guard({agent:h.agent,name:'exec'}),/禁用/);
  assert.equal(h.attached[0],NATIVE_AGENT_ID);await a.close();assert.equal(h.settings.disposed,true);
});
test('QQ native turn completion is correlated to its input and tool authority; probes and local UI never forward to QQ',async()=>{
  const {NativeGroupAgent}=await moduleUnderTest(),h=host(),delivered=[],updates=[];
  const a=new NativeGroupAgent(h.ctx,path.resolve('group-native'),{selection:{provider:'qoder-cn',model:'DeepSeek-Flash'},getPrompt:()=> 'GROUP',onStatus:v=>updates.push(v),onGroupResult:async r=>delivered.push(r)});
  await a.start(h.workspace);h.tools=['qq_group_memory'];
  h.onTool=agent=>{const c=a.contextForTool({agent});assert.equal(c.origin,'qq');assert.equal(c.evidenceIds.has('qq-1'),true);};
  const result=await a.run({messages:[{id:'qq-1',text:'群消息'}]},{origin:'qq',operationId:'operation-1'});
  assert.equal(result.text,'native answer');assert.equal(delivered.length,1);assert.equal(delivered[0].operationId,'operation-1');
  const request=updates.find(v=>v.lastRequest).lastRequest;assert.equal(request.provider,'qoder-cn');assert.equal(request.model,'DeepSeek-Flash');assert.deepEqual(Array.from(request.tools),security.GROUP_TOOLS);
  h.onTool=undefined;await a.run('只读检查',{origin:'probe'});assert.equal(delivered.length,1);
  assert.equal(Object.hasOwn(h.received.at(-1).source,'operationId'),false);
  h.agent.followup({id:'local-ui',source:{kind:'user'},content:[{type:'text',text:'本地管理问题'}]});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(delivered.length,1);await a.close();
});
test('local UI steering mixed into a QQ turn is not broadcast, and failed turns do not send partial output',async()=>{
  const {NativeGroupAgent}=await moduleUnderTest(),h=host(),sent=[];
  const a=new NativeGroupAgent(h.ctx,path.resolve('group-native'),{selection:{provider:'qoder-cn',model:'DeepSeek-Flash'},getPrompt:()=> 'GROUP',onGroupResult:async r=>sent.push(r)});
  await a.start(h.workspace);h.steer={id:'local-steer',source:{kind:'user'},content:[]};
  const mixed=await a.run({messages:[{id:'qq-2'}]},{origin:'qq'});assert.equal(mixed.origin,'mixed');assert.equal(sent.length,0);
  h.steer=undefined;h.reason={kind:'failed',message:'upstream unavailable'};
  await assert.rejects(a.run({messages:[{id:'qq-3'}]},{origin:'qq'}),/did not complete/);assert.equal(sent.length,0);await a.close();
});
test('a stored native session belonging to another workspace is rejected before resuming',async()=>{
  const {NativeGroupAgent}=await moduleUnderTest(),h=host();h.metadata={header:{cwd:path.resolve('private-companion')}};
  const a=new NativeGroupAgent(h.ctx,path.resolve('group-native'),{selection:{provider:'qoder-cn',model:'DeepSeek-Flash'},getPrompt:()=> 'GROUP'});
  await assert.rejects(a.start(h.workspace),/another workspace/);assert.equal(h.settings.resumed,undefined);await a.close();
});
