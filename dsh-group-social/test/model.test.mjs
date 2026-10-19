import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

async function loadModel() {
  const context = vm.createContext({});
  const model = new vm.SourceTextModule(readFileSync(new URL('../lib/model.mjs', import.meta.url), 'utf8'), { context });
  const messages = new vm.SyntheticModule(['createSystemMessage','createUserMessage'], function() {
    this.setExport('createSystemMessage', text=>({role:'system',text}));
    this.setExport('createUserMessage', value=>({role:'user',...value}));
  }, {context});
  await model.link(specifier=>{assert.equal(specifier,'@deepseek-ai/dsh-llm');return messages;});
  await model.evaluate();
  return model.namespace;
}

test('actual model wrapper excludes host tools and private system context, even if provider defaults contain tools', async () => {
  const model=await loadModel();
  let request;
  const ctx = {
    systemPrompt: { context(){throw Error('PRIVATE_CONTEXT_MUST_NOT_BE_READ');} },
    tools: { execute(){throw Error('HOST_TOOL_MUST_NOT_BE_EXECUTED');} },
    agentDefaultModel: {currentSelection:()=>({})},
    llm: {prepareCall:async()=>({config:{tools:[{name:'shell'}]},stream:async function*(value){
      request=value;
      yield {type:'tool-call',name:'write_file',arguments:{path:'C:/private/SOUL.md'}};
      yield {type:'text-delta',text:'{"reply":"不能改电脑文件"}'};
    }})},
  };
  const result = await model.generate(ctx,'GROUP_PERSONA','GROUP_HISTORY');
  assert.equal(request.tools.length,0);assert.equal(request.messages.length,2);
  assert.equal(request.messages[0].text,'GROUP_PERSONA');
  assert.equal(request.messages[1].content[0].text,'GROUP_HISTORY');
  assert.equal(JSON.stringify(request).includes('PRIVATE_CONTEXT'),false);
  assert.match(result,/不能改电脑文件/);
});

test('group override uses Qoder without changing the host default and reports the successful route', async () => {
  const model=await loadModel();
  const hostDefault={provider:'deepseek-account',model:'deepseek-flash',reasoningEffort:'high'};
  const routes=[];let request,success;
  const ctx={agentDefaultModel:{currentSelection:()=>hostDefault},llm:{prepareCall:async(route,signal,configure)=>{
    routes.push({...route});
    const controls=configure({}, {reasoning:{efforts:[{id:'low'},{id:'high'}]}});
    return {config:{...route,...controls},stream:async function*(value){request=value;yield {type:'text-delta',text:'{"reply":"ready"}'};}};
  }}};
  await model.generate(ctx,'group','probe',undefined,{modelProvider:'qoder-cn',modelId:'DeepSeek-Flash',reasoningEffort:'high',onSuccess:r=>{success=r;}});
  assert.deepEqual(routes,[{provider:'qoder-cn',model:'DeepSeek-Flash',reasoningEffort:'high'}]);
  assert.equal(request.provider,'qoder-cn');assert.equal(request.tools.length,0);assert.equal(request.reasoningEffort,'high');
  assert.equal(success.provider,'qoder-cn');assert.equal(success.model,'DeepSeek-Flash');
  assert.deepEqual(hostDefault,{provider:'deepseek-account',model:'deepseek-flash',reasoningEffort:'high'});
  assert.equal(model.selectGroupModel(hostDefault).provider,'deepseek-account');
});

test('partial model settings and unavailable Qoder fail without falling back to the host provider', async () => {
  const model=await loadModel();let calls=0;
  const ctx={agentDefaultModel:{currentSelection:()=>({provider:'deepseek-account',model:'deepseek-flash'})},llm:{prepareCall:async route=>{
    calls++;assert.equal(route.provider,'qoder-cn');throw Error('QODER_UNAVAILABLE');
  }}};
  await assert.rejects(model.generate(ctx,'group','probe',undefined,{modelProvider:'qoder-cn'}),/requires both/);
  assert.equal(calls,0);
  await assert.rejects(model.generate(ctx,'group','probe',undefined,{modelProvider:'qoder-cn',modelId:'DeepSeek-Flash'}),/QODER_UNAVAILABLE/);
  assert.equal(calls,1);
});
