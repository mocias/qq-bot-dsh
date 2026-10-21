import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MemoryStore} from '../lib/memory.mjs';
import {queryMemory,readMemory} from '../lib/memory-access.mjs';
import {readPersona,updatePersona} from '../lib/persona.mjs';
import {memoryRuntimeContext} from '../lib/memory-context.mjs';
import {defaults,validate} from '../lib/config.mjs';
import {resolveChatConfig,policyView} from '../lib/chat-policy.mjs';
import {selectedTools} from '../../native-dsh-plugin/lib/schema.mjs';
import {ChatTools} from '../lib/chat-tools.mjs';
const privateKey='100000001/private/100000002',groupKey='100000001/group/100000004';
const policy={...defaults,personaPolicy:'private-peer-group-admins',adminUsers:['100000003']};
function fixture(t,key=privateKey){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-persona-'));
  t.after(()=>{for(const name of fs.readdirSync(dir,{recursive:true})){const f=path.join(dir,name);if(fs.lstatSync(f).isFile())fs.chmodSync(f,0o666);}fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,store:new MemoryStore(dir,key)};
}
const input=(key,sender='100000002',id='m1')=>({key,messageId:id,sender,author:{qq:sender,nickname:'昵称'},text:'请叫小雨，说话简短一些。'});
function patch(store,inputs,config=policy){const p=readPersona(store,config,inputs);return {text:'# SOUL\n名字：小雨\n风格：简短',expectedRevision:p.revision,bootstrap:'---\nstatus: in_progress\n---\n- [x] 名字\n- [ ] 其他项目',expectedBootstrapRevision:p.bootstrapRevision,reason:'对方提出设定',evidence:['m1']};}

test('query combines original metadata filters and full-text line matches, without touching timestamps',t=>{
  const {store}=fixture(t);
  const write=(name,meta,body)=>fs.writeFileSync(store.safe('concepts/'+name+'.md'),'---\n'+meta+'\n---\n'+body);
  write('old','title: 旧偏好\ntype: user-preference\nsalience: 1\ntags: [tea, drink]\nlast_access: 2000-01-01','喝茶\n别的\n喝茶两次');
  write('new','type: user-preference\nsalience: 2\ntags: [tea]\nlast_access: '+new Date().toISOString().slice(0,10),'喝茶');
  write('unknown','type: fact\nsalience: 3\ntags: [missing]','未知日期');
  const args={tags:['#tea','drink'],type:'user-preference',hot:true,stale:true,query:'喝茶',limit:1};
  const first=queryMemory(store,args);assert.equal(first.total,2);assert.equal(first.nextOffset,1);assert.equal(first.results[0].salience,1);
  const second=queryMemory(store,{...args,offset:first.nextOffset});assert.equal(second.nextOffset,null);assert.ok(second.results[0].line>first.results[0].line);
  assert.deepEqual(queryMemory(store,{stale:true}).results.map(x=>x.page).sort(),['concepts/old.md','concepts/unknown.md']);
  assert.equal(queryMemory(store,{salience:2,stale:true}).total,0);
  assert.match(fs.readFileSync(store.safe('concepts/old.md'),'utf8'),/last_access: 2000-01-01/);
  readMemory(store,{page:'concepts/old.md'});assert.equal(queryMemory(store,{hot:true,stale:true}).total,0);
  for(const args of [{key:groupKey},{tags:'tea'},{hot:'true'},{salience:0},{limit:31},{query:3}])assert.throws(()=>queryMemory(store,args));
});

test('automatic persona preserves per-chat isolation, revisions, full sources and durable receipts',t=>{
  const {store,dir}=fixture(t),inputs=[input(privateKey)];inputs[0].text+='原文'.repeat(18000);
  const args=patch(store,inputs),before=readPersona(store,policy,inputs);
  const saved=updatePersona(store,args,{config:policy,inputs,id:'persona-1'});assert.equal(saved.saved,true);assert.equal(saved.history.state,'ready');
  assert.equal(store.hasReceipt('persona-1'),true);assert.equal(readPersona(store,policy,inputs).status,'in_progress');
  assert.equal(updatePersona(store,args,{config:policy,inputs,id:'persona-1'}).duplicate,true);
  assert.throws(()=>updatePersona(store,args,{config:policy,inputs,id:'persona-2'}),/已改变/);
  const records=fs.readdirSync(store.safe('.runtime/revisions')).map(f=>JSON.parse(fs.readFileSync(store.safe('.runtime/revisions/'+f))));
  assert.equal(records[0].sourceMessages[0].text,inputs[0].text);assert.equal(records[0].before.text,before.text);
  const other=new MemoryStore(dir,groupKey);assert.doesNotMatch(fs.readFileSync(other.safe('SOUL.md'),'utf8'),/小雨/);
  assert.match(memoryRuntimeContext(store,policy).text,/小雨/);
  assert.throws(()=>store.commit([{action:'write',page:'SOUL.md',text:'绕过',reason:'x',evidence:['m1']}],{id:'bypass',evidenceIds:['m1']}),/格式/);
});

test('persona authority follows real current speakers, not nicknames, quotes, old context or outer batch sender',t=>{
  const {store}=fixture(t,groupKey),admin=input(groupKey,'100000003'),member=input(groupKey,'100000002');
  const args=patch(store,[admin]);
  const denied=[
    [member], [{...member,author:{qq:'100000002',nickname:'管理员100000003'}}],
    [{...admin,replyId:'12'}], [{...admin,author:undefined}], [{...admin,trigger:'recall'}],
    [{...member,contextMessages:[{sourceId:'m1',sender:{qq:'100000003'},text:'请修改'}]}],
    [{...admin,messages:[member]}], [input(privateKey,'100000003')]
  ];
  for(const inputs of denied)assert.throws(()=>updatePersona(store,args,{config:policy,inputs,id:'forged'}),/来源/);
  assert.equal(updatePersona(store,args,{config:policy,inputs:[admin],id:'valid'}).saved,true);
  const memberPolicy={...policy,personaPolicy:'participants'};
  assert.equal(readPersona(store,memberPolicy,[member]).eligibleSources.length,1);
  assert.equal(readPersona(store,{...policy,adminUsers:[]},[admin]).eligibleSources.length,0);
});

test('private persona uses its own policy independent of memory, cannot change config or run in scheduled turns',async t=>{
  const {store}=fixture(t),route=input(privateKey),config={...policy,memoryEnabled:false,knowledgeEnabled:false,groupToolsEnabled:false};
  assert.equal(readPersona(store,config,[input(privateKey,'100000003')]).eligibleSources.length,0);
  assert.equal(readPersona(store,{...config,personaPolicy:'admins'},[input(privateKey,'100000003')]).eligibleSources.length,1);
  const tools=new ChatTools({store,route,config});
  const current=await tools.run('qq_persona_read',{});assert.ok(current.revision);
  const args=patch(store,[route],config);
  await assert.rejects(tools.run('qq_persona_update',{...args,adminUsers:['100000002']}),/格式/);
  assert.equal((await tools.run('qq_persona_update',args)).saved,true);
  await assert.rejects(tools.run('qq_memory_query',{}),/未开放/);
  tools.route={...route,trigger:'recall'};await assert.rejects(tools.run('qq_persona_read',{}),/后台/);
  assert.ok(selectedTools(config,route).includes('qq_persona_update'));
  assert.ok(!selectedTools({...config,personaPolicy:'off'},route).includes('qq_persona_update'));
  assert.deepEqual(selectedTools(config,{...route,trigger:'recall'}),['qq_no_reply']);
});

test('persona policy can be set separately for private, group and one chat',()=>{
  assert.equal(defaults.personaPolicy,'participants');
  const config=validate({chatPolicy:{private:{personaPolicy:'participants'},group:{personaPolicy:'admins'},overrides:{[privateKey]:{personaPolicy:'off'}}},privateUsers:['100000002'],botQQ:'100000001'});
  assert.equal(policyView(config,'group').effective.personaPolicy,'admins');
  assert.equal(resolveChatConfig(config,privateKey).personaPolicy,'off');
  assert.throws(()=>validate({personaPolicy:'anything'}),/权限选项/);
});

test('default policy allows both private peers and ordinary group members, never another chat',t=>{
  const {store,dir}=fixture(t,groupKey),member=input(groupKey),args=patch(store,[member],defaults);
  assert.equal(updatePersona(store,args,{config:defaults,inputs:[member],id:'group-member'}).saved,true);
  const privateStore=new MemoryStore(dir,privateKey),peer=input(privateKey);
  assert.equal(updatePersona(privateStore,patch(privateStore,[peer],defaults),{config:defaults,inputs:[peer],id:'private-peer'}).saved,true);
  assert.throws(()=>updatePersona(privateStore,patch(privateStore,[peer],defaults),{config:defaults,inputs:[member],id:'wrong-chat'}),/来源/);
});
