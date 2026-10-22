import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {syncNapcat,mergeNapcat} from '../lib/napcat-sync.mjs';
import {createApp} from '../server.mjs';
import {once} from 'node:events';
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'napcat-sync-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir=path.join(root,'framework');fs.mkdirSync(path.join(dir,'config'),{recursive:true});fs.writeFileSync(path.join(dir,'nativeLoader.cjs'),'fixture');
  return {root,dir,config:{qqBackend:'external',botQQ:'100000001',qqUrl:'ws://127.0.0.1:3001',qqToken:'test-only-token',napcatFrameworkDir:dir}};
}
test('panel connection replaces managed listener while retaining unrelated NapCat settings',()=>{
  const original={parseMultMsg:true,network:{httpServers:[{name:'other'}],websocketServers:[{name:'qq-rsi-local',port:1234},{name:'external',port:9999}]}};
  const result=mergeNapcat(original,{qqUrl:'ws://127.0.0.1:3001',qqToken:'test-only'});
  assert.equal(result.network.websocketServers[0].port,9999);
  assert.deepEqual(result.network.httpServers,original.network.httpServers);
  const managed=result.network.websocketServers[1];assert.equal(managed.port,3001);assert.equal(managed.host,'127.0.0.1');assert.equal(managed.token,'test-only');assert.equal(managed.messagePostFormat,'array');assert.equal(managed.enable,true);
  assert.equal(original.network.websocketServers[0].port,1234);
  assert.throws(()=>mergeNapcat({}, {qqUrl:'ws://example.com:3001'}),/本机/);
  assert.throws(()=>mergeNapcat({}, {qqUrl:'wss://127.0.0.1:3001'}),/ws:/);
});
test('offline sync prepares only panel account, backs up changes and is idempotent',async t=>{
  const {root,dir,config}=fixture(t),file=path.join(dir,'config','onebot11_100000001.json'),other=path.join(dir,'config','onebot11_100000002.json');
  fs.writeFileSync(file,'{"parseMultMsg":true}');fs.writeFileSync(other,'{"untouched":true}');
  const result=await syncNapcat(config,root);assert.equal(result.state,'pending');assert.equal(result.changed,true);
  assert.equal(JSON.parse(fs.readFileSync(file)).network.websocketServers[0].port,3001);assert.equal(fs.readFileSync(other,'utf8'),'{"untouched":true}');
  const backups=fs.readdirSync(path.join(root,'napcat-backups'));assert.equal(backups.length,1);
  assert.equal((await syncNapcat(config,root)).changed,false);assert.equal(fs.readdirSync(path.join(root,'napcat-backups')).length,1);
  await assert.rejects(syncNapcat({...config,botQQ:'../escape'},root),/账号/);
});
test('matching logged-in account applies panel endpoint through authenticated NapCat API',async t=>{
  const {root,dir,config}=fixture(t);fs.writeFileSync(path.join(dir,'config','webui.json'),JSON.stringify({host:'127.0.0.1',port:6099,token:'test-webui'}));
  const calls=[];let applied;
  const fetch=async(url,options)=>{calls.push(url);assert.ok(url.startsWith('http://127.0.0.1:6099/api/'));
    if(url.endsWith('/login'))return Response.json({code:0,data:{Credential:'test-session'}});
    assert.equal(options.headers.Authorization,'Bearer test-session');
    if(url.endsWith('/GetQQLoginInfo'))return Response.json({code:0,data:{uin:config.botQQ}});
    if(url.endsWith('/GetConfig'))return Response.json({code:0,data:{network:{httpServers:[]}}});
    applied=JSON.parse(JSON.parse(options.body).config);return Response.json({code:0,data:null});
  };
  const result=await syncNapcat(config,root,{fetch});assert.equal(result.state,'applied');assert.equal(applied.network.websocketServers[0].token,config.qqToken);assert.equal(calls.length,4);
  assert.ok(!JSON.stringify(result).includes(config.qqToken));
});
test('wrong logged-in account and web auth failure never update another active account',async t=>{
  const {root,dir,config}=fixture(t);fs.writeFileSync(path.join(dir,'config','webui.json'),JSON.stringify({port:6099,token:'test-webui'}));
  let writes=0;
  const fetch=async(url)=>{if(url.endsWith('/login'))return Response.json({code:0,data:{Credential:'test-session'}});
    if(url.endsWith('/GetQQLoginInfo'))return Response.json({code:0,data:{uin:'100000002'}});
    writes++;throw Error('should not write');
  };
  const result=await syncNapcat(config,root,{fetch});assert.equal(result.state,'pending');assert.match(result.message,/账号/);assert.equal(writes,0);
  const failure=await syncNapcat(config,root,{fetch:async()=>{throw Error('secret upstream failure');}});
  assert.equal(failure.state,'pending');assert.ok(!JSON.stringify(failure).includes('secret'));
});
test('panel save syncs the selected account and sync endpoint requires authentication and idle bridge',async t=>{
  const {root,dir,config}=fixture(t),app=createApp({runtime:root,voice:{status:()=>({})},qqRuntime:{status:async()=>({process:{state:'stopped'}})}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{app.bridge.stop();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});
  const login=await fetch(app.loginUrl(),{redirect:'manual'}),origin=new URL(app.loginUrl()).origin;
  const headers={cookie:login.headers.get('set-cookie').split(';')[0],Origin:origin,'Content-Type':'application/json','X-QQ-RSI':'panel'};
  const save=await fetch(origin+'/api/config',{method:'POST',headers,body:JSON.stringify(config)});
  assert.equal(save.status,200);const data=await save.json();assert.equal(data.napcatSync.state,'pending');assert.ok(!JSON.stringify(data).includes(config.qqToken));
  const file=path.join(dir,'config','onebot11_100000001.json');assert.equal(JSON.parse(fs.readFileSync(file)).network.websocketServers[0].token,config.qqToken);
  assert.equal((await fetch(origin+'/api/qq/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  app.bridge.status.state='running';
  assert.equal((await fetch(origin+'/api/qq/sync',{method:'POST',headers,body:'{}'})).status,400);
  app.bridge.status.state='stopped';
  assert.equal((await fetch(origin+'/api/qq/sync',{method:'POST',headers,body:'{}'})).status,200);
});
