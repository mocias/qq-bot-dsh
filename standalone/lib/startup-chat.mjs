import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {snapshotOf,inboxSnapshot} from './message-snapshot.mjs';
import {maintain} from './lifecycle.mjs';
import {resumeAfterMaintenance} from './absence.mjs';

const sourceId=m=>m.sourceId??m.messageId;
const input=m=>({...((m.sourceId&&typeof m.sender==='object')?m:snapshotOf({messageId:sourceId(m),sender:m.sender,text:m.text,qqMessageId:m.qqMessageId})),messageId:sourceId(m)});

// Receipt-backed memory coverage is independent of inbox read/reply state.
export function startupSources(store,inbox,sessions=[]){
  const records=[],dir=store.safe('raw/conversations');
  if(fs.existsSync(dir))for(const name of fs.readdirSync(dir)){
    const file=path.join(dir,name);if(!name.endsWith('.json'))continue;
    if(!fs.lstatSync(file).isFile())throw Error('原始记忆记录必须是普通文件');
    const record=JSON.parse(fs.readFileSync(file,'utf8'));
    if((record.chatKey??store.memoryKey??store.key)===store.key)records.push(record);
  }
  const covered=new Set(),turns=new Set(),compressions=new Set();
  for(const r of records)if(r.kind==='digest-source'&&store.hasReceipt(r.id)){
    for(const c of r.conversation??[]){if(c.id)turns.add(c.id);for(const m of c.inputs??[])covered.add(sourceId(m));}
    for(const c of r.compactions??[]){compressions.add(c.id);if(c.sourceId)compressions.add(c.sourceId);}
  }
  const conversation=new Map(),messages=new Map(),compactions=new Map();
  for(const r of [...records,...sessions.flatMap(s=>(s.life?.conversation??[]).map(c=>({...c,kind:'conversation'})))]){
    if(r.kind==='conversation'&&!turns.has(r.id))conversation.set(r.id,{...r,inputs:(r.inputs??[]).map(input)});
    if(r.kind==='qq-input'||r.kind==='qq-snapshot'){
      const m=r.snapshot??snapshotOf({messageId:r.id,sender:r.sender,text:r.text,segments:r.segments});
      if(!covered.has(sourceId(m))&&(r.kind==='qq-snapshot'||!messages.has(sourceId(m))))messages.set(sourceId(m),input(m));
    }
    if(r.kind==='compaction'&&!compressions.has(r.id))compactions.set(r.sourceId??r.id,r);
  }
  for(const s of sessions)for(const c of s.life?.compactions??[])if(!compressions.has(c.sourceId??c.id)&&!compressions.has(c.id)&&!(s.life.digestedIds??[]).includes(c.id))compactions.set(c.sourceId??c.id,c);
  const state=inbox.read();
  for(const row of state.messages)if(!row.outgoing&&!row.read&&row.seq>state.readThrough&&!covered.has(row.sourceId))messages.set(row.sourceId,input(inboxSnapshot(row)));
  for(const c of conversation.values())for(const m of c.inputs)messages.delete(sourceId(m));
  for(const [id,m]of messages)conversation.set('input/'+id,{id:'input/'+id,inputs:[m],reply:'',at:m.receivedAt??m.time??0});
  return {conversation:[...conversation.values()].sort((a,b)=>(a.at??0)-(b.at??0)),compactions:[...compactions.values()]};
}

export function startupBatches(snapshot){
  const batches=[];let current={conversation:[],compactions:[]},size=0;
  for(const type of ['compactions','conversation'])for(const record of snapshot[type]){
    const length=JSON.stringify(record).length;
    if(length>180000)throw Error('单条待整理记录过大；已保留原文，启动暂停');
    if(size+length>180000){batches.push(current);current={conversation:[],compactions:[]};size=0;}
    current[type].push(record);size+=length;
  }
  if(size||!batches.length)batches.push(current);return batches;
}

