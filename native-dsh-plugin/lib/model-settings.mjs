// Session-bound hooks: never mutate provider metadata or DSH's global selection.
// An unavailable model or an unsupported window degrades to the DSH default for
// this turn and reports a warning; it must never fail the whole QQ turn.
const compactionHooks=new WeakMap();
function checkWindow(info,size){
  const capacity=info?.context?.contextWindow;
  if(!Number.isSafeInteger(capacity))return {ok:false,reason:'模型未在 DSH 中声明上下文容量'};
  if(size>capacity)return {ok:false,reason:'超过模型声明容量 '+capacity};
  return {ok:true,info:{...info,context:{...info.context,contextWindow:size}}};
}
function limitedContext(info,size){const checked=checkWindow(info,size);return checked.ok?checked.info:info;}
export async function bindModelSettings(agent,engine,settings={},controller){
  const {provider='',model='',contextWindow=0}=settings;
  if(typeof provider!=='string'||typeof model!=='string'||!!provider!==!!model||!Number.isSafeInteger(contextWindow)||contextWindow<0||contextWindow>10000000)throw Error('模型与上下文配置无效');
  const warnings=[],none={dispose:()=>{},warnings};
  if(!provider&&!contextWindow)return none;
  const llm=agent.loopCtx?.llm??agent.ctx.llm;
  let size=contextWindow;
  if(provider){
    const models=await llm.listModels(provider);
    if(!models.some(x=>x.id===model)){warnings.push(`配置的模型 ${provider}/${model} 当前不可用，本次沿用 DSH 默认模型`);return none;}
  }
  // Resolve the model this window would apply to before installing hooks, so an
  // unsupported size is reported with the submit result instead of failing a turn.
  const target=provider?{provider,model}:typeof controller?.selectionFor==='function'?controller.selectionFor(agent)?.current:null;
  if(size&&target?.provider&&target?.model){
    const checked=checkWindow(await llm.resolveModelInfo(target.provider,target.model),size);
    if(!checked.ok){warnings.push(`上下文窗口 ${size} ${checked.reason}，本次沿用模型默认窗口`);size=0;}
  }else if(size){
    warnings.push(`无法确认${provider?' '+provider+'/'+model:'当前模型'}的上下文容量，本次沿用模型默认窗口`);size=0;
  }
  const disposers=[];
  try{
    if(size){
      if(typeof agent.prepareRequest!=='function'||typeof engine?.compactIfNeeded!=='function'){
        warnings.push('此 DSH 不支持会话独立上下文窗口，本次沿用模型默认窗口');
      }else{
        const original=agent.prepareRequest;
        const wrapped=async function(...args){
          const result=await original.apply(this,args);
          if(!result.preparedCall)return result;
          return {...result,preparedCall:limitedContext(result.preparedCall,size)};
        };
        agent.prepareRequest=wrapped;
        disposers.push(()=>{if(agent.prepareRequest===wrapped)agent.prepareRequest=original;});
        let hook=compactionHooks.get(engine);
        if(!hook){
          const original=engine.compactIfNeeded,limits=new Map();
          const wrapped=async function(target,...args){
            const size=limits.get(target);if(!size)return original.call(this,target,...args);
            const base=this.ctx.llm;
            const localLlm=new Proxy(base,{get:(obj,key)=>key==='resolveModelInfo'?async(...a)=>limitedContext(await obj.resolveModelInfo(...a),size):typeof obj[key]==='function'?obj[key].bind(obj):obj[key]});
            // Copy every own descriptor of the real engine (including non-enumerable
            // ones) and only swap ctx.llm, so the original implementation still reads
            // its own config, services and symbols.
            const receiver=Object.create(Object.getPrototypeOf(this));
            Object.defineProperties(receiver,Object.getOwnPropertyDescriptors(this));
            Object.defineProperty(receiver,'ctx',{value:new Proxy(this.ctx,{get:(obj,key)=>key==='llm'?localLlm:Reflect.get(obj,key)}),enumerable:true,writable:true,configurable:true});
            return original.call(receiver,target,...args);
          };
          hook={original,wrapped,limits};compactionHooks.set(engine,hook);engine.compactIfNeeded=wrapped;
        }
        hook.limits.set(agent,size);
        disposers.push(()=>{hook.limits.delete(agent);if(!hook.limits.size){if(engine.compactIfNeeded===hook.wrapped)engine.compactIfNeeded=hook.original;compactionHooks.delete(engine);}});
      }
    }
    if(provider){
      if(typeof controller?.selectForNextRequest!=='function')warnings.push('此 DSH 不支持会话独立模型选择，本次沿用 DSH 默认模型');
      else{
        const selected=await llm.resolveCallConfig({provider,model});
        controller.selectForNextRequest(agent,{provider:selected.provider,model:selected.model,...(selected.reasoningEffort===undefined?{}:{reasoningEffort:selected.reasoningEffort})});
      }
    }
    return {dispose:()=>{for(const dispose of disposers.reverse())dispose();},warnings};
  }catch(error){for(const dispose of disposers.reverse())dispose();throw error;}
}
