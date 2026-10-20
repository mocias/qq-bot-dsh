import {VERSION,PROTOCOL,BUILD_ID,DEFINITIONS,names} from './schema.mjs';

export class NativeRuntime{
  constructor(ctx,defineTool){this.ctx=ctx;this.defineTool=defineTool;this.bindings=new Map();}
  probe(){return {version:VERSION,protocol:PROTOCOL,buildId:BUILD_ID,active:this.bindings.size};}
  async submit(request){
    const {sessionId,runId,requestId,mode,content,callback,allowed,version,protocol,buildId}=request??{};
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
      binding={runId,sessionId,agent,callback,allowed,ids:new Set(),claimed:false,disposers:[],expires:Date.now()+240000};
      this.bindings.set(sessionId,binding);
      binding.timer=setTimeout(()=>this.drop(binding),240000);binding.timer.unref?.();
      try{
        binding.disposers.push(agent.ctx.tools.presentAs('native'));
        binding.disposers.push(agent.ctx.on('agent/inbox/claimed',({message})=>{
          binding.claimed=message.source?.kind==='plugin:qq-rsi-native'&&message.source?.runId===runId;
        }));
        for(const definition of DEFINITIONS.filter(t=>allowed.includes(t.name))){
          binding.disposers.push(agent.ctx.tools.register(this.defineTool({...definition,
            output:{schema:{type:'json'},render:(_args,value)=>[
              {type:'text',text:JSON.stringify(value.result??value)},
              ...(value.images??[])
            ]},
            isConcurrencySafe:()=>false,
            execute:async(args,exec)=>{
              if(this.bindings.get(sessionId)!==binding||!binding.claimed||Date.now()>binding.expires||exec.agent!==agent||exec.signal.aborted)throw Error('工具不属于有效的QQ执行回合');
              const response=await fetch(callback.url,{method:'POST',redirect:'error',
                headers:{'Content-Type':'application/json',Authorization:'Bearer '+callback.token},
                body:JSON.stringify({sessionId,runId,callId:String(exec.callId),tool:definition.name,args}),
                signal:AbortSignal.any([exec.signal,AbortSignal.timeout(20000)])});
              const value=await response.json();
              if(!response.ok||value.error)throw Error(value.error??'QQ宿主拒绝工具调用');
              if(value.images?.length){
                if(!this.ctx.attachments)throw Error('DSH图片附件服务未就绪');
                value.images=await this.ctx.attachments.admitPromptContent(value.images);
              }
              return value;
            }
          })));
        }
      }catch(error){this.drop(binding);throw error;}
    }else if(JSON.stringify(allowed)!==JSON.stringify(binding.allowed)||callback.url!==binding.callback.url||callback.token!==binding.callback.token)throw Error('不能替换本轮工具授权');
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
  release({sessionId,runId}){
    const binding=this.bindings.get(sessionId);if(!binding)return {released:true};
    if(binding.runId!==runId)throw Error('执行请求不匹配');
    this.drop(binding);return {released:true};
  }
  drop(binding){
    if(this.bindings.get(binding.sessionId)!==binding)return;
    clearTimeout(binding.timer);this.bindings.delete(binding.sessionId);
    for(const dispose of binding.disposers.reverse())dispose();
  }
  dispose(){for(const binding of [...this.bindings.values()])this.drop(binding);}
}
