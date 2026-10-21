import {randomUUID} from 'node:crypto';

// Wrap the installed compaction service only for this bound Agent. No installed
// DSH files, session IDs or original log events are changed by this adapter.
const hooks=new WeakMap();
export const HANDOFF_SUMMARY_PROMPT='这是QQ持续对话的压缩交接摘要，不是向QQ发送消息。请在压缩摘要中详细保留：1.群聊/私聊与当前人格、相关人物的稳定对应；2.此前话题的起因、演变、最近对话及更正，谁在对谁说话；3.已执行动作及实际成功/失败/未知回执，不能把计划写成已完成；4.未完成事项、承诺、待确认信息、子任务与下一步，已结束的明确结束；5.当前角色状态及真实世界模拟，区分角色推演和现实事实；6.最近已展示但尚未回应的消息。保留足够具体的内容，使压缩后自然接话，不逐条补答历史，不重复发送。不要输出隐含思考。完整公开原文已由宿主归档，可通过qq_handoff读取。压缩后先qq_wait_for_messages接收交接，再继续处理新消息。';
export function hookCompaction(engine,agent,run){
  if(typeof engine?.compactRegion!=='function')throw Error('当前DSH不支持压缩交接接口');
  let hook=hooks.get(engine);
  if(!hook){
    const original=engine.compactRegion,handlers=new Map();
    const wrapped=async function(start,end,target,signal){
      const handler=handlers.get(target);
      return handler?handler({start,end,signal,compact:()=>original.call(this,start,end,target,signal)}):original.call(this,start,end,target,signal);
    };
    const summarize=engine.summarize;
    const summaryWrapper=typeof summarize==='function'?function(input,target,signal){
      if(handlers.has(target))input={...input,messages:[...input.messages,{role:'user',content:[{type:'text',text:HANDOFF_SUMMARY_PROMPT}]}]};
      return summarize.call(this,input,target,signal);
    }:null;
    hook={original,wrapped,handlers,summarize,summaryWrapper};hooks.set(engine,hook);engine.compactRegion=wrapped;
    if(summaryWrapper)engine.summarize=summaryWrapper;
  }
  if(hook.handlers.has(agent))throw Error('此会话已有压缩交接绑定');
  hook.handlers.set(agent,run);
  return ()=>{hook.handlers.delete(agent);if(!hook.handlers.size){if(engine.compactRegion===hook.wrapped)engine.compactRegion=hook.original;if(engine.summarize===hook.summaryWrapper)engine.summarize=hook.summarize;hooks.delete(engine);}};
}

export function publicEvents(log){
  return [...log].filter(e=>['user/message','assistant/message','tool/call','tool/result','subagent/catalog','compaction/summary'].includes(e.type)).map(e=>{
    const data=e.data??{},message=data.message??data;
    if(e.type==='tool/call')return {seq:e.seq,time:e.time,type:e.type,turn:data.turn,name:data.name,callId:data.callId,args:data.args??data.arguments};
    if(e.type==='subagent/catalog')return {seq:e.seq,time:e.time,type:e.type,turn:data.turn,childId:data.childId,state:data.state};
    return {seq:e.seq,time:e.time,type:e.type,turn:data.turn,compactionId:data.compactionId,
      message:{id:message.id,source:message.source,callId:message.callId,isError:message.isError,
        content:(message.content??data.summary??[]).filter(p=>p.type==='text').map(p=>({type:'text',text:p.text}))}};
  });
}

export async function saveHandoff(control,agent,{reason='manual',summary='',unfinished=[],metadata={}}={}){
  const id='handoff-'+randomUUID();
  const events=publicEvents(agent.session.log);
  // Keep the complete public history, not hidden reasoning/provider payloads.
  const text=JSON.stringify({events,unfinished,summary}),chunkSize=40000,parts=Math.ceil(text.length/chunkSize);
  await control('begin',{id,reason,metadata});
  for(let index=0;index<parts;index++)await control('part',{id,index,text:text.slice(index*chunkSize,(index+1)*chunkSize)});
  return {id,parts,unfinished,summary};
}
