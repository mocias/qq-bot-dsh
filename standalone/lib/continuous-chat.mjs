import {messageSnapshot} from './message-snapshot.mjs';
import {MAX_WAIT_SECONDS} from '../../native-dsh-plugin/lib/continuations.mjs';
export const CONTINUOUS_POLICY_VERSION=2;

export const CONTINUOUS_POLICY=`持续对话规则（覆盖旧的发送后结束本轮规则）：只有调用QQ发送工具才会向用户发送消息，普通正文不会自动投递。发送工具立即投递并返回实际回执，发完仍可继续调用工具、接话、搜索或等待；不要把工具回执复述给用户。发送失败或结果未知不得自动重发。
主智能体负责与用户对话；耗时研究可交给当前真实可用的DSH子智能体。子智能体的进展和结果先回主智能体，由主智能体结合最新消息决定是否、何时、如何回复，不能让子智能体直接发QQ。委派成功不代表研究完成。
调用qq_wait_for_messages等待本聊天新消息或子智能体进展/结果，根据任务自行选择timeoutSeconds（1～${MAX_WAIT_SECONDS}秒，省略默认30秒）。任一事件到达都会提前返回；reason=subagent表示DSH收件箱已收到子任务通知，正文在后续步骤注入，不要将唤醒提示当作研究结论。返回消息后先理解最新要求再继续工作，不忙轮询、不为保持运行而输出废话。可先发一句有用的回应，再等待或处理研究结果。等待超时不是错误；没有后续工作时可以自然结束，或调用qq_no_reply结束，不用输出占位文字。已有子任务时其通知会在当前受控窗口内交回主智能体；窗口最多15分钟，不保证跨服务停止、重启或超时继续回传。不要将等待工具当成无限保活机制。`;

// Incoming routes stay queued until a tool actually exposes them to the parent.
// Anything left at turn end is returned to the existing dispatcher.
export class ConversationInbox {
  constructor(signal){this.signal=signal;this.pending=[];this.children=new Map();this.wake=null;}
  push(route){if(this.pending.length>=20)return false;this.pending.push(route);this.wake?.();return true;}
  childNotice(message,claimed=false){
    if(this.signal.aborted||typeof message.id!=='string')return;
    if(claimed){this.children.delete(message.id);return;}
    // Wake metadata only. DSH owns delivery of the actual child content.
    if(this.children.size>=128)this.children.delete(this.children.keys().next().value);
    this.children.set(message.id,{messageId:message.id,childId:message.source.senderSessionId,kind:message.source.kind});
    this.wake?.();
  }
  async take(args,prepare){
    if(!args||Object.keys(args).some(k=>k!=='timeoutSeconds'))throw Error('等待参数无效');
    const seconds=args.timeoutSeconds??30;
    if(!Number.isInteger(seconds)||seconds<1||seconds>MAX_WAIT_SECONDS)throw Error(`每次等待应为1～${MAX_WAIT_SECONDS}秒`);
    if(!this.pending.length&&!this.children.size&&!this.signal.aborted)await new Promise(resolve=>{
      const finish=()=>{clearTimeout(timer);this.signal.removeEventListener('abort',finish);this.wake=null;resolve();};
      const timer=setTimeout(finish,seconds*1000);this.wake=finish;this.signal.addEventListener('abort',finish,{once:true});
      if(this.signal.aborted||this.pending.length||this.children.size)finish();
    });
    if(this.signal.aborted)throw Error('当前聊天已停止');
    const routes=this.pending.splice(0,10),messages=[];
    for(let i=0;i<routes.length;i++){
      try{messages.push(messageSnapshot(await prepare(routes[i])));}
      catch(error){this.pending.unshift(...routes.slice(i));throw error;}
    }
    const notifications=[...this.children.values()];this.children.clear();
    const reason=messages.length?'messages':notifications.length?'subagent':'timeout';
    return {timeout:reason==='timeout',reason,messages,notifications,hasMore:this.pending.length>0};
  }
}
