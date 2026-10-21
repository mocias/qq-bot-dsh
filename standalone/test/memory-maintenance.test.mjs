import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MemoryStore} from '../lib/memory.mjs';
import {diagnoseMemory,maintainMemory,maintenanceRevision} from '../lib/memory-maintenance.mjs';
import {readMemory,searchMemory,queryMemory,revisionOf} from '../lib/memory-access.mjs';
import {pageState} from '../lib/memory-state.mjs';
import {pageAttribution} from '../lib/message-snapshot.mjs';
import {defaults,writeJson} from '../lib/config.mjs';
import {initializeLife,observeCompaction,maintain,noteArrival,due} from '../lib/lifecycle.mjs';
import {ChatTools} from '../lib/chat-tools.mjs';
import {nativeTurn} from '../lib/native-turn.mjs';
import {selectedTools} from '../../native-dsh-plugin/lib/schema.mjs';

const key='100000001/private/100000002';
function fixture(t,scope=key){
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-maintenance-'));
  t.after(()=>{for(const name of fs.readdirSync(runtime,{recursive:true})){const f=path.join(runtime,name);if(fs.lstatSync(f).isFile())fs.chmodSync(f,0o666);}fs.rmSync(runtime,{recursive:true,force:true});});
  const store=new MemoryStore(runtime,scope);
  const put=(name,body,meta='salience: 2\nlast_access: 2000-01-01')=>{
    fs.mkdirSync(path.dirname(store.safe(name)),{recursive:true});
    fs.writeFileSync(store.safe(name),'---\ntype: concept\nsummary: 简述\n'+meta+'\n---\n'+body);
  };
  const get=name=>fs.readFileSync(store.safe(name),'utf8');
  const operation=(action,page,extra={})=>({operations:[{action,page,reason:'核对旧页后整理',...extra}],expectedRevision:maintenanceRevision(store),preview:false});
  return {runtime,store,put,get,operation};
}
const attribution=(qq,source='s1',basis='self')=>'\n\n<!-- qq-attribution-v2 -->\n来源\n'+JSON.stringify([{qq,basis,sources:[{sourceId:source,speaker:{qq},subjectQQ:qq,basis}]}])+'\n<!-- /qq-attribution-v2 -->';

