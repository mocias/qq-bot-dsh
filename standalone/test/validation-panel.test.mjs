import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createValidationPanel} from '../scripts/validation-panel.mjs';
async function fixture(t,options={}){
 const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-validation-entry-'));
 const panel=await createValidationPanel({runtime,...options});
 t.after(async()=>{await panel.close();fs.rmSync(runtime,{recursive:true,force:true});});
 const origin=new URL(panel.app.loginUrl()).origin,login=await fetch(panel.app.loginUrl(),{redirect:'manual'}),cookie=login.headers.get('set-cookie').split(';')[0];
 const api=async(url,input)=>{const r=await fetch(origin+url,{method:input===undefined?'GET':'POST',headers:{cookie,Origin:origin,'Content-Type':'application/json','X-QQ-RSI':'panel'},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:r.status,data:await r.json()};};
 return {panel,api,runtime};
}
test('isolated mock entry exercises version prepare, activate and rollback without native components or real model',async t=>{
 const {api,runtime}=await fixture(t,{botQQ:'100000001',privatePeer:'100000002'});
 const initial=(await api('/api/status')).data;assert.match(initial.validationMessage,/模拟/);assert.deepEqual(initial.config.privateUsers,['100000002']);assert.deepEqual(initial.config.groups,[]);assert.notEqual(initial.config.dshUrl,'http://127.0.0.1:3080');assert.equal(initial.bridge.state,'stopped');
 await api('/api/qq/runtime/prepare',{});
 let state=(await api('/api/qq/control/status',{})).data;assert.equal(state.runtime.versions.activeId,'mock-a');
 await api('/api/qq/runtime/version/install',{versionId:'mock-b'});state=(await api('/api/qq/control/status',{})).data;assert.equal(state.runtime.versions.activeId,'mock-a');
 assert.equal((await api('/api/qq/runtime/version/activate',{versionId:'mock-b',expectedActiveId:'mock-a',expectedRevision:1})).status,200);
 assert.equal((await api('/api/qq/runtime/version/rollback',{expectedActiveId:'mock-b',expectedRevision:2})).status,200);
 state=(await api('/api/qq/control/status',{})).data;assert.equal(state.runtime.versions.activeId,'mock-a');assert.equal(state.receiving.state,'stopped');
 await api('/api/qq/runtime/start',{});await api('/api/qq/control/qrcode',{});assert.equal((await api('/api/bridge/start',{kind:'private'})).status,200);
 assert.equal((await api('/api/bridge/start',{kind:'group'})).status,400);await api('/api/bridge/stop',{});await api('/api/qq/runtime/stop',{});
 assert.equal(fs.existsSync(path.join(runtime,'qq-shell')),false);
});
test('components entry creates fresh scoped configuration but does not prepare, launch QQ or connect to real DSH',async t=>{
 const {api,runtime}=await fixture(t,{mode:'components',botQQ:'100000001',privatePeer:'100000002'});
 const state=(await api('/api/status')).data;assert.equal(state.bridge.state,'stopped');assert.deepEqual(state.config.groups,[]);assert.deepEqual(state.config.privateUsers,['100000002']);assert.match(state.validationMessage,/不会自动启动/);assert.notEqual(state.config.dshUrl,'http://127.0.0.1:3080');
 assert.equal(fs.existsSync(path.join(runtime,'qq-shell')),false);assert.equal(JSON.parse(fs.readFileSync(path.join(runtime,'validation.private.json'))).mode,'components');
 await assert.rejects(createValidationPanel({runtime}),/全新空目录/);
});
test('resuming an isolated component panel preserves its data and requires its marker and exact account scope',async t=>{
 const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-rsi-validation-')),options={mode:'components',runtime,botQQ:'100000001',privatePeer:'100000002'};
 const first=await createValidationPanel(options);await first.close();fs.writeFileSync(path.join(runtime,'preserve-me.txt'),'fixture');
 await assert.rejects(createValidationPanel({...options,resume:true,privatePeer:'100000009'}),/范围不符/);
 const resumed=await createValidationPanel({...options,resume:true});t.after(async()=>{await resumed.close();fs.rmSync(runtime,{recursive:true,force:true});});
 assert.equal(fs.readFileSync(path.join(runtime,'preserve-me.txt'),'utf8'),'fixture');assert.equal(resumed.app.bridge.status.state,'stopped');
});
