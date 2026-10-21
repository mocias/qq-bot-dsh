import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {MemoryStore} from '../lib/memory.mjs';
import {readMemory,searchMemory,revisionOf} from '../lib/memory-access.mjs';
import {historyStatus,snapshotHistory} from '../lib/memory-history.mjs';
import {memoryRuntimeContext} from '../lib/memory-context.mjs';
import {defaults} from '../lib/config.mjs';
import {Management} from '../lib/management.mjs';
import {ChatTools} from '../lib/chat-tools.mjs';
const key='100000001/private/100000002';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-memory-flow-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,store:new MemoryStore(dir,key)};}
function save(store,text,id='save-1',extra={}){return store.commit([{action:'write',page:'user/100000002.md',text,reason:'测试',evidence:[id],...extra}],{id,evidenceIds:[id]});}

test('full text search and paginated reads find the end of a long page without truncating storage',t=>{
  const {store}=fixture(t);save(store,'# 人物\n'+'原文'.repeat(7000)+'末尾独有词');
  const hit=searchMemory(store,{query:'末尾独有词'}).results[0];assert.ok(hit.matchOffset>12000);
  let cursor=0,revision,all='';do{const page=readMemory(store,{page:hit.page,offset:cursor,limit:4000,revision});all+=page.text;cursor=page.nextOffset;revision=page.revision;}while(cursor!==null);
  assert.equal(all,fs.readFileSync(store.safe(hit.page),'utf8'));assert.match(all,/末尾独有词/);
  const before=readMemory(store,{page:hit.page});save(store,'# 更新','save-2');
  assert.throws(()=>readMemory(store,{page:hit.page,offset:4000,revision:before.revision}),/改变/);
  assert.throws(()=>save(store,'覆盖','save-3',{expectedRevision:before.revision}),/改变/);
});

test('memory access excludes raw, internal files and other chats; search never broadens scope',t=>{
  const {dir,store}=fixture(t);save(store,'# 本聊天\n私有甲');
  const other=new MemoryStore(dir,'100000001/group/100000002');save(other,'# 另一个聊天\n群私有乙');
  assert.equal(searchMemory(store,{query:'群私有乙'}).total,0);
  for(const page of ['../index.md','raw/conversations/x.json','.runtime/store.json','C:/secrets','user/../index.md','user\\x.md'])assert.throws(()=>readMemory(store,{page}));
  assert.throws(()=>searchMemory(store,{query:'甲',key:other.key}));
  assert.throws(()=>readMemory(store,{page:'index.md',recipient:'100000003'}));
  assert.equal(readMemory(store,{page:'user/100000003.md'}).exists,false);
});

test('local Git retains baseline, edits and forget history but excludes original messages and runtime files',t=>{
  const {store}=fixture(t);store.record({id:'raw-original',text:'原文'.repeat(20000)});
  fs.writeFileSync(store.safe('credential.private.json'),'secret');
  save(store,'# 偏好\n茶');assert.equal(historyStatus(store).state,'ready');
  const git=args=>execFileSync('git',['--git-dir='+store.safe('.runtime/history.git'),...args],{encoding:'utf8'});
  const first=git(['rev-parse','HEAD']).trim();
  save(store,'# 偏好\n咖啡','save-2');
  assert.match(git(['show',first+':user/100000002.md']),/茶/);
  const before=git(['rev-parse','HEAD']).trim();snapshotHistory(store);assert.equal(git(['rev-parse','HEAD']).trim(),before);
  store.commit([{action:'forget',page:'user/100000002.md',text:'',reason:'明确遗忘',evidence:['forget']}],{id:'forget',evidenceIds:['forget']});
  const files=git(['ls-tree','-r','--name-only','HEAD']);assert.doesNotMatch(files,/raw|\.runtime|credential/);
  assert.match(git(['show','HEAD:user/100000002.md']),/已忘记/);
  assert.match(git(['show',before+':user/100000002.md']),/咖啡/);
  assert.equal(fs.readFileSync(store.safe('raw/conversations/'+revisionOf('raw-original')+'.json'),'utf8').includes('原文'.repeat(20000)),true);
});

test('Git failure does not lose a memory write, and history recovers on a later snapshot',t=>{
  const {store}=fixture(t);fs.mkdirSync(store.safe('.runtime/history.git'),{recursive:true});
  save(store,'# 可靠保存');assert.equal(historyStatus(store).state,'unavailable');assert.match(store.pages()[0].text,/可靠保存/);assert.equal(store.hasReceipt('save-1'),true);
  // Only the empty fixture directory is removed; no existing history is deleted.
  fs.rmdirSync(store.safe('.runtime/history.git'));assert.equal(snapshotHistory(store).state,'ready');
});

test('persona edits share local Git history and runtime injection respects settings',t=>{
  const {dir,store}=fixture(t);const management=new Management(dir);const old=management.inspect(key);
  management.savePersona({key,text:'# 人设\n测试人格',revision:old.personaRevision});
  assert.equal(historyStatus(store).state,'ready');
  let ctx=memoryRuntimeContext(store,defaults);assert.match(ctx.text,/测试人格/);assert.match(ctx.skill,/qq_memory_search/);
  ctx=memoryRuntimeContext(store,{...defaults,memoryAutoInject:false,memoryRegisterSkill:false});
  assert.equal(ctx.skill,'');assert.doesNotMatch(ctx.text,/"schema"/);assert.match(ctx.text,/测试人格/);
  ctx=memoryRuntimeContext(store,{...defaults,memoryEnabled:false});assert.match(ctx.text,/长期记忆已关闭/);assert.equal(ctx.skill,'');
});

test('legacy private and group tool paths can search and read even with knowledge and group tools off',async t=>{
  const {store}=fixture(t);save(store,'# 偏好\n茶');
  for(const group of [false,true]){
    const tools=new ChatTools({route:{group},store,config:{memoryEnabled:true,knowledgeEnabled:false,groupToolsEnabled:false}});
    assert.ok((await tools.run('qq_memory_search',{query:'茶'})).total);
    assert.match((await tools.run('qq_memory_read',{page:'index.md'})).text,/100000002/);
    tools.config.memoryEnabled=false;await assert.rejects(tools.run('qq_memory_read',{}),/未开放/);
  }
});
