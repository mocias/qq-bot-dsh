import path from 'node:path';
import {createHash} from 'node:crypto';
import {readJson,writeJson} from './config.mjs';

// Protocol/behavior adapted from Derpyu520/qq-bridge; see docs/QQ-CHAT-0.12.md.
// Local IDs are cursors, never substitutes for real OneBot message IDs.
export class ChatInbox {
  constructor(runtime,key,now=Date.now){
    if(!/^\d{5,20}\/(?:private|group)\/\d{5,20}$/.test(key))throw Error('聊天范围无效');
    this.file=path.join(runtime,'chat-inbox',createHash('sha256').update(key).digest('hex')+'.json');
    this.key=key;this.now=now;
  }
  read(){
    const s=readJson(this.file,{key:this.key,next:1,readThrough:0,messages:[],wake:{mode:'active',until:0}});
    if(s.key!==this.key)throw Error('聊天索引范围不匹配');
    return s;
  }
  save(s){writeJson(this.file,s);}
  append({messageId,sourceId,sender,text,replyTo,kind='message',outgoing=false}){
    const s=this.read(),existing=s.messages.find(m=>m.sourceId===sourceId);
    if(existing)return existing;
    const item={seq:s.next++,messageId:messageId==null?null:String(messageId),sourceId,
      sender:String(sender??''),text:String(text??'').slice(0,12000),replyTo:replyTo==null?null:String(replyTo),kind,outgoing,at:this.now()};
    s.messages.push(item);s.messages=s.messages.slice(-500);this.save(s);return item;
  }
  list({unread=false,mine=false,limit=20,offset=0,afterSeq}={}){
    if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>500
      ||afterSeq!==undefined&&(!Number.isSafeInteger(afterSeq)||afterSeq<0))throw Error('消息分页参数无效');
    const s=this.read(),floor=s.messages[0]?.seq??s.next;
    let rows=s.messages.filter(m=>(!mine||m.outgoing)&&(!unread||!m.outgoing&&!m.read&&m.seq>s.readThrough)&&(afterSeq===undefined||m.seq>afterSeq));
    const total=rows.length;
    const chronological=unread||afterSeq!==undefined;
    rows=chronological?rows.slice(offset,offset+limit):rows.slice().reverse().slice(offset,offset+limit);
    const bounded=[];let size=0;
    for(const row of rows){
      const item={...row,text:row.text.slice(0,1000),textTruncated:row.text.length>1000};
      const length=JSON.stringify(item).length;if(size+length>6000)break;
      size+=length;bounded.push(item);
    }
    rows=chronological?bounded:bounded.reverse();
    return {messages:rows,unreadCount:s.messages.filter(m=>!m.outgoing&&!m.read&&m.seq>s.readThrough).length,
      readThroughSeq:rows.at(-1)?.seq??s.readThrough,hasMore:total>offset+rows.length,
      truncatedBeforeSeq:floor>1?floor:null,retentionLimit:500};
  }
  detail({messageId,seq}){
    const row=this.read().messages.find(m=>seq!==undefined?m.seq===seq:m.messageId!==null&&m.messageId===String(messageId));
    if(!row)throw Error('消息不在当前聊天保留记录中');return row;
  }
  mark(throughSeq,ceiling){
    if(!Number.isSafeInteger(throughSeq)||throughSeq<0||throughSeq>ceiling)throw Error('不能将未展示的消息标记已读');
    const s=this.read();if(throughSeq>=s.next)throw Error('已读位置无效');
    s.readThrough=Math.max(s.readThrough,throughSeq);this.save(s);return {readThroughSeq:s.readThrough};
  }
  consume(seqs){
    const s=this.read();for(const m of s.messages)if(seqs.includes(m.seq))m.read=true;
    for(const m of s.messages){if(m.seq<=s.readThrough)continue;if(!m.outgoing&&!m.read)break;s.readThrough=m.seq;}
    this.save(s);
  }
  setWake(mode,minutes=30){
    if(!['active','diving'].includes(mode)||!Number.isInteger(minutes)||minutes<1||minutes>1440)throw Error('潜水模式或时长无效');
    const s=this.read();s.wake={mode,until:mode==='diving'?this.now()+minutes*60000:0};this.save(s);return s.wake;
  }
  sleeping(){const w=this.read().wake;return w.mode==='diving'&&this.now()<w.until;}
}

export class Participation {
  constructor(inbox){this.inbox=inbox;}
  onInput(route,config){
    if(!config.wakeEnabled)return true;
    const direct=!route.group||!route.ambient;
    const named=(config.wakeKeywords??'').split(/[\n,，]+/).map(x=>x.trim()).filter(Boolean).some(x=>route.text.includes(x));
    const speaker=(config.wakeSpeakers??[]).includes(route.sender);
    if(direct||named||speaker){this.inbox.setWake('active');return true;}
    return !this.inbox.sleeping();
  }
  allowsBackground(config){return !config.wakeEnabled||!this.inbox.sleeping();}
}
