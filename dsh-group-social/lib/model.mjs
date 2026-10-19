import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm';

export function selectGroupModel(defaultSelection, options={}) {
  const hasOverride=options.modelProvider!==undefined||options.modelId!==undefined;
  if(!hasOverride)return {...defaultSelection};
  if(typeof options.modelProvider!=='string'||!options.modelProvider.trim()||typeof options.modelId!=='string'||!options.modelId.trim()) {
    throw Error('Group model override requires both modelProvider and modelId');
  }
  return {provider:options.modelProvider,model:options.modelId,
    ...(options.reasoningEffort?{reasoningEffort:options.reasoningEffort}:{})};
}

export async function generate(ctx, system, input, signal, options={}) {
  const route=selectGroupModel(ctx.agentDefaultModel.currentSelection(),options);
  const prepared=await ctx.llm.prepareCall(route,signal,(_controls,model)=>{
    const effort=route.reasoningEffort??model.reasoning?.efforts?.[0]?.id;
    return {maxTokens:2400,...(effort?{reasoningEffort:effort}:{})};
  });
  let text='';
  const request={...prepared.config,tools:[],
    sessionId:'companion-group-social-100000003',signal,
    messages:[createSystemMessage(system),createUserMessage({source:{kind:'plugin:companion-group-social'},content:[{type:'text',text:input}]})]};
  for await(const chunk of prepared.stream(request)){
    if(chunk.type==='text-delta')text+=chunk.text;
    if(chunk.type==='finish'&&chunk.reason?.kind==='error')throw Error(chunk.reason.failure?.message??JSON.stringify(chunk.reason));
    if(chunk.type==='finish'&&chunk.reason?.kind==='aborted')throw Error('Group model call aborted');
  }
  if(!text.trim())throw Error('Group model returned no text');
  options.onSuccess?.({provider:prepared.config.provider,model:prepared.config.model,
    ...(prepared.config.reasoningEffort?{reasoningEffort:prepared.config.reasoningEffort}:{})});
  return text;
}
