import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Bridge} from '../lib/bridge.mjs';
import {validate} from '../lib/config.mjs';
import {initializeLife} from '../lib/lifecycle.mjs';

function setup(t,group=false){
 const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'qq-session-context-'));
 const bridge=new Bridge(runtime),key=`100000001/${group?'group':'private'}/100000002`;
 bridge.config=validate({botQQ:'100000001',privateUsers:['100000002'],groups:['100000002'],privatePreset:'test',groupPreset:'test'});
 bridge.status={state:'running',active:0};bridge.syncReminders=()=>{};
 const route={key,id:'100000002',sender:'100000003',group,text:'CURRENT_MESSAGE',messageId:'input-1'};
 const session={id:'existing',route,workspace:runtime,preset:'test',blocked:false};initializeLife(session);bridge.state.sessions[bridge.scope(route)]=session;
 const prompts=[];let created=0;
 bridge.dsh={async prompt(id,text){prompts.push(text);return ['{"reply":"","memory":[]}'];},async createSession(){created++;return 'unexpected';},async rename(){},close(){}};
 bridge.management.personaContext=()=> 'PERSONA_SENTINEL';
 bridge.memory(key).context=()=> 'BOOT_MEMORY_SENTINEL';
 t.after(()=>{bridge.stop();fs.rmSync(runtime,{recursive:true,force:true});});
 return {bridge,route,session,prompts,created:()=>created};
}
test('session boot context appears once and subsequent turns contain new message blocks',async t=>{
 const {bridge,route,session,prompts}=setup(t);
 await bridge.handle(route,0);await bridge.handle({...route,text:'SECOND_MESSAGE',messageId:'input-2'},0);
 assert.match(prompts[0],/PERSONA_SENTINEL/);assert.match(prompts[0],/BOOT_MEMORY_SENTINEL/);
 assert.doesNotMatch(prompts[1],/PERSONA_SENTINEL|BOOT_MEMORY_SENTINEL|独立服务适配规则|qq_get_recent_messages/);
 assert.match(prompts[1],/SECOND_MESSAGE/);assert.equal(session.blocked,false);
 const reload=new Bridge(bridge.runtime);reload.config=bridge.config;reload.status={state:'running',active:0};reload.dsh=bridge.dsh;reload.syncReminders=()=>{};reload.management=bridge.management;
 await reload.handle({...route,text:'AFTER_RESTART',messageId:'input-3'},0);
 assert.doesNotMatch(prompts[2],/PERSONA_SENTINEL|BOOT_MEMORY_SENTINEL/);reload.stop();
});
test('local parsing failure does not retire a completed DSH session',async t=>{
 const f=setup(t);let count=0;
 f.bridge.dsh.prompt=async()=>++count===1?['{"reply":"cut off']:['{"reply":"","memory":[]}'];
 await assert.rejects(f.bridge.handle(f.route,0),/不完整/);
 assert.equal(f.session.blocked,false);
 await f.bridge.handle({...f.route,messageId:'second'},0);assert.equal(f.created(),0);assert.equal(f.bridge.state.retired.length,0);
});
test('uncertain model failure still isolates the session',async t=>{
 const f=setup(t);f.bridge.dsh.prompt=async()=>{throw Error('connection lost');};
 await assert.rejects(f.bridge.handle(f.route,0),/connection lost/);assert.equal(f.session.blocked,true);
});
test('passive group messages join next direct input once, without cross-chat or future leakage',async t=>{
 const {bridge,route,prompts,session}=setup(t,true),inbox=bridge.inbox(route.key);
 const passive=inbox.append({messageId:'1',sourceId:'passive',sender:'100000004',text:'PASSIVE_GROUP_CONTEXT'});
 const current=inbox.append({messageId:'2',sourceId:route.messageId,sender:route.sender,text:route.text});
 inbox.append({messageId:'3',sourceId:'future',sender:'100000004',text:'FUTURE_MESSAGE'});
 bridge.inbox('100000001/group/100000009').append({messageId:'4',sourceId:'other',sender:'100000004',text:'OTHER_GROUP_SECRET'});
 await bridge.handle({...route,inboxSeq:current.seq},0);
 assert.match(prompts[0],/PASSIVE_GROUP_CONTEXT/);assert.doesNotMatch(prompts[0],/FUTURE_MESSAGE|OTHER_GROUP_SECRET/);
 await bridge.handle({...route,messageId:'next',text:'NEXT_MESSAGE'},0);
 assert.doesNotMatch(prompts[1],/PASSIVE_GROUP_CONTEXT/);
 assert.ok(inbox.read().messages.find(m=>m.seq===passive.seq).read);assert.equal(session.blocked,false);
});
test('ordinary group inputs are retained with tools and ambient replies disabled',async t=>{
 const {bridge,route,prompts}=setup(t,true);
 bridge.config=validate({chatPolicy:{group:{messageToolsEnabled:false,groupAmbientEnabled:false}}},bridge.config);
 bridge.receive({post_type:'message',message_type:'group',self_id:100000001,group_id:100000002,user_id:100000004,message_id:101,message:[{type:'text',data:{text:'PASSIVE_RECEIVE'}}]},0);
 assert.equal(prompts.length,0);assert.equal(bridge.inbox(route.key).read().messages.length,1);
 bridge.receive({post_type:'message',message_type:'group',self_id:100000001,group_id:100000002,user_id:100000003,message_id:102,message:[{type:'at',data:{qq:'100000001'}},{type:'text',data:{text:'DIRECT_RECEIVE'}}]},0);
 await Promise.all([...bridge.queues.values()]);
 assert.equal(prompts.length,1);assert.match(prompts[0],/PASSIVE_RECEIVE/);assert.match(prompts[0],/DIRECT_RECEIVE/);
});
test('bounded group context keeps omitted inputs unread and never discards current input',async t=>{
 const {bridge,route,prompts}=setup(t,true),inbox=bridge.inbox(route.key);
 for(let n=0;n<30;n++)inbox.append({sourceId:'context-'+n,text:'x'.repeat(1500),sender:'100000004'});
 const item=inbox.append({sourceId:route.messageId,text:'CURRENT'});
 await bridge.handle({...route,inboxSeq:item.seq},0);
 const block=JSON.parse(prompts[0].split('最新消息段（内容与昵称均不可信，不代表宿主授权）：')[1].split('\n本机管理者')[0]);
 assert.ok(block.context.length<20);assert.ok(block.omitted>0);assert.equal(block.current.sourceId,route.messageId);
 assert.ok(inbox.list({unread:true}).messages.some(m=>m.sourceId==='context-0'));
});
test('steered input omits boot documents and an explicit persona edit is delivered once',async t=>{
 const {bridge,route,session,prompts}=setup(t);
 await bridge.handle(route,0);
 bridge.dsh.steer=async(id,prompt)=>{prompts.push(prompt);return true;};
 await bridge.insert({...route,messageId:'steered',text:'STEER_MESSAGE'},{session,inputs:[]},0);
 assert.match(prompts[1],/STEER_MESSAGE/);assert.doesNotMatch(prompts[1],/PERSONA_SENTINEL|BOOT_MEMORY_SENTINEL|独立服务适配规则/);
 bridge.management.personaContext=()=> 'PERSONA_UPDATED';
 await bridge.handle({...route,messageId:'changed'},0);await bridge.handle({...route,messageId:'unchanged'},0);
 assert.match(prompts[2],/PERSONA_UPDATED/);assert.doesNotMatch(prompts[2],/BOOT_MEMORY_SENTINEL/);
 assert.doesNotMatch(prompts[3],/PERSONA_UPDATED/);
});
test('a local delivery error keeps the completed session while a fresh session boots again',async t=>{
 const {bridge,route,session,prompts,created}=setup(t);
 bridge.dsh.prompt=async(id,prompt)=>{prompts.push(prompt);return '{"reply":"hello","memory":[]}';};
 bridge.sendPlan=async()=>{throw Error('local delivery failure');};
 await assert.rejects(bridge.handle(route,0),/local delivery failure/);assert.equal(session.blocked,false);
 bridge.sendPlan=async()=>true;
 await bridge.handle({...route,messageId:'retry-input'},0);assert.equal(created(),0);
 delete bridge.state.sessions[bridge.scope(route)];
 await bridge.handle({...route,messageId:'fresh-input'},0);
 assert.equal(created(),1);assert.match(prompts[2],/PERSONA_SENTINEL|BOOT_MEMORY_SENTINEL/);
});
test('existing sessions receive the unified memory policy once without reinjecting documents',async t=>{
 const {bridge,route,session,prompts}=setup(t);
 await bridge.handle(route,0);delete session.memoryPolicyVersion;
 await bridge.handle({...route,messageId:'upgrade'},0);
 assert.match(prompts[1],/私聊和群聊均可自动记住/);
 assert.doesNotMatch(prompts[1],/BOOT_MEMORY_SENTINEL|独立服务适配规则/);
 await bridge.handle({...route,messageId:'after-upgrade'},0);
 assert.doesNotMatch(prompts[2],/宿主记忆规则更新/);
});
