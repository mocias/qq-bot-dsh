import path from 'node:path';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {installModelSelection} from '@deepseek-ai/dsh-agent';
import {GROUP} from './core.mjs';
import {GROUP_TOOLS,groupToolDenial} from './security.mjs';

export const NATIVE_AGENT_ID=`companion-group-social-${GROUP}-agent`;
export const NATIVE_AGENT_TITLE='示例测试群 · 原生群聊';
export const QQ_SOURCE_CHANNEL='companion-group-native';
export function finalText(message){return (message?.content??[]).filter(p=>p.type==='text').map(p=>p.text??'').join('').trim();}
export function normalizedReply(text){const value=String(text??'').trim();return value==='[[QQ_SILENT]]'?'':value.slice(0,500);}

export class NativeGroupAgent {
  constructor(ctx,workspacePath,{selection,getPrompt,onStatus=()=>{},onGroupResult=async()=>{}}){
    this.ctx=ctx;this.workspacePath=workspacePath;this.selection=selection;this.getPrompt=getPrompt;
    this.onStatus=onStatus;this.onGroupResult=onGroupResult;
    this.pending=new Map();this.turns=new Map();this.seen=new Set();this.currentTurn=0;this.closed=false;
    this.unlisten=ctx.on('session/event',(session,event)=>{if(session.id===NATIVE_AGENT_ID)this.onEvent(event);});
  }
  async start(workspace){
    if(this.handle)return;
    if(this.closed)throw Error('Group native agent is closed');
    if(this.ctx.agents.get(NATIVE_AGENT_ID))throw Error('Group native Agent already has an owner');
    const metadata=await this.ctx.sessionPersistence.stat(NATIVE_AGENT_ID);
    if(metadata){
      if(path.resolve(metadata.header.cwd??'').toLowerCase()!==path.resolve(this.workspacePath).toLowerCase())throw Error('Native group session belongs to another workspace');
      const reader=await this.ctx.sessionPersistence.open(NATIVE_AGENT_ID,'read');
      try{for(const event of (await reader.read()).events){
        if(event.type==='user/message'&&event.data.source?.channel===QQ_SOURCE_CHANNEL&&event.data.source.origin==='qq'){
          for(const id of [...(event.data.source.groupMessageIds??[]),...(event.data.source.evidenceMessageIds??[])])this.seen.add(String(id));
        }
      }}finally{await reader.close();}
    }
    const setup=async agentCtx=>{
      agentCtx.tools.presentAs('native');
      agentCtx.tools.restrict({allow:[...GROUP_TOOLS]});
      agentCtx.tools.guard(exec=>groupToolDenial(exec,this.workspacePath));
      installModelSelection(agentCtx,{current:{...this.selection},assembled:undefined});
      agentCtx.systemPrompt.section({name:'qq-group-native-complete',order:0,complete:true,interpolate:false,text:()=>this.getPrompt()});
      agentCtx.on('system-prompt/assemble',async(_assembly,_context,next)=>{
        const assembled=await next();
        return {...assembled,contexts:[],variables:{},tools:assembled.tools.filter(tool=>GROUP_TOOLS.includes(tool.name))};
      });
      agentCtx.on('agent/inbox/claimed',({message,turn})=>this.claim(message,turn));
    };
    const agentOptions={...this.selection,maxTokens:2400};
    this.handle=metadata?await this.ctx.agents.resume({resumeSessionId:NATIVE_AGENT_ID,agentOptions,setup})
      :await this.ctx.agents.create({sessionId:NATIVE_AGENT_ID,meta:{cwd:this.workspacePath},agentOptions,setup});
    this.agent=this.handle.agent;
    await this.agent.whenIdle();
    this.ctx.sessionTitle.rename(this.agent.session,NATIVE_AGENT_TITLE);
    await this.ctx.sessions.flush(this.agent.session);
    await workspace.attachSession(this.agent.session.id);
    this.onStatus({id:this.agent.session.id,title:NATIVE_AGENT_TITLE,mode:'native-agentloop',ready:true,restored:!!metadata,
      agentImplementation:this.agent.constructor?.name,provider:this.selection.provider,model:this.selection.model,
      allowedTools:[...GROUP_TOOLS],qqMessagesAdmitted:this.seen.size});
  }
  claim(message,turn){
    const source=message.source??{};
    const owned=source.channel===QQ_SOURCE_CHANNEL;
    const origin=owned?source.origin:source.kind==='user'?'local-ui':'context';
    let record=this.turns.get(turn);
    if(!record){record={turn,origin:'context',text:'',toolCalls:[],toolResults:[],searches:0,memoryWrites:0,evidenceIds:new Set()};this.turns.set(turn,record);}
    if(origin==='context')return;
    if(record.origin==='context')Object.assign(record,{origin,messageId:message.id,operationId:owned?source.operationId:undefined,trigger:source.trigger});
    else if(record.origin!==origin)record.origin='mixed';
    if(origin==='qq'){
      for(const id of [...(source.groupMessageIds??[]),...(source.evidenceMessageIds??[])])this.seen.add(String(id));
      record.evidenceIds=new Set(this.seen);
    }
    const pending=this.pending.get(message.id);if(pending)pending.turn=turn;
  }
  onEvent(event){
    const data=event.data;
    if(event.type==='turn/start'){this.currentTurn=data.turn;this.turns.set(data.turn,{turn:data.turn,origin:'context',text:'',toolCalls:[],toolResults:[],searches:0,memoryWrites:0,evidenceIds:new Set()});return;}
    if(event.type==='user/message'&&this.turns.has(this.currentTurn))this.claim(data,this.currentTurn);
    const turn=data?.turn??this.currentTurn,record=this.turns.get(turn);
    if(event.type==='request/header'){
      const header=data.header;
      this.onStatus({lastRequest:{at:new Date().toISOString(),provider:header.config?.provider,model:header.config?.model,
        tools:(header.tools??[]).map(t=>t.name)}});
    }
    if(!record)return;
    if(event.type==='assistant/message')record.text=finalText(data.message);
    if(event.type==='tool/call')record.toolCalls.push(data.name);
    if(event.type==='tool/result'){
      const message=data.message??data;
      record.toolResults.push({callId:message.callId??message.source?.callId,isError:message.isError??null});
    }
    if(event.type==='turn/end'){
      record.reason=data.reason;
      const pending=this.pending.get(record.messageId);
      const result={turn,origin:record.origin,text:normalizedReply(record.text),operationId:record.operationId,
        trigger:record.trigger,reason:data.reason,toolCalls:[...record.toolCalls],toolResults:[...record.toolResults]};
      this.onStatus({lastTurn:{...result,at:new Date().toISOString()},qqMessagesAdmitted:this.seen.size});
      void (async()=>{
        try{
          if(this.agent)await this.ctx.sessions.flush(this.agent.session);
          if(data.reason?.kind!=='completed')throw Error('Native group turn did not complete: '+JSON.stringify(data.reason));
          if(record.origin==='qq'&&!this.closed)await this.onGroupResult(result);
          this.onStatus({lastTurnError:null});
          pending?.resolve(result);
        }catch(error){pending?.reject(error);this.onStatus({lastTurnError:error.message});}
        finally{this.pending.delete(record.messageId);this.turns.delete(turn);}
      })();
    }
  }
  contextForTool(exec){
    if(exec?.agent?.session?.id!==NATIVE_AGENT_ID)throw Error('This tool is only available to the native group Agent');
    const authority=this.turns.get(this.currentTurn);
    if(!authority)throw Error('No admitted native group turn');
    return authority;
  }
  async run(input,{origin='qq',signal,operationId,trigger='direct'}={}){
    if(!this.agent||this.closed)throw Error('Native group Agent is not ready');
    signal?.throwIfAborted();
    const messages=input.messages??[];
    const attachments=Array.isArray(input.attachments)?input.attachments.filter(Boolean):[];
    const content=[{type:'text',text:typeof input==='string'?input:JSON.stringify(input)},
      ...attachments.map(attachment=>({type:'image',attachment}))];
    const message=createUserMessage({source:{kind:'user',channel:QQ_SOURCE_CHANNEL,origin,groupId:GROUP,...(operationId===undefined?{}:{operationId}),trigger,
      groupMessageIds:messages.map(m=>String(m.id)),evidenceMessageIds:[...messages,...(input.recentContext??[])].map(m=>String(m.id))},
      content});
    return new Promise((resolve,reject)=>{
      const onAbort=()=>{
        const pending=this.pending.get(message.id);
        this.agent.inbox.remove(message.id);
        if(pending?.turn===this.currentTurn)this.agent.cancel({kind:'hook',reason:'Group turn canceled or timed out'},{keepInbox:true});
        this.pending.delete(message.id);reject(signal.reason??Error('Group turn aborted'));
      };
      this.pending.set(message.id,{resolve:value=>{signal?.removeEventListener('abort',onAbort);resolve(value);},
        reject:error=>{signal?.removeEventListener('abort',onAbort);reject(error);}});
      signal?.addEventListener('abort',onAbort,{once:true});
      try{this.agent.followup(message);}catch(error){this.pending.delete(message.id);signal?.removeEventListener('abort',onAbort);reject(error);}
    });
  }
  async close(){
    if(this.closed)return;this.closed=true;
    for(const pending of this.pending.values())pending.reject(Error('Native group Agent stopped'));
    this.pending.clear();
    try{await this.handle?.dispose();}finally{this.unlisten?.();this.handle=undefined;this.agent=undefined;}
  }
}
