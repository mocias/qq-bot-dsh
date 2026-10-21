import {promptText,validatePromptRules,promptTool} from './prompt-text.mjs';
import {VERSION,PROTOCOL,BUILD_ID,DEFINITIONS,names} from './schema.mjs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {Continuations,CONTINUOUS_TOOL_TIMEOUT_MS,isHostContext} from './continuations.mjs';
import {hookCompaction,saveHandoff} from './handoff.mjs';
import {ScheduleWakeRouter} from './scheduled-wake.mjs';
export const RUN_LEASE_MS=240000;
const terminal=name=>/^qq_(send_message|reply|send_media|send_poke|send_sticker|group_send_image|no_reply)$/.test(name);
const unsentReplyInstruction=binding=>promptText(binding,'runtime.unsent');
function validateMemoryContext(value){
  if(value===undefined)return;
  if(!value||typeof value.text!=='string'||typeof value.skill!=='string'||value.text.length>10000000||value.skill.length>50000||Object.keys(value).some(k=>!['text','skill'].includes(k)))throw Error('记忆运行时上下文无效');
}

export class NativeRuntime{
  constructor(ctx,defineTool,{scheduleRoot}={}){
    this.ctx=ctx;this.defineTool=defineTool;this.bindings=new Map();this.receipts=new Map();
    // Older stable loaders already expose their trusted manifest on the service.
    // Resolve it there so this update also works before the next DSH restart.
    const manifest=ctx.qqRsiNative?.manifest;
    if(!scheduleRoot&&path.isAbsolute(manifest??''))scheduleRoot=path.resolve(path.dirname(manifest),'../standalone/.runtime');
    // The old loader disposes after constructing its replacement. Detach its
    // hooks first, otherwise two live-update generations wrap the same agent.
    const previous=ctx.qqRsiNative?.runtime;
    if(previous&&previous.bindings?.size===0)previous.dispose();
    this.scheduleRouter=new ScheduleWakeRouter(ctx,scheduleRoot);
  }
  probe(request){
    this.scheduleRouter.refresh();
    const status={version:VERSION,protocol:PROTOCOL,buildId:BUILD_ID,active:this.bindings.size,scheduledWakeRouter:!!this.scheduleRouter.root};
    if(typeof request?.sessionId==='string'){
      const agent=this.ctx.agents.get(request.sessionId);
      const engine=agent&&this.ctx.agentPresets?.serviceFor(agent,'compaction');
      status.presetCompaction=!agent?'agent-not-loaded':typeof engine?.compactRegion==='function'?'available':'unavailable';
    }
    return status;
  }
  async submit(request){
    let dispatchStarted=false;
    try{return await this.admit(request,()=>{dispatchStarted=true;});}
    catch(error){
      // Only pre-dispatch failures prove that this input never reached the agent.
      if(dispatchStarted)throw error;
      return {accepted:false,error:{code:'QQ_SUBMIT_REJECTED',message:error.message}};
    }
  }
  async admit(request,onDispatch){
    const {sessionId,runId,requestId,mode,content,callback,allowed,version,protocol,buildId,memoryContext,promptRules={},continuous=false,handoff=false,handoffPending=false,awayRequested=false}=request??{};
    validatePromptRules(promptRules);
    if(typeof continuous!=='boolean')throw Error('持续对话开关无效');
    if(typeof handoff!=='boolean'||typeof handoffPending!=='boolean'||typeof awayRequested!=='boolean'||handoff&&!continuous||awayRequested&&!handoff)throw Error('交接设置无效');
    validateMemoryContext(memoryContext);
    if(version!==VERSION||protocol!==PROTOCOL||buildId!==BUILD_ID)throw Error('QQ服务与DSH插件版本或构建不一致，请一起更新');
    if(typeof sessionId!=='string'||typeof runId!=='string'||typeof requestId!=='string'||!['queue','steer'].includes(mode))throw Error('执行请求标识无效');
    if(!Array.isArray(allowed)||allowed.some(name=>!names.has(name))||new Set(allowed).size!==allowed.length)throw Error('工具清单无效');
    const address=new URL(callback?.url);
    if(address.protocol!=='http:'||address.hostname!=='127.0.0.1'||address.pathname!=='/tool'||address.username||address.password||address.search||address.hash||!address.port||!/^[a-f0-9]{64}$/.test(callback.token))throw Error('工具回调地址无效');
    if(!Array.isArray(content)||!content.length||JSON.stringify(content).length>10000000||content.some(p=>!['text','image'].includes(p?.type)))throw Error('执行请求内容无效');
    let agent=this.ctx.agents.get(sessionId);
    if(!agent&&this.ctx.sessionController){
      const found=await this.ctx.sessionController.resolveAgent(sessionId);
      if(found.error)throw found.error;agent=found.agent;
    }
    if(!agent)throw Error('DSH会话Agent未就绪，请在DSH打开该会话后重试');
    this.scheduleRouter.attach(agent);
    let binding=this.bindings.get(sessionId);
    if(binding&&binding.runId!==runId)throw Error('会话已有其他执行请求');
    if(!binding){
      if(mode!=='queue'||agent.status!=='idle')throw Error('新执行请求必须从空闲会话开始');
      binding={runId,sessionId,agent,callback,allowed,memoryContext,promptRules:structuredClone(promptRules),continuous,handoff,handoffPending,awayRequested,continuations:new Continuations(),ids:new Set(),calls:new Set(),results:new Map(),claimed:false,disposers:[],activeTurns:new Set(),expires:0};
      this.bindings.set(sessionId,binding);
      this.renew(binding);
      try{
        if(handoff){
          let serial=0;
          binding.control=async(action,args)=>{
            if(binding.invalidated||this.bindings.get(sessionId)!==binding)throw Error('交接回合已失效');
            const response=await fetch(callback.url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer '+callback.token},
              body:JSON.stringify({sessionId,runId,callId:`handoff-control-${++serial}`,control:action,args}),signal:AbortSignal.timeout(20000)});
            const value=await response.json();if(!response.ok||value.error)throw Error(value.error??'交接保存失败');return value;
          };
          binding.disposers.push(agent.ctx.systemPrompt.context({name:'qq-rsi-handoff',order:-190,required:true,interpolate:false,
            text:context=>context?.agent===agent&&binding.claimed&&this.bindings.get(sessionId)===binding?
              (binding.handoffPending?promptText(binding,'runtime.1'):
                promptText(binding,'runtime.2')):''}));
          let attached=false;
          const attach=engine=>{
            binding.disposers.push(hookCompaction(engine,agent,async({start,end,signal,compact})=>{
              if(!binding.claimed||binding.invalidated)return compact();
              signal?.throwIfAborted();
              const saved=await saveHandoff(binding.control,agent,{reason:'compaction',metadata:{start,end},
                unfinished:[...binding.continuations.pending].map(id=>`子任务 ${id} 尚未完成，等待真实结果`)});
              let result;
              try{signal?.throwIfAborted();if(binding.invalidated)throw Error('交接回合已停止');result=await compact();}
              catch(error){await binding.control('failed',{id:saved.id,error:error.message}).catch(()=>{});throw error;}
              const summary=(result.summary??[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');
              // If durable commit fails after DSH changed the surface, stop writes;
              // the prepared archive remains available for recovery.
              try{await binding.control('commit',{...saved,summary,compactionId:result.compactionId,
                unfinished:[...saved.unfinished,'完整待办、承诺、尚未回应消息及角色状态见本交接summary，须结合原对话和动作回执核对。历史不是重新执行动作的授权。']});}
              catch(error){this.invalidate(binding);throw error;}
              binding.handoffPending=true;return result;
            }));attached=true;
          };
          // Presets isolate compaction in a child group. Resolve the service
          // from this Agent's retained preset revision, not its outer scope.
          const engine=this.ctx.agentPresets?.serviceFor(agent,'compaction');
          if(engine)attach(engine);
          else {
            const registration=agent.ctx.inject(['compaction'],ctx=>attach(ctx.compaction));
            binding.disposers.push(()=>registration.dispose());await registration;
          }
          if(!attached)throw Error('DSH压缩服务未就绪，未启动QQ回合');
        }
        if(memoryContext!==undefined){
          if(typeof agent.ctx.systemPrompt?.context!=='function')throw Error('DSH 缺少记忆运行时上下文服务，请更新 DSH 与轻量插件');
          binding.disposers.push(agent.ctx.systemPrompt.context({name:'qq-rsi-memory',order:-200,required:true,interpolate:false,
            text:context=>context?.agent===agent&&binding.claimed&&this.bindings.get(sessionId)===binding?binding.memoryContext.text:''}));
          if(memoryContext.skill){
            // Declare the service on a child of the agent scope. Never borrow
            // agent.ctx.skills without injection, or register the skill globally.
            const registration=agent.ctx.inject(['skills'],ctx=>{
              binding.disposers.push(ctx.skills.register({name:'qq-memory',description:'当前QQ聊天长期记忆：主动记住、查索引、读页、全文搜索和遗忘。',
                whenToUse:'回忆已有事实，学到稳定偏好、约定或人物关系，用户要求修正或遗忘时。',content:memoryContext.skill,source:'dsh-qq-rsi-native'}));
            });
            binding.disposers.push(()=>registration.dispose());await registration;
            if(this.bindings.get(sessionId)!==binding||binding.invalidated)throw Error('技能准备期间回合已失效');
          }
        }
        binding.disposers.push(agent.ctx.tools.presentAs('native'));
        if(continuous)binding.disposers.push(agent.ctx.on('agent/turn-stopping',({signal})=>{
          if(signal.aborted||binding.invalidated||binding.departed||!binding.claimed||this.bindings.get(sessionId)!==binding||Date.now()>binding.expires)return;
          if(binding.textOnlyResponse)binding.replyPending=true;
          binding.textOnlyResponse=false;
          // DSH awaits this hook before turn/end. The next step stays in this turn.
          agent.steer({id:randomUUID(),role:'user',source:{kind:'plugin:qq-rsi-native',runId,continuation:true},content:[{type:'text',text:
            binding.awayRequested?promptText(binding,'absence.handoff'):(binding.replyPending?unsentReplyInstruction(binding)+'\n':'')+promptText(binding,'runtime.3')}]});
        }));
        binding.disposers.push(agent.ctx.on('agent/inbox/claimed',({message})=>{
          if(isHostContext(message,binding.continuations.compactions))return;
          binding.claimed=message.source?.kind==='plugin:qq-rsi-native'&&message.source?.runId===runId||continuous&&binding.claimed&&binding.continuations.owns(message);
        }));
        binding.disposers.push(agent.ctx.on('session/event',(session,event)=>{
          if(session===agent.session){
            if(event.type==='turn/start'){binding.started=true;binding.activeTurns.add(event.data.turn);}
            if(event.type==='turn/end'){
              binding.activeTurns.delete(event.data.turn);
              if(binding.invalidated&&this.terminal(binding)){this.drop(binding);return;}
            }
          }
          if(continuous&&session===agent.session&&event.type==='turn/start')binding.turn=event.data.turn;
          if(continuous&&binding.claimed&&session===agent.session){
            binding.continuations.observe(event);
            // Track only new public model messages. Never inspect reasoning,
            // snapshots, old session history or tool results for draft content.
            if(event.type==='assistant/message')binding.textOnlyResponse=!!event.data.message?.content?.some(p=>p.type==='text'&&p.text?.trim());
            if(event.type==='tool/call')binding.textOnlyResponse=false;
          }
          if(binding.claimed&&session===agent.session&&event.type==='tool/result'&&binding.calls.has(event.data.message.callId)&&!binding.results.has(event.data.message.callId)&&!event.data.message.isError)
            binding.results.set(event.data.message.callId,event);
        }));
        for(const definition of DEFINITIONS.filter(t=>allowed.includes(t.name)).map(d=>promptTool(d,binding))){
          binding.disposers.push(agent.ctx.tools.register(this.defineTool({...definition,
            ...(continuous&&terminal(definition.name)?{description:definition.description+promptText(binding,'runtime.4')}:{}),
            output:{schema:{type:'json'},render:(_args,value)=>[
              {type:'text',text:JSON.stringify(value.result??value)},
              ...(value.images??[])
            ]},
            isConcurrencySafe:()=>false,
            execute:async(args,exec)=>{
              if(binding.invalidated)throw Error('QQ执行回合已失效，正在等待结束确认；不要改用命令或其他工具写入');
              if(binding.departed)throw Error('已保存离开交接，本阶段已结束，等待宿主整理记忆');
              if(this.bindings.get(sessionId)!==binding||!binding.claimed||Date.now()>binding.expires||exec.agent!==agent||exec.signal.aborted)throw Error('工具不属于有效的QQ执行回合');
              if(continuous)binding.textOnlyResponse=false; // Text accompanying tools is commentary.
              if(continuous&&definition.name==='qq_wait_for_messages'){
                const {discardDraft,...waitArgs}=args;
                if(discardDraft!==undefined&&typeof discardDraft!=='boolean')throw Error('discardDraft必须为布尔值');
                if(binding.replyPending&&!discardDraft&&!binding.handoffPending&&!binding.awayRequested)return {result:{reason:'reply-not-sent',messages:[],notifications:[],hasMore:false,instruction:unsentReplyInstruction(binding)}};
                if(discardDraft)binding.replyPending=false;
                args=waitArgs; // Native routing control, never forwarded as inbox input.
              }
              if(binding.handoffPending&&terminal(definition.name))throw Error('先调用qq_wait_for_messages恢复交接，再决定是否回应新消息');
              if(definition.name==='qq_handoff'&&args.action==='create'){
                if(!handoff||typeof args.summary!=='string'||!args.summary.trim()||args.summary.length>60000||!Array.isArray(args.unfinished)||args.unfinished.some(x=>typeof x!=='string')||JSON.stringify(args.unfinished).length>60000||Object.keys(args).some(k=>!['action','summary','unfinished'].includes(k)))throw Error('交接需要summary和unfinished，不接受其他聊天或路径');
                if(binding.awayRequested&&typeof exec.concludeTurn!=='function')throw Error('当前DSH不支持安全结束离开回合');
                const saved=await saveHandoff(binding.control,agent,{reason:binding.awayRequested?'user-away':'manual',summary:args.summary,unfinished:args.unfinished});
                const committed=await binding.control('commit',saved);binding.handoffPending=true;
                if(binding.awayRequested&&committed.departed){binding.departed=true;binding.replyPending=false;exec.concludeTurn();}
                return {result:{saved:true,id:saved.id,nextAction:promptText(binding,binding.departed?'absence.saved':'runtime.5')}};
              }
              const concludes=terminal(definition.name)&&(!continuous||definition.name==='qq_no_reply');
              if(concludes&&(typeof exec.concludeTurn!=='function'||!agent.session.surface||typeof agent.session.append!=='function'))throw Error('此DSH版本不支持结束回合与投递回执，请更新DSH');
              const response=await fetch(callback.url,{method:'POST',redirect:'error',
                headers:{'Content-Type':'application/json',Authorization:'Bearer '+callback.token},
                body:JSON.stringify({sessionId,runId,callId:continuous?`${binding.turn}:${exec.callId}`:String(exec.callId),tool:definition.name,args}),
                signal:AbortSignal.any([exec.signal,AbortSignal.timeout(continuous?CONTINUOUS_TOOL_TIMEOUT_MS:20000)])}).catch(error=>{
                  this.invalidate(binding);throw Error('QQ宿主连接失效，回合已停止授权，等待结束确认',{cause:error});
                });
              const value=await response.json();
              if(!response.ok||value.error)throw Error(value.error??'QQ宿主拒绝工具调用');
              if(definition.name==='qq_wait_for_messages'&&value.result?.reason==='user-away')binding.awayRequested=true;
              // A receipt resolves the routing decision, including failed/unknown
              // sends. Those outcomes must not trigger an automatic resend.
              if(continuous&&terminal(definition.name)&&definition.name!=='qq_no_reply'&&
                (value.result?.sent===true||value.result?.messages?.length))binding.replyPending=false;
              if(definition.name==='qq_wait_for_messages'&&value.result?.reason==='handoff')binding.handoffPending=false;
              if(value.memoryContext!==undefined){
                validateMemoryContext(value.memoryContext);
                if(binding.memoryContext===undefined)throw Error('本轮没有绑定记忆上下文');
                binding.memoryContext=value.memoryContext;
                delete value.memoryContext; // Host context is never displayed as a tool result.
              }
              if(value.images?.length){
                if(!this.ctx.attachments)throw Error('DSH图片附件服务未就绪');
                value.images=await this.ctx.attachments.admitPromptContent(value.images);
              }
              if(concludes){
                if(definition.name!=='qq_no_reply'&&!value.result?.duplicate)binding.calls.add(String(exec.callId));
                exec.concludeTurn();
              }
              return value;
            }
          })));
        }
      }catch(error){this.drop(binding);throw error;}
    }else if(binding.invalidated)throw Error('QQ执行回合已失效，等待结束确认');
    else if(JSON.stringify(promptRules)!==JSON.stringify(binding.promptRules))throw Error('不能在活动回合替换提示词配置');
    else if(continuous!==binding.continuous||JSON.stringify(allowed)!==JSON.stringify(binding.allowed)||callback.url!==binding.callback.url||callback.token!==binding.callback.token||memoryContext?.skill!==binding.memoryContext?.skill)throw Error('不能替换本轮工具授权');
    if(memoryContext!==undefined)binding.memoryContext=memoryContext;
    if(binding.ids.has(requestId))throw Error('执行请求已提交，禁止重复投递');
    binding.ids.add(requestId);
    let dispatchStarted=false;
    try{
      const admitted=this.ctx.attachments?await this.ctx.attachments.admitPromptContent(content):content;
      if(this.bindings.get(sessionId)!==binding||this.ctx.agents.get(sessionId)!==agent)throw Error('执行请求在附件准备期间失效');
      const message={id:requestId,role:'user',source:{kind:'plugin:qq-rsi-native',runId,rpcId:requestId},content:admitted};
      onDispatch();dispatchStarted=true;agent[mode==='steer'?'steer':'followup'](message);
    }catch(error){if(dispatchStarted)this.invalidate(binding);else this.drop(binding);throw error;}
    return {accepted:true,requestId,source:'plugin:qq-rsi-native'};
  }
  release(request){
    // Reuse the existing remote entry so an already-loaded stable loader can
    // adopt this runtime without a DSH-wide restart or a newly registered RPC.
    if(request?.results!==undefined)return this.delivery(request);
    const {sessionId,runId,action='finish'}=request;
    if(!['finish','renew','invalidate','status'].includes(action))throw Error('回合控制操作无效');
    const binding=this.bindings.get(sessionId);
    if(!binding){
      if(action==='renew')throw Error('QQ执行回合已失效，无法续期');
      return {released:true,terminal:this.ctx.agents.get(sessionId)?.status==='idle'};
    }
    if(binding.runId!==runId)throw Error('执行请求不匹配');
    if(action!=='finish'&&request.token!==binding.callback.token)throw Error('回合控制授权无效');
    if(action==='renew'){this.renew(binding);return {renewed:true};}
    if(action==='status')return {released:false,terminal:this.terminal(binding),invalidated:!!binding.invalidated};
    if(action==='invalidate'||!this.terminal(binding)){
      this.invalidate(binding);return {released:!this.bindings.has(sessionId),terminal:this.terminal(binding)};
    }
    if(binding.calls.size){
      for(const [key,value] of this.receipts)if(value.expires<Date.now())this.receipts.delete(key);
      if(this.receipts.size>=64)this.receipts.delete(this.receipts.keys().next().value);
      this.receipts.set(runId,{...binding,expires:Date.now()+600000,done:new Map()});
    }
    this.drop(binding);return {released:true,terminal:true};
  }
  terminal(binding){return binding.agent.status==='idle'||!!binding.started&&binding.activeTurns.size===0;}
  renew(binding){
    if(binding.invalidated)throw Error('QQ执行回合已失效，无法续期');
    clearTimeout(binding.timer);binding.expires=Date.now()+RUN_LEASE_MS;
    binding.timer=setTimeout(()=>this.invalidate(binding),RUN_LEASE_MS);binding.timer.unref?.();
  }
  invalidate(binding){
    if(this.bindings.get(binding.sessionId)!==binding)return;
    if(binding.invalidated){if(this.terminal(binding))this.drop(binding);return;}
    binding.invalidated=true;clearTimeout(binding.timer);
    if(this.terminal(binding)){this.drop(binding);return;}
    // Revoke writes immediately, but keep the names until DSH acknowledges end.
    try{Promise.resolve(binding.agent.cancel?.({kind:'user'})).catch(()=>{});}catch{}
  }
  delivery({sessionId,runId,token,results}){
    const receipt=this.receipts.get(runId);
    if(!receipt||receipt.sessionId!==sessionId||receipt.callback.token!==token||receipt.expires<Date.now())throw Error('投递回执不属于有效执行请求');
    if(!Array.isArray(results)||results.length>32||JSON.stringify(results).length>200000)throw Error('投递回执格式无效');
    for(const row of results){
      if(!receipt.calls.has(row.callId)||!Array.isArray(row.messages)||row.messages.length>16||row.messages.some(m=>
        !['sent','failed','unknown','not_sent'].includes(m.state)||typeof m.text!=='string'||m.text.length>50000||
        (m.qqMessageId!==undefined&&typeof m.qqMessageId!=='string')))throw Error('投递回执内容无效');
    }
    for(const row of results){
      const fingerprint=JSON.stringify(row);
      if(receipt.done.has(row.callId)){if(receipt.done.get(row.callId)!==fingerprint)throw Error('回执已确认，不能改写');continue;}
      const session=receipt.agent.session;
      const original=receipt.results.get(row.callId);
      if(!original||!session.surface.nodes.includes(original.seq))throw Error('原工具结果不在当前会话中，未修改历史');
      const labels={sent:'已发送',failed:'发送失败',unknown:'发送结果未知（不会自动重试）',not_sent:'未发送'};
      const text=row.messages.length?row.messages.map(m=>labels[m.state]+(m.qqMessageId?' · QQ消息 '+m.qqMessageId:'')+'\n'+m.text).join('\n\n'):'未发送任何QQ消息。';
      session.append('tool/result',{...original.data,message:{...original.data.message,content:[{type:'text',text:'QQ实际投递回执\n'+text}]}},
        {surfaceOp:{op:'replace',startSeq:original.seq,endSeq:original.seq},sourceEventSeqs:[original.seq]});
      receipt.done.set(row.callId,fingerprint);
    }
    return {recorded:true};
  }
  drop(binding){
    if(this.bindings.get(binding.sessionId)!==binding)return;
    clearTimeout(binding.timer);this.bindings.delete(binding.sessionId);
    for(const dispose of binding.disposers.reverse())dispose();
  }
  dispose(){for(const binding of [...this.bindings.values()])this.drop(binding);this.receipts.clear();this.scheduleRouter.dispose();}
}
