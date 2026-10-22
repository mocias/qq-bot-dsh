import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ChatInbox} from './chat-inbox.mjs';
import {PersonaCards} from './persona-cards.mjs';
import {inboxSnapshot} from './message-snapshot.mjs';
export function monitorView(runtime,keys,{key,personaId,query='',before}={}){
  const cards=new PersonaCards(runtime);
  const chats=keys.flatMap(k=>cards.view(k).cards.map(c=>{
    const s=new ChatInbox(runtime,k,Date.now,c.id).read(),last=s.messages.at(-1);
    return {key:k,personaId:c.id,name:c.name,active:c.id===cards.view(k).activeId,count:s.messages.length,
      unread:s.messages.filter(m=>!m.outgoing&&!m.read&&m.seq>s.readThrough).length,lastAt:last?.at??null,preview:last?.text?.slice(0,100)??''};
  })).sort((a,b)=>(b.lastAt??0)-(a.lastAt??0));
  if(!key)return {chats};
  if(!keys.includes(key))throw Error('请选择当前账号已接入的聊天');
  const card=cards.get(key,personaId),s=new ChatInbox(runtime,key,Date.now,card.id).read();
  if(query.length>200||before!==undefined&&(!Number.isSafeInteger(before)||before<1))throw Error('消息筛选参数无效');
  const filtered=s.messages.filter(m=>(before===undefined||m.seq<before)&&(!query||[m.text,m.sender,m.snapshot?.sender?.nickname,m.snapshot?.sender?.card].join(' ').toLowerCase().includes(query.toLowerCase())));
  const rows=filtered.slice(-50).map(m=>{
    const snapshot=inboxSnapshot(m);
    const media=(snapshot.media??[]).map((a,index)=>({kind:a.kind,name:a.attachmentName??'',transcript:a.transcript??'',status:a.status,
      ...(a.attachmentName?{url:'/api/message-monitor/media?'+new URLSearchParams({key,personaId:card.id,seq:String(m.seq),index:String(index)})}:{})}));
    return {seq:m.seq,messageId:m.messageId,sender:snapshot.sender,at:m.at,text:m.text,outgoing:m.outgoing,
      unread:!m.outgoing&&!m.read&&m.seq>s.readThrough,replyTo:snapshot.replyTo?{messageId:snapshot.replyTo.messageId,text:snapshot.replyTo.text??''}:null,media,
      segments:(m.segments??[]).filter(x=>['face','at'].includes(x.type)).map(x=>({kind:x.type,id:String(x.data?.id??x.data?.qq??'')})),
      forwards:(snapshot.forwards??[]).map(x=>({sender:x.sender,text:x.text}))};
  });
  return {chats,key,personaId:card.id,messages:rows,hasMore:filtered.length>rows.length,retentionLimit:500,truncated:s.messages[0]?.seq>1};
}
export function monitorMedia(runtime,keys,{key,personaId,seq,index}){
  if(!keys.includes(key)||!Number.isSafeInteger(seq)||!Number.isSafeInteger(index)||index<0)throw Error('附件范围无效');
  const row=new ChatInbox(runtime,key,Date.now,personaId).detail({seq});
  const media=inboxSnapshot(row).media?.[index],name=media?.attachmentName;
  if(typeof name!=='string'||!/^[-a-zA-Z0-9]+\.(png|jpg|webp|gif|wav|bin)$/.test(name))throw Error('此附件未在本机缓存');
  const root=path.join(runtime,'media'),dir=path.join(root,createHash('sha256').update(key).digest('hex')),file=path.join(dir,name);
  for(const p of [root,dir,file])if(!fs.existsSync(p)||fs.lstatSync(p).isSymbolicLink())throw Error('附件已清理或路径不可用');
  if(!fs.statSync(file).isFile()||fs.statSync(file).size>24*1024*1024)throw Error('附件不可读取');
  const type={'.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.wav':'audio/wav'}[path.extname(name)]??'application/octet-stream';
  return {bytes:fs.readFileSync(file),type,name};
}