export class StartupChats{
  constructor(bridge){this.bridge=bridge;this.jobs=new Map();bridge.state.startups??={};}
  blocked(key){return !!this.bridge.state.startups[key]&&!['ready','cancelled'].includes(this.bridge.state.startups[key].phase);}
  summary(){return Object.values(this.bridge.state.startups).map(r=>({key:r.route.key,phase:r.phase,batches:r.batches??0,completed:r.completedBatches??0,
    queued:(this.bridge.state.maintenanceInbox[r.route.key]??[]).filter(x=>x.state==='pending').length,error:r.error??''}));}
  phase(run,value){run.phase=value;this.bridge.persist();this.bridge.flow('startup.'+value,run.route);}
  begin(kinds,{resumeCompleted=false}={}){
    const b=this.bridge;
    for(const kind of kinds)for(const id of b.config[kind==='group'?'groups':'privateUsers']){
      const route={key:`${b.status.account||b.config.botQQ}/${kind}/${id}`,id,group:kind==='group'};
      if(this.jobs.has(route.key))continue;
      const previous=b.state.startups[route.key];
      if(resumeCompleted&&previous?.phase==='ready'&&Number.isSafeInteger(previous.historyThroughSeq)&&previous.backend===b.config.dshUrl){
        b.drainDeferred(route.key);continue;
      }
      if(previous&&(previous.greeting||previous.delivery||['greeting','publishing','uncertain','failed'].includes(previous.phase))){
        // Retain the old greeting outcome for audit; never retry that removed step.
        (b.state.startupHistory??=[]).push(previous);
      }
      const run={id:'startup-'+randomUUID(),route,backend:b.config.dshUrl,phase:'preparing',at:b.now(),historyThroughSeq:b.inbox(route.key).read().next-1};
      b.state.startups[route.key]=run;b.persist();
      // Capture the boundary synchronously; arrivals during digest remain live.
      b.archiveStartupBacklog(route);
      const controller=new AbortController(),generation=b.generation,epoch=b.epochs.get(route.key)??0;
      const job={controller};this.jobs.set(route.key,job);
      const current=()=>!controller.signal.aborted&&b.enabled(route)&&generation===b.generation&&epoch===(b.epochs.get(route.key)??0)&&b.state.startups[route.key]===run;
      job.promise=Promise.resolve().then(()=>this.run(run,current,controller.signal)).catch(error=>{
        if(error.exitUnconfirmed&&run.sessionId){const session=Object.values(b.state.sessions).find(s=>s.id===run.sessionId);if(session){session.exitUnconfirmed=error.exitUnconfirmed;session.blocked=true;}}
        run.error=error.message;
        this.phase(run,controller.signal.aborted?'cancelled':'failed');
        if(!controller.signal.aborted)b.reportError('启动流程暂停：'+error.message);
      }).finally(()=>{if(this.jobs.get(route.key)===job)this.jobs.delete(route.key);if(current()&&run.phase==='ready')b.drainDeferred(route.key,generation);});
    }
  }
  stop(matches){
    for(const [key,job]of this.jobs)if(matches(key))job.controller.abort();
    for(const [key,run]of Object.entries(this.bridge.state.startups))if(matches(key)&&!this.jobs.has(key)&&!['ready','publishing','uncertain'].includes(run.phase))run.phase='cancelled';
  }
  async run(run,current,signal){
    const b=this.bridge,route=run.route,config=b.configFor(route),store=b.memory(route.key);
    const check=()=>{if(!current())throw Error('启动已停止');};check();
    if(!config.memoryEnabled)throw Error('此聊天关闭了记忆，无法完成启动整理；请先启用该聊天记忆');
    const sessions=[...Object.values(b.state.sessions),...b.state.retired].filter(s=>s.route?.key===route.key&&b.activePersonaSession(s));
    const batches=startupBatches(startupSources(store,b.inbox(route.key),sessions));
    let session=await b.ensureStartupSession(route,current);check();run.sessionId=session.id;run.batches=batches.length;run.completedBatches=0;
    this.phase(run,'digesting');
    for(const [i,snapshot]of batches.entries()){
      check();const id=run.id+'/digest/'+i;
      await maintain({session,config,store,dsh:b.maintenanceDsh(session),persist:()=>b.persist(),now:b.now,isCurrent:current,signal,rotate:async()=>{},startupSnapshot:snapshot,digestId:id});
      check();if(!store.hasReceipt(id))throw Error('整理未取得保存回执');
      run.completedBatches++;b.persist();
    }
    check();
    if(config.dshNativeTools){session=await b.prepareChatWindow({...route,inboxSeq:run.historyThroughSeq+1},session,current);check();run.sessionId=session.id;b.persist();}
    resumeAfterMaintenance(session,b.now(),true);
    this.phase(run,'ready');
  }
}
