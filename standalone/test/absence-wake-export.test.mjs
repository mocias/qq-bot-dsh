import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server.mjs';
import {AbsenceClock} from '../lib/absence.mjs';
import {ConversationInbox} from '../lib/continuous-chat.mjs';
import {WorldSimulationClock} from '../lib/world-simulation.mjs';
import {ScheduleWakeRouter,wakePaths,readWakeJson,writeWakeJson} from '../../native-dsh-plugin/lib/scheduled-wake.mjs';
import {exportMemory} from '../lib/export-memory.mjs';
import {PersonaCards,personaIdentity} from '../lib/persona-cards.mjs';
import {NativeRuntime} from '../../native-dsh-plugin/lib/runtime.mjs';

const temp=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-away-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
test('already loaded stable loader enables wake routing from its trusted manifest without a DSH restart',t=>{
  let detached=0;const root=temp(t),runtime=new NativeRuntime({agents:{get:()=>null},qqRsiNative:{manifest:path.join(root,'.runtime/native-release.private.json'),runtime:{bindings:new Map(),dispose:()=>detached++}}},x=>x);
  try{assert.equal(detached,1);assert.equal(runtime.scheduleRouter.root,path.join(root,'standalone/.runtime'));assert.equal(runtime.probe().scheduledWakeRouter,true);}finally{runtime.dispose();}
});
test('elapsed real-user silence, not waits or simulations, triggers departure; pending input and cancellation win',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});
  const session={lastHumanMessageAt:100000},config={userAwaySeconds:120},absence=new AbsenceClock(session,{config}),simulation=new WorldSimulationClock(session);
  simulation.delivered();const controller=new AbortController(),inbox=new ConversationInbox(controller.signal,()=>true,{absence,simulation,config});
  for(let n=0;n<4;n++){const p=inbox.take({timeoutSeconds:15},async x=>x);t.mock.timers.tick(15000);await p;}
  assert.equal(absence.remaining(),60000);assert.equal(session.absence,undefined);
  const p=inbox.take({timeoutSeconds:300},async x=>x);t.mock.timers.tick(60000);assert.equal((await p).reason,'user-away');assert.equal(session.absence.phase,'handoff');
  const fresh={lastHumanMessageAt:Date.now()-120000},box=new ConversationInbox(controller.signal,()=>true,{absence:new AbsenceClock(fresh,{config}),config});
  box.push({compactView:{messages:[{text:'回来'}]}});assert.equal((await box.take({},async x=>x)).reason,'messages');
  box.scheduleWake({text:'预约'});assert.equal((await box.take({},async x=>x)).reason,'scheduled-wake');assert.equal(fresh.lastHumanMessageAt,100000);
  controller.abort();await assert.rejects(box.take({},async x=>x),/已停止/);
});
test('DSH schedule delivery is durable, scoped, deduplicated, stopped-aware and reversible including cold resolution',async t=>{
  const root=temp(t),paths=wakePaths(root),forwarded=[],agent={session:{id:'qq'},followup:m=>forwarded.push(m)},other={session:{id:'other'},followup:m=>forwarded.push(m)};
  writeWakeJson(paths.registry,{epoch:'one',sessions:{qq:{key:'100000001/group/100000002',personaId:'default',enabled:true}}});
  const original=agent.followup,ctx={agents:{get:()=>null},sessionController:{resolveAgent:async id=>({agent:id==='qq'?agent:other})}},resolve=ctx.sessionController.resolveAgent;
  const router=new ScheduleWakeRouter(ctx,root);t.after(()=>router.dispose());
  await ctx.sessionController.resolveAgent('qq');const reminder={id:'r',source:{kind:'schedule'},content:[{type:'text',text:'scheduled occurrence #1'}]};
  agent.followup(reminder);agent.followup({...reminder,id:'retry'});assert.equal(forwarded.length,0);
  const files=fs.readdirSync(paths.queue);assert.equal(files.length,1);assert.equal(readWakeJson(path.join(paths.queue,files[0])).state,'pending');
  agent.followup({...reminder,source:{kind:'user'}});assert.equal(forwarded.length,1);
  await ctx.sessionController.resolveAgent('other');other.followup(reminder);assert.equal(forwarded.length,2);
  writeWakeJson(paths.registry,{epoch:'one',sessions:{qq:{enabled:false}}});agent.followup({...reminder,content:[{type:'text',text:'later occurrence'}]});
  assert.ok(fs.readdirSync(paths.queue).some(f=>readWakeJson(path.join(paths.queue,f)).state==='skipped'));
  router.dispose();assert.equal(agent.followup,original);assert.equal(ctx.sessionController.resolveAgent,resolve);
});
test('persona export includes only selected Markdown and handoff summaries, excludes private runtime and other personas',t=>{
  const root=temp(t),key='100000001/group/100000002',cards=new PersonaCards(root);const second=cards.create({key,name:'小夏',revision:0});
  const scope=personaIdentity(root,key,'default').scope,dir=path.join(root,'memories',scope);fs.mkdirSync(path.join(dir,'.runtime/handoffs/session'),{recursive:true});
  fs.writeFileSync(path.join(dir,'SOUL.md'),'知遥的人设');fs.writeFileSync(path.join(dir,'MEMORY.md'),'当前人格记忆');fs.writeFileSync(path.join(dir,'.runtime/secret.json'),'SECRET');
  fs.writeFileSync(path.join(dir,'.runtime/handoffs/session/handoff-one.json'),JSON.stringify({status:'ready',id:'handoff-one',summary:'保存的交接',unfinished:['待办'],dialogue:['不导出原始日志']}));
  const other=path.join(root,'memories',personaIdentity(root,key,second.id).scope);fs.mkdirSync(other,{recursive:true});fs.writeFileSync(path.join(other,'SOUL.md'),'OTHER-PERSONA');
  const out=exportMemory(root,key,'default'),text=out.bytes.toString();assert.equal(out.bytes.readUInt32LE(),0x04034b50);assert.match(out.filename,/群聊-100000002/);
  for(const s of ['知遥的人设','当前人格记忆','保存的交接','manifest.json'])assert.ok(text.includes(s));
  for(const s of ['SECRET','OTHER-PERSONA','不导出原始日志'])assert.ok(!text.includes(s));
  assert.throws(()=>exportMemory(root,key),/明确选择/);
});

