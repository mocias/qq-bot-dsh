import {VERSION,PROTOCOL,BUILD_ID,DEFINITIONS,names} from './schema.mjs';
import {Continuations,CONTINUOUS_TIMEOUT_MS} from './continuations.mjs';
const terminal=name=>/^qq_(send_message|reply|send_media|send_poke|send_sticker|group_send_image|no_reply)$/.test(name);
function validateMemoryContext(value){
  if(value===undefined)return;
  if(!value||typeof value.text!=='string'||typeof value.skill!=='string'||value.text.length>10000000||value.skill.length>50000||Object.keys(value).some(k=>!['text','skill'].includes(k)))throw Error('记忆运行时上下文无效');
}

export class NativeRuntime{
  constructor(ctx,defineTool){this.ctx=ctx;this.defineTool=defineTool;this.bindings=new Map();this.receipts=new Map();}
  probe(){return {version:VERSION,protocol:PROTOCOL,buildId:BUILD_ID,active:this.bindings.size};}
  async submit(request){
    const {sessionId,runId,requestId,mode,content,callback,allowed,version,protocol,buildId,memoryContext,continuous=false}=request??{};
    if(typeof continuous!=='boolean')throw Error('持续对话开关无效');
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
    let binding=this.bindings.get(sessionId);
    if(binding&&binding.runId!==runId)throw Error('会话已有其他执行请求');
    if(!binding){
      if(mode!=='queue'||agent.status!=='idle')throw Error('新执行请求必须从空闲会话开始');
      const lease=continuous?CONTINUOUS_TIMEOUT_MS+30000:240000;
      binding={runId,sessionId,agent,callback,allowed,memoryContext,continuous,continuations:new Continuations(),ids:new Set(),calls:new Set(),results:new Map(),claimed:false,disposers:[],expires:Date.now()+lease};
      this.bindings.set(sessionId,binding);
      binding.timer=setTimeout(()=>this.drop(binding),lease);binding.timer.unref?.();
      try{
        if(memoryContext!==undefined){
          if(typeof agent.ctx.systemPrompt?.context!=='function'||memoryContext.skill&&typeof agent.ctx.skills?.register!=='function')throw Error('DSH 缺少记忆运行时上下文或技能服务，请更新 DSH 与轻量插件');
          binding.disposers.push(agent.ctx.systemPrompt.context({name:'qq-rsi-memory',order:-200,required:true,interpolate:false,
            text:context=>context?.agent===agent&&binding.claimed&&this.bindings.get(sessionId)===binding?binding.memoryContext.text:''}));
          if(memoryContext.skill)binding.disposers.push(agent.ctx.skills.register({name:'qq-memory',description:'当前QQ聊天长期记忆：主动记住、查索引、读页、全文搜索和遗忘。',
            whenToUse:'回忆已有事实，学到稳定偏好、约定或人物关系，用户要求修正或遗忘时。',content:memoryContext.skill,source:'dsh-qq-rsi-native'}));
        }
        binding.disposers.push(agent.ctx.tools.presentAs('native'));
        binding.disposers.push(agent.ctx.on('agent/inbox/claimed',({message})=>{
          binding.claimed=message.source?.kind==='plugin:qq-rsi-native'&&message.source?.runId===runId||continuous&&binding.claimed&&binding.continuations.owns(message);
        }));
        binding.disposers.push(agent.ctx.on('session/event',(session,event)=>{
          if(continuous&&session===agent.session&&event.type==='turn/start')binding.turn=event.data.turn;
          if(continuous&&binding.claimed&&session===agent.session)binding.continuations.observe(event);
          if(binding.claimed&&session===agent.session&&event.type==='tool/result'&&binding.calls.has(event.data.message.callId)&&!binding.results.has(event.data.message.callId)&&!event.data.message.isError)
            binding.results.set(event.data.message.callId,event);
        }));
        for(const definition of DEFINITIONS.filter(t=>allowed.includes(t.name))){
          binding.disposers.push(agent.ctx.tools.register(this.defineTool({...definition,
            ...(continuous&&terminal(definition.name)?{description:definition.description+' 当前为持续对话：发送工具立即投递并返回逐条实际结果，不结束本轮；qq_no_reply只结束当前发言阶段，保留已发消息。普通正文不向QQ投递。'}:{}),
            output:{schema:{type:'json'},render:(_args,value)=>[
              {type:'text',text:JSON.stringify(value.result??value)},
              ...(value.images??[])
            ]},
            isConcurrencySafe:()=>false,
            execute:async(args,exec)=>{
              if(this.bindings.get(sessionId)!==binding||!binding.claimed||Date.now()>binding.expires||exec.agent!==agent||exec.signal.aborted)throw Error('工具不属于有效的QQ执行回合');
              const concludes=terminal(definition.name)&&(!continuous||definition.name==='qq_no_reply');
              if(concludes&&(typeof exec.concludeTurn!=='function'||!agent.session.surface||typeof agent.session.append!=='function'))throw Error('此DSH版本不支持结束回合与投递回执，请更新DSH');
              const response=await fetch(callback.url,{method:'POST',redirect:'error',
                headers:{'Content-Type':'application/json',Authorization:'Bearer '+callback.token},
                body:JSON.stringify({sessionId,runId,callId:continuous?`${binding.turn}:${exec.callId}`:String(exec.callId),tool:definition.name,args}),
                signal:AbortSignal.any([exec.signal,AbortSignal.timeout(continuous?CONTINUOUS_TIMEOUT_MS:20000)])});
              const value=await response.json();
              if(!response.ok||value.error)throw Error(value.error??'QQ宿主拒绝工具调用');
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
    }else if(continuous!==binding.continuous||JSON.stringify(allowed)!==JSON.stringify(binding.allowed)||callback.url!==binding.callback.url||callback.token!==binding.callback.token||memoryContext?.skill!==binding.memoryContext?.skill)throw Error('不能替换本轮工具授权');
    if(memoryContext!==undefined)binding.memoryContext=memoryContext;
    if(binding.ids.has(requestId))throw Error('执行请求已提交，禁止重复投递');
    binding.ids.add(requestId);
    try{
      const admitted=this.ctx.attachments?await this.ctx.attachments.admitPromptContent(content):content;
      if(this.bindings.get(sessionId)!==binding||this.ctx.agents.get(sessionId)!==agent)throw Error('执行请求在附件准备期间失效');
      const message={id:requestId,role:'user',source:{kind:'plugin:qq-rsi-native',runId,rpcId:requestId},content:admitted};
      agent[mode==='steer'?'steer':'followup'](message);
    }catch(error){this.drop(binding);throw error;}
    return {accepted:true,requestId,source:'plugin:qq-rsi-native'};
  }
  release(request){
    // Reuse the existing remote entry so an already-loaded stable loader can
    // adopt this runtime without a DSH-wide restart or a newly registered RPC.
    if(request?.results!==undefined)return this.delivery(request);
    const {sessionId,runId}=request;
    const binding=this.bindings.get(sessionId);if(!binding)return {released:true};
    if(binding.runId!==runId)throw Error('执行请求不匹配');
    if(binding.calls.size){
      for(const [key,value] of this.receipts)if(value.expires<Date.now())this.receipts.delete(key);
      if(this.receipts.size>=64)this.receipts.delete(this.receipts.keys().next().value);
      this.receipts.set(runId,{...binding,expires:Date.now()+600000,done:new Map()});
    }
    this.drop(binding);return {released:true};
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
  dispose(){for(const binding of [...this.bindings.values()])this.drop(binding);this.receipts.clear();}
}
