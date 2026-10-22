import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DshClient} from '../lib/dsh.mjs';
import {reloadNativePlugin,restorePluginProfileOrder} from '../../scripts/native-plugin-reload.mjs';
test('native entry reload preserves disabled state and refuses active rounds',async()=>{
  let calls=0;const dsh={nativeStatus:async()=>({enabled:false}),rpc:async()=>{calls++;}};
  await reloadNativePlugin(dsh);assert.equal(calls,0);
  dsh.nativeStatus=async()=>({enabled:true});dsh.rpc=async()=>({active:1});
  await assert.rejects(reloadNativePlugin(dsh),/活动/);
});
test('native entry reload applies disable and enable with named arguments and verifies the new runtime',async()=>{
  const toggles=[];const dsh={nativeStatus:async()=>({enabled:true}),rpc:async(method,args)=>{
    if(method==='qqRsiNative/probe')return {active:0,version:'test'};
    assert.equal(method,'pluginManager/setBundleEnabled');assert.equal(args.name,'dsh-qq-rsi-native');toggles.push(args.enabled);return {application:'applied'};
  }};
  assert.equal((await reloadNativePlugin(dsh)).version,'test');assert.deepEqual(toggles,[false,true]);
});
test('a rejected disable still attempts to restore the original enabled state',async()=>{
  const toggles=[];const dsh={nativeStatus:async()=>({enabled:true}),rpc:async(method,args)=>{
    if(method==='qqRsiNative/probe')return {active:0};toggles.push(args.enabled);if(!args.enabled)throw Error('rejected');return {application:'applied'};
  }};
  await assert.rejects(reloadNativePlugin(dsh),/rejected/);assert.deepEqual(toggles,[false,true]);
});
test('DSH plugin management encodes named arguments without a request wrapper',async t=>{
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);
    assert.deepEqual(body.payload.args,{name:'dsh-qq-rsi-native',enabled:true});
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({type:'server-response',rpcId:body.rpcId,result:{ok:true,value:{application:'applied'}}}));
  });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const client=new DshClient({dshUrl:'http://127.0.0.1:'+server.address().port});client.cookie='test-cookie';
  assert.equal((await client.rpc('pluginManager/setBundleEnabled',{name:'dsh-qq-rsi-native',enabled:true})).application,'applied');
});
test('entry reload restores exact profile bytes and original bundle order',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-reload-profile-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const profileFile=path.join(root,'package.json'),text=JSON.stringify({unrelated:{keep:true},dsh:{profile:{bundles:['base','dsh-qq-rsi-native','other']}}},null,2)+'\n';fs.writeFileSync(profileFile,text);
  const dsh={nativeStatus:async()=>({enabled:true}),rpc:async(method,args)=>{
    if(method==='qqRsiNative/probe')return {active:0};
    const doc=JSON.parse(fs.readFileSync(profileFile));doc.dsh.profile.bundles=doc.dsh.profile.bundles.filter(x=>x!==args.name);
    if(args.enabled)doc.dsh.profile.bundles.push(args.name);fs.writeFileSync(profileFile,JSON.stringify(doc));return {application:'applied'};
  }};
  await reloadNativePlugin(dsh,{profileFile});assert.equal(fs.readFileSync(profileFile,'utf8'),text);
  const changed=JSON.parse(text);changed.unrelated.keep=false;fs.writeFileSync(profileFile,JSON.stringify(changed));
  assert.throws(()=>restorePluginProfileOrder(profileFile,text),/其他变化/);assert.equal(JSON.parse(fs.readFileSync(profileFile)).unrelated.keep,false);
});
