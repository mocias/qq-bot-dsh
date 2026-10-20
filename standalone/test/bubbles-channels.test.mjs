import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {Bridge} from '../lib/bridge.mjs';
import {defaults,validate} from '../lib/config.mjs';
const group={key:'100000001/group/100000003',id:'100000003',group:true,sender:'100000002',text:'你好',messageId:'m1',qqMessageId:'1'};
const peer={...group,key:'100000001/private/100000002',id:'100000002',group:false};
const config={...defaults,botQQ:'100000001',groups:[group.id],privateUsers:[peer.id],privatePreset:'test',groupPreset:'test',memoryEnabled:false,qqVoiceSend:false,mentionSend:true};
const env=(reply='',actions=[])=>JSON.stringify({reply,memory:[],actions});
const text=p=>(p.message??[]).filter(s=>s.type==='text').map(s=>s.data.text).join('');
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-bubbles-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function fixture(t,extra={}){
  let now=Date.now();const waits=[],sent=[];
  const bridge=new Bridge(temp(t),{now:()=>now,random:()=>0.5,wait:async ms=>{waits.push(ms);now+=ms;},...extra});
  bridge.config={...config};bridge.status={state:'running',active:0,channels:{private:true,group:true}};
  bridge.dsh={probe:async()=>({presets:[{id:'test'}]}),createSession:async()=> 's1',rename:async()=>{},close(){}};
  bridge.call=async(action,params)=>{if(action==='get_group_member_info')return {group_id:params.group_id,user_id:params.user_id};sent.push({action,params});return {message_id:sent.length};};
  t.after(()=>bridge.stop());return {bridge,waits,sent};
}
const until=async predicate=>{for(let n=0;n<200;n++){if(predicate())return;await new Promise(r=>setImmediate(r));}assert.fail('condition timed out');};

