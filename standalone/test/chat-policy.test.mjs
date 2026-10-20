import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {validate,writeJson} from '../lib/config.mjs';
import {policyView,resolveChatConfig} from '../lib/chat-policy.mjs';
import {Bridge,routeMessage} from '../lib/bridge.mjs';
import {Media} from '../lib/media.mjs';
import {ChatTools} from '../lib/chat-tools.mjs';
import {createApp} from '../server.mjs';
import {initializeLife} from '../lib/lifecycle.mjs';
const bot='100000001',friend='100000002',group='100000003',other='100000004';
const privateKey=`${bot}/private/${friend}`,groupKey=`${bot}/group/${group}`;
const config=()=>validate({botQQ:bot,privateUsers:[friend,other],groups:[group],privatePreset:'private',groupPreset:'group'});
const route=(key=privateKey)=>({key,id:key.split('/')[2],sender:friend,group:key.includes('/group/'),text:'你好',messageId:'m1'});
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-policy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function wav(){const b=Buffer.alloc(364);b.write('RIFF');b.writeUInt32LE(356,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(320,40);return b;}
test('legacy settings inherit without changing group voice defaults; overrides isolate bot and recipient',()=>{
  const c=config();assert.equal(policyView(c,'private').effective.voiceSend,true);assert.equal(policyView(c,'group').effective.voiceSend,false);
  const changed=validate({chatPolicy:{private:{imageSend:false},group:{voiceSend:true},overrides:{[privateKey]:{imageSend:true,memoryEnabled:false}}}},c);
  assert.equal(resolveChatConfig(changed,privateKey).qqImageSend,true);
  assert.equal(resolveChatConfig(changed,`${bot}/private/${other}`).qqImageSend,false);
  assert.equal(resolveChatConfig(changed,`999999999/private/${friend}`).qqImageSend,false);
  assert.equal(resolveChatConfig(changed,privateKey).memoryEnabled,false);
  assert.equal(resolveChatConfig(changed,groupKey).groupVoiceSend,true);
  assert.equal(c.chatPolicy.overrides[privateKey],undefined);
  const changedDefault=validate({chatPolicy:{...changed.chatPolicy,private:{imageSend:false,voiceReceive:false}}},changed);
  assert.equal(resolveChatConfig(changedDefault,privateKey).qqImageSend,true);
  assert.equal(resolveChatConfig(changedDefault,privateKey).qqVoiceReceive,false);
  const reset=validate({chatPolicy:{...changed.chatPolicy,overrides:{}}},changed);
  assert.equal(resolveChatConfig(reset,privateKey).qqImageSend,false);
});
test('policy rejects unknown settings, wrong domains and invalid merged interval ranges',()=>{
  for(const chatPolicy of [
    {private:{mimoApiKey:'bad'}},{private:{groupAmbientEnabled:true}},{group:{rotationEnabled:'true'}},
    {private:{imageSend:'false'}},{private:{adminUsers:['../bad']}},{overrides:{'../bad':{}}},
    {private:{proactiveMinSeconds:9000},overrides:{[privateKey]:{proactiveMaxSeconds:6000}}},
  ])assert.throws(()=>validate({chatPolicy},config()));
  assert.throws(()=>validate({chatPolicy:JSON.parse('{"private":{"__proto__":{}}}')},config()));
});
test('group rotation settings inherit defaults and accept per-group overrides independently of private chats',()=>{
  const c=validate({chatPolicy:{group:{rotationEnabled:true,rotateAfterCompactions:3},overrides:{[groupKey]:{rotationEnabled:false,rotateAfterCompactions:2}}}},config());
  assert.equal(policyView(c,'group').effective.rotateAfterCompactions,3);
  assert.equal(resolveChatConfig(c,groupKey).rotationEnabled,false);
  assert.equal(resolveChatConfig(c,groupKey).rotateAfterCompactions,2);
  assert.equal(resolveChatConfig(c,privateKey).rotateAfterCompactions,15);
  assert.equal(resolveChatConfig(c,`${bot}/group/100000005`).rotationEnabled,true);
  assert.throws(()=>validate({chatPolicy:{group:{rotateAfterCompactions:0}}},config()));
});
test('incoming route uses private/group/recipient permissions while keeping allowlists',()=>{
  const c=validate({chatPolicy:{private:{imageReceive:false},group:{groupAmbientEnabled:true},overrides:{[privateKey]:{voiceReceive:false}}}},config());
  const event={post_type:'message',message_type:'private',self_id:bot,user_id:friend,message_id:1,message:[{type:'image',data:{file:'opaque'}}]};
  assert.equal(routeMessage(event,c),null);
  event.message=[{type:'record',data:{file:'opaque'}}];assert.equal(routeMessage(event,c),null);
  assert.ok(routeMessage({...event,user_id:other},c));
  assert.equal(routeMessage({...event,user_id:'999999'},c),null);
  assert.ok(routeMessage({...event,message_type:'group',group_id:group,message:[{type:'text',data:{text:'topic'}}]},c)?.ambient);
  assert.equal(routeMessage({...event,message_type:'group',group_id:'999999'},c),null);
});
test('group voice is opt-in per group; media receive and send flags are independent',async t=>{
  const root=temp(t),calls=[],media=new Media(root,{voice:{synthesize:async()=>{calls.push('tts');return {id:'wav'};},audio:()=>wav()},call:async action=>{calls.push(action);return {};},now:()=>Date.parse('2026-10-20T04:00:00Z')});
  const c=validate({chatPolicy:{group:{voiceSend:true,voiceReplyMode:'voice',imageReceive:false,imageSend:false}}},config());
  let p=resolveChatConfig(c,groupKey);
  const plan=await media.outgoing({reply:'',qq:{voice:'你好'}},route(groupKey),{workspace:root},p);
  assert.equal(plan.action,'send_group_msg');assert.equal(plan.params.group_id,group);assert.equal(plan.params.message[0].type,'record');
  const disabled=await media.outgoing({reply:'',qq:{voice:'你好'}},route(groupKey),{workspace:root},resolveChatConfig(config(),groupKey));
  assert.equal(disabled.params.message[0].type,'text');assert.equal(calls.length,1);
  await assert.rejects(media.outgoing({reply:'',qq:{images:['https://example.org/a']}},route(groupKey),{workspace:root},p),/未启用/);
  await media.incoming({...route(groupKey),segments:[{type:'image',data:{file:'opaque'}}]},p);assert.equal(calls.length,1);
});
test('tool-specific sticker, slang and image switches cannot be bypassed by the general tool switch',async t=>{
  const root=temp(t),c=resolveChatConfig(validate({chatPolicy:{group:{stickerLearn:false,stickerSend:false,slangLearn:true,imageSend:false,groupToolsEnabled:true}}},config()),groupKey);
  const tools=new ChatTools({route:route(groupKey),session:{workspace:root},store:{},knowledge:{read:()=>({slang:[],stickers:[]})},config:c});
  await assert.rejects(tools.run('qq_send_sticker',{id:'x'}),/未开启/);
  await assert.rejects(tools.run('qq_sticker_note',{id:'x'}),/未开启/);
  await assert.rejects(tools.run('qq_group_send_image',{sources:[]}),/未开启/);
  assert.deepEqual(await tools.run('qq_slang_query',{}),{entries:[]});
});
test('bridge uses recipient preset, memory switch and reminder subscriptions without global mutation',async t=>{
  const root=temp(t),bridge=new Bridge(root);t.after(()=>bridge.stop());
  bridge.config=validate({chatPolicy:{private:{remindersEnabled:false},overrides:{[privateKey]:{preset:'specific',memoryEnabled:false,remindersEnabled:true}}}},config());
  bridge.status.state='running';bridge.status.account=bot;bridge.generation=1;
  let presetSeen,promptSeen;bridge.dsh={rename:async()=>{},createSession:async(dir,preset)=>{presetSeen=preset;return 'specific-session';},prompt:async(id,prompt,options)=>{
    promptSeen=prompt;
    options.onEvent({type:'compaction/summary',seq:1,data:{compactionId:'disabled',summary:[{type:'text',text:'should not persist'}]}});
    options.onEvent({type:'compaction/end',seq:2,data:{compactionId:'disabled'}});
    return '{"reply":"","memory":[]}';
  },close(){}};
  const subscribed=[];bridge.reminders.sync=(d,sessions)=>subscribed.push(sessions.map(s=>s.route.key));
  await bridge.handle(route(),1);
  assert.equal(presetSeen,'specific');assert.match(promptSeen,/记忆已关闭/);assert.doesNotMatch(promptSeen,/独立服务适配规则/);
  assert.equal(bridge.config.privatePreset,'private');assert.equal(bridge.config.memoryEnabled,true);
  assert.equal(bridge.state.sessions[bridge.scope(route())].life.compactions.length,0);
  const second=route(`${bot}/private/${other}`),scope=bridge.scope(second);
  bridge.state.sessions[scope]={id:'other-session',route:second,backend:bridge.config.dshUrl,preset:'private'};initializeLife(bridge.state.sessions[scope]);
  bridge.syncReminders();assert.deepEqual(subscribed.at(-1),[privateKey]);
});
test('background candidate receives effective per-chat settings',async t=>{
  const root=temp(t),seen=[],bridge=new Bridge(root,{proactive:{candidate:async(s,c)=>{seen.push([s.route.key,c.recallEnabled,c.memoryIdleSeconds]);return null;}}});t.after(()=>bridge.stop());
  bridge.config=validate({chatPolicy:{private:{proactiveEnabled:false},overrides:{[privateKey]:{proactiveEnabled:true,memoryIdleSeconds:4620}}}},config());
  bridge.status.state='running';bridge.status.account=bot;bridge.generation=1;
  bridge.syncReminders=()=>{};bridge.sweep=async()=>{};
  for(const key of [privateKey,`${bot}/private/${other}`]){const r=route(key),s={id:key,route:r};initializeLife(s);bridge.state.sessions[bridge.scope(r)]=s;}
  await bridge.tick();assert.deepEqual(seen,[[privateKey,true,4620],[`${bot}/private/${other}`,false,1800]]);
});
test('scoped policy HTTP enforces auth, revision, allowlist and inheritance reset without touching credentials',async t=>{
  const runtime=temp(t);writeJson(path.join(runtime,'config.private.json'),{...config(),mimoApiKey:'test-only-preserved'});
  const app=createApp({runtime,voice:{status:()=>({})}});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{app.bridge.stop();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});
  const origin=new URL(app.loginUrl()).origin,login=await fetch(app.loginUrl(),{redirect:'manual'}),cookie=login.headers.get('set-cookie').split(';')[0];
  const headers={cookie,Origin:origin,'Content-Type':'application/json','X-QQ-RSI':'panel'};
  const get=scope=>fetch(origin+'/api/chat-policy?scope='+encodeURIComponent(scope),{headers});
  const post=data=>fetch(origin+'/api/chat-policy',{method:'POST',headers,body:JSON.stringify(data)});
  assert.equal((await fetch(origin+'/api/chat-policy')).status,401);
  const view=await (await get(privateKey)).json();assert.equal(view.effective.voiceSend,true);assert.ok(!JSON.stringify(view).includes('test-only-preserved'));
  const saved=await (await post({scope:privateKey,revision:view.revision,patch:{imageSend:false}})).json();assert.equal(saved.effective.imageSend,false);
  assert.equal((await post({scope:privateKey,revision:view.revision,patch:{}})).status,400);
  assert.equal((await get(`${bot}/private/999999`)).status,400);
  assert.equal((await post({scope:`999999999/private/${friend}`,revision:saved.revision,patch:{}})).status,400);
  app.bridge.status.state='running';assert.equal((await post({scope:privateKey,revision:saved.revision,reset:true})).status,400);app.bridge.status.state='stopped';
  assert.equal((await post({scope:privateKey,revision:saved.revision,reset:true})).status,200);
  const stored=JSON.parse(fs.readFileSync(path.join(runtime,'config.private.json')));assert.equal(stored.mimoApiKey,'test-only-preserved');assert.equal(stored.chatPolicy.overrides[privateKey],undefined);
  const managed=await (await fetch(origin+'/api/manage?key='+encodeURIComponent(privateKey),{headers})).json();assert.equal(managed.detail.key,privateKey);assert.ok(managed.detail.insights);assert.ok(managed.policy);
  const collect=await fetch(origin+'/api/manage/collect',{method:'POST',headers,body:JSON.stringify({key:privateKey,id:'x'})});assert.match((await collect.json()).error,/开启/);
});
