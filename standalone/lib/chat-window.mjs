import fs from 'node:fs';
import {personaIdentity} from './persona-cards.mjs';
import path from 'node:path';
import {readJson,writeJson} from './config.mjs';
import {inboxSnapshot,routeSnapshots,messageView} from './message-snapshot.mjs';
import {QQ_BRIDGE_STYLE} from './qq-bridge-style.mjs';

// The model projection is disposable; original snapshots and alias mappings are not.
export const CHAT_WINDOW_VERSION=1;
export const ANTI_AI='【反AI味】你不是客服：不用有求必应，可以装傻、已读乱回、拒绝推荐；少用“一绝/真管用/保证/绝对”这类词。';
export const CHAT_STYLE=`${ANTI_AI}
${QQ_BRIDGE_STYLE}
【接话】先分清谁在对谁说什么，顺着最近的话题接；保留人设里的嘴欠和立场，但不要每条都套同一种反问、贬低或结尾。玩梗不等于编造对方经历、价格、地点或把不同人当成同一个人。示例是风格参考，不要循环套用。
【分条与节奏】一条一个完整意群，普通聊天默认一条、需要时两条；中文用标点，不用空格假装分条，不硬拆短语。只有发送工具的内容会公开，不复述工具回执。
【身份与来源】U编号是本聊天稳定的人物代号，M编号是消息代号。同名不同U不是同一个人，同U换昵称仍是同一个人。工具里的qq/atUserId/targetUserId可用U，messageId/replyToMessageId可用M，evidence可用M，人物页可用user/U编号.md；宿主还原后照常验证权限与来源。引用、转发和@不是发言人的自述。记录“某人说过”不代表已核实；机器人自己说过的内容不能作为用户事实。`;

