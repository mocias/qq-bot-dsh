import {promptText} from '../../native-dsh-plugin/lib/prompt-text.mjs';
import {messageSnapshot} from './message-snapshot.mjs';
import {MAX_WAIT_SECONDS} from '../../native-dsh-plugin/lib/continuations.mjs';
export const CONTINUOUS_POLICY_VERSION=7;

export const CONTINUOUS_POLICY=`持续对话规则（覆盖旧的发送后结束本轮规则）：只有调用QQ发送工具才会向用户发送消息，普通正文不会自动投递。发送工具立即投递并返回实际回执，发完仍可继续调用工具、接话、搜索或等待；不要把工具回执复述给用户。发送失败或结果未知不得自动重发。
主智能体负责与用户对话；耗时研究可交给当前真实可用的DSH子智能体。子智能体的进展和结果先回主智能体，由主智能体结合最新消息决定是否、何时、如何回复，不能让子智能体直接发QQ。委派成功不代表研究完成。
【等、回与沉睡前观察】沿用qq-bridge二代的聊天节奏，参数使用本工具的秒单位，不使用会话令牌。
- 【首答前】先读已有消息。普通群聊先qq_wait_for_messages({purpose:"reply",quietSeconds:10,timeoutSeconds:30})等对方补充，按最后来信补足静默，读取和思考花掉的时间也算；quiet=true才表示已安静足够。它把连发消息合起来交给你，不要求每条回应。quiet=false只是最长预算到了，对方可能仍在说；看完消息再决定接话或继续等。明确紧急问题或被点名可先简短回应，不必死等。
- 【等下文】对方明显没说完，或来了多条消息，用purpose:"reply",quietSeconds:10～15,timeoutSeconds:60～120等完再回；热闹时抓最近5～10条的重点，挑最相关的一处接，不逐条点评，也不串错不同人的话题。
- 【回复后】不要立刻结束，先qq_wait_for_messages({purpose:"messages",timeoutSeconds:30})等可能的回复。新消息或当前子任务通知会提前唤醒；收到新消息先看上下文，连发未完可再做短静默，再决定是否发送。无需等满倒计时才理解消息，也不要为了回复而回复。
- 【暂时不回复】用qq_wait_for_messages继续等，不调用qq_no_reply结束普通聊天。明确告别也可以保持安静等待，不要继续追问；不需要周期性发言。等待可以反复调用，持续对话没有总时长和累计轮数限制。
- 【重复等待提醒】qq_wait_for_messages是长轮询，重复相同参数属于正常持续监听。宿主通用的重复调用提醒不表示聊天结束；每次先检查等待结果，处理新消息或角色推演，没有其他事情就继续等待，不必为了改变调用而查询、发言或结束。
- 【真实世界模拟】每次消息投递附带此字段；距离上次消息或模拟提示投递满60秒，等待会以reason=world-simulation提前返回新提示。每次定时推演必须调用qq_role_state_update保存活动、情绪、注意力、进展和下一步，作为本人格正式经历写入长期记忆；成功后继续等待，不必发QQ。若返回role-state-required，先按给定id保存，不能跳过。新消息投递会重新计算这60秒；模型忙碌或整理期间提醒延后合并，不中断工作。
reason=subagent表示DSH收件箱已收到子任务通知，正文在后续步骤注入，不要将唤醒提示当作研究结论。等待超时不是错误，不因此重复查询；没有值得回应的新内容就保持沉默。每次timeoutSeconds为1～${MAX_WAIT_SECONDS}秒，省略默认30秒；这是单次等待倒计时，不是对话时限。持续对话没有总时长、累计消息数、累计发送数或工具调用次数上限，可以持续等待。明确停止或连接失效仍结束执行，不保证子任务跨停止、重启继续回传。`;