test('memory download requires panel authentication and an explicit valid persona',async t=>{
  const root=temp(t),app=createApp({runtime:root,voice:{status:()=>({}),busy:false}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{app.bridge.stop();await new Promise(r=>app.server.close(r));});
  const origin=new URL(app.loginUrl()).origin,key='100000001/group/100000002';
  assert.equal((await fetch(origin+'/api/manage/export?key='+key+'&personaId=default')).status,401);
  const login=await fetch(app.loginUrl(),{redirect:'manual'}),cookie=login.headers.get('set-cookie').split(';')[0];await login.body.cancel();
  const headers={cookie,Origin:origin,'X-QQ-RSI':'panel','Content-Type':'application/json'};
  assert.equal((await fetch(origin+'/api/config',{method:'POST',headers,body:JSON.stringify({botQQ:'100000001',groups:['100000002']})})).status,200);
  // An upgraded service starts stopped with saved sessions, before Bridge.config
  // is assigned by start(). Status and management must still render correctly.
  app.bridge.state.sessions.old={id:'old',route:{key,group:true,id:'100000002'}};
  assert.equal(app.bridge.config,undefined);
  const status=await fetch(origin+'/api/status',{headers});assert.equal(status.status,200);
  assert.equal((await status.json()).lifecycle[0].absence.thresholdSeconds,600);
  for(const suffix of ['','&personaId=nonexistent'])assert.equal((await fetch(origin+'/api/manage/export?key='+key+suffix,{headers})).status,400);
  const result=await fetch(origin+'/api/manage/export?key='+key+'&personaId=default',{headers});
  assert.equal(result.status,200);assert.equal(result.headers.get('content-type'),'application/zip');assert.match(result.headers.get('content-disposition'),/attachment/);
  assert.equal(Buffer.from(await result.arrayBuffer()).readUInt32LE(),0x04034b50);
});