test('saving preserves index partitions, prose, order and full large pages; repeated sync is stable',t=>{
  const {store,put,get,operation}=fixture(t);
  put('concepts/b.md','# B\n正文');put('concepts/a.md','# A\n原文'.repeat(40000));
  const intro='# 手写索引\n\n这一段说明必须保留。\n\n## 分区乙\n- [B](concepts/b.md)\n\n## 分区甲\n- [A](concepts/a.md)\n<!-- 自定义说明 -->\n- [失效](concepts/missing.md)\n';
  fs.writeFileSync(store.safe('index.md'),intro);
  store.commit([{action:'write',page:'concepts/new.md',text:'# 新页\n稳定事实',reason:'新增',evidence:['m']}],{id:'new',evidenceIds:['m']});
  const index=get('index.md');
  assert.match(index,/这一段说明必须保留/);assert.match(index,/<!-- 自定义说明 -->/);assert.match(index,/concepts\/missing.md/);
  assert.ok(index.indexOf('分区乙')<index.indexOf('分区甲'));assert.ok(index.indexOf('concepts/b.md')<index.indexOf('concepts/a.md'));
  assert.match(index,/## 新记忆[\s\S]*concepts\/new.md/);assert.ok(store.pages().find(p=>p.name==='concepts/a.md').text.length>100000);
  maintainMemory(store,operation('sync_index',undefined));assert.equal(get('index.md'),index);
  assert.equal(diagnoseMemory(store).indexNeedsSync,false);
  assert.equal(diagnoseMemory(store).checkup.integrity.checks.find(c=>c.label==='index 与页面同步').ok,true);
  assert.ok(diagnoseMemory(store).indexDiagnostics.brokenRoutes.items.includes('concepts/missing.md'));
});

test('diagnosis is read only and reports integrity, decay and compatible exact duplicates with pagination',t=>{
  const {store,put,get}=fixture(t);
  put('concepts/a.md','# 内容\n同一段');put('concepts/b.md','# 内容\n同一段');
  put('concepts/c.md','# 冷页','salience: 3\nlast_access: 2000-01-01');put('concepts/unknown.md','# 未知','salience: 2');
  const before=store.pages(),revision=maintenanceRevision(store),first=diagnoseMemory(store,{limit:2});
  readMemory(store,{page:'concepts/a.md',inspect:true});assert.equal(maintenanceRevision(store),revision);
  assert.equal(first.revision,revision);assert.equal(first.nextOffset,2);assert.equal(first.pages[0].downgrade,true);
  assert.deepEqual(first.exactDuplicateGroups,[['concepts/a.md','concepts/b.md']]);
  assert.ok(first.checkup.integrity.checks.some(x=>!x.ok));assert.equal(first.checkup.store,undefined);
  const next=diagnoseMemory(store,{offset:2});assert.equal(next.pages.find(x=>x.page==='concepts/c.md').archive,true);
  assert.equal(next.pages.find(x=>x.page==='concepts/unknown.md').downgrade,false);
  assert.deepEqual(store.pages(),before);assert.equal(maintenanceRevision(store),revision);
  assert.match(get('concepts/a.md'),/2000-01-01/);
});

test('decay preview, archive, explicit retrieval and restore preserve full text, history and raw sources',t=>{
  const {store,put,get,operation}=fixture(t);const page='concepts/cold.md';
  put(page,'# 冷记忆\n独特原文归档测试'+attribution('100000002'),'salience: 2\nlast_access: 2000-01-01\nsummary: 独特原文归档测试');
  store.record({id:'raw',text:'完整原始记录'.repeat(30000)});
  const raw=fs.readdirSync(store.safe('raw/conversations')).map(n=>get('raw/conversations/'+n));
  const original=get(page),request=operation('downgrade',page);
  const preview=maintainMemory(store,{...request,preview:true});assert.equal(preview.preview,true);assert.equal(get(page),original);
  maintainMemory(store,request);assert.match(get(page),/salience: 3/);assert.match(get(page),/2000-01-01/);
  const beforeArchive=get(page);maintainMemory(store,operation('archive',page));assert.equal(pageState(get(page)).state,'archived');
  assert.equal(queryMemory(store,{query:'独特原文归档测试'}).total,0);assert.equal(searchMemory(store,{query:'独特原文归档测试'}).total,0);
  assert.equal(searchMemory(store,{query:'独特原文归档测试',includeArchived:true}).results.find(r=>r.page===page).state,'archived');
  assert.equal(queryMemory(store,{includeArchived:true}).results[0].state,'archived');
  assert.doesNotMatch(store.context('',defaults),/独特原文归档测试/);
  const explicit=readMemory(store,{page});assert.equal(explicit.state,'archived');assert.match(get(page),/2000-01-01/);
  assert.deepEqual(pageAttribution(get(page)),pageAttribution(original));
  maintainMemory(store,operation('restore',page));assert.equal(get(page),beforeArchive);
  const records=fs.readdirSync(store.safe('.runtime/revisions')).map(n=>JSON.parse(get('.runtime/revisions/'+n)));
  assert.ok(records.some(r=>r.before.some(p=>p.text===original)));
  assert.ok(fs.existsSync(store.safe('.runtime/history.git/HEAD')));
  assert.deepEqual(fs.readdirSync(store.safe('raw/conversations')).map(n=>get('raw/conversations/'+n)),raw);
});

test('model chooses decay regardless of age; stale version, forged state and cross-chat tokens still reject atomically',t=>{
  const {store,runtime,put,get,operation}=fixture(t);
  put('concepts/hot.md','# 热','salience: 1\nlast_access: 2000-01-01');put('concepts/old.md','# 旧');
  put('concepts/new.md','# 新','salience: 2\nlast_access: '+new Date().toISOString().slice(0,10));put('concepts/unknown.md','# 无日期','salience: 3');
  for(const [action,page] of [['downgrade','hot'],['archive','hot'],['downgrade','new'],['archive','unknown']])assert.equal(maintainMemory(store,operation(action,'concepts/'+page+'.md')).saved,true);
  assert.match(get('concepts/hot.md'),/salience: 2/);assert.match(get('concepts/new.md'),/salience: 3/);
  const batch=operation('downgrade','concepts/old.md');batch.operations.push({action:'archive',page:'concepts/missing.md',reason:'无效'});
  const before=store.pages();assert.throws(()=>maintainMemory(store,batch));assert.deepEqual(store.pages(),before);
  const stale=operation('downgrade','concepts/old.md');fs.appendFileSync(store.safe('index.md'),'\n修改');assert.throws(()=>maintainMemory(store,stale),/版本已改变/);
  const other=new MemoryStore(runtime,'100000001/group/100000002');assert.throws(()=>maintainMemory(other,operation('downgrade','concepts/old.md')),/版本已改变/);
  assert.throws(()=>store.commit([{action:'write',page:'concepts/old.md',text:'---\nqq_memory_state : archived\n---\n恶意状态',reason:'x',evidence:['m']}],{id:'fake',evidenceIds:['m']}),/只能由宿主/);
  assert.match(get('concepts/old.md'),/salience: 2/);
});

test('merge preserves attribution, originals and metadata, rewrites live backlinks and rebases copied links',t=>{
  const {store,put,get,operation}=fixture(t,'100000001/group/100000009');
  const target='user/100000002.md',source='user/100000002/tea.md';
  put(target,'# 偏好\n喜欢茶'+attribution('100000002','s1'),'salience: 3\ntags: [old]\nlast_access: 2000-01-01');
  put(source,'# 茶\n喜欢红茶\n[项目](../../concepts/project.md)'+attribution('100000002','s2','reported'),'salience: 1\ntags: [tea]\nlast_access: 2020-01-01');
  put('concepts/project.md','# 项目\n[人物](../user/100000002/tea.md)');
  const originalSource=get(source),originalTarget=get(target);
  const result=maintainMemory(store,operation('merge',target,{sources:[source]}));assert.equal(result.saved,true);
  assert.match(get(target),/喜欢茶[\s\S]*喜欢红茶/);assert.match(get(target),/\(\.\.\/concepts\/project.md\)/);
  assert.match(get(target),/salience: 1/);assert.match(get(target),/tags: \[old, tea\]/);assert.match(get(target),/2020-01-01/);
  assert.deepEqual(pageAttribution(get(target)),[...pageAttribution(originalTarget),...pageAttribution(originalSource)]);
  assert.match(get('concepts/project.md'),/\(\.\.\/user\/100000002.md\)/);
  assert.equal(pageState(get(source)).mergedInto,target);assert.ok(get(source).includes(originalSource.slice(originalSource.indexOf('\n---\n')+5)));
  assert.equal(queryMemory(store).results.some(x=>x.page===source),false);
  const records=fs.readdirSync(store.safe('.runtime/revisions')).map(n=>JSON.parse(get('.runtime/revisions/'+n)));
  assert.equal(records.at(-1).before.find(p=>p.page===source).text,originalSource);
  assert.equal(records.at(-1).before.find(p=>p.page===target).text,originalTarget);
});

test('exact duplicate merge does not repeat prose and cannot merge different or unverified people',t=>{
  const {store,put,get,operation}=fixture(t);const target='user/100000002.md',source='user/100000002/copy.md';
  put(target,'# 事实\n同一事实'+attribution('100000002','one'));put(source,'# 事实\n同一事实'+attribution('100000002','two'));
  put('user/100000003.md','# 事实\n同一事实'+attribution('100000003'));
  put('user/legacy.md','# 事实\n同一事实');
  for(const bad of ['user/100000003.md','user/legacy.md'])assert.throws(()=>maintainMemory(store,operation('merge',target,{sources:[bad]})),/人物|归属/);
  maintainMemory(store,operation('merge',target,{sources:[source]}));assert.equal(get(target).split('同一事实').length,2);
  assert.equal(pageAttribution(get(target)).length,2);
});

test('transaction replay recovers all maintenance files and receipt; invalid journal is prevalidated',t=>{
  const {store,put,get,operation,runtime}=fixture(t);put('concepts/a.md','# 原文');
  const recover=store.recover.bind(store);let calls=0;
  store.recover=()=>{calls++;if(calls===3)throw Error('模拟落盘中断');return recover();};
  assert.throws(()=>maintainMemory(store,operation('downgrade','concepts/a.md')),/模拟/);
  const restored=new MemoryStore(runtime,key);assert.match(fs.readFileSync(restored.safe('concepts/a.md'),'utf8'),/salience: 3/);
  assert.ok(restored.state.receipts.length);assert.equal(fs.existsSync(restored.txFile),false);
  const before=get('concepts/a.md');writeJson(restored.txFile,{key,files:[{name:'concepts/a.md',text:'bad'},{name:'../evil.md',text:'bad'}]});
  assert.throws(()=>restored.recover());assert.equal(get('concepts/a.md'),before);
});

function digestSetup(store){
  const session={id:'session',route:{key:store.key,group:store.key.includes('/group/')}};
  initializeLife(session,1000);
  observeCompaction(session,{type:'compaction/summary',seq:1,time:1000,data:{compactionId:'c',summary:[]}},store,()=>{});
  observeCompaction(session,{type:'compaction/end',seq:2,time:1000,data:{compactionId:'c'}},store,()=>{});
  return session;
}
test('native compaction-idle maintenance reads without warming pages and commits preview with final receipt',async t=>{
  const {store,put,get}=fixture(t);put('concepts/old.md','# 原文');const session=digestSetup(store);
  const dsh={async prompt(id,text,{nativeTools}){
    assert.match(text,/本次诊断/);assert.ok(nativeTools.allowed.includes('qq_memory_diagnose'));
    const first=(await nativeTools.execute('qq_memory_diagnose',{})).result;
    await nativeTools.execute('qq_memory_read',{page:'concepts/old.md'});
    await nativeTools.execute('qq_memory_search',{query:'原文'});
    assert.equal(maintenanceRevision(store),first.revision);
    const request={operations:[{action:'downgrade',page:'concepts/old.md',reason:'旧温记忆'}],expectedRevision:first.revision};
    await assert.rejects(nativeTools.execute('qq_memory_maintain',{...request,preview:false}),/只可预览/);
    await nativeTools.execute('qq_memory_maintain',request);assert.match(get('concepts/old.md'),/salience: 2/);
    await nativeTools.execute('qq_memory_digest',{summary:'降级',updates:[],maintenance:request});return '';
  }};
  await maintain({session,store,config:{...defaults,dshNativeTools:true},dsh,persist(){},now:()=>2000000,isCurrent:()=>true,signal:new AbortController().signal,rotate(){assert.fail();}});
  assert.match(get('concepts/old.md'),/salience: 3/);assert.match(get('concepts/old.md'),/2000-01-01/);
  assert.ok(store.hasReceipt(session.life.receipt));assert.deepEqual(session.life.digestedIds,['c']);
  assert.equal(due({life:{...session.life,compactions:[]}},defaults,99999999),null);
});

test('legacy background diagnostic action loop commits maintenance; invalidated final result never writes',async t=>{
  for(const cancel of [false,true]){
    const {store,put,get}=fixture(t);put('concepts/old.md','# 原文');const session=digestSetup(store);let calls=0;
    const dsh={async prompt(id,text){
      if(calls++===0)return JSON.stringify({reply:'',memory:[],actions:[{tool:'qq_memory_diagnose',args:{}}]});
      const revision=maintenanceRevision(store);
      if(cancel)noteArrival(session,2000001);
      return JSON.stringify({reply:'',summary:'降级',memory:[],maintenance:{expectedRevision:revision,operations:[{action:'downgrade',page:'concepts/old.md',reason:'旧温记忆'}]}});
    }};
    await maintain({session,store,config:{...defaults,dshNativeTools:false},dsh,persist(){},now:()=>2000000,isCurrent:()=>true,signal:new AbortController().signal,rotate(){assert.fail();}});
    assert.equal(calls,2);assert.match(get('concepts/old.md'),cancel?/salience: 2/:/salience: 3/);
    assert.equal(!!session.life.receipt,!cancel);
  }
});

test('normal native and legacy tools expose maintenance in both chats without context invalidating preview',async t=>{
  for(const scope of [key,'100000001/group/100000009']){
    const {store,put,get}=fixture(t,scope);put('concepts/old.md','# 原文');
    const route={key:scope,group:scope.includes('/group/'),messageId:'m'},config={...defaults,memoryEnabled:true};
    const tools=new ChatTools({store,route,config,session:{}});
    const turn=nativeTurn({config,route,session:{id:'s'},store,tools,messaging:{outputs:[]},job:{inputs:[]},isCurrent:()=>true});
    const diagnostic=await turn.execute('qq_memory_diagnose',{},'diagnose');assert.equal(diagnostic.memoryContext,undefined);
    const args={operations:[{action:'downgrade',page:'concepts/old.md',reason:'确认'}],expectedRevision:diagnostic.result.revision};
    const preview=await turn.execute('qq_memory_maintain',args,'preview');assert.equal(preview.memoryContext,undefined);assert.equal(maintenanceRevision(store),args.expectedRevision);
    const saved=await turn.execute('qq_memory_maintain',{...args,preview:false},'save');assert.ok(saved.memoryContext);assert.match(get('concepts/old.md'),/2000-01-01/);
    assert.ok((await tools.run('qq_memory_diagnose',{})).revision);
    assert.equal(selectedTools({...config,memoryEnabled:false},route).some(n=>n.startsWith('qq_memory_')),false);
    assert.equal(selectedTools(config,{...route,trigger:true}).includes('qq_memory_maintain'),false);
    await assert.rejects(new ChatTools({store,route:{...route,trigger:true},config,session:{}}).run('qq_memory_maintain',args));
  }
});
