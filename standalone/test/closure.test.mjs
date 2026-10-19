import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {probeQQ} from '../lib/onebot.mjs';
import {MemoryStore,preparePrompt} from '../lib/memory.mjs';
import {defaults} from '../lib/config.mjs';
import {localSessionCookie} from '../lib/local-dsh-auth.mjs';
import {Bridge} from '../lib/bridge.mjs';
import {initializeLife,noteArrival} from '../lib/lifecycle.mjs';

test('QQ probe rejects wrong account, offline state, invalid auth and verifies real RPC receipts',async t=>{
 const server=new WebSocketServer({port:0,host:'127.0.0.1'});await once(server,'listening');
 let online=true;
 server.on('connection',(socket,req)=>socket.on('message',bytes=>{
  const v=JSON.parse(bytes),ok=req.headers.authorization==='Bearer good';
  socket.send(JSON.stringify({echo:v.echo,status:ok?'ok':'failed',retcode:ok?0:1403,data:v.action==='get_login_info'?{user_id:100000001}:{online,good:true}}));
 }));
 t.after(async()=>{for(const c of server.clients)c.terminate();await new Promise(r=>server.close(r));});
 const config={qqUrl:'ws://127.0.0.1:'+server.address().port,qqToken:'good',botQQ:'100000001'};
 assert.equal((await probeQQ(config)).account,'100000001');
 await assert.rejects(probeQQ({...config,botQQ:'100000002'}),/不匹配/);
 await assert.rejects(probeQQ({...config,qqToken:'invalid'}),/拒绝/);
 online=false;await assert.rejects(probeQQ(config),/离线/);
});
test('original memory core indexes, stamps access, checks health and recalls nested pages across sessions',t=>{
 const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-original-core-'));t.after(()=>fs.rmSync(runtime,{recursive:true,force:true}));
 const key='100000001/private/100000002',store=new MemoryStore(runtime,key);
 store.commit([{page:'user/preferences/tea.md',action:'write',text:'# 喝茶偏好\n喜欢茉莉花茶。',reason:'用户明确要求记住',evidence:['m1']}],{id:'remember1',evidenceIds:['m1']});
 const restored=new MemoryStore(runtime,key);
 const prompt=preparePrompt(restored,{text:'我喜欢什么茶',messageId:'m2'},defaults);
 assert.match(prompt,/茉莉花茶/);assert.match(prompt,/memory — 长期记忆技能操作手册/);
 const detail=restored.inspect();assert.equal(detail.insights.overview.pages,1);assert.equal(detail.graph.nodes.filter(n=>n.kind==='page').length,1);assert.ok(detail.checkup.integrity);
 assert.match(fs.readFileSync(path.join(store.dir,'user/preferences/tea.md'),'utf8'),/last_access: \d{4}-\d{2}-\d{2}/);
 assert.equal(new MemoryStore(runtime,'100000001/private/998877').context('茶',defaults).includes('茉莉花茶'),false);
 restored.commit([{page:'user/preferences/tea.md',action:'forget',text:'',reason:'用户要求忘记',evidence:['m3']}],{id:'forget1',evidenceIds:['m3']});
 assert.equal(restored.context('茶',defaults).includes('茉莉花茶'),false);
});
test('local DSH auth binds authority, expires and never accepts remote addresses',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'qq-auth-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 fs.writeFileSync(path.join(home,'.credentials.yaml'),JSON.stringify({records:{'client-connection/browser-session':{kind:'grant',payload:{version:1,secret:Buffer.alloc(32,1).toString('base64url')}}}}));
 const result=localSessionCookie('http://127.0.0.1:54450',{home,now:1000});
 const payload=JSON.parse(Buffer.from(result.cookie.split('.')[1],'base64url'));
 assert.equal(payload.authority,'127.0.0.1:54450');assert.equal(payload.expiresAt,3601000);
 assert.throws(()=>localSessionCookie('https://example.com',{home}),/本机/);
});
test('manual fresh session preserves old history and durable memory; arrival prevents switch',async t=>{
 const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-session-new-'));t.after(()=>fs.rmSync(runtime,{recursive:true,force:true}));
 const bridge=new Bridge(runtime),key='100000001/private/100000002';bridge.config={...defaults,privatePreset:'minimal'};bridge.status.state='running';
 const route={key,id:'100000002',group:false},scope=bridge.scope(route),old={id:'old',route,workspace:runtime,preset:'minimal',blocked:false};initializeLife(old,Date.now());bridge.state.sessions[scope]=old;
 const memory=bridge.memory(key);memory.commit([{action:'write',page:'user/test.md',text:'# Test\n记忆不丢失',reason:'test',evidence:['1']}],{id:'m1',evidenceIds:['1']});
 bridge.dsh={async createSession(){return 'fresh';},async rename(){}};
 const result=await bridge.newConversation(key);assert.equal(result.newId,'fresh');assert.equal(bridge.state.retired[0].id,'old');assert.ok(new MemoryStore(runtime,key).hasReceipt('m1'));
 const current=bridge.state.sessions[scope];bridge.dsh.createSession=async()=>{noteArrival(current,Date.now());return'abandoned';};
 await assert.rejects(bridge.newConversation(key),/新消息/);assert.equal(bridge.state.sessions[scope].id,'fresh');
});
