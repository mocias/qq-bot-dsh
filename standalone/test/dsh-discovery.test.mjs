import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import YAML from 'js-yaml';
import {discoverDshUrl,probeDshUrl} from '../lib/dsh-discovery.mjs';
import {DshClient} from '../lib/dsh.mjs';

function dshHome(t){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-home-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const secret=randomBytes(32).toString('base64url');
  fs.writeFileSync(path.join(home,'.credentials.yaml'),
    YAML.dump({records:{'client-connection/browser-session':{kind:'grant',payload:{version:1,secret}}}}));
  return home;
}
async function listen(t,handler){
  const server=http.createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const port=server.address().port;
  return {port,url:'http://127.0.0.1:'+port};
}
const dshHandler=(req,res)=>{
  let body='';req.on('data',c=>body+=c);req.on('end',()=>{
    const value=JSON.parse(body||'{}');
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({type:'server-response',rpcId:value.rpcId,result:{ok:true,value:{presets:[{id:'minimal'}]}}}));
  });
};
const decoyHandler=(req,res)=>{res.writeHead(404,{'Content-Type':'text/plain'});res.end('not dsh');};

test('discovery ignores a stale address and finds the live DSH listener by its handshake',async t=>{
  const home=dshHome(t);
  const dsh=await listen(t,dshHandler),decoy=await listen(t,decoyHandler);
  assert.equal(await probeDshUrl(dsh.url,{home}),true);
  assert.equal(await probeDshUrl(decoy.url,{home}),false);
  const found=await discoverDshUrl({current:decoy.url,ports:[decoy.port,dsh.port],home});
  assert.deepEqual(found,{url:dsh.url,reused:false});
  const kept=await discoverDshUrl({current:dsh.url,ports:[dsh.port],home});
  assert.deepEqual(kept,{url:dsh.url,reused:true});
  assert.equal(await discoverDshUrl({current:'',ports:[decoy.port],home}),null);
});
test('a client recovers from a stale port once and persists the discovered address',async t=>{
  const home=dshHome(t),previous=process.env.DSH_HOME;
  process.env.DSH_HOME=home;t.after(()=>{if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;});
  const dsh=await listen(t,dshHandler),decoy=await listen(t,decoyHandler);
  const config={dshUrl:decoy.url,dshLocalAuth:true,dshToken:'',dshNativeTools:true};
  const persisted=[];
  const client=new DshClient(config,{discover:async()=>({url:dsh.url,reused:false})});
  client.systemLog={record(){} };
  const value=await client.rpc('agentPresets/list');
  assert.equal(value.presets[0].id,'minimal');
  assert.equal(config.dshUrl,dsh.url);
  assert.equal(client.urlRecoveryTried,true);
  // A second failure must not rescan.
  client.config.dshUrl=decoy.url;
  await assert.rejects(client.rpc('agentPresets/list'),/DSH 请求失败或超时/);
  client.close();
  assert.deepEqual(persisted,[]);
});
