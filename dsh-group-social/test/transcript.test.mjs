import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import * as core from '../lib/core.mjs';

async function loadTranscript(){
  const context=vm.createContext({process,structuredClone,Intl,Date,Set,Promise});
  const module=new vm.SourceTextModule(readFileSync(new URL('../lib/transcript.mjs',import.meta.url),'utf8'),{context});
  let messageId=0;
  const deps={
    'node:path':{default:path},'./core.mjs':core,
    '@deepseek-ai/dsh-llm':{createUserMessage:input=>({id:'msg-'+(++messageId),role:'user',...structuredClone(input)})},
  };
  await module.link(specifier=>new vm.SyntheticModule(Object.keys(deps[specifier]),function(){
    for(const [name,value] of Object.entries(deps[specifier]))this.setExport(name,value);
  },{context}));
  await module.evaluate();return module.namespace;
}

function host({restoreMarker=false}={}){
  const stored=new Map(),live=new Map(),owned=new Set(),attached=[];
  const makeWriter=id=>({header:stored.get(id).header,inheritedEventCount:0,
    read:async()=>({events:structuredClone(stored.get(id).events),eventState:'detached'}),
    append:async events=>{for(const event of events){assert.equal(event.seq,stored.get(id).events.length);stored.get(id).events.push(structuredClone(event));}},
    close:async()=>{owned.delete(id);}});
  const ctx={sessions:{
    get:id=>live.get(id),
    prepare:(id,options)=>{
      const header={version:4,id,createdAt:1,isSeeded:false,...options.meta};
      const events=structuredClone(options.seed??[]);
      if(options.seed&&restoreMarker)events.push({seq:events.length,time:Date.now(),type:'permission/preset',data:{preset:'workspace-write'}});
      return {id,header,events,snapshotEvents:start=>events.slice(start),append(type,data,options){const event={seq:events.length,time:Date.now(),type,data,...options};events.push(event);return event;}};
    },
    enter:s=>{assert.equal(live.has(s.id),false);live.set(s.id,s);return ()=>live.delete(s.id);},
    announce:s=>assert.equal(live.get(s.id),s),
    flush:async s=>{assert.equal(owned.has(s.id),true);stored.get(s.id).events=structuredClone(s.events);return true;},
  },sessionPersistence:{
    stat:async id=>stored.has(id)?{header:stored.get(id).header}:undefined,
    create:async header=>{assert.equal(stored.has(header.id),false);stored.set(header.id,{header,events:[]});owned.add(header.id);return makeWriter(header.id);},
    open:async(id,access)=>{assert.equal(access,'write');assert.equal(owned.has(id),false);owned.add(id);return makeWriter(id);},
  },sessionTitle:{rename:(session,title)=>session.append('session/title',{title,source:{kind:'user'},messageSeqs:[]})}};
  const workspace={attachSession:async id=>{assert.ok(stored.has(id));if(!attached.includes(id))attached.push(id);}};
  return {ctx,workspace,stored,live,attached};
}

test('creates and attaches a durable native session without starting an agent or calling a model',async()=>{
  const {GroupTranscript,TRANSCRIPT_ID,TRANSCRIPT_TITLE}=await loadTranscript(),h=host(),updates=[];
  const t=new GroupTranscript(h.ctx,path.resolve('group-fixture'),info=>updates.push(info));
  await t.start(h.workspace);
  assert.deepEqual(h.attached,[TRANSCRIPT_ID]);assert.equal(h.stored.get(TRANSCRIPT_ID).header.cwd,path.resolve('group-fixture'));
  assert.equal(h.stored.get(TRANSCRIPT_ID).events[0].data.title,TRANSCRIPT_TITLE);
  assert.equal(h.stored.get(TRANSCRIPT_ID).events.some(e=>e.type==='turn/start'),true);
  assert.equal(h.stored.get(TRANSCRIPT_ID).events.some(e=>e.type==='step/start'),false);
  assert.equal(updates.at(-1).ready,true);assert.equal(updates.at(-1).mode,'read-only-transcript');
  await t.close();assert.equal(h.live.has(TRANSCRIPT_ID),false);
});

