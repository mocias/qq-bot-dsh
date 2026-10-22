import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {repairWorkspaceMembership} from '../../native-dsh-plugin/lib/workspace-link.mjs';
import {VERSION,PROTOCOL,BUILD_ID} from '../../native-dsh-plugin/lib/schema.mjs';

test('installed DSH registry restores existing session membership across deletion and reload without touching archive or pins',{
  skip:!process.env.QQ_RSI_DSH_SDK_ROOT
},async t=>{
  const {WorkspaceRegistry}=await import(process.env.QQ_RSI_DSH_SDK_ROOT.replace(/\/$/,'')+'/dsh-workspace/lib/index.js');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-workspace-sdk-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const workspace=path.join(root,'workspaces','original');fs.mkdirSync(workspace,{recursive:true});
  const headers=[{id:'original-session',cwd:workspace,createdAt:1}],records=new Map();let state={initialized:true,workspaceIds:[],archivedSessionIds:['old-archived'],pinnedSessionIds:['pinned-other']};
  function registry(){
    const r=Object.assign(Object.create(WorkspaceRegistry.prototype),{ctx:{sessionPersistence:{list:async()=>headers.map(header=>({header}))},get:()=>undefined},state,
      table:{get:id=>records.get(id),put:async(id,value)=>records.set(id,value),delete:async id=>records.delete(id),entries:()=>records.entries(),keys:()=>records.keys(),
        update:async(id,fn)=>{const value=fn(records.get(id));records.set(id,value);return value;}},global:{set:async value=>{state=value;}},
      entities:new Map(),headers:new Map(),sessionPaths:new Map(),missingSessionPaths:new Set(),invalidSessionPaths:new Map(),operationTail:Promise.resolve()});
    r.host={table:()=>r.table,candidateMatches:(id,dir)=>r.sessionPaths.get(id)===dir||r.missingSessionPaths.has(id),readSessionHeader:id=>r.readSessionHeader(id),
      rememberSessionPath:(id,dir)=>{r.sessionPaths.set(id,dir);r.missingSessionPaths.delete(id);r.invalidSessionPaths.delete(id);}};
    return r;
  }
  const request={sessionId:'original-session',workspacePath:workspace,version:VERSION,protocol:PROTOCOL,buildId:BUILD_ID};
  let r=registry(),ctx={workspaceRegistry:r,sessionPersistence:r.ctx.sessionPersistence};
  const first=await repairWorkspaceMembership(ctx,root,request);assert.deepEqual(r.get(first.workspaceId).sessionIds,['original-session']);
  await r.get(first.workspaceId).setTitle('用户自定义工作区');await repairWorkspaceMembership(ctx,root,request);
  assert.equal(r.get(first.workspaceId).title,'用户自定义工作区');assert.equal(records.size,1);
  r=registry();await r.replaceHeaderIndex(headers);r.rebuildEntities();ctx={workspaceRegistry:r,sessionPersistence:r.ctx.sessionPersistence};
  await repairWorkspaceMembership(ctx,root,request);assert.equal(records.size,1);assert.equal(r.get(first.workspaceId).title,'用户自定义工作区');
  await r.delete(first.workspaceId);assert.equal(records.size,0);
  const restored=await repairWorkspaceMembership(ctx,root,request);assert.deepEqual(r.get(restored.workspaceId).sessionIds,['original-session']);
  assert.deepEqual(state.archivedSessionIds,['old-archived']);assert.deepEqual(state.pinnedSessionIds,['pinned-other']);assert.equal(headers[0].id,'original-session');
});

test('installed Cordis enforces the native entry service dependencies during workspace repair',{
  skip:!process.env.QQ_RSI_DSH_SDK_ROOT
},async t=>{
  const base=process.env.QQ_RSI_DSH_SDK_ROOT.replace(/\/$/,'');
  const {Context,Service}=await import(base+'/cordis/lib/index.js');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-workspace-scope-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const workspace=path.join(root,'workspaces','original');fs.mkdirSync(workspace,{recursive:true});
  let source=fs.readFileSync(new URL('../../native-dsh-plugin/lib/index.mjs',import.meta.url),'utf8');
  for(const name of ['dsh-tools','dsh-typert-protocol'])source=source.replace(`'@deepseek-ai/${name}'`,JSON.stringify(base+'/'+name+'/lib/index.js'));
  const entry=path.join(root,'entry.mjs');fs.writeFileSync(entry,source);
  const Native=(await import(pathToFileURL(entry))).default,ctx=new Context(),fibers=[];
  for(const name of [...new Set([...Native.inject,'sessions'])]){
    class Stub extends Service{constructor(c){super(c,name);
      if(name==='sessions')this.get=()=>undefined;
      if(name==='sessionPersistence')this.list=async()=>[{header:{id:'original',cwd:workspace}}];
      if(name==='workspaceRegistry')this.create=async dir=>({id:'restored',path:dir,sessionIds:[],async attachSession(id){this.sessionIds.push(id);}});
    }}
    fibers.push(await ctx.plugin(Stub));
  }
  let operation,scope;
  try{
    scope=await ctx.inject(Native.inject,inner=>{operation=repairWorkspaceMembership(inner,root,{sessionId:'original',workspacePath:workspace,version:VERSION,protocol:PROTOCOL,buildId:BUILD_ID});});
    assert.ok(operation);assert.equal((await operation).sessionId,'original');
  }finally{await scope?.dispose();for(const fiber of fibers.reverse())await fiber.dispose();}
});
