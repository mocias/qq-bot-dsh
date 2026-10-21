import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ScheduleWakeRouter,wakePaths,writeWakeJson,readWakeJson} from '../../native-dsh-plugin/lib/scheduled-wake.mjs';

test('installed DSH scheduler dispatch persists QQ wake before acknowledging delivery, including recurring replay', {skip:!process.env.QQ_RSI_DSH_SDK_ROOT},async t=>{
  const base=process.env.QQ_RSI_DSH_SDK_ROOT.replace(/\/$/,'');
  const [{Context,Service},{ScheduleService,renderRecurringReminderBatchFraming}]=await Promise.all(['cordis','dsh-schedule'].map(n=>import(base+'/'+n+'/lib/index.js')));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-schedule-sdk-')),paths=wakePaths(root),tasks=new Map(),forwarded=[],resolved=[],flushed=[];
  const agent={session:{id:'qq-sdk'},followup:m=>forwarded.push(m)};
  const ctx=new Context();
  class Agents extends Service{constructor(c){super(c,'agents');}get(){return undefined;}withoutInitiator(fn){return fn();}}
  class Sessions extends Service{constructor(c){super(c,'sessions');}async flush(s){flushed.push(s.id);assert.equal(fs.readdirSync(paths.queue).length,1);return true;}}
  class Controller extends Service{constructor(c){super(c,'sessionController');}async resolveAgent(id){resolved.push(id);return {agent};}}
  class Persistence extends Service{constructor(c){super(c,'sessionPersistence');}}
  class Storage extends Service{constructor(c){super(c,'storageDomain');}async open(){return {table:()=>({entries:()=>tasks.entries(),get:id=>tasks.get(id),put:async(id,value)=>tasks.set(id,value)}),close:async()=>{}};}}
  const fibers=[];for(const plugin of [Agents,Sessions,Controller,Persistence,Storage])fibers.push(await ctx.plugin(plugin));
  writeWakeJson(paths.registry,{epoch:'sdk',sessions:{'qq-sdk':{key:'100000001/group/100000002',personaId:'default',enabled:true}}});
  const router=new ScheduleWakeRouter(ctx,root);let schedule;
  try{
    fibers.push(await ctx.plugin(ScheduleService,{}));await ctx.inject(['schedule'],inner=>{schedule=inner.schedule;});
    assert.ok(schedule);await schedule.initialized;
    const record=await schedule.create('qq-sdk',{title:'测试预约',prompt:'分享一个具体念头',after_seconds:1});
    await new Promise(r=>setTimeout(r,1200));await schedule.runtime.running;
    assert.deepEqual(resolved,['qq-sdk']);assert.deepEqual(flushed,['qq-sdk']);assert.equal(forwarded.length,0);
    assert.equal(tasks.get(record.id).status,'inactive');
    const file=fs.readdirSync(paths.queue)[0];assert.equal(readWakeJson(path.join(paths.queue,file)).state,'pending');
    const rows=['a','b'].map(id=>({record:{id,prompt:'主动聊聊'},occurrenceAt:'2026-10-21T12:00:00.000Z'}));
    agent.followup({source:{kind:'schedule'},content:[{type:'text',text:renderRecurringReminderBatchFraming(rows)}]});
    agent.followup({source:{kind:'schedule'},content:[{type:'text',text:renderRecurringReminderBatchFraming(rows.slice(1))}]});
    assert.equal(fs.readdirSync(paths.queue).length,3,'regrouped batches do not repeat the same occurrence');
  }finally{await schedule?.runtime?.dispose();router.dispose();for(const fiber of fibers.reverse())await fiber.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
