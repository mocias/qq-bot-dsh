import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {DshClient} from '../lib/dsh.mjs';
import {createApp} from '../server.mjs';
import {VERSION,PROTOCOL,BUILD_ID} from '../../native-dsh-plugin/lib/schema.mjs';

test('native status uses DSH inventory and live version, distinguishing off, missing, incompatible and unavailable',async t=>{
  let bundles=[],failProbe=false,live={version:VERSION,protocol:PROTOCOL,buildId:BUILD_ID,active:0};
  const methods=[];
  const dsh=http.createServer(async(req,res)=>{
    if(req.method==='GET'){res.writeHead(200,{'Set-Cookie':'dsh-auth-test=local'});res.end('{}');return;}
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);methods.push(body.method);
    if(body.method==='pluginManager/listBundles')assert.deepEqual(body.payload.args,{});
    const ok=body.method!=='qqRsiNative/probe'||!failProbe;
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({type:'server-response',rpcId:body.rpcId,result:{ok,value:body.method==='pluginManager/listBundles'?bundles:live}}));
  });
  dsh.listen(0,'127.0.0.1');await once(dsh,'listening');t.after(()=>{dsh.closeAllConnections();dsh.close();});
  const config={dshUrl:`http://127.0.0.1:${dsh.address().port}`,dshToken:'test-only',dshNativeTools:true};
  const client=new DshClient(config);
  assert.equal((await client.nativeStatus()).state,'missing');
  bundles=[{name:'dsh-qq-rsi-native',installed:true,enabled:false,version:VERSION}];
  assert.equal((await client.nativeStatus()).state,'disabled');assert.equal(methods.includes('qqRsiNative/probe'),false);
  bundles[0].enabled=true;assert.equal((await client.nativeStatus()).state,'ready');
  live.buildId='wrong';assert.equal((await client.nativeStatus()).state,'mismatch');
  live.buildId=BUILD_ID;failProbe=true;assert.equal((await client.nativeStatus()).state,'unavailable');
  failProbe=false;bundles[0].version='old';assert.equal((await client.nativeStatus()).state,'mismatch');
  bundles[0].version=VERSION;
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-native-panel-'));
  fs.writeFileSync(path.join(runtime,'config.private.json'),JSON.stringify(config));
  const app=createApp({runtime});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{app.bridge.stop();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));fs.rmSync(runtime,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(origin+'/api/dsh/native-status',{method:'POST'})).status,401);
  const login=await fetch(app.loginUrl(),{redirect:'manual'}),cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
  const response=await fetch(origin+'/api/dsh/native-status',{method:'POST',headers:{cookie,Origin:origin,'X-QQ-RSI':'panel','Content-Type':'application/json'},body:'{}'});
  assert.equal(response.status,200);const status=await response.json();
  assert.equal(status.state,'ready');assert.equal(status.serviceVersion,VERSION);assert.equal(JSON.stringify(status).includes('test-only'),false);
  const page=await(await fetch(origin+'/',{headers:{cookie}})).text();assert.match(page,/id="native-plugin-card"/);
  dsh.closeAllConnections();await new Promise(r=>dsh.close(r));
  const unreachable=await client.nativeStatus();assert.equal(unreachable.state,'unreachable');assert.equal(unreachable.installed,null);
});
