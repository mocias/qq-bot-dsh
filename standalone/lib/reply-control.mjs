// Whole-message control markers only. Never strip a phrase from real prose.
export function isSilentReply(value){
  return typeof value==='string'&&/^(?:\[\[QQ_SILENT\]\]|[（(]\s*(?:无回复|不回复|无需回复)\s*[）)])$/u.test(value.trim());
}

export function planDescription(plan){
  return (plan.params.message??[]).map(x=>x.type==='text'?x.data.text:
    x.type==='record'?'[语音] '+(plan.transcript??''):
    x.type==='reply'?'[引用 '+x.data.id+']':x.type==='at'?'[@'+x.data.qq+']':'['+x.type+']').join('')||
    (plan.action.endsWith('_poke')?'[拍一拍]':'[附件或合并转发]');
}

// Prepare every bubble before transport, sharing native media, poke routing and
// split voice handling across immediate and deferred replies. No sending here.
export async function prepareReplyPlans(parts,route,outgoing,isCurrent=()=>true){
  const plans=[];
  for(const part of parts){
    if(!isCurrent())return null;
    const plan=part.nativePlan??(part.poke?{
      action:route.group?'group_poke':'send_poke',
      params:{[route.group?'group_id':'user_id']:route.id,...(route.group?{user_id:part.poke}:{})}
    }:await outgoing(part,route));
    if(plan)for(const item of [plan,...(plan.following??[])])plans.push({...item,nativeCallId:part.nativeCallId});
  }
  return plans;
}
