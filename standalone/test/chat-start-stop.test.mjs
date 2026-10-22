import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {Bridge} from '../lib/bridge.mjs';
import {validate} from '../lib/config.mjs';
import {PersonaCards} from '../lib/persona-cards.mjs';
const bot='100000001',a=bot+'/private/100000002',b=bot+'/private/100000003',g=bot+'/group/100000004';
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-single-chat-'));
 const ws=new WebSocketServer({port:0,host:'127.0.0.1'});await once(ws,'listening');let connections=0;
 ws.on('connection',socket=>{connections++;socket.on('message',bytes=>{const input=JSON.parse(bytes);socket.send(JSON.stringify({echo:input.echo,status:'ok',retcode:0,data:input.action==='get_login_info'?{user_id:bot}:{online:true,good:true}}));});});
 class Dsh{async probe(){return {presets:[{id:'minimal'}]};}close(){}}
 const bridge=new Bridge(root,{Dsh}),starts=[];bridge.startup.begin=(kinds,options)=>starts.push(options.keys);
 const config=validate({botQQ:bot,privateUsers:['100000002','100000003'],groups:['100000004'],privatePreset:'minimal',groupPreset:'minimal',qqUrl:'ws://127.0.0.1:'+ws.address().port});
 t.after(async()=>{bridge.stop();for(const s of ws.clients)s.terminate();await new Promise(r=>ws.close(r));fs.rmSync(root,{recursive:true,force:true});});
 return {bridge,config,starts,root,connections:()=>connections};
}
test('single chat start does not validate or start siblings; bulk start fills gaps without another connection',async t=>{
 const f=await fixture(t),{bridge,config,starts}=f;
 config.chatPolicy.overrides={[b]:{preset:'missing'}};
 await bridge.start(config,'all',{key:a,personaId:'default'});assert.deepEqual(bridge.status.chatKeys,[a]);assert.deepEqual(starts,[[a]]);
 assert.equal(bridge.enabled({key:b,group:false}),false);assert.equal(bridge.enabled({key:a,group:false}),true);
 assert.equal(bridge.status.allChannels.private,false);
 await assert.rejects(bridge.start(config,'private'),/不存在/);assert.deepEqual(bridge.status.chatKeys,[a]);
 bridge.config.chatPolicy.overrides={};await bridge.start(config,'private');assert.deepEqual(starts.at(-1),[b]);assert.equal(f.connections(),1);
 assert.equal(bridge.status.allChannels.private,true);await bridge.start(config,'all',{key:g});assert.equal(f.connections(),1);
 bridge.stop('all',a);assert.equal(bridge.status.state,'running');assert.equal(bridge.enabled({key:a,group:false}),false);assert.equal(bridge.enabled({key:b,group:false}),true);assert.equal(bridge.enabled({key:g,group:true}),true);
 await bridge.start(config,'private');assert.deepEqual(starts.at(-1),[a]);
 bridge.stop('private');assert.deepEqual(bridge.status.chatKeys,[g]);bridge.stop('all',g);assert.equal(bridge.status.state,'stopped');
});
test('stop revokes only target jobs, timers and message admission, and blocks restarting unfinished jobs',async t=>{
 const {bridge,config,root}=await fixture(t);await bridge.start(config,'private');
 const ca=new AbortController(),cb=new AbortController(),da=new AbortController();bridge.jobs.set(a,{controller:ca});bridge.jobs.set(b,{controller:cb});bridge.deliveryWaits.set(a,new Set([da]));
 const generation=bridge.generation;bridge.stop('all',a);assert.equal(bridge.generation,generation);assert.equal(ca.signal.aborted,true);assert.equal(da.signal.aborted,true);assert.equal(cb.signal.aborted,false);
 await assert.rejects(bridge.start(config,'all',{key:a}),/退出/);
 bridge.jobs.delete(a);bridge.jobs.delete(b);bridge.deliveryWaits.delete(a);
 const received=[];bridge.dispatch=r=>received.push(r.key);
 for(const id of ['100000002','100000003'])bridge.receive({post_type:'message',message_type:'private',self_id:bot,user_id:id,message_id:id,message:[{type:'text',data:{text:'模拟'}}]},generation);
 assert.deepEqual(received,[b]);assert.equal(bridge.inbox(a).read().messages.length,0);
 const cards=new PersonaCards(root),card=cards.create({key:a,name:'新人格',revision:0});bridge.configurePersona({key:a,personaId:card.id,revision:1});
 await assert.rejects(bridge.start(config,'all',{key:a,personaId:'default'}),/人格绑定/);
 await bridge.start(config,'all',{key:a,personaId:card.id});assert.equal(bridge.enabled({key:a,group:false,personaId:card.id}),true);
});