test('topic bubbles retain separate mentions or no mention and random intervals',async t=>{
  const {bridge,sent,waits}=fixture(t);let round=0;
  bridge.dsh.prompt=async()=>round++?env():env('',[
    {tool:'qq_send_message',args:{messages:'天气话题',atUserId:'100000002'}},
    {tool:'qq_send_message',args:{messages:'聚餐话题',atUserId:'100000004'}},
    {tool:'qq_send_message',args:{messages:['补充说明','结束语']}},
  ]);
  await bridge.handle(group,0);
  assert.deepEqual(sent.map(x=>text(x.params)),['天气话题','聚餐话题','补充说明','结束语']);
  assert.deepEqual(sent.map(x=>x.params.message.find(s=>s.type==='at')?.data.qq),['100000002','100000004',undefined,undefined]);
  assert.deepEqual(waits,[3500,3500,3500]);
  assert.deepEqual(bridge.state.deliveries.map(d=>[d.partIndex,d.partCount]),[[0,4],[1,4],[2,4],[3,4]]);
});
test('group minimum gap waits before transport; each bubble still counts against hourly quota',async t=>{
  const {bridge,sent,waits}=fixture(t);bridge.config.groupMinReplyGapSeconds=10;bridge.config.groupMaxRepliesPerHour=2;
  bridge.dsh.prompt=async()=>[env('一'),env('二'),env('三')];
  await assert.rejects(bridge.handle(group,0),/发送限额/);
  assert.deepEqual(sent.map(x=>text(x.params)),['一','二']);
  assert.deepEqual(waits,[3500,6500,3500]);assert.equal(bridge.state.groupSendTimes[group.key].length,2);
});
test('reminder bypasses diving and bubble timer, remaining bubbles resume afterwards',async t=>{
  let release,waiting;const ready=new Promise(r=>waiting=r);
  const {bridge,sent}=fixture(t,{wait:async(ms,signal)=>new Promise(resolve=>{release=resolve;signal.addEventListener('abort',resolve,{once:true});waiting();})});
  bridge.config.wakeEnabled=true;bridge.inbox(group.key).setWake('diving',30);
  bridge.dsh.prompt=async()=>[env('第一气泡'),env('第二气泡')];
  const task=bridge.handle(group,0);await ready;
  await bridge.deliverReminder({route:group},env('预约提醒'),'alarm');
  assert.deepEqual(sent.map(x=>text(x.params)),['第一气泡','预约提醒']);
  assert.equal(bridge.inbox(group.key).sleeping(),true);
  release();await task;assert.equal(text(sent.at(-1).params),'第二气泡');
});
test('stopping group during delay cancels unsent bubbles without stopping private chat',async t=>{
  let waiting;const ready=new Promise(r=>waiting=r);
  const {bridge,sent}=fixture(t,{wait:async(ms,signal)=>new Promise(resolve=>{signal.addEventListener('abort',resolve,{once:true});waiting();})});
  bridge.dsh.prompt=async()=>[env('已经发送'),env('不能再发')];
  const task=bridge.handle(group,0);await ready;bridge.stop('group');await task;
  assert.equal(bridge.status.state,'running');assert.deepEqual(bridge.status.channels,{private:true,group:false});
  await bridge.sendText(peer,'私聊仍可用');
  assert.deepEqual(sent.map(x=>text(x.params)),['已经发送','私聊仍可用']);
  await bridge.start(config,'group');assert.equal(bridge.status.channels.group,true);
  assert.equal(sent.length,2);
});
test('new addressed input cancels remaining bubbles and queues its own answer',async t=>{
  let waiting;const ready=new Promise(r=>waiting=r);
  const {bridge,sent}=fixture(t,{wait:async(ms,signal)=>new Promise(resolve=>{signal.addEventListener('abort',resolve,{once:true});waiting();})});
  let turns=0;bridge.dsh.prompt=async()=>turns++?[env('新问题回答')]:[env('旧话第一条'),env('旧话第二条')];
  bridge.accept({...group,epoch:0},0);await ready;
  bridge.accept({...group,text:'先别说这个',messageId:'m2',qqMessageId:'2',epoch:0},0);
  await until(()=>bridge.status.active===0);
  assert.deepEqual(sent.map(x=>text(x.params)),['旧话第一条','新问题回答']);
});
test('interval validation includes inherited defaults and per-chat overrides',()=>{
  assert.throws(()=>validate({bubbleMinSeconds:5,bubbleMaxSeconds:2}),/最长间隔/);
  assert.throws(()=>validate({chatPolicy:{group:{bubbleMinSeconds:6}}}),/最长间隔/);
  assert.throws(()=>validate({chatPolicy:{group:{bubbleMinSeconds:4,bubbleMaxSeconds:7},overrides:{[group.key]:{bubbleMaxSeconds:3}}}}),/最长间隔/);
});
test('independent startup validates only selected presets and reuses one OneBot connection',async t=>{
  const server=new WebSocketServer({port:0,host:'127.0.0.1'});await once(server,'listening');let connections=0;
  server.on('connection',socket=>{connections++;socket.on('message',bytes=>{const v=JSON.parse(bytes);socket.send(JSON.stringify({echo:v.echo,status:'ok',retcode:0,data:v.action==='get_login_info'?{user_id:config.botQQ}:{online:true,good:true}}));});});
  class Dsh{async probe(){return {presets:[{id:'test'}]};}close(){}}
  const bridge=new Bridge(temp(t),{Dsh});
  t.after(async()=>{bridge.stop();for(const socket of server.clients)socket.terminate();await new Promise(r=>server.close(r));});
  const c={...config,groupPreset:'',qqUrl:'ws://127.0.0.1:'+server.address().port};
  await bridge.start(c,'private');assert.deepEqual(bridge.status.channels,{private:true,group:false});
  await assert.rejects(bridge.start(c,'group'),/群聊.*预设/);assert.equal(bridge.status.channels.private,true);
  bridge.config.groupPreset='test';await bridge.start(c,'group');assert.equal(connections,1);
  const received=[];bridge.dispatch=route=>received.push(route.group?'group':'private');
  const event={post_type:'message',message_type:'group',self_id:config.botQQ,user_id:peer.id,group_id:group.id,message_id:1,message:[{type:'at',data:{qq:config.botQQ}},{type:'text',data:{text:'你好'}}]};
  bridge.stop('private');bridge.receive({...event,message_type:'private'},bridge.generation);bridge.receive(event,bridge.generation);
  assert.deepEqual(received,['group']);assert.equal(bridge.inbox(peer.key).list().messages.length,0);
  bridge.stop('group');assert.equal(bridge.status.state,'stopped');
  assert.deepEqual(new Bridge(temp(t)).status.state,'stopped');
  await assert.rejects(bridge.start(c,'invalid'),/请选择/);
});
