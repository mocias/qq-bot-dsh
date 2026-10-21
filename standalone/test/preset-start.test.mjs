import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {Bridge} from '../lib/bridge.mjs';
import {defaults} from '../lib/config.mjs';

test('missing configured group preset rejects before QQ connection, preserves config and active private channel',async t=>{
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-preset-'));
  const qq=new WebSocketServer({port:0,host:'127.0.0.1'});await once(qq,'listening');let connections=0;
  qq.on('connection',socket=>{connections++;socket.on('message',bytes=>{const v=JSON.parse(bytes);socket.send(JSON.stringify({echo:v.echo,status:'ok',retcode:0,data:v.action==='get_login_info'?{user_id:'100000001'}:{online:true,good:true}}));});});
  let available=[{id:'minimal',name:'私聊'},{id:'standard'}];
  class Dsh{async probe(){return {presets:available};}close(){}}
  const bridge=new Bridge(runtime,{Dsh});
  bridge.startup.begin=()=>{}; // This fixture isolates preset validation; startup-chat covers the full sequence.
  t.after(async()=>{bridge.stop();for(const s of qq.clients)s.terminate();await new Promise(r=>qq.close(r));fs.rmSync(runtime,{recursive:true,force:true});});
  const config={...defaults,botQQ:'100000001',qqUrl:'ws://127.0.0.1:'+qq.address().port,privateUsers:['100000002'],groups:['100000003'],privatePreset:'minimal',groupPreset:'group-only'};
  await assert.rejects(bridge.start(config,'group'),/群聊.*group-only.*不存在/);
  assert.equal(connections,0);assert.equal(bridge.status.state,'stopped');assert.equal(config.groupPreset,'group-only');
  await bridge.start(config,'private');
  await assert.rejects(bridge.start(config,'group'),/不存在/);
  assert.deepEqual(bridge.status.channels,{private:true,group:false});assert.equal(connections,1);
  available.push({id:'group-only'});
  await bridge.start(config,'group');assert.equal(connections,1);assert.equal(bridge.status.channels.group,true);
  bridge.stop('group');bridge.config.groupPreset='私聊';
  await assert.rejects(bridge.start(config,'group'),/不存在/); // display labels are not preset IDs
  bridge.config.groupPreset='group-only';
  let finish;bridge.dsh.probe=()=>new Promise(resolve=>{finish=resolve;});
  const pending=bridge.start(config,'group');bridge.stop('group');finish({presets:available});
  await assert.rejects(pending,/启动已取消/);assert.equal(bridge.status.channels.group,false);
});
