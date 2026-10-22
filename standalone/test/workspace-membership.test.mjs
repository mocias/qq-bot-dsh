import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {NativeRuntime} from '../../native-dsh-plugin/lib/runtime.mjs';
import {VERSION,PROTOCOL,BUILD_ID} from '../../native-dsh-plugin/lib/schema.mjs';
import {DshClient} from '../lib/dsh.mjs';
import {Bridge} from '../lib/bridge.mjs';
import {validate} from '../lib/config.mjs';
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-membership-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const workspace=path.join(root,'workspaces','existing');fs.mkdirSync(workspace,{recursive:true});
  let registrations=0;const records=new Map(),header={id:'original-session',cwd:workspace};
  const registry={async create(dir){let item=records.get(dir);if(!item){item={id:'workspace-'+(++registrations),path:dir,title:'保留工作区标题',sessionIds:[],async attachSession(id){if(!this.sessionIds.includes(id))this.sessionIds.push(id);}};records.set(dir,item);}return item;}};
  const runtime=Object.assign(Object.create(NativeRuntime.prototype),{ctx:{workspaceRegistry:registry,sessionPersistence:{list:async()=>[{header}]}},scheduleRouter:{root}});
  const request={sessionId:header.id,workspacePath:workspace,version:VERSION,protocol:PROTOCOL,buildId:BUILD_ID};
  return {runtime,request,records,header,root,count:()=>registrations};
}
test('recreate registration and attach the original session idempotently without creating an agent',async t=>{
  const f=fixture(t),first=await f.runtime.repairWorkspace(f.request),again=await f.runtime.repairWorkspace(f.request);
  assert.equal(first.workspaceId,again.workspaceId);assert.equal(first.sessionId,f.header.id);assert.equal(f.count(),1);
  const item=[...f.records.values()][0];assert.deepEqual(item.sessionIds,[f.header.id]);assert.equal(item.title,'保留工作区标题');
  f.records.clear();const repaired=await f.runtime.repairWorkspace(f.request);assert.equal(repaired.sessionId,f.header.id);assert.equal(f.count(),2);
});
test('repair refuses foreign or mismatched cwd, unknown sessions and incompatible requests before registration',async t=>{
  const f=fixture(t),foreign=path.join(f.root,'other-project');fs.mkdirSync(foreign);
  for(const request of [{...f.request,workspacePath:foreign},{...f.request,sessionId:'unknown'},{...f.request,buildId:'old'}])await assert.rejects(f.runtime.repairWorkspace(request));
  f.header.cwd=foreign;await assert.rejects(f.runtime.repairWorkspace(f.request));assert.equal(f.count(),0);
});
test('native DSH client verifies returned session membership and marks repair failure as pre-submission',async()=>{
  const client=new DshClient({dshNativeTools:true});let seen;
  client.rpc=async(method,args)=>{seen={method,args};return {sessionId:args.sessionId,workspaceId:'restored',path:args.workspacePath};};
  await client.ensureWorkspace('original-session',path.resolve('workspaces/test'));assert.equal(seen.method,'qqRsiNative/repairWorkspace');
  client.rpc=async()=>({sessionId:'wrong',workspaceId:'other'});
  await assert.rejects(client.ensureWorkspace('original-session',path.resolve('workspaces/test')),e=>e.notSubmitted===true);
});

test('startup, ordinary input and maintenance restore membership while retaining the persisted session',async t=>{
  const f=fixture(t),bridge=new Bridge(f.root,{media:{outgoing:async()=>null}}),route={key:'100000001/private/100000002',id:'100000002',group:false,text:'你好',messageId:'first'};
  bridge.config=validate({botQQ:'100000001',privateUsers:['100000002'],privatePreset:'test'});bridge.status.state='running';
  let created=0,linked=false,prompts=0;
  bridge.dsh={createSession:async()=>{created++;return 'original-session';},rename:async()=>{},ensureWorkspace:async()=>{linked=true;},prompt:async()=>{assert.equal(linked,true);prompts++;return '{"reply":"","memory":[]}';}};
  await bridge.handle(route,0);const scope=bridge.scope(route),original=bridge.state.sessions[scope];
  linked=false;await bridge.ensureStartupSession(route);assert.equal(linked,true);
  linked=false;await bridge.handle({...route,messageId:'second'},0);assert.equal(bridge.state.sessions[scope].id,original.id);
  linked=false;await bridge.maintenanceDsh(original).prompt(original.id,'内部整理',{signal:new AbortController().signal});
  assert.equal(created,1);assert.equal(prompts,3);
});
