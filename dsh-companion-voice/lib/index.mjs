import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {readApiConfig,publicApiConfig} from './mimo-api.mjs';
import { VOICE_HOOK,defaults,ownerSession,preferenceAllowed,readPolicy,writeMode,createTransport } from './core.mjs';
export const name='companion-voice';
export const inject=['tools','systemPrompt'];
export function apply(ctx,config={}){
 const workspace=config.workspace??'D:/qq-bot-dsh/dsh-companion';
 const policyFile=path.join(workspace,'.memory','voice.json');
 const runtime=config.runtime??'C:/Users/YOUR_USER/.dsh/media/onebot/companion-voice';
 fs.mkdirSync(runtime,{recursive:true});
 if(!fs.existsSync(policyFile)){fs.mkdirSync(path.dirname(policyFile),{recursive:true});fs.writeFileSync(policyFile,JSON.stringify(defaults,null,2)+'\n')}
 const audit=event=>fs.appendFileSync(path.join(runtime,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),...event})+'\n');
 const statusFile=path.join(runtime,'status.json');
 const apiConfigFile=path.join(workspace,'.runtime','voice-api.private.json');
 const transport=createTransport({policyFile,runtime,apiConfigFile,script:path.join(path.dirname(fileURLToPath(import.meta.url)),'tts.ps1'),audit});
 if(globalThis[VOICE_HOOK])throw Error('A companion voice transport is already registered');
 globalThis[VOICE_HOOK]=transport;
 ctx.effect(()=>()=>{if(globalThis[VOICE_HOOK]===transport){delete globalThis[VOICE_HOOK];fs.writeFileSync(statusFile,JSON.stringify({mounted:false,pid:process.pid,stoppedAt:new Date().toISOString()}))}});
 ctx.systemPrompt.context({name:'companion-voice-choice',order:-165,text:context=>{
  if(!ownerSession(String(context?.agent?.session?.id??'')))return '';
  const p=readPolicy(policyFile);
  return [
   'QQ 私聊支持中文语音消息。你可以根据聊天情境自主选择打字或语音；语音消息与打电话是两回事，此功能不允许自行拨电话。',
   `当前回复偏好：${p.mode}；语音最长 ${p.maxCharacters} 字。auto 模式北京时间 ${p.quietHours.start}:00–${p.quietHours.end}:00 默认打字。`,
   '短问候、闲聊和情绪表达可以用语音，不必每条都发语音。路径、代码、链接、步骤、长解释和精确信息用文字。用户明确指定的形式优先；不方便听、休息或要求停止时尊重用户。',
   '选择语音时，只在最终回复输出 [[qq_voice]]正文[[/qq_voice]]，由 QQ 出站通道合成并发送一条语音；控制标记不会发给对方。成功时不会重复发送相同文字。',
   '普通文字直接正常输出。执行中的进度、工具调用说明和审批提示都用文字；不要在它们上使用语音标记。',
   '收到 [语音] 而尚未出现语音转写时，表示后台正在识别。先等待后续“（语音转写：...）”再针对内容回复，不要立即断言听不到或要求用户重新发送。',
   '用户要求长期只打字、只发语音或恢复自主选择时，调用 qq_voice_preferences 设置 text、voice 或 auto。只有用户明确要求时才修改这个偏好。',
   '已经选择语音标记就不要再调用 qq_send_voice，否则会重复发送。语音预处理失败会自动退回文字；发送结果未知不会自动重发。',
  ].join('\n');
 }});
 const output={schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
 const allowed=exec=>{if(!preferenceAllowed(String(exec?.agent?.session?.id??'')))throw Error('此会话没有修改私人语音偏好的权限')};
 ctx.tools.register(defineTool({name:'qq_voice_status',description:'查看私人 QQ 回复语音是否可用、当前文字/语音偏好；不发送任何消息。',parameters:{},output,isConcurrencySafe:()=>true,execute:async(_args,exec)=>{allowed(exec);return {policy:readPolicy(policyFile),api:publicApiConfig(readApiConfig(apiConfigFile)),calls_enabled:false}}}));
 ctx.tools.register(defineTool({name:'qq_voice_preferences',description:'仅在用户明确要求时修改回复形式：auto=自主选择、text=只打字、voice=优先语音。技术信息仍用文字；不拨电话。',parameters:{mode:{type:'string',required:true,enum:['auto','text','voice']}},output,isConcurrencySafe:()=>false,execute:async(args,exec)=>{allowed(exec);return {policy:writeMode(policyFile,args.mode)}}}));
 fs.writeFileSync(statusFile,JSON.stringify({mounted:true,pid:process.pid,executable:process.execPath,mountedAt:new Date().toISOString(),policyFile,tools:['qq_voice_status','qq_voice_preferences'],voiceHookRegistered:globalThis[VOICE_HOOK]===transport},null,2));
 ctx.logger.info('Companion voice loaded: model-selected voice messages; owner private chat only; no calls.');
}
