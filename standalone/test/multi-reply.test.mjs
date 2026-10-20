import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Bridge} from '../lib/bridge.mjs';
import {defaults} from '../lib/config.mjs';
import {initializeLife} from '../lib/lifecycle.mjs';

function fixture(t,{failureAt,stopAt}={}){
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-batch-'));
  t.after(()=>fs.rmSync(runtime,{recursive:true,force:true}));
  const bridge=new Bridge(runtime),route={key:'100000001/private/100000002',id:'100000002',group:false,text:'记住我喜欢茶',messageId:'m1'};
  bridge.config={...defaults,privatePreset:'test',qqVoiceSend:false,knowledgeEnabled:true};bridge.status.state='running';
  const session={id:'session',route,workspace:runtime,preset:'test',blocked:false};
  initializeLife(session);bridge.state.sessions[bridge.scope(route)]=session;
  const sent=[];
  bridge.socket={close(){},send(bytes){
    const frame=JSON.parse(bytes);sent.push(frame.params.message);
    queueMicrotask(()=>{
      if(stopAt===sent.length){bridge.stop();return;}
      bridge.pending.get(frame.echo)?.({status:failureAt===sent.length?'failed':'ok',retcode:failureAt===sent.length?1:0,data:{message_id:sent.length}});
    });
  }};
  bridge.dsh={close(){}};return {bridge,route,session,sent};
}
const text=segments=>segments.filter(s=>s.type==='text').map(s=>s.data.text).join('');
const envelope=(reply,extra={})=>JSON.stringify({reply,memory:[],...extra});

test('host-tool continuations retain every reply and process memory without sending JSON/tool data',async t=>{
  const {bridge,route,sent,session}=fixture(t);let calls=0;
  bridge.dsh.prompt=async(id,prompt,options)=>{
    assert.equal(options.collectMessages,true);
    if(calls++===0)return [envelope('工具前的回答',{actions:[{tool:'qq_list_stickers',args:{}}]})];
    assert.match(prompt,/宿主工具结果/);
    return [envelope('工具后的回答',{memory:[{action:'write',page:'user/tea.md',text:'# 茶\n喜欢茶',reason:'用户要求记住',evidence:['m1']}]}),envelope('最后回答')];
  };
  await bridge.handle(route,0);
  assert.deepEqual(sent.map(text),['工具前的回答','工具后的回答','最后回答']);
  assert.equal(calls,2);assert.match(bridge.memory(route.key).pages()[0].text,/喜欢茶/);
  assert.equal(session.life.conversation.at(-1).reply,'工具前的回答\n\n工具后的回答\n\n最后回答');
  assert.deepEqual(bridge.state.deliveries.map(d=>[d.partIndex,d.partCount,d.state]),[[0,3,'sent'],[1,3,'sent'],[2,3,'sent']]);
});

test('a malformed memory envelope in any complete reply prevents partial public delivery',async t=>{
  const {bridge,route,sent}=fixture(t);
  bridge.dsh.prompt=async()=>[envelope('看似正常'),'{\"reply\":\"未完成\",\"memory\":['];
  await assert.rejects(bridge.handle(route,0),/不完整/);assert.equal(sent.length,0);
});

test('failed second QQ delivery is recorded and stops later parts without resending earlier ones',async t=>{
  const {bridge,route,sent}=fixture(t,{failureAt:2});
  bridge.dsh.prompt=async()=>[envelope('第一条'),envelope('第二条'),envelope('第三条')];
  await assert.rejects(bridge.handle(route,0),/不会自动重试/);
  assert.deepEqual(sent.map(text),['第一条','第二条']);
  assert.deepEqual(bridge.state.deliveries.map(d=>d.state),['sent','failed']);
});

test('stopping during a multi-part QQ reply prevents subsequent sends',async t=>{
  const {bridge,route,sent}=fixture(t,{stopAt:1});
  bridge.dsh.prompt=async()=>[envelope('第一条'),envelope('第二条')];
  await assert.rejects(bridge.handle(route,0),/不会自动重试/);
  assert.deepEqual(sent.map(text),['第一条']);assert.equal(bridge.state.deliveries[0].state,'unknown');
});

test('long complete text is segmented without dropping its tail or splitting emoji',async t=>{
  const {bridge,route,sent}=fixture(t),reply='a'.repeat(3999)+'😀'+'末尾'.repeat(2600);
  bridge.dsh.prompt=async()=>[envelope(reply)];
  await bridge.handle(route,0);
  assert.equal(sent.length,1);assert.equal(text(sent[0]),reply);assert.equal(sent[0].length,3);
  assert.equal(sent[0][0].data.text.endsWith('😀'),true);
});
