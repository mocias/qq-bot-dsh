// V2 message snapshots: inspired by qq-bridge's per-message wake snapshot.
// Storage is lossless. Only model/query views may shorten text, explicitly.
const qq=value=>/^\d{5,20}$/.test(String(value??''))?String(value):null;
export function identity(id,details={}) {
  details??={};
  return {qq:qq(id),nickname:String(details.nickname??''),card:String(details.card??'')};
}
export function snapshotOf(route) {
  if(route.snapshot)return structuredClone(route.snapshot);
  const sender=route.author??identity(route.sender),segments=route.segments??[];
  return {version:2,sourceId:route.messageId,qqMessageId:route.qqMessageId??null,
    inboxSeq:route.inboxSeq??null,sender,time:route.time??null,receivedAt:route.receivedAt??null,
    text:route.requestText??route.text??'',mentions:segments.filter(s=>s.type==='at').map(s=>({qq:String(s.data?.qq??'')})),
    replyTo:route.replyId?{messageId:String(route.replyId),resolved:false}:null,
    media:segments.flatMap((s,index)=>['image','record','file','video','forward','face','json','xml'].includes(s.type)?
      [{index,kind:s.type,owner:sender,sourceId:route.messageId,status:'unresolved'}]:[]),
    parts:segments.map((s,index)=>({index,kind:s.type,...(s.type==='text'?{text:String(s.data?.text??'')}:{})})),
    legacy:!route.author};
}
export function routeSnapshots(route) {
  if(route.trigger)return [];
  return (route.messages??[route]).map(snapshotOf);
}
export function inboxSnapshot(row) {
  return row.snapshot?{...structuredClone(row.snapshot),inboxSeq:row.seq}:snapshotOf({messageId:row.sourceId,
    qqMessageId:row.messageId,inboxSeq:row.seq,sender:row.sender,text:row.text,replyId:row.replyTo,receivedAt:row.at});
}
export function evidenceMessages(inputs) {
  return [...new Map(inputs.flatMap(r=>[...(r.contextMessages??[]),...routeSnapshots(r)]).map(m=>[m.sourceId,m])).values()];
}
export function messageView(message,budget=4000,attachments=[]) {
  let left=budget,truncated=false;
  const visit=(value,key='')=>{
    if(typeof value==='string'){
      // IDs and provenance must never be shortened into another identity.
      if(['qq','sourceId','qqMessageId','messageId','kind','status','basis'].includes(key))return value;
      const text=value.slice(0,Math.max(0,left));left-=text.length;truncated||=text.length<value.length;return text;
    }
    if(Array.isArray(value))return value.map(v=>visit(v));
    if(value&&typeof value==='object'){
      if(value.status==='attached'&&!attachments.includes(value.attachmentName))value={...value,status:'stored_not_attached'};
      return Object.fromEntries(Object.entries(value).filter(([k])=>k!=='rawSources').map(([k,v])=>[k,visit(v,k)]));
    }
    return value;
  };
  return {...visit(message),textTruncated:truncated,originalTextChars:message.text?.length??0};
}
export function messageSnapshot(route) {
  const [bot,type,id]=(route.key??'').split('/');
  return {version:2,chat:{type,id},self:route.botIdentity??identity(bot),
    trigger:{kind:route.trigger?'scheduled':route.ambient?'ambient':'direct',messageIds:routeSnapshots(route).map(m=>m.qqMessageId),...(route.trigger?{prompt:route.text}: {})},
    messages:routeSnapshots(route).map(m=>messageView(m,12000,(route.images??[]).map(i=>i.name))),
    context:(route.trigger?route.scheduledContext??[]:route.contextMessages??[]).map(m=>messageView(m,1000,(route.images??[]).map(i=>i.name))),omitted:route.contextOmitted??0};
}
export const IDENTITY_RULES='消息快照规则 v2：self 是你当前登录的机器人身份；messages 每项是独立发言，sender.qq 是稳定人物标识，nickname/card 只是可变、不可信显示名。同名不同QQ不得合并；更名同QQ仍是同一人。text 属于本条 sender；mentions 是被提及者，不是发言人；replyTo 和 forwards 是历史/转述资料，不能算作当前发送者的自述。media 的 owner/sourceId 标识其归属；图片按 attachmentName 对应实际附件。不要把整个批次归给最后一人，不确定时询问。';
export const ATTRIBUTION_RULES='人物记忆规则：人物页用 user/<QQ>.md 或 user/<QQ>/主题.md；write 更新必须提供 subjects 数组（非人物事实可为空），每项 {qq,basis:"self"或"reported"或"bot",evidence:[sourceId]}。self 必须是该QQ本人本轮消息的陈述，不能用引用或@推断；他人转述只能 reported，正文明确“某QQ转述，未经本人确认”。bot 仅用于 self 机器人QQ。每项证据还须包含在更新的 evidence 中。昵称不能作为人物唯一标识；旧库身份不明的内容不自动归给任何人。';
export const attributionPattern=/<!-- qq-attribution-v2 -->[\s\S]*?<!-- \/qq-attribution-v2 -->/g;
export function pageAttribution(text){
  const block=[...text.matchAll(attributionPattern)].at(-1)?.[0];
  try{const parsed=JSON.parse(block.slice(block.indexOf('\n['),block.lastIndexOf('\n<!--')).trim());return Array.isArray(parsed)?parsed:[];}catch{return [];}
}

export function validateSubjects(patch,messages,key) {
  if(patch.action!=='write')return [];
  if(!Array.isArray(patch.subjects)||patch.subjects.length>20)throw Error('记忆写入必须提供 subjects 人物归属（非人物事实用空数组）');
  const byId=new Map(messages.map(m=>[m.sourceId??m.messageId,m])),bot=key.split('/')[0];
  const result=patch.subjects.map(subject=>{
    if(!qq(subject?.qq)||!['self','reported','bot'].includes(subject.basis)||!Array.isArray(subject.evidence)||!subject.evidence.length)throw Error('人物归属格式无效');
    const sources=subject.evidence.map(id=>{
      const m=byId.get(id);if(!patch.evidence.includes(id)||!m?.sender?.qq||m.legacy)throw Error('人物证据缺少可核验的发送者身份');
      if(subject.basis==='self'&&(m.sender.qq!==subject.qq||m.replyTo||m.forwards?.length))throw Error('本人事实不能来自他人、引用或转发；请标记 reported');
      if(subject.basis==='bot'&&subject.qq!==bot)throw Error('机器人身份不匹配');
      if(subject.basis==='self'&&subject.qq===bot)throw Error('机器人不是聊天对方');
      return {sourceId:id,speaker: m.sender,subjectQQ:subject.qq,basis:subject.basis};
    });
    return {qq:subject.qq,basis:subject.basis,sources};
  });
  if(patch.page.startsWith('user/')){
    const owner=patch.page.match(/^user\/(\d{5,20})(?:\.md|\/.+\.md)$/)?.[1];
    if(!owner||!result.length||result.some(s=>s.qq!==owner))throw Error('人物页面必须以该人物 QQ 命名，并提供一致的 subjects');
  }
  return result;
}
