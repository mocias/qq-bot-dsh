import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Bridge} from '../lib/bridge.mjs';
import {validate} from '../lib/config.mjs';
import {PersonaCards} from '../lib/persona-cards.mjs';

const key='100000001/private/100000002',route={key,id:'100000002',group:false,text:'你好',messageId:'first'};
function fixture(t){
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-reset-'));t.after(()=>fs.rmSync(runtime,{recursive:true,force:true}));
  new PersonaCards(runtime).rename({key,personaId:'default',name:'Lumen',revision:0});
  const bridge=new Bridge(runtime,{now:()=>Date.parse('2026-10-22T02:00:00Z'),media:{outgoing:async()=>null}});
  bridge.config=validate({botQQ:'100000001',privateUsers:['100000002'],privatePreset:'test'});bridge.status.state='running';
  const registrations=new Map(),titles=[];let count=0,prompts=0;
  bridge.dsh={createSession:async workspace=>{const id='session-'+(++count);registrations.set(workspace,{workspaceId:'workspace-'+count,sessionId:id});return id;},
    ensureWorkspace:async(id,workspace,expected)=>{const item=registrations.get(workspace);if(!item||item.sessionId!==id||expected&&item.workspaceId!==expected)throw Object.assign(Error('工作区登记已删除'),{notSubmitted:true,workspaceResetRequired:true});return {...item,path:workspace};},
    rename:async(id,title)=>titles.push({id,title}),prompt:async()=>{prompts++;return '{"reply":"","memory":[]}';},close(){}};
  return {bridge,runtime,registrations,titles,counts:()=>({created:count,prompts})};
}
test('deleting a directory creates a new workspace and session, preserves memory and never recreates the deleted path',async t=>{
  const {bridge,runtime,counts}=fixture(t);await bridge.handle(route,0);
  const scope=bridge.scope(route),old=bridge.state.sessions[scope];
  bridge.memory(key).commit([],{id:'keep',evidenceIds:[],digest:true});
  fs.writeFileSync(path.join(old.workspace,'private-file.txt'),'do not restore');
  fs.renameSync(old.workspace,path.join(runtime,'deleted-original'));
  const fresh=await bridge.ensureStartupSession(route);
  assert.notEqual(fresh.id,old.id);assert.notEqual(fresh.workspace,old.workspace);assert.equal(fs.existsSync(old.workspace),false);
  assert.deepEqual(fs.readdirSync(fresh.workspace),[]);assert.ok(bridge.memory(key).hasReceipt('keep'));
  assert.equal(bridge.state.retired.at(-1).id,old.id);assert.match(fresh.workspace,/Lumen/);
  await bridge.handle({...route,messageId:'next'},0);assert.equal(counts().created,2);
});
test('deleting only a DSH registration allocates fresh identities instead of reattaching the old session',async t=>{
  const {bridge,registrations}=fixture(t);await bridge.handle(route,0);
  const old=bridge.state.sessions[bridge.scope(route)];registrations.delete(old.workspace);
  const fresh=await bridge.ensureStartupSession(route);
  assert.notEqual(fresh.id,old.id);assert.notEqual(fresh.workspace,old.workspace);assert.equal(registrations.has(old.workspace),false);
  assert.equal(fresh.workspaceId,registrations.get(fresh.workspace).workspaceId);
  assert.notEqual(path.basename(old.workspace),path.basename(fresh.workspace));
});
test('new session names include the selected persona and keep the same reserved name on retry',async t=>{
  const {bridge,titles}=fixture(t);let fail=true;
  bridge.dsh.rename=async(id,title)=>{titles.push({id,title});if(fail)throw Error('rename unavailable');};
  await assert.rejects(bridge.handle(route,0),/rename/);fail=false;await bridge.handle(route,0);
  assert.match(titles[0].title,/^2026-10-22-私聊-100000002-Lumen-1$/);assert.deepEqual(titles[0],titles[1]);
});
test('a failed fresh session creation retries the reserved new path without restoring the deleted workspace',async t=>{
  const {bridge,registrations}=fixture(t);await bridge.handle(route,0);
  const old=bridge.state.sessions[bridge.scope(route)];registrations.delete(old.workspace);
  const create=bridge.dsh.createSession,attempts=[];bridge.dsh.createSession=async workspace=>{attempts.push(workspace);if(attempts.length===1)throw Error('creation rejected');return create(workspace);};
  await assert.rejects(bridge.ensureStartupSession(route),/creation rejected/);
  const fresh=await bridge.ensureStartupSession(route);assert.equal(attempts[0],attempts[1]);assert.equal(fresh.workspace,attempts[0]);
});
test('an unavailable registry is a pre-submission error and never interpreted as a user deletion',async t=>{
  const {bridge,counts}=fixture(t);await bridge.handle(route,0);const id=bridge.state.sessions[bridge.scope(route)].id;
  bridge.dsh.ensureWorkspace=async()=>{throw Object.assign(Error('registry unavailable'),{notSubmitted:true});};
  await assert.rejects(bridge.ensureStartupSession(route),/unavailable/);assert.equal(counts().created,1);assert.equal(bridge.state.sessions[bridge.scope(route)].id,id);
});
