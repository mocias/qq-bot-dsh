import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {createApp} from '../server.mjs';
import {validate,writeJson} from '../lib/config.mjs';
import {QQControl} from '../lib/qq-control.mjs';

async function fixture(t,{saved,endpoint='ws://127.0.0.1:1'}={}){
 const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-shell-panel-'));
 if(saved)writeJson(path.join(runtime,'config.private.json'),saved);
 const calls=[];let prepared=false,process='stopped',online=false,account='';
 const catalog=[{id:'fixture-v1',version:'4.18.41',qqVersion:'fixture-1'},{id:'fixture-v2',version:'99.0.0-fixture',qqVersion:'fixture-2'}],installed=new Set();let activeId='',previousId='',revision=0;
 const versions=()=>({catalog:catalog.map(item=>({...item,installed:installed.has(item.id),active:activeId===item.id,previous:previousId===item.id,componentState:installed.has(item.id)?'verified':'missing'})),activeId,previousId,revision,canRollback:!!previousId,legacy:{state:'absent'}});
 const versionInput=({versionId,expectedActiveId,expectedRevision},activate=false)=>{if(activate&&process!=='stopped')throw Error('请先停止 QQ 登录进程');if(versionId&&!catalog.some(item=>item.id===versionId))throw Error('不在受控版本列表');if(activate&&(expectedActiveId!==activeId||expectedRevision!==revision))throw Error('当前版本已变化，请刷新后重试');};
 const qqRuntime={
  resolveConfig:config=>{if(!prepared)throw Error('请先准备组件');return {...config,qqUrl:endpoint,qqToken:'test-managed-secret',napcatFrameworkDir:path.join(runtime,'managed')};},
  status:async()=>({state:prepared?'prepared':'missing',message:prepared?'组件已准备':'来源与兼容记录未完成，无法准备组件',component:{state:prepared?'verified':'missing'},process:{state:process,owned:process==='running'},versions:versions()}),
  prepare:async()=>{calls.push('prepare');prepared=true;installed.add('fixture-v1');if(!activeId){activeId='fixture-v1';revision++;}return {message:'已准备'};},
  installVersion:async(config,input)=>{versionInput(input);calls.push('install:'+input.versionId);installed.add(input.versionId);return {message:'所选版本已准备，尚未使用'};},
  activateVersion:async(config,input)=>{versionInput(input,true);if(!installed.has(input.versionId))throw Error('请先准备所选版本');calls.push('activate:'+input.versionId);previousId=activeId;activeId=input.versionId;revision++;prepared=true;return {message:'版本已切换，接收保持停止'};},
  rollback:async(config,input)=>{versionInput(input,true);if(!previousId)throw Error('没有可回退版本');calls.push('rollback');[activeId,previousId]=[previousId,activeId];revision++;return {message:'已回退，接收保持停止'};},
  start:async()=>{calls.push('start');process='running';return {message:'等待登录'};},
  stop:async()=>{calls.push('stop');process='stopped';return {message:'已停止'};},
 };
 const qqControl={status:async cfg=>({expectedAccount:cfg.botQQ,account,online,accountMatches:online&&account===cfg.botQQ,interfaceOnline:online&&account===cfg.botQQ,napcatReady:true,message:'mock login'}),qrcode:async()=>({image:'data:image/png;base64,test'}),contacts:async()=>({account,items:[{id:'100000002',name:'fixture'}]})};
 const bridge={status:{state:'stopped',active:0},start:async cfg=>{calls.push(cfg);bridge.status.state='running';bridge.status.account=cfg.botQQ;},stop:()=>{bridge.status.state='stopped';},summary:()=>[]};
 const app=createApp({runtime,voice:{status:()=>({})},bridge,qqRuntime,qqControl});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 const origin=new URL(app.loginUrl()).origin,login=await fetch(app.loginUrl(),{redirect:'manual',headers:{Connection:'close'}}),cookie=login.headers.get('set-cookie').split(';')[0];
 const api=async(url,body)=>{const result=await fetch(origin+url,{method:body===undefined?'GET':'POST',headers:{cookie,Origin:origin,'X-QQ-RSI':'panel','Content-Type':'application/json',Connection:'close'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:result.status,data:await result.json()};};
 t.after(async()=>{await new Promise(r=>app.server.close(r));fs.rmSync(runtime,{recursive:true,force:true});});
 return {api,app,origin,runtime,calls,qqRuntime,qqControl,login:(id,ready=true)=>{account=id;online=ready;}};
}
test('new installations select managed Shell while old configurations retain external integration without writes',async t=>{
 assert.equal(validate({}).qqBackend,'shell');assert.throws(()=>validate({qqBackend:'other'}));
 const fresh=await fixture(t);assert.equal((await fresh.api('/api/status')).data.config.qqBackend,'shell');assert.deepEqual(fresh.calls,[]);
 assert.equal(fs.existsSync(path.join(fresh.runtime,'config.private.json')),false);
 const old=await fixture(t,{saved:{botQQ:'100000001',qqUrl:'ws://127.0.0.1:9999',qqToken:'old-secret'}});
 const state=(await old.api('/api/status')).data;assert.equal(state.config.qqBackend,'external');assert.equal(state.bridge.state,'stopped');assert.ok(!JSON.stringify(state).includes('old-secret'));
 assert.equal(JSON.parse(fs.readFileSync(path.join(old.runtime,'config.private.json'))).qqBackend,undefined);
});
test('Shell management requires local authentication, explicit account and idle reception; never auto-enables reception',async t=>{
 const f=await fixture(t);
 assert.equal((await fetch(f.origin+'/api/qq/runtime/prepare',{method:'POST'})).status,401);
 let state=(await f.api('/api/qq/control/status',{})).data;assert.equal(state.phase,'missing');assert.match(state.message,/兼容记录/);
 assert.equal((await f.api('/api/qq/runtime/start',{})).status,400);
 assert.equal((await f.api('/api/config',{botQQ:'100000001'})).status,200);assert.deepEqual(f.calls,[]);
 assert.equal((await f.api('/api/qq/runtime/prepare',{})).status,200);
 assert.equal((await f.api('/api/qq/runtime/start',{})).status,200);
 state=(await f.api('/api/qq/control/status',{})).data;assert.equal(state.phase,'waiting_login');assert.equal(state.receiving.state,'stopped');
 assert.equal((await f.api('/api/qq/control/qrcode',{})).status,200);
 f.login('100000009');state=(await f.api('/api/qq/control/status',{})).data;assert.equal(state.phase,'account_mismatch');
 f.login('100000001');state=(await f.api('/api/qq/control/status',{})).data;assert.equal(state.phase,'interface_ready');
 const status=f.qqControl.status;f.qqControl.status=async c=>({...await status(c),interfaceOnline:false});
 assert.equal((await f.api('/api/qq/control/status',{})).data.phase,'waiting_interface');f.qqControl.status=status;
 assert.equal((await f.api('/api/config',{botQQ:'100000009'})).status,400);
 assert.equal((await f.api('/api/config',{qqBackend:'external'})).status,400);
 assert.equal((await f.api('/api/bridge/start',{})).status,400);
 f.app.bridge.status.state='running';assert.equal((await f.api('/api/qq/runtime/stop',{})).status,400);assert.equal((await f.api('/api/qq/runtime/prepare',{})).status,400);assert.equal((await f.api('/api/qq/control/qrcode',{})).status,400);
 f.app.bridge.stop();assert.equal((await f.api('/api/qq/runtime/stop',{})).status,200);
 assert.ok(!JSON.stringify(state).includes('test-managed-secret'));
});
test('Shell reception verifies actual OneBot identity and online status before passing private connection to Bridge',async t=>{
 let account='100000009',online=true;const wss=new WebSocketServer({host:'127.0.0.1',port:0});await once(wss,'listening');
 wss.on('connection',(socket,req)=>{assert.equal(req.headers.authorization,'Bearer test-managed-secret');socket.on('message',bytes=>{const msg=JSON.parse(bytes);socket.send(JSON.stringify({status:'ok',retcode:0,echo:msg.echo,data:msg.action==='get_login_info'?{user_id:account}:{online,good:true}}));});});
 t.after(async()=>{for(const client of wss.clients)client.terminate();await new Promise(r=>wss.close(r));});
 const f=await fixture(t,{endpoint:`ws://127.0.0.1:${wss.address().port}`});
 await f.api('/api/config',{botQQ:'100000001',privateUsers:['100000002']});await f.api('/api/qq/runtime/prepare',{});await f.api('/api/qq/runtime/start',{});
 assert.equal((await f.api('/api/bridge/start',{kind:'private'})).status,400);assert.equal(f.calls.filter(x=>typeof x==='object').length,0);
 account='100000001';online=false;assert.equal((await f.api('/api/bridge/start',{kind:'private'})).status,400);
 online=true;const started=await f.api('/api/bridge/start',{kind:'private'});assert.equal(started.status,200);assert.equal(f.calls.at(-1).qqToken,'test-managed-secret');assert.equal(f.calls.at(-1).qqBackend,'shell');
 assert.ok(!JSON.stringify(started).includes('test-managed-secret'));
 await f.api('/api/bridge/stop',{});assert.equal(f.calls.includes('stop'),false);
});
test('QQ status never calls an unconfigured account verified and contacts require expected identity',async()=>{
 const control=new QQControl({connect:async()=>({account:'100000001',items:[]})});
 const status=await control.status(validate({}));assert.equal(status.accountMatches,false);
 await assert.rejects(control.contacts(validate({}),'private'),/账号/);
});
test('explicit external migration tolerates an unrelated QQ but refuses an owned or unconfirmed Shell',async t=>{
 const f=await fixture(t);
 f.qqRuntime.status=async()=>({component:{state:'missing'},process:{state:'orphaned',owned:false}});
 assert.equal((await f.api('/api/config',{botQQ:'100000001'})).status,200);
 assert.equal((await f.api('/api/config',{qqBackend:'external',botQQ:'100000001'})).status,200);
 assert.deepEqual(f.calls,[]);
 for(const process of [{state:'running',owned:true},{state:'exit_unconfirmed',owned:false}]){
  const blocked=await fixture(t);blocked.qqRuntime.status=async()=>({component:{state:'missing'},process});
  assert.equal((await blocked.api('/api/config',{qqBackend:'external'})).status,400);assert.deepEqual(blocked.calls,[]);
 }
});
test('a verified endpoint cannot enable Shell reception without a process owned by this service',async t=>{
 const f=await fixture(t);await f.api('/api/config',{botQQ:'100000001',privateUsers:['100000002']});await f.api('/api/qq/runtime/prepare',{});
 f.qqRuntime.status=async()=>({component:{state:'verified'},process:{state:'orphaned',owned:false}});
 const result=await f.api('/api/bridge/start',{kind:'private'});assert.equal(result.status,400);assert.match(result.data.error,/归属/);assert.equal(f.calls.filter(x=>typeof x==='object').length,0);
});
test('invalid Shell components take priority over a matching online account and keep reception blocked',async t=>{
 const f=await fixture(t);await f.api('/api/config',{botQQ:'100000001',privateUsers:['100000002'],groups:['100000003']});await f.api('/api/qq/runtime/prepare',{});f.login('100000001');
 f.qqRuntime.status=async()=>({state:'online',message:'QQ Shell 在线，账号与面板一致',component:{state:'invalid',message:'QQ Shell 本地组件摘要校验失败'},process:{state:'running',owned:true},versions:{catalog:[],activeId:'fixture-v1'}});
 let state=(await f.api('/api/qq/control/status',{})).data;
 assert.equal(state.online,true);assert.equal(state.accountMatches,true);assert.equal(state.interfaceOnline,true);
 assert.equal(state.phase,'component_invalid');assert.equal(state.message,'QQ Shell 本地组件摘要校验失败');assert.equal(state.runtime.process.owned,true);
 const rejected=await f.api('/api/bridge/start',{kind:'private'});assert.equal(rejected.status,400);assert.match(rejected.data.error,/^QQ Shell 本地组件摘要校验失败/);assert.match(rejected.data.error,/登录进程仍在运行/);assert.equal(f.calls.filter(x=>typeof x==='object').length,0);
});
test('Shell status and receive errors preserve stopped and unowned process reasons',async t=>{
 const f=await fixture(t);await f.api('/api/config',{botQQ:'100000001',privateUsers:['100000002']});await f.api('/api/qq/runtime/prepare',{});f.login('100000001');
 f.qqRuntime.status=async()=>({state:'blocked',message:'QQ 进程归属未确认',component:{state:'verified'},process:{state:'running',owned:false}});
 let state=(await f.api('/api/qq/control/status',{})).data;assert.equal(state.phase,'blocked');assert.equal(state.message,'QQ 进程归属未确认');
 let rejected=await f.api('/api/bridge/start',{kind:'private'});assert.equal(rejected.status,400);assert.match(rejected.data.error,/归属未确认/);
 f.qqRuntime.status=async()=>({state:'stopped',message:'QQ 登录进程已停止',component:{state:'verified'},process:{state:'stopped',owned:false}});
 state=(await f.api('/api/qq/control/status',{})).data;assert.equal(state.phase,'stopped');
 rejected=await f.api('/api/bridge/start',{kind:'private'});assert.equal(rejected.status,400);assert.equal(rejected.data.error,'请先启动本项目管理的 QQ 登录进程，再启用接收。');
});
test('the actual panel channel renderer keeps Shell reception disabled until ownership and component are verified',async()=>{
 const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const helper=source.match(/function shellReceiveGate\(data\)\{[\s\S]*?\n\}/)?.[0],renderer=source.match(/function paintChannels\(bridge\)\{[\s\S]*?\n\}/)?.[0];
 assert.ok(helper&&renderer,'expected the panel gate and channel renderer to remain testable functions');
 const elements=new Map(['start','stop','qq-control-start','qq-control-stop','start-private','stop-private','start-group','stop-group','qq-control-start-private','qq-control-stop-private','qq-control-start-group','qq-control-stop-group','bridge-detail','qq-control-bridge'].map(id=>[id,{disabled:false,textContent:''}]));
 const context={qqBackendMode:'shell',qqShellReceiveState:null,$:id=>elements.get(id)};vm.runInNewContext(`${helper}\n${renderer}`,context);
 context.qqShellReceiveState=context.shellReceiveGate({backend:'shell',runtime:{component:{state:'invalid'},process:{state:'running',owned:true}}});
 context.paintChannels({state:'stopped',active:0});
 for(const id of ['start','qq-control-start','start-private','qq-control-start-private','start-group','qq-control-start-group'])assert.equal(elements.get(id).disabled,true,id);
 context.qqBackendMode='external';context.qqShellReceiveState=null;context.paintChannels({state:'stopped',active:0});
 for(const id of ['start','qq-control-start','start-private','qq-control-start-private','start-group','qq-control-start-group'])assert.equal(elements.get(id).disabled,false,id);
});
test('Shell login lifecycle and identity changes wait for outgoing queues and confirmed old Agent exit',async t=>{
 const f=await fixture(t);await f.api('/api/config',{botQQ:'100000001'});await f.api('/api/qq/runtime/prepare',{});
 for(const field of ['outbox','backgrounds','deferredDrains','deliveryWaits']){
  f.app.bridge[field]=new Map([['fixture',{}]]);
  for(const verb of ['start','stop','prepare'])assert.equal((await f.api('/api/qq/runtime/'+verb,{})).status,400);
  assert.equal((await f.api('/api/config',{botQQ:'100000009'})).status,400);
  f.app.bridge[field].clear();
 }
 f.app.bridge.state={sessions:{fixture:{exitUnconfirmed:{sessionId:'old-mock-agent'}}}};
 assert.equal((await f.api('/api/qq/runtime/stop',{})).status,400);assert.equal((await f.api('/api/config',{qqBackend:'external'})).status,400);
 assert.deepEqual(f.calls,['prepare']);
});
test('async receive verification and QQ process management exclude one another',async t=>{
 const f=await fixture(t);await f.api('/api/config',{botQQ:'100000001',privateUsers:['100000002']});await f.api('/api/qq/runtime/prepare',{});
 let release,entered;const checking=new Promise(r=>{entered=r;});f.qqRuntime.status=()=>{entered();return new Promise(r=>{release=r;});};
 const starting=f.api('/api/bridge/start',{kind:'private'});await checking;
 assert.equal((await f.api('/api/qq/runtime/stop',{})).status,400);assert.equal((await f.api('/api/config',{botQQ:'100000009'})).status,400);
 release({component:{state:'verified'},process:{state:'stopped',owned:false}});assert.equal((await starting).status,400);
 let stopped;const stoppingEntered=new Promise(r=>{stopped=r;});f.qqRuntime.stop=()=>{stopped();return new Promise(r=>{release=r;});};
 const stopping=f.api('/api/qq/runtime/stop',{});await stoppingEntered;
 assert.equal((await f.api('/api/bridge/start',{kind:'private'})).status,400);
 release({message:'mock stopped'});assert.equal((await stopping).status,200);
});
test('version management authenticates, separates installed and active versions, rejects stale changes and retains stopped reception',async t=>{
 const f=await fixture(t),base='/api/qq/runtime/version/';
 for(const action of ['install','activate','rollback'])assert.equal((await fetch(f.origin+base+action,{method:'POST'})).status,401);
 assert.equal((await f.api(base+'install',{versionId:'fixture-v1'})).status,400);
 await f.api('/api/config',{botQQ:'100000001'});
 assert.equal((await f.api(base+'install',{versionId:'fixture-v1',url:'https://untrusted.test/qq.zip'})).status,400);
 assert.equal((await f.api(base+'install',{versionId:'https://untrusted.test/qq.zip'})).status,400);
 assert.equal((await f.api(base+'install',{versionId:'fixture-v1'})).status,200);
 let state=(await f.api('/api/qq/control/status',{})).data;assert.equal(state.runtime.versions.activeId,'');assert.equal(state.runtime.versions.catalog[0].installed,true);assert.equal(state.receiving.state,'stopped');
 assert.equal((await f.api(base+'activate',{versionId:'fixture-v1'})).status,400);
 assert.equal((await f.api(base+'activate',{versionId:'fixture-v1',expectedActiveId:'',expectedRevision:0})).status,200);
 await f.api(base+'install',{versionId:'fixture-v2'});state=(await f.api('/api/qq/control/status',{})).data;assert.equal(state.runtime.versions.activeId,'fixture-v1');
 assert.equal((await f.api(base+'activate',{versionId:'fixture-v2',expectedActiveId:'stale',expectedRevision:1})).status,400);assert.equal((await f.api('/api/qq/control/status',{})).data.runtime.versions.activeId,'fixture-v1');
 assert.equal((await f.api(base+'activate',{versionId:'fixture-v2',expectedActiveId:'fixture-v1',expectedRevision:1})).status,200);
 state=(await f.api('/api/qq/control/status',{})).data;assert.equal(state.runtime.versions.activeId,'fixture-v2');assert.equal(state.runtime.versions.previousId,'fixture-v1');
 assert.equal((await f.api(base+'rollback',{expectedActiveId:'fixture-v1',expectedRevision:1})).status,400);
 assert.equal((await f.api(base+'rollback',{expectedActiveId:'fixture-v2',expectedRevision:2})).status,200);
 state=(await f.api('/api/qq/control/status',{})).data;assert.equal(state.runtime.versions.activeId,'fixture-v1');assert.equal(state.runtime.versions.previousId,'fixture-v2');assert.equal(state.receiving.state,'stopped');
 assert.equal(f.calls.some(item=>typeof item==='object'||item==='start'),false);assert.ok(!JSON.stringify(state).includes('test-managed-secret'));
});
test('version changes cannot bypass receiving, pending delivery or unresolved Agent exit gates',async t=>{
 const f=await fixture(t);await f.api('/api/config',{botQQ:'100000001'});await f.api('/api/qq/runtime/prepare',{});
 const blocked=async()=>{for(const [operation,body]of [['install',{versionId:'fixture-v2'}],['activate',{versionId:'fixture-v1',expectedActiveId:'fixture-v1'}],['rollback',{expectedActiveId:'fixture-v1'}]])assert.equal((await f.api('/api/qq/runtime/version/'+operation,body)).status,400);};
 f.app.bridge.status.state='running';await blocked();f.app.bridge.stop();
 f.app.bridge.outbox=new Map([['fixture',{}]]);await blocked();f.app.bridge.outbox.clear();
 f.app.bridge.state={sessions:{old:{exitUnconfirmed:{}}}};await blocked();delete f.app.bridge.state.sessions.old;
 const state=(await f.api('/api/qq/control/status',{})).data;assert.equal(state.runtime.versions.activeId,'fixture-v1');assert.deepEqual(f.calls,['prepare']);
});
test('preparing an immutable version may keep QQ logged in but switching still requires its exit',async t=>{
 const f=await fixture(t);await f.api('/api/config',{botQQ:'100000001'});await f.api('/api/qq/runtime/prepare',{});await f.api('/api/qq/runtime/start',{});
 const state=(await f.api('/api/qq/control/status',{})).data;assert.equal(state.management.allowed,true);assert.equal(state.management.activationAllowed,false);
 assert.equal((await f.api('/api/qq/runtime/version/install',{versionId:'fixture-v2'})).status,200);
 assert.equal((await f.api('/api/qq/runtime/version/activate',{versionId:'fixture-v2',expectedActiveId:'fixture-v1'})).status,400);
 assert.equal(f.calls.includes('stop'),false);assert.equal((await f.api('/api/qq/control/status',{})).data.runtime.versions.activeId,'fixture-v1');
});