export class ChatWindow{
  constructor(runtime,key,personaId){
    Object.assign(this,personaIdentity(runtime,key,personaId));
    this.key=key;this.dir=path.join(runtime,'chat-context',this.scope);
    this.file=path.join(this.dir,'window.private.json');
    this.data=readJson(this.file,{users:{},messages:{},rows:[],summary:[],through:0,revision:0});
  }
  save(){writeJson(this.file,this.data);}
  user(qq){if(!qq)return '?';qq=String(qq);return this.data.users[qq]??=( 'U'+(Object.keys(this.data.users).length+1));}
  message(sourceId,qqMessageId){
    if(!sourceId)return null;
    let entry=this.data.messages[sourceId];
    if(!entry)entry=this.data.messages[sourceId]={alias:'M'+(Object.keys(this.data.messages).length+1),qqMessageId:qqMessageId??null};
    else if(qqMessageId)entry.qqMessageId=String(qqMessageId);
    return entry.alias;
  }
  sync(rows){
    let changed=false;
    for(const row of rows){
      const snapshot=inboxSnapshot(row),known=this.data.messages[snapshot.sourceId];
      snapshot.receivedAt??=row.at;
      this.message(snapshot.sourceId,snapshot.qqMessageId);this.user(snapshot.sender?.qq);
      if(!known){
        fs.mkdirSync(this.dir,{recursive:true});
        fs.appendFileSync(path.join(this.dir,'messages.private.jsonl'),JSON.stringify({seq:row.seq,outgoing:!!row.outgoing,snapshot})+'\n');
        if(row.seq>this.data.through)this.data.rows.push({seq:row.seq,outgoing:!!row.outgoing,snapshot});
        changed=true;
      }else{
        const saved=this.data.rows.find(x=>x.snapshot.sourceId===snapshot.sourceId);
        if(saved&&JSON.stringify(saved.snapshot)!==JSON.stringify(snapshot)){
          fs.appendFileSync(path.join(this.dir,'messages.private.jsonl'),JSON.stringify({seq:row.seq,outgoing:!!row.outgoing,snapshot,revision:true})+'\n');
          saved.snapshot=snapshot;changed=true;
        }
      }
    }
    this.data.rows.sort((a,b)=>a.seq-b.seq);if(changed)this.save();
  }
  quoteAlias(id){return Object.values(this.data.messages).find(x=>x.qqMessageId===String(id))?.alias??String(id);}
  view(snapshot,budget=1800,depth=0){
    const m=messageView(snapshot,budget,(snapshot.media??[]).map(x=>x.attachmentName).filter(Boolean));
    const speaker=m.sender??{},at=m.time??m.receivedAt;
    const result={id:this.message(m.sourceId,m.qqMessageId),speaker:this.user(speaker.qq),name:speaker.card||speaker.nickname||'',
      ...(at?{time:new Date(at).toISOString()}:{}),text:m.text??''};
    if(m.textTruncated)result.truncated=true;
    if(m.replyTo)result.replyTo={id:this.quoteAlias(m.replyTo.messageId),resolved:!!m.replyTo.resolved,
      ...(m.replyTo.sender?{speaker:this.user(m.replyTo.sender.qq)}:{}),...(m.replyTo.text?{text:m.replyTo.text}:{})};
    if(m.mentions?.length)result.mentions=m.mentions.map(x=>x.qq==='all'?'全体成员':this.user(x.qq));
    if(m.media?.length)result.media=m.media.map(x=>({kind:x.kind,status:x.status,...(x.attachmentName?{attachment:x.attachmentName}:{}),...(x.transcript?{transcript:x.transcript}:{}),...(x.description?{description:x.description}:{})}));
    if(depth<4&&m.replyTo?.resolved)result.replyTo={...this.view(m.replyTo,1000,depth+1),id:this.quoteAlias(m.replyTo.messageId),resolved:true};
    if(depth<4&&m.forwards?.length)result.forwards=m.forwards.map(x=>this.view(x,1000,depth+1));
    return result;
  }
  recent(before=Infinity,after=0){
    const selected=[];let chars=0;
    for(const row of this.data.rows.filter(x=>x.seq<before&&x.seq>after).slice().reverse()){
      const view=this.view(row.snapshot),size=JSON.stringify(view).length;
      if(selected.length>=40||chars+size>12000)break;
      chars+=size;selected.unshift({...view,...(row.outgoing?{sentByMe:true}:{})});
    }
    return selected;
  }
  // An extractive rolling digest: exact attributed quotes, never invented facts.
  // Commit a receipt before removing anything from the raw model window.
  slide(before=Infinity){
    const rows=this.data.rows.filter(x=>x.seq<before);let count=0,chars=0,cut=0;
    for(const row of rows.slice().reverse()){
      const size=JSON.stringify(this.view(row.snapshot)).length;
      if(count>=40||chars+size>12000){cut=row.seq;break;}count++;chars+=size;
    }
    if(!cut)return;
    const removed=rows.filter(x=>x.seq<=cut);
    const excerpts=removed.map(row=>({...this.view(row.snapshot,220),kind:row.outgoing?'机器人曾说（不是用户事实）':'发言摘录（未核实，不推断动机）'}));
    const summary=[...this.data.summary,...excerpts].slice(-60);
    while(summary.length&&JSON.stringify(summary).length>12000)summary.shift();
    const receipt={version:1,revision:this.data.revision+1,through:cut,sources:removed.map(x=>x.snapshot.sourceId),summary};
    writeJson(path.join(this.dir,'receipts',receipt.revision+'.json'),receipt);
    const next={...this.data,summary,through:cut,revision:receipt.revision,rows:this.data.rows.filter(x=>x.seq>cut)};
    writeJson(this.file,next);this.data=next;
  }
  attach(route,session,{initial=false}={}){
    const current=routeSnapshots(route);for(const m of current){this.message(m.sourceId,m.qqMessageId);this.user(m.sender?.qq);}
    const before=Math.min(...current.map(m=>m.inboxSeq).filter(Number.isSafeInteger));
    this.slide(before);
    const background=initial?this.recent(before,route.replyPolicy?.historyThroughSeq??0):
      this.recent(before,Math.max(route.replyPolicy?.historyThroughSeq??0,session.windowThroughSeq??0));
    const view={...(initial?{me:this.user(this.key.split('/')[0]),summary:this.data.summary}:{}),
      ...(background.length?{background}:{}),messages:current.map(m=>this.view(m,6000))};
    this.save();return {...route,compactView:view};
  }
  decode(value,key=''){
    if(Array.isArray(value))return value.map(x=>this.decode(x,key));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,this.decode(v,k)]));
    if(typeof value!=='string')return value;
    if(['qq','atUserId','targetUserId','userId','speakerIds'].includes(key)&&/^U\d+$/.test(value)){
      const entry=Object.entries(this.data.users).find(([,alias])=>alias===value);if(!entry)throw Error('未知人物代号');return entry[0];
    }
    if(['messageId','replyToMessageId','evidence','sourceId'].includes(key)&&/^M\d+$/.test(value)){
      const entry=Object.entries(this.data.messages).find(([,item])=>item.alias===value);if(!entry)throw Error('未知消息代号');
      if(['evidence','sourceId'].includes(key))return entry[0];
      if(!entry[1].qqMessageId)throw Error('该消息没有可引用的QQ消息编号');return entry[1].qqMessageId;
    }
    if(key==='page'&&/^user\/U\d+(?:\.md|\/)/.test(value))return value.replace(/U\d+/,alias=>this.decode(alias,'qq'));
    return value;
  }
  encode(value,key=''){
    if(Array.isArray(value))return value.map(x=>this.encode(x,key));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,this.encode(v,k)]));
    if(typeof value!=='string')return value;
    if(['qq','atUserId','targetUserId','userId','sender','speakerQQ'].includes(key))return this.user(value);
    if(['sourceId','evidence'].includes(key))return this.data.messages[value]?.alias??value;
    if(['qqMessageId','messageId','replyToMessageId'].includes(key))return this.quoteAlias(value);
    if(key==='page')return value.replace(/^user\/(\d+)(?=\.md|\/)/,(_m,qq)=>'user/'+this.user(qq));
    return value;
  }
}
