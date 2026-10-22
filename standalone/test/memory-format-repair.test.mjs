import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MemoryStore} from '../lib/memory.mjs';
import {RoleState,ROLE_STATE_PAGE} from '../lib/role-state.mjs';
import {lintMemory} from '../lib/memory-lint.mjs';
import {maintainMemory,maintenanceRevision} from '../lib/memory-maintenance.mjs';
import {parseFrontmatter} from '../lib/legacy-memory/insights.js';
const key='100000001/private/100000002';
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-format-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return new MemoryStore(root,key);}
const body=text=>text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'');
function put(store,page,text){const file=store.safe(page);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
const character=(date='2026-10-20T16:30:00.000Z')=>'---\ntitle: 当前人格状态\ntype: concepts\nsource: role-simulation\nsummary: 当前状态\nsalience: 1\n---\n\n正文不可更改\n<!-- role-state -->\n'+JSON.stringify({at:date,simulationId:'saved'})+'\n<!-- /role-state -->\n';

test('new role state and history satisfy required date metadata',t=>{
  const store=setup(t),role=new RoleState(store,{}, {now:()=>Date.parse('2026-10-20T16:30:00Z')});
  const task=role.begin(),result=role.update({simulationId:task.id,activity:'读书',mood:'平静',attention:'阅读',progress:'第二章',nextIntent:'继续阅读'});
  for(const page of [ROLE_STATE_PAGE,result.journal])assert.equal(parseFrontmatter(fs.readFileSync(store.safe(page),'utf8')).date,'2026-10-20');
  assert.equal(lintMemory(store).passed,true);
});

test('empty digest repairs legacy metadata, preserves full bodies, attribution and prior revisions',t=>{
  const store=setup(t),person='user/100000002.md',journal='concepts/character-history/old.md';
  const personText='---\ntitle: 已确认的人物资料\ndate: 2026-10-19\ntype: user\nsalience: 2\nsummary: '+ '摘要'.repeat(27)+'\n---\n\n不喜欢苦茶，仅周末喝红茶。\n<!-- qq-attribution-v2 -->\n[{"qq":"100000002","basis":"self","sources":[]}]\n<!-- /qq-attribution-v2 -->\n';
  const stateText=character(),journalText='---\ntitle: 旧经历\ntype: concepts\nsource: role-simulation\nsummary: 本人格经历\nsalience: 2\n---\n\n## 2026-10-18T12:00:00.000Z\n\n来源：角色推演；作为本人格正式经历。编号：old\n\n完整经历\n';
  for(const [page,text] of [[person,personText],[ROLE_STATE_PAGE,stateText],[journal,journalText]])put(store,page,text);
  store.commit([],{id:'empty-digest',evidenceIds:[],digest:true});
  for(const [page,text] of [[person,personText],[ROLE_STATE_PAGE,stateText],[journal,journalText]])assert.equal(body(fs.readFileSync(store.safe(page),'utf8')),body(text));
  assert.ok(parseFrontmatter(fs.readFileSync(store.safe(person),'utf8')).summary.length<=48);
  assert.equal(parseFrontmatter(fs.readFileSync(store.safe(ROLE_STATE_PAGE),'utf8')).date,'2026-10-20');
  assert.equal(parseFrontmatter(fs.readFileSync(store.safe(journal),'utf8')).date,'2026-10-18');
  assert.equal(lintMemory(store).passed,true);
  const revisions=fs.readdirSync(store.safe('.runtime/revisions')).map(n=>JSON.parse(fs.readFileSync(store.safe('.runtime/revisions/'+n))));
  assert.ok(revisions.some(r=>r.before.some(p=>p.page===person&&p.text===personText)));
  const before=store.pages();store.commit([],{id:'again',evidenceIds:[],digest:true});assert.deepEqual(store.pages(),before);
});

test('unknown dates and ambiguous long labels remain explicit pending issues instead of fabricated values',t=>{
  const store=setup(t),page='concepts/unknown.md';
  put(store,page,'---\ntitle: '+ '长标题'.repeat(20)+'\nsummary: '+ '长摘要'.repeat(20)+'\ntype: concepts\nsalience: 2\n---\n无可核实日期\n');
  store.commit([],{id:'unknown',evidenceIds:[],digest:true});
  assert.equal(parseFrontmatter(fs.readFileSync(store.safe(page),'utf8')).date,undefined);
  assert.ok(store.state.formatRepair.pending.some(p=>p.page===page&&p.field==='date'));
  assert.ok(store.state.formatRepair.pending.some(p=>p.page===page&&p.field==='summary'));
});

test('metadata maintenance previews safely, rejects stale versions and cannot rewrite protected role facts',t=>{
  const store=setup(t),text=character();put(store,ROLE_STATE_PAGE,text);
  const request={operations:[{action:'repair_metadata',page:ROLE_STATE_PAGE,reason:'修复已有系统元数据'}],expectedRevision:maintenanceRevision(store)};
  assert.equal(maintainMemory(store,request).preview,true);assert.equal(fs.readFileSync(store.safe(ROLE_STATE_PAGE),'utf8'),text);
  put(store,'concepts/other.md','# another page');assert.throws(()=>maintainMemory(store,{...request,preview:false}),/版本/);
  maintainMemory(store,{...request,expectedRevision:maintenanceRevision(store),preview:false});
  assert.equal(body(fs.readFileSync(store.safe(ROLE_STATE_PAGE),'utf8')),body(text));
  assert.throws(()=>store.commit([{page:ROLE_STATE_PAGE,action:'write',text:'伪造角色事实',reason:'绕过',evidence:['x']}],{id:'bad',evidenceIds:['x']}),/qq_role_state_update/);
});
