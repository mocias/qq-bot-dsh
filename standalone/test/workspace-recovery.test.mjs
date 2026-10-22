import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {workspaceFor} from '../lib/workspace.mjs';
import {Bridge} from '../lib/bridge.mjs';
import {validate} from '../lib/config.mjs';

const key='100000001/private/100000002';
const route={key,id:'100000002',sender:'100000002',group:false,text:'你好',messageId:'input-1'};
function setup(t){
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-recovery-'));
  t.after(()=>removeTree(runtime));
  const bridge=new Bridge(runtime,{media:{outgoing:async()=>null}});
  bridge.config=validate({botQQ:'100000001',privateUsers:['100000002'],privatePreset:'test'});
  bridge.status.state='running';
  let created=0,prompts=0;
  bridge.dsh={createSession:async workspace=>{assert.ok(fs.statSync(workspace).isDirectory());return 'session-'+(++created);},
    rename:async()=>{},prompt:async()=>{prompts++;return '{"reply":"","memory":[]}';},close(){}};
  return {runtime,bridge,counts:()=>({created,prompts})};
}

// Node on Windows can leave empty Unicode-named directories after rmSync.
// Explicit removal also lets the regression assert its missing-directory setup.
function removeTree(dir){
  for(const name of fs.readdirSync(dir)){
    const file=path.join(dir,name),stat=fs.lstatSync(file);
    if(stat.isDirectory()&&!stat.isSymbolicLink())removeTree(file);else fs.unlinkSync(file);
  }
  fs.rmdirSync(dir);
}

test('a deleted mapped workspace allocates a different path without restoring deleted files',t=>{
  const {runtime}=setup(t),workspace=path.join(runtime,'workspaces','legacy-scope');
  fs.mkdirSync(workspace,{recursive:true});fs.writeFileSync(path.join(workspace,'deleted.txt'),'user deleted this');
  const state={sessions:{},workspaces:{scope:workspace}};
  removeTree(workspace);
  const fresh=workspaceFor(runtime,state,route,'scope',Date.now(),()=>{});
  assert.notEqual(fresh,workspace);assert.equal(fs.existsSync(workspace),false);assert.deepEqual(fs.readdirSync(fresh),[]);
});

test('startup and the next message create fresh sessions when their directories were deleted',async t=>{
  const {bridge,runtime,counts}=setup(t);
  await bridge.handle(route,0);
  const scope=bridge.scope(route),session=bridge.state.sessions[scope],workspace=session.workspace;
  bridge.memory(key).commit([],{id:'keep-receipt',evidenceIds:[],digest:true});
  removeTree(path.join(runtime,'workspaces'));
  const second=await bridge.ensureStartupSession(route);
  assert.notEqual(second.id,session.id);assert.equal(fs.existsSync(workspace),false);
  removeTree(second.workspace);
  bridge.dsh.prompt=async id=>{assert.notEqual(id,second.id);assert.ok(fs.statSync(bridge.state.sessions[scope].workspace).isDirectory());return '{"reply":"","memory":[]}';};
  await bridge.handle({...route,messageId:'input-2'},0);
  assert.notEqual(bridge.state.sessions[scope].id,session.id);
  assert.equal(counts().created,3);
  assert.ok(bridge.memory(key).hasReceipt('keep-receipt'));
});

test('maintenance refuses to resurrect a directory deleted after the session became ready',async t=>{
  const {bridge}=setup(t);await bridge.handle(route,0);
  const session=bridge.state.sessions[bridge.scope(route)];
  removeTree(session.workspace);
  assert.equal(fs.existsSync(session.workspace),false);
  bridge.dsh.prompt=async()=>assert.fail('deleted workspace must not receive another prompt');
  await assert.rejects(bridge.maintenanceDsh(session).prompt(session.id,'test',{signal:new AbortController().signal}),e=>e.workspaceResetRequired&&e.notSubmitted);
  assert.equal(fs.existsSync(session.workspace),false);
});

test('ordinary submission retains input when deletion happens during message preparation',async t=>{
  const {bridge}=setup(t);await bridge.handle(route,0);
  const session=bridge.state.sessions[bridge.scope(route)],prepare=bridge.prepareMessages.bind(bridge);
  bridge.prepareMessages=async(...args)=>{const result=await prepare(...args);removeTree(session.workspace);return result;};
  bridge.dsh.prompt=async()=>assert.fail('deleted workspace must not receive a prompt');
  await assert.rejects(bridge.handle({...route,messageId:'input-2'},0),e=>e.workspaceResetRequired&&e.notSubmitted);
  assert.equal(session.blocked,false);
  assert.equal(fs.existsSync(session.workspace),false);assert.ok(bridge.hasDeferred(route.key));
});

test('manual replacement allocates a new directory if the previous one was deleted',async t=>{
  const {bridge,counts}=setup(t);await bridge.handle(route,0);
  const scope=bridge.scope(route),old=bridge.state.sessions[scope];
  removeTree(old.workspace);
  assert.equal(fs.existsSync(old.workspace),false);
  await bridge.newConversation(key);
  assert.notEqual(bridge.state.sessions[scope].workspace,old.workspace);assert.equal(fs.existsSync(old.workspace),false);
  assert.equal(counts().created,2);
});

test('a missing external workspace is rejected without creating directories or dispatching a model',async t=>{
  const {bridge,runtime,counts}=setup(t);await bridge.handle(route,0);
  const session=bridge.state.sessions[bridge.scope(route)],external=path.join(runtime,'external-deleted');
  session.workspace=external;
  await assert.rejects(bridge.ensureStartupSession(route),/工作区/);
  assert.equal(fs.existsSync(external),false);assert.deepEqual(counts(),{created:1,prompts:1});
});

test('a file occupying the saved workspace is rejected without replacing it',t=>{
  const {runtime}=setup(t),workspace=path.join(runtime,'workspaces','occupied');
  fs.mkdirSync(path.dirname(workspace),{recursive:true});fs.writeFileSync(workspace,'keep');
  assert.throws(()=>workspaceFor(runtime,{sessions:{scope:{workspace}}},route,'scope',Date.now(),()=>{}),/工作区/);
  assert.equal(fs.readFileSync(workspace,'utf8'),'keep');
});

test('workspace recovery refuses a junction to another directory',t=>{
  const {runtime}=setup(t),external=path.join(runtime,'external'),parent=path.join(runtime,'workspaces');
  fs.mkdirSync(external);
  try{fs.symlinkSync(external,parent,process.platform==='win32'?'junction':'dir');}
  catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('symlinks unavailable');return;}throw error;}
  const workspace=path.join(parent,'missing');
  assert.throws(()=>workspaceFor(runtime,{sessions:{scope:{workspace}}},route,'scope',Date.now(),()=>{}),/工作区/);
  assert.deepEqual(fs.readdirSync(external),[]);
});
