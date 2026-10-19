import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {GroupStore} from '../lib/security.mjs';
import {GroupMemory,buildNativeGroupPrompt} from '../lib/memory.mjs';

function fixture(t){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'qq-native-memory-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(base)),path.resolve(os.tmpdir()));assert.ok(path.basename(base).startsWith('qq-native-memory-'));fs.rmSync(base,{recursive:true,force:true});});
  const workspace=path.join(base,'group'),root=path.join(workspace,'.memory'),runtime=path.join(workspace,'.runtime'),persona=path.join(root,'PERSONA.md');
  const store=new GroupStore(workspace,{root,runtime,persona});
  fs.writeFileSync(persona,'GROUP_BASE_PERSONA');store.write('memory','已有群内事实');
  const privateFile=path.join(base,'PRIVATE.md');fs.writeFileSync(privateFile,'PRIVATE_CANARY');
  return {store,memory:new GroupMemory(store),persona,privateFile};
}
test('native memory tool persists sourced group facts and persona evolution, with an audit and no private/base-persona writes',t=>{
  const f=fixture(t),authority={origin:'qq',evidenceIds:new Set(['qq-1'])};
  const result=f.memory.execute({action:'update',memory:'群里喜欢讨论CS',persona:{tone:'简短有梗',interests:['CS'],habits:['事实拿不准先搜索']},reason:'群内多次讨论和明确反馈',evidence_message_ids:['qq-1']},authority);
  assert.equal(result.personaChanged,true);assert.equal(result.memoryChanged,true);
  const resumed=new GroupMemory(f.store);assert.equal(resumed.read().persona.tone,'简短有梗');
  assert.match(buildNativeGroupPrompt(f.store,resumed),/事实拿不准先搜索/);
  assert.match(f.store.read('log'),/qq-1/);assert.match(f.store.read('log'),/执行完成/);
  assert.equal(fs.readFileSync(f.persona,'utf8'),'GROUP_BASE_PERSONA');assert.equal(fs.readFileSync(f.privateFile,'utf8'),'PRIVATE_CANARY');
  assert.equal(buildNativeGroupPrompt(f.store,resumed).includes('PRIVATE_CANARY'),false);
  assert.throws(()=>resumed.execute({action:'update',memory:'第二次',reason:'again',evidence_message_ids:['qq-1']},authority),/one successful/);
});
test('untrusted sources, forged evidence, paths and permission changes cannot use persona memory as a file-write escape',t=>{
  const f=fixture(t),update={action:'update',memory:'modified',reason:'test',evidence_message_ids:['qq-1']};
  assert.throws(()=>f.memory.execute(update,{origin:'probe',evidenceIds:new Set(['qq-1'])}),/cannot update/);
  assert.throws(()=>f.memory.execute(update,{origin:'qq',evidenceIds:new Set(['other'])}),/source IDs/);
  assert.throws(()=>f.memory.execute({...update,path:f.privateFile},{origin:'local-ui'}),/Unsupported/);
  assert.throws(()=>f.memory.execute({...update,persona:{permissions:'full-access'}},{origin:'local-ui'}),/only update/);
  assert.equal(f.store.read('memory'),'已有群内事实');assert.equal(fs.readFileSync(f.privateFile,'utf8'),'PRIVATE_CANARY');
});
test('a read-only probe can inspect group memory, while explicit local owner changes are audited separately',t=>{
  const f=fixture(t);
  assert.equal(f.memory.execute({action:'read'},{origin:'probe'}).memory,'已有群内事实');
  f.memory.execute({action:'update',persona:{habits:['少用反问句']},reason:'本地用户明确要求'}, {origin:'local-ui'});
  assert.equal(f.memory.read().persona.lastUpdate.origin,'local-ui');
  assert.match(f.store.read('log'),/本地用户明确要求/);
});
