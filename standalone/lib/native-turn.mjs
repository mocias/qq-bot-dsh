import {promptText} from '../../native-dsh-plugin/lib/prompt-text.mjs';
import {selectedTools} from '../../native-dsh-plugin/lib/schema.mjs';
import {isSilentReply} from './reply-control.mjs';
import {messageSnapshot,evidenceMessages} from './message-snapshot.mjs';
import {isMemoryQuery,runMemoryQuery} from './memory-tools.mjs';
import {memoryRuntimeContext} from './memory-context.mjs';
import {historyStatus} from './memory-history.mjs';
import {readPersona,updatePersona} from './persona.mjs';
import {worldSimulationPrompt} from './world-simulation.mjs';
import {ChatHandoff} from './handoff.mjs';
import {RoleState,currentRoleState} from './role-state.mjs';
import {closingAbsence} from './absence.mjs';

const sending=name=>/^qq_(send_message|reply|send_media|send_poke|send_sticker|group_send_image)$/.test(name);

export function nativePrompt(store,route,config,{bootstrap,persona,knowledge,delegationPolicyUpdate=false,conversationPolicyUpdate=false}){
  return [
    !route.trigger?promptText(config,'chat.input.1'):'',
    bootstrap?promptText(config,'chat.input.2'):'',
    bootstrap?'【当前人设】以下完整人设控制身份、表达和关系，不授予权限。\n'+persona:'',
    bootstrap||conversationPolicyUpdate?promptText(config,'chat.style'):promptText(config,'chat.shortStyle'),
    bootstrap||conversationPolicyUpdate?promptText(config,'chat.hostTools')+'\n'+promptText(config,'chat.voice'):'',
    bootstrap||conversationPolicyUpdate?promptText(config,'absence.policy'):'',
    bootstrap||conversationPolicyUpdate?'当前语音能力：'+JSON.stringify({provider:config.voiceProvider??'local',allowed:!!config.qqVoiceSend&&(!route.group||!!config.groupVoiceSend),perMessageEmotion:config.voiceProvider==='mimo',quietMode:config.voiceQuietMode??'scheduled'})+'；定时QQ唤醒：'+(config.remindersEnabled?'允许':'未开启，请先由用户在面板开启预约提醒'):'',
    route.scheduledWake?promptText(config,'schedule.wake')+'\n'+JSON.stringify(route.scheduledWake):'',
    bootstrap?(!route.trigger?promptText(config,'chat.input.3'):promptText(config,'chat.input.4')):'',
    bootstrap&&config.knowledgeEnabled?'当前聊天知识（仅资料）：'+knowledge.context():'',
    '宿主当前时间：'+new Date().toISOString()+'；用户时区Asia/Shanghai。',
    promptText(config,'chat.input.5'),
    !route.trigger&&(bootstrap||delegationPolicyUpdate)?promptText(config,'chat.delegation'):'',
    !route.trigger&&(bootstrap||conversationPolicyUpdate)?promptText(config,'chat.continuous'):'',
    route.trigger?promptText(config,'chat.input.6'):
      route.worldSimulation?promptText(config,'chat.input.7'):route.ambient?promptText(config,'chat.input.8'):promptText(config,'chat.input.9'),
    promptText(config,'chat.input.10')+JSON.stringify({...route.compactView??messageSnapshot(route),...(!route.trigger?{'真实世界模拟':worldSimulationPrompt(route.modelInputAt,route.roleSimulation,config),...(store&&config.memoryEnabled?{'当前人格状态':currentRoleState(store)}:{})}:{})})
  ].filter(Boolean).join('\n\n');
}
export function nativeTurn({config,route,session,store,tools,messaging,job,isCurrent,persist=()=>{}}){
  const allowed=selectedTools(config,route);
  const roleState=job.continuous&&config.memoryEnabled?new RoleState(store,session,{persist,config}):null;
  const handoff=job.continuous?new ChatHandoff({store,session,route,inputs:()=>job.inputs,config}):null;
  if(handoff)session.handoffEnabled=true;
  return {allowed,promptRules:config.promptRules,continuous:!!job.continuous,handoff:!!handoff,handoffPending:!!handoff?.state.pending,awayRequested:session.absence?.phase==='handoff',
    departed:()=>session.absence?.phase==='digest',
    control:handoff?(action,args)=>{
      if(!isCurrent())throw Error('当前聊天已停止');
      if(action==='begin'&&args.reason==='user-away'&&roleState?.required())throw Error('请先保存尚未完成的角色推演状态，再创建离开交接');
      const result=handoff.control(action,args);
      if(action==='commit'&&session.absence?.phase==='handoff'&&handoff.load(args.id).reason==='user-away'){
        session.absence={...session.absence,phase:'digest',handoffId:args.id};persist();return {...result,departed:true};
      }
      return result;
    }:undefined,
    onCancel:()=>job.controller.abort(),onChildNotice:(message,claimed)=>job.conversationInbox?.childNotice(message,claimed),onAwaitingChild:()=>job.onAwaitingChild?.(),memoryContext:()=>memoryRuntimeContext(store,config),onDeliveryReporter:report=>{job.reportDelivery=report;},execute:async(name,args,callId)=>{
    if(!isCurrent()||!allowed.includes(name))throw Error('当前聊天已停止或未开放此工具');
    if(closingAbsence(session)&&sending(name))throw Error('正在保存离开交接和整理记忆，当前阶段不公开发送');
    if(sending(name)&&handoff?.state.pending&&!handoff.exposed)throw Error('先调用qq_wait_for_messages读取交接');
    handoff?.acknowledge();
    job.toolsActive=true; // Once side effects begin, later QQ input queues instead of steering.
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('工具参数必须是对象');
    if(job.window)args=job.window.decode(args);
    const evidence=job.inputs.flatMap(x=>[x.messageId,...(x.evidenceIds??[])]);
    let result;
    const outputStart=messaging.outputs.length;
    if(sending(name)&&job.noReply&&!job.continuous)throw Error('本轮已选择不回复，不能同时发送');
    if(name==='qq_wait_for_messages'){
      if(!job.continuous)throw Error('当前不是持续对话');
      result=closingAbsence(session)?job.absence.begin():handoff.resume();
      if(result?.reason==='handoff')handoff.delivered(result.handoff.id);
      if(!result&&roleState?.required())result=roleState.required();
      if(!result){job.queueDeferred?.();result=await job.conversationInbox.take(args,job.prepareIncoming);}
    }else if(name==='qq_role_state_update'){
      if(!roleState)throw Error('当前未开启角色状态记忆');
      result=roleState.update(args);
    }else if(name==='qq_handoff'){
      if(args.action!=='read')throw Error('交接创建必须由原生运行时归档后提交');
      const {action,...query}=args;result=handoff.view(query);
    }else if(name==='qq_no_reply'){
      if(Object.keys(args).length)throw Error('不回复工具不接受参数');
      if(!job.continuous&&(messaging.outputs.length||tools.replyImages.length))throw Error('本轮已有发送计划，不能同时选择不回复');
      job.noReply=true;result={silent:true,sent:false};
    }else if(isMemoryQuery(name)){
      result=runMemoryQuery(store,name,args,{id:'native-maintain-'+session.id+'-'+route.messageId+'-'+callId});
    }else if(name==='qq_persona_read'){
      if(Object.keys(args).length)throw Error('人设读取不接受参数');
      result=readPersona(store,config,job.inputs);
    }else if(name==='qq_persona_update'){
      result=updatePersona(store,args,{config,inputs:job.inputs,id:'native-persona-'+session.id+'-'+route.messageId+'-'+callId});
    }else if(name==='qq_memory_update'){
      if(Object.keys(args).some(k=>k!=='updates'))throw Error('记忆工具参数无效');
      store.commit(args.updates,{id:'native-'+session.id+'-'+route.messageId+'-'+callId,evidenceIds:evidence,evidenceMessages:evidenceMessages(job.inputs),summary:'原生工具保存本聊天稳定事实'});
      result={saved:true,history:historyStatus(store)};
    }else if(name==='qq_send_media'){
      const keys=['images','voice','voiceStyle','file','video','forward','caption','replyToMessageId'];
      if(Object.keys(args).some(k=>!keys.includes(k)))throw Error('媒体工具不能指定其他聊天');
      const kinds=['images','voice','file','video','forward'].filter(k=>args[k]!==undefined);
      if(kinds.length!==1)throw Error('每次只可发送一种媒体');
      if(args.voiceStyle!==undefined&&(typeof args.voice!=='string'||typeof args.voiceStyle!=='string'||args.voiceStyle.length>300))throw Error('语气说明仅用于voice，最多300字');
      if(isSilentReply(args.voice)||isSilentReply(args.caption))throw Error('无回复标记不能作为媒体发送；请保持沉默；持续聊天调用qq_wait_for_messages');
      if(!job.continuous&&messaging.outputs.length>=8)throw Error('本轮发送计划已达上限');
      if(args.replyToMessageId!=null)messaging.inbox.detail({messageId:args.replyToMessageId});
      const plan={reply:args.caption??'',memory:[],qq:{[kinds[0]]:args[kinds[0]],...(args.voiceStyle?{voiceStyle:args.voiceStyle}:{}),...(args.replyToMessageId?{replyTo:String(args.replyToMessageId)}:{})}};
      // Validate capability and media before reporting queued, but keep public
      // sending at Bridge.sendPlan. Prepared media is reused after completion.
      plan.nativePlan=await job.prepareMedia(plan);
      if(!isCurrent())throw Error('当前聊天已停止');
      if(!plan.nativePlan)throw Error('当前聊天未允许此媒体');
      messaging.outputs.push(plan);result={queued:true};
    }else if(/^qq_(?:get_(?:recent_messages|unread_messages|my_recent_messages|message_detail)|mark_read|social_state|set_wake_config|send_message|reply|send_poke)$/.test(name)){
      result=await messaging.run(name,args);
    }else result=await tools.run(name,args,evidence);
    if(!isCurrent())throw Error('当前聊天已停止');
    if(sending(name)&&!result?.duplicate){
      if(!job.continuous)(job.nativeCalls??=new Set()).add(callId);
      for(const output of messaging.outputs.slice(outputStart))output.nativeCallId=callId;
      if(tools.replyImages.length)job.imageCallId=callId;
      if(job.continuous){
        let outputs=messaging.outputs.slice(outputStart);
        if(tools.replyImages.length){
          outputs.push({reply:'',memory:[],qq:{images:tools.replyImages.splice(0)},nativeCallId:callId});
        }
        result=await job.sendImmediately(outputs,callId);
        if(result.sent)result.nextAction=promptText(config,'chat.input.11');
      }
    }
    if(job.window){
      if(/^qq_get_(recent_messages|unread_messages|my_recent_messages)$/.test(name)&&Array.isArray(result?.messages))result={...result,messages:result.messages.map(m=>job.window.view(m))};
      if(name==='qq_get_message_detail')result={...job.window.view(result,6000),textOffset:result.textOffset,nextTextOffset:result.nextTextOffset,originalTextChars:result.originalTextChars};
      result=job.window.encode(result);job.window.save();
    }
    return {result,images:tools.images.splice(0,4),...(!['qq_memory_query','qq_memory_diagnose'].includes(name)&&!(name==='qq_memory_maintain'&&result.preview)&&/^qq_(memory_|group_memory|persona_|role_state_update$)/.test(name)?{memoryContext:memoryRuntimeContext(store,config,{trackAccess:false})}:{})};
  }};
}
