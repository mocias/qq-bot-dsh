import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validate} from '../lib/config.mjs';
import {policyView,resolveChatConfig} from '../lib/chat-policy.mjs';
import {MemoryStore} from '../lib/memory.mjs';
import {estimateMemoryBudget} from '../public/memory-budget.js';

const key='100000001/group/100000003';
test('large memory budgets survive validation, serialization and scoped inheritance',()=>{
  const config=validate({memoryBootMaxChars:100000,memoryPageMaxChars:200000,
    chatPolicy:{private:{memoryPageMaxChars:300001},group:{memoryBootMaxChars:600000},
      overrides:{[key]:{memoryPageMaxChars:900000}}}});
  const reloaded=validate(JSON.parse(JSON.stringify(config)));
  assert.equal(policyView(reloaded,'private').effective.memoryBootMaxChars,100000);
  assert.equal(policyView(reloaded,'private').effective.memoryPageMaxChars,300001);
  assert.equal(resolveChatConfig(reloaded,key).memoryBootMaxChars,600000);
  assert.equal(resolveChatConfig(reloaded,key).memoryPageMaxChars,900000);
  assert.equal(policyView(reloaded,'group').effective.memoryPageMaxChars,200000);
  for(const name of ['memoryBootMaxChars','memoryPageMaxChars']){
    assert.equal(policyView(reloaded,'group').fields[name].max,undefined);
    assert.match(policyView(reloaded,'group').fields[name].label,/字符数/);
    assert.equal(validate({[name]:Number.MAX_SAFE_INTEGER})[name],Number.MAX_SAFE_INTEGER);
    for(const value of [999,-1,1000.5,Infinity,NaN,Number.MAX_SAFE_INTEGER+1]){
      assert.throws(()=>validate({[name]:value}));
      assert.throws(()=>validate({chatPolicy:{group:{[name]:value}}}));
      assert.throws(()=>validate({chatPolicy:{overrides:{[key]:{[name]:value}}}}));
    }
  }
  assert.throws(()=>validate({proactiveMaxPerSession:101}));
});
test('estimates and warnings distinguish unknown windows, soft guidance and entered capacity',()=>{
  assert.equal(estimateMemoryBudget(1000,1000).warning,'unknown');
  const large=estimateMemoryBudget(100000,200000);
  assert.equal(large.total,300000n);assert.equal(large.low,75000n);assert.equal(large.high,300000n);
  assert.equal(large.warning,'large');
  assert.equal(estimateMemoryBudget(100000,200000,128000).warning,'over');
  assert.equal(estimateMemoryBudget(40000,40000,100000).warning,'near');
  assert.equal(estimateMemoryBudget(1000,1000,100000).warning,'none');
  assert.equal(estimateMemoryBudget(1000,1000,-10).reference,null);
  assert.equal(estimateMemoryBudget(NaN,1000).valid,false);
  assert.equal(estimateMemoryBudget(Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER).total,18014398509481982n);
});
test('budgets above 30000 actually reach boot documents and selected memory pages',t=>{
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-budget-'));
  t.after(()=>fs.rmSync(runtime,{recursive:true,force:true}));
  const store=new MemoryStore(runtime,key);
  fs.writeFileSync(path.join(store.dir,'SOUL.md'),'S'.repeat(35000)+'BOOT_END');
  fs.mkdirSync(path.join(store.dir,'user'),{recursive:true});
  for(let i=0;i<20;i++)fs.writeFileSync(path.join(store.dir,'user',`p${i}.md`),'P'.repeat(2900));
  const small=store.context('',validate({memoryBootMaxChars:1000,memoryPageMaxChars:1000}));
  const big=store.context('',validate({memoryBootMaxChars:100000,memoryPageMaxChars:100000}));
  assert.ok(!small.includes('BOOT_END'));assert.ok(big.includes('BOOT_END'));
  assert.ok(big.length>90000);assert.ok(small.length<10000);
});