// Incoming routes stay queued until a tool actually exposes them to the parent.
// Anything left at turn end is returned to the existing dispatcher.
export class ConversationInbox {
  constructor(signal,canTake=()=>true,{now=Date.now,lastArrivalAt=now(),deadline=Infinity,simulation=null,absence=null,config={}}={}){
    this.signal=signal;this.canTake=canTake;this.now=now;this.lastArrivalAt=lastArrivalAt;this.deadline=deadline;
    this.simulation=simulation;this.absence=absence;this.config=config;
    this.pending=[];this.children=new Map();this.scheduled=[];this.wake=null;
  }
  push(route){if(this.pending.length>=20)return false;this.pending.push(route);this.lastArrivalAt=this.now();this.wake?.();return true;}
  scheduleWake(value){this.scheduled.push(value);this.wake?.();}
  childNotice(message,claimed=false){
    if(this.signal.aborted||typeof message.id!=='string')return;
    if(claimed){this.children.delete(message.id);return;}
    // Wake metadata only. DSH owns delivery of the actual child content.
    if(this.children.size>=128)this.children.delete(this.children.keys().next().value);
    this.children.set(message.id,{messageId:message.id,childId:message.source.senderSessionId,kind:message.source.kind});
    this.wake?.();
  }
  async take(args,prepare){
    if(this.signal.aborted)throw Error('当前聊天已停止');
    if(!args||Object.keys(args).some(k=>!['timeoutSeconds','purpose','quietSeconds'].includes(k)))throw Error('等待参数无效');
    const seconds=args.timeoutSeconds??30;
    if(!Number.isInteger(seconds)||seconds<1||seconds>MAX_WAIT_SECONDS)throw Error(`每次等待应为1～${MAX_WAIT_SECONDS}秒`);
    const purpose=args.purpose??'messages',quietSeconds=args.quietSeconds??10;
    if(!['messages','reply'].includes(purpose)||!Number.isInteger(quietSeconds)||quietSeconds<1||quietSeconds>60)throw Error('等待用途或静默秒数无效');
    const full=()=>({reason:'window-full',messages:[],hasMore:this.pending.length>0,instruction:promptText(this.config,'wait.deadline')});
    if(!this.canTake())return full();
    if(!this.pending.length&&!this.scheduled.length&&this.absence?.remaining()===0)return this.absence.begin();
    const deadline=Math.min(this.now()+seconds*1000,this.deadline);
    while(!this.signal.aborted&&!this.children.size&&!this.scheduled.length&&this.canTake()){
      const remaining=deadline-this.now(),quietRemaining=quietSeconds*1000-(this.now()-this.lastArrivalAt);
      if(remaining<=0||this.simulation?.remaining()===0||this.absence?.remaining()===0||(purpose==='reply'?quietRemaining<=0:this.pending.length>0))break;
      await new Promise(resolve=>{
        const finish=()=>{clearTimeout(timer);this.signal.removeEventListener('abort',finish);this.wake=null;resolve();};
        const timer=setTimeout(finish,Math.min(purpose==='reply'?Math.min(remaining,quietRemaining):remaining,this.simulation?.remaining()??Infinity,this.absence?.remaining()??Infinity));
        this.wake=finish;this.signal.addEventListener('abort',finish,{once:true});
        if(this.signal.aborted)finish();
      });
    }
    if(this.signal.aborted)throw Error('当前聊天已停止');
    if(!this.canTake())return full();
    if(!this.pending.length&&!this.scheduled.length&&this.absence?.remaining()===0)return this.absence.begin();
    if(this.scheduled.length)return {reason:'scheduled-wake',messages:[],scheduled:this.scheduled.splice(0),instruction:promptText(this.config,'schedule.wake')};
    const routes=this.pending.splice(0,10),messages=[];
    for(let i=0;i<routes.length;i++){
      if(!this.canTake()){this.pending.unshift(...routes.slice(i));break;}
      try{const route=await prepare(routes[i]);if(route)messages.push(route.compactView??messageSnapshot(route));}
      catch(error){this.pending.unshift(...routes.slice(i));throw error;}
    }
    const notifications=[...this.children.values()];this.children.clear();
    const simulation=this.simulation&&(messages.length||this.simulation.remaining()===0)?this.simulation.delivered(!messages.length):null;
    const reason=messages.length?'messages':notifications.length?'subagent':simulation?'world-simulation':'timeout';
    return {timeout:reason==='timeout',reason,messages,notifications,hasMore:this.pending.length>0,
      ...(simulation?{'真实世界模拟':simulation}:{}),
      ...(purpose==='reply'?{quiet:this.now()-this.lastArrivalAt>=quietSeconds*1000}:{}),
      instruction:promptText(this.config,'wait.messages')};
  }
}