test('restoration persists pre-publication markers and snapshot recovery does not duplicate QQ records',async()=>{
  const {GroupTranscript,TRANSCRIPT_ID,TRANSCRIPT_SOURCE}=await loadTranscript(),h=host({restoreMarker:true});
  let t=new GroupTranscript(h.ctx,path.resolve('group-fixture'));await t.start(h.workspace);
  await t.sync([{id:'301',time:1,sender:'123',text:'original'}]);await t.close();
  t=new GroupTranscript(h.ctx,path.resolve('group-fixture'));await t.start(h.workspace);
  const source={kind:TRANSCRIPT_SOURCE,groupId:core.GROUP,messageId:'302',senderId:'123'};
  const recovery={id:TRANSCRIPT_ID,cwd:path.resolve('group-fixture'),events:[{type:'user/message',data:{id:'recovered',role:'user',source,content:[{type:'text',text:'unsaved group record'}]}}]};
  await t.recover(recovery);await t.recover(recovery);await t.close();
  const events=h.stored.get(TRANSCRIPT_ID).events;
  assert.equal(events.filter(e=>e.data?.source?.messageId==='302').length,1);
  assert.equal(events.filter(e=>e.type==='permission/preset').length,1);
  assert.equal(events.every((e,i)=>e.seq===i),true);
});

test('a flush failure still releases the live session and its write ownership',async()=>{
  const {GroupTranscript,TRANSCRIPT_ID}=await loadTranscript(),h=host();
  const t=new GroupTranscript(h.ctx,path.resolve('group-fixture'));await t.start(h.workspace);
  h.ctx.sessions.flush=async()=>{throw Error('disk unavailable');};
  await assert.rejects(t.close(),/disk unavailable/);assert.equal(h.live.has(TRANSCRIPT_ID),false);
  const writer=await h.ctx.sessionPersistence.open(TRANSCRIPT_ID,'write');await writer.close();
});

test('history, live echoes and verified bot sends deduplicate across reloads',async()=>{
  const {GroupTranscript,TRANSCRIPT_ID,TRANSCRIPT_SOURCE}=await loadTranscript(),h=host();
  const input=[{id:'101',time:1,sender:'123',name:'群友甲',text:'你好'},
    {id:'102',time:2,sender:core.BOT,name:'机器人',text:'已实际发出的回答'}];
  let t=new GroupTranscript(h.ctx,path.resolve('group-fixture'));
  await t.start(h.workspace);await Promise.all([t.sync(input),t.sync([input[1]]),t.sync(input)]);
  await t.close();t=new GroupTranscript(h.ctx,path.resolve('group-fixture'));
  await t.start(h.workspace);await t.sync(input);
  const entries=h.stored.get(TRANSCRIPT_ID).events.filter(e=>e.type==='user/message'&&e.data.source.messageId);
  assert.equal(entries.length,2);assert.equal(entries[1].data.source.kind,'user');assert.equal(entries[1].data.source.channel,TRANSCRIPT_SOURCE);
  assert.equal(h.stored.get(TRANSCRIPT_ID).events.filter(e=>e.type==='turn/start').length,2);
  assert.equal(entries[1].data.source.direction,'outgoing');assert.match(entries[1].data.content[0].text,/机器人.*\n.*\n\n已实际发出的回答/s);
  assert.equal(entries.some(e=>e.type==='assistant/message'),false);
  await t.close();
});

test('closing drains accepted queued records before releasing the native writer',async()=>{
  const {GroupTranscript,TRANSCRIPT_ID}=await loadTranscript(),h=host();
  const t=new GroupTranscript(h.ctx,path.resolve('group-fixture'));await t.start(h.workspace);
  const queued=t.sync([{id:'201',time:1,sender:'123',text:'重启前最后一条'}]);
  await t.close();await queued;
  assert.equal(h.stored.get(TRANSCRIPT_ID).events.some(e=>e.data?.source?.messageId==='201'),true);
});

test('a colliding native session in another workspace is never read or attached',async()=>{
  const {GroupTranscript,TRANSCRIPT_ID}=await loadTranscript(),h=host();
  h.stored.set(TRANSCRIPT_ID,{header:{cwd:path.resolve('private-fixture')},events:[{secret:'PRIVATE'}]});
  h.ctx.sessionPersistence.open=async()=>{throw Error('PRIVATE_LOG_MUST_NOT_BE_READ');};
  await assert.rejects(new GroupTranscript(h.ctx,path.resolve('group-fixture')).start(h.workspace),/different workspace/);
  assert.equal(h.attached.length,0);
});

test('transcript accepts the selected group only, including bot echoes but excluding private messages',async()=>{
  const {transcriptEventAllowed}=await loadTranscript();
  const e={post_type:'message',message_type:'group',group_id:core.GROUP,self_id:core.BOT,user_id:'123'};
  assert.equal(transcriptEventAllowed(e),true);assert.equal(transcriptEventAllowed({...e,post_type:'message_sent',user_id:core.BOT}),true);
  assert.equal(transcriptEventAllowed({...e,message_type:'private'}),false);
  assert.equal(transcriptEventAllowed({...e,group_id:'other'}),false);
  assert.equal(transcriptEventAllowed({...e,self_id:'other'}),false);
});
