import path from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { BOT, GROUP } from './core.mjs';

export const TRANSCRIPT_ID = `companion-group-social-${GROUP}-transcript`;
export const TRANSCRIPT_TITLE = '示例测试群 · 实时记录';
export const TRANSCRIPT_SOURCE = 'plugin:companion-group-transcript';
const recordSource=source=>source?.kind===TRANSCRIPT_SOURCE||(source?.kind==='user'&&source.channel===TRANSCRIPT_SOURCE);
const visibleSource=source=>({...source,kind:'user',channel:TRANSCRIPT_SOURCE});

export function transcriptEventAllowed(event) {
  return ['message','message_sent'].includes(event?.post_type) && event.message_type==='group'
    && String(event.group_id)===GROUP && String(event.self_id)===BOT;
}

function sameDirectory(left,right) {
  if(typeof left!=='string'||!path.isAbsolute(left))return false;
  const normalize=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
  return normalize(left)===normalize(right);
}

// A real SessionStore/SessionPersistence session, with no Agent or model driver.
// All QQ entries remain imported user-role records with explicit sender labels;
// we never invent model streams, token usage, or tool executions for QQ history.
export class GroupTranscript {
  constructor(ctx,workspacePath,onStatus=()=>{},title=TRANSCRIPT_TITLE) {
    this.ctx=ctx;this.workspacePath=workspacePath;this.onStatus=onStatus;this.title=title;
    this.seen=new Set();this.tail=Promise.resolve();this.closed=false;this.turn=0;
  }
  async start(workspace) {
    if(this.session)return;
    if(this.starting)return this.starting;
    this.starting=this.open(workspace);
    try{return await this.starting;}finally{this.starting=undefined;}
  }
  async open(workspace) {
    if(this.closed||this.closing)throw Error('Group transcript is closed');
    if(this.ctx.sessions.get(TRANSCRIPT_ID))throw Error('Group transcript already has a live owner');
    const metadata=await this.ctx.sessionPersistence.stat(TRANSCRIPT_ID);
    let session,writer,detach,storedCount=0,legacy=[];
    try {
      if(metadata){
        if(!sameDirectory(metadata.header.cwd,this.workspacePath))throw Error('Transcript belongs to a different workspace');
        writer=await this.ctx.sessionPersistence.open(TRANSCRIPT_ID,'write');
        const snapshot=await writer.read();
        storedCount=snapshot.events.length;
        const visibleIds=new Set(snapshot.events.filter(e=>e.type==='user/message'&&e.data.source?.kind==='user'&&e.data.source.channel===TRANSCRIPT_SOURCE).map(e=>String(e.data.source.messageId)));
        session=this.ctx.sessions.prepare(TRANSCRIPT_ID,{seed:snapshot.events,meta:structuredClone(writer.header),
          inheritedEventCount:writer.inheritedEventCount,eventState:snapshot.eventState});
        for(const event of snapshot.events){
          if(event.type==='turn/start')this.turn=Math.max(this.turn,Number(event.data.turn));
          const source=event.type==='user/message'?event.data.source:undefined;
          if(recordSource(source)&&source.groupId===GROUP&&source.messageId)this.seen.add(String(source.messageId));
          if(source?.kind===TRANSCRIPT_SOURCE&&source.groupId===GROUP&&source.messageId&&!visibleIds.has(String(source.messageId)))legacy.push(event);
        }
      }else{
        session=this.ctx.sessions.prepare(TRANSCRIPT_ID,{meta:{cwd:this.workspacePath}});
        writer=await this.ctx.sessionPersistence.create(session.header);
      }
      if(this.closed||this.closing)throw Error('Group transcript closed during startup');
      // Session preparation can append a lifecycle marker before publication.
      // Persist that suffix exactly as the native AgentLoop factory does, before
      // live event routing starts at the following sequence number.
      const suffix=session.snapshotEvents(storedCount);
      if(suffix.length)await writer.append(suffix);
      detach=this.ctx.sessions.enter(session);
      this.ctx.sessions.announce(session);
      this.session=session;this.writer=writer;this.detach=detach;
      this.ctx.sessionTitle.rename(session,this.title);
      // DSH marks a Session blank until its first turn/start. A sync batch is a
      // native turn with no model step, not a fabricated inference or tool run.
      if(!this.turn){
        this.session.append('turn/start',{turn:++this.turn});
        session.append('user/message',createUserMessage({source:visibleSource({}),content:[{type:'text',text:
          '这是示例测试群（100000003）的只读实时同步记录。群友与机器人消息都按实际发送者、时间和 QQ 消息 ID 标注。首次接入回填最近 30 条，后续同步新消息；图片、语音和文件只显示类型占位。此会话不运行 Agent，不把在 DSH 输入的文字发到 QQ。群聊人设和长期记忆仍独立保存在群工作区 .memory/。'}]}),{surfaceOp:'append'});
        this.session.append('turn/end',{turn:this.turn,reason:{kind:'completed'}});
      }
      // DSH's conversation view hides plugin context. Native user-source
      // records display the explicit imported sender label without creating
      // an Agent. Replace legacy hidden surface nodes and retain provenance.
      if(legacy.length){
        session.append('turn/start',{turn:++this.turn});
        for(const event of legacy)session.append('user/message',createUserMessage({source:visibleSource(event.data.source),content:event.data.content}),
          {surfaceOp:{op:'replace',startSeq:event.seq,endSeq:event.seq},sourceEventSeqs:[event.seq]});
        session.append('turn/end',{turn:this.turn,reason:{kind:'completed'}});
      }
      await this.flush();
      await workspace.attachSession(TRANSCRIPT_ID);
      this.onStatus({id:TRANSCRIPT_ID,title:this.title,mode:'read-only-transcript',ready:true,
        restored:!!metadata,messageCount:this.seen.size,storage:writer.location??null});
    }catch(error){
      this.session=undefined;this.writer=undefined;this.detach=undefined;
      try{detach?.();}catch{}
      try{await writer?.close();}catch{}
      throw error;
    }
  }
  sync(messages) {
    if(this.closed||this.closing)return Promise.resolve();
    const task=this.tail.catch(()=>{}).then(async()=>{
      if(this.closed||!this.session)return;
      let added=0;
      for(const message of [...messages].sort((a,b)=>a.time-b.time)){
        const id=String(message.id??'');
        if(!id||this.seen.has(id))continue;
        const sender=String(message.sender??''),text=String(message.text??'');
        if(!sender)continue;
        const timestamp=new Date(Number(message.time)*1000);
        const time=Number.isFinite(timestamp.getTime())?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'medium',hour12:false}).format(timestamp):'时间未知';
        const label=sender===BOT?'机器人':'群友';
        if(!added)this.session.append('turn/start',{turn:++this.turn});
        this.session.append('user/message',createUserMessage({
          source:visibleSource({groupId:GROUP,messageId:id,senderId:sender,direction:sender===BOT?'outgoing':'incoming'}),
          content:[{type:'text',text:`【${label}】${message.name||sender}（QQ ${sender}）\n${time} · 消息 ${id}\n\n${text||'（非文字消息）'}`}],
        }),{surfaceOp:'append'});
        this.seen.add(id);added++;
      }
      if(added)this.session.append('turn/end',{turn:this.turn,reason:{kind:'completed'}});
      await this.flush();
      if(added)this.onStatus({id:TRANSCRIPT_ID,title:this.title,mode:'read-only-transcript',ready:true,
        messageCount:this.seen.size,lastSyncedAt:new Date().toISOString(),lastBatchCount:added});
    });
    this.tail=task;return task;
  }
  async flush(){if(this.session)await this.ctx.sessions.flush(this.session);}
  recover(snapshot){
    if(!snapshot)return Promise.resolve();
    if(snapshot.id!==TRANSCRIPT_ID||!sameDirectory(snapshot.cwd,this.workspacePath))return Promise.reject(Error('Wrong group recovery snapshot'));
    const task=this.tail.catch(()=>{}).then(async()=>{
      if(this.closed||!this.session)return;
      let added=0;
      for(const event of snapshot.events??[]){
        const source=event.type==='user/message'?event.data?.source:undefined;
        if(!recordSource(source)||source.groupId!==GROUP||!source.messageId||this.seen.has(String(source.messageId)))continue;
        if(!added)this.session.append('turn/start',{turn:++this.turn});
        this.session.append('user/message',createUserMessage({source:visibleSource(source),content:event.data.content}),{surfaceOp:'append'});
        this.seen.add(String(source.messageId));added++;
      }
      if(added)this.session.append('turn/end',{turn:this.turn,reason:{kind:'completed'}});
      await this.flush();
      this.onStatus({messageCount:this.seen.size,recoveredRecords:added});
    });
    this.tail=task;return task;
  }
  async close(){
    if(this.closed||this.closing)return;
    this.closing=true;
    await this.starting?.catch(()=>{});
    await this.tail.catch(()=>{});
    let failure;
    try{await this.flush();}catch(error){failure=error;}
    try{this.detach?.();}catch(error){failure??=error;}
    try{await this.writer?.close();}catch(error){failure??=error;}
    this.session=undefined;this.writer=undefined;this.detach=undefined;this.closed=true;
    if(failure)throw failure;
  }
}
