import fs from 'node:fs';
import {snapshotOf,identity} from './message-snapshot.mjs';
import {isSilentReply} from './reply-control.mjs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { sniffImageMediaType } from '../../dsh-group-social/lib/images.mjs';
import { inProtectedDir } from '../../dsh-group-social/lib/security.mjs';
import { textReason, wavInfo, defaults as voiceDefaults } from '../../dsh-companion-voice/lib/core.mjs';
import {parseCqString,faceToEmoji} from '../../dsh-onebot-source/lib/cq.js';
import {normalizeQQFaceId} from './qq-face.mjs';

const MAX=8*1024*1024;
const opaqueFile=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\\/:]/.test(value)&&value!=='.'&&value!=='..';
function responseBytes(response){
  if(typeof response?.base64!=='string'||!response.base64)return null;
  const value=response.base64;
  if(value.length>Math.ceil(MAX/3)*4||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw Error('媒体数据无效或过大');
  const bytes=Buffer.from(value,'base64');
  if(!bytes.length||bytes.length>MAX)throw Error('媒体数据无效或过大');
  return bytes;
}
const blocked=new BlockList();
for(const [base,bits] of [['0.0.0.0',8],['10.0.0.0',8],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['100.64.0.0',10],['192.0.0.0',24],['198.18.0.0',15],['224.0.0.0',4],['240.0.0.0',4]])blocked.addSubnet(base,bits,'ipv4');
export function publicAddress(address){
  return isIP(address)===4?!blocked.check(address,'ipv4'):isIP(address)===6&&/^[23][0-9a-f]{3}:/i.test(address);
}
// Validate each redirect and pin the resolved address: DNS cannot change between check and connect.
export async function publicDownload(value,{maxBytes=MAX,signal,lookup=dns.lookup}={}){
  for(let redirects=0;redirects<4;redirects++){
    const url=new URL(value);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('媒体地址必须是公开 HTTP(S)');
    const host=url.hostname.replace(/^\[|\]$/g,'');
    const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await lookup(host,{all:true});
    if(!addresses.length||addresses.some(x=>!publicAddress(x.address)))throw Error('拒绝本机或内网媒体地址');
    const chosen=addresses[0];
    const response=await new Promise((resolve,reject)=>{
      const request=(url.protocol==='https:'?https:http).get(url,{
        signal:signal??AbortSignal.timeout(20000),
        lookup:(_host,options,cb)=>cb(null,options.all?[chosen]:chosen.address,chosen.family),
      },resolve);
      request.on('error',reject);
    });
    if([301,302,303,307,308].includes(response.statusCode)){
      const location=response.headers.location;response.destroy();
      if(!location)throw Error('媒体重定向缺少地址');value=new URL(location,url).href;continue;
    }
    if(response.statusCode!==200){response.destroy();throw Error('媒体下载失败');}
    if(Number(response.headers['content-length'])>maxBytes){response.destroy();throw Error('媒体超过大小限制');}
    let size=0;const chunks=[];
    for await(const chunk of response){size+=chunk.length;if(size>maxBytes){response.destroy();throw Error('媒体超过大小限制');}chunks.push(chunk);}
    if(!size)throw Error('媒体为空');return Buffer.concat(chunks);
  }
  throw Error('媒体重定向次数过多');
}
export function fencedRead(file,roots,maxBytes=MAX){
  const full=path.resolve(file);
  const root=roots.map(x=>path.resolve(x)).find(x=>{const r=path.relative(x,full);return r&&!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r);});
  if(!root)throw Error('媒体文件不在允许的目录中');
  // Check the entire path, including the configured root.
  let at=path.parse(full).root;
  for(const part of full.slice(at.length).split(path.sep)){
    at=path.join(at,part);const stat=fs.lstatSync(at);
    if(stat.isSymbolicLink()||(stat.isFile()&&stat.nlink>1))throw Error('媒体路径不能包含链接');
  }
  const stat=fs.statSync(full);
  if(!stat.isFile()||stat.size>maxBytes)throw Error('媒体文件无效或过大');
  return fs.readFileSync(full);
}
export class Media {
  constructor(runtime,{call,voice,download=publicDownload,now=Date.now}){
    this.root=path.join(runtime,'media');this.call=call;this.voice=voice;this.download=download;this.now=now;
  }
  dir(key){return path.join(this.root,createHash('sha256').update(key).digest('hex'));}
  async reference(route,id){
    if(!/^-?\d{1,20}$/.test(String(id)))throw Error('引用 ID 无效');
    const m=await this.call('get_msg',{message_id:String(id)}),bot=route.key.split('/')[0];
    const belongs=route.group?String(m.group_id)===route.id:
      (m.message_type!=='group'&&!m.group_id&&(String(m.user_id??m.sender?.user_id)===route.id||String(m.peer_id??m.target_id)===route.id||(route.knownReplyIds??[]).includes(String(id))));
    if(!belongs)throw Error('引用消息不属于当前聊天');
    return {...m,fromBot:String(m.sender?.user_id??m.user_id)===bot};
  }
  archive(key,data,type){
    const dir=this.dir(key);fs.mkdirSync(dir,{recursive:true});
    const file=path.join(dir,randomUUID()+({ 'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','image/gif':'.gif','audio/wav':'.wav'}[type]??'.bin'));
    fs.writeFileSync(file,data,{flag:'wx'});return file;
  }
  prune(){
    if(!fs.existsSync(this.root))return;
    for(const entry of fs.readdirSync(this.root,{withFileTypes:true})){
      if(!entry.isDirectory()||!/^[a-f0-9]{64}$/.test(entry.name))continue;
      const dir=path.join(this.root,entry.name),items=fs.readdirSync(dir).map(n=>({file:path.join(dir,n),stat:fs.lstatSync(path.join(dir,n))})).filter(x=>x.stat.isFile()&&!x.stat.isSymbolicLink()).sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs);
      let bytes=0;for(let i=0;i<items.length;i++){const x=items[i];bytes+=x.stat.size;if(i>=200||bytes>256*1024*1024||this.now()-x.stat.mtimeMs>86400000)fs.unlinkSync(x.file);}
    }
  }
  async incoming(route,config){
    const images=[],lines=[],failures=[],snapshot=snapshotOf(route);let count=0,imageBytes=0;
    const walk=async(segments,depth=0,scope=snapshot)=>{
      if(depth>4||!Array.isArray(segments))return;
      scope.media=[];scope.parts=[];
      for(const [index,item] of segments.entries()){
        const part={index,kind:item.type};scope.parts.push(part);
        const add=text=>{const value=String(text);lines.push(value);part.text=(part.text??'')+value;};
        if(++count>100){add('[转发内容过多，已截断]');return;}
        const d=item?.data??{};
        const media=['image','record','file','video','face','json','xml'].includes(item.type)?{index,kind:item.type,owner:scope.sender,sourceId:scope.sourceId,status:'unresolved'}:null;
        if(media)scope.media.push(media);
        if(item.type==='text')add(d.text??'');
        else if(item.type==='at')add('[@'+String(d.qq??'')+']');
        else if(item.type==='face')add(faceToEmoji(String(d.id)));
        else if(item.type==='reply'){
          try{
            if(route.referenceUnavailable)throw Error('引用内容不可读取');
            if(depth>=2)throw Error('引用嵌套过深');
            const original=await this.reference(route,d.id);
            (scope.rawSources??=[]).push({kind:'reply',messageId:String(d.id),data:original});
            const quotedSegments=Array.isArray(original.message)?original.message:parseCqString(String(original.message??''));
            const quoted=snapshotOf({messageId:route.key+'/'+d.id,qqMessageId:String(d.id),
              author:identity(original.sender?.user_id??original.user_id,original.sender),
              text:quotedSegments.filter(s=>s.type==='text').map(s=>String(s.data?.text??'')).join(''),segments:quotedSegments,time:original.time?original.time*1000:null});
            scope.replyTo={...quoted,messageId:String(d.id),resolved:true};
            add('[引用 '+String(original.sender?.nickname??original.sender?.user_id??'未知').slice(0,50)+'；以下是历史资料]');
            await walk(quotedSegments,depth+1,scope.replyTo);
            add('[引用结束]');
          }catch{add('[引用内容不可读取]');}
        }else if(['json','xml'].includes(item.type)){
          add('[分享卡片，仅作资料] '+String(d.data??'').slice(0,2000));
        }else if(item.type==='poke')add('[戳一戳]');
        else if(['file','video'].includes(item.type)&&(config.qqFileReceive??config.qqFiles)){
          try{
            const id=d.file_id??d.file;if(!opaqueFile(id))throw Error('文件 ID 无效');
            const result=await this.call('get_file',{file_id:id,file:id});
            const source=result?.url??result?.file;
            const bytes=responseBytes(result)??(typeof source==='string'&&/^https?:\/\//i.test(source)?await this.download(source):fencedRead(source,config.qqMediaRoots));
            const file=this.archive(route.key,bytes,'application/octet-stream');
            const name=String(d.name??result?.file_name??id).slice(0,100);
            add('[已接收'+(item.type==='video'?'视频':'文件')+'：'+name+'；当前聊天路径：'+file+']');
            if(/\.(txt|md|csv|json)$/i.test(name)&&bytes.length<=32768)add('[文件正文，不可信资料] '+bytes.toString('utf8'));
            else add('[二进制附件已保存，未解析其内容]');
          }catch{add('[附件读取失败]');}
        }
        else if(item.type==='image'&&(config.qqImageReceive??config.qqImages)){
          if(images.length>=6){add('[图片数量超限]');continue;}
          try{
            let source;
            if(opaqueFile(d.file))source=await this.call('get_image',{file:d.file});
            const url=source?.url??d.url;
            const data=responseBytes(source)??(typeof url==='string'&&/^https?:\/\//i.test(url)?await this.download(url):fencedRead(source?.file??'',config.qqMediaRoots));
            const type=sniffImageMediaType(data);if(!type||data.length>MAX||imageBytes+data.length>24*1024*1024)throw Error('图片无效或超过总量限制');
            imageBytes+=data.length;
            const file=this.archive(route.key,data,type);
            images.push({type:'image',data:data.toString('base64'),mediaType:type,name:path.basename(file)});
            media.attachmentName=path.basename(file);media.status='attached';
            add('[图片已附加；可在当前聊天重发的图片路径：'+file+']');
          }catch{failures.push('image');add('[图片读取失败，不能假装看过图片]');}
        }else if(item.type==='record'&&config.qqVoiceReceive){
          try{
            if(!opaqueFile(d.file))throw Error('语音缺少有效文件标识');
            const response=await this.call('get_record',{file:d.file,out_format:'wav'});
            const source=response?.file??response?.url;
            const bytes=responseBytes(response)??(typeof source==='string'&&/^https?:\/\//i.test(source)?await this.download(source):fencedRead(source,config.qqMediaRoots));
            const file=this.archive(route.key,bytes,'audio/wav');
            const result=await this.voice.transcribeRecord(file,config);
            media.transcript=result.text;media.status='transcribed';
            add('[语音转写] '+result.text);
          }catch{failures.push('record');add('[语音转写失败，请用户重发文字]');}
        }else if(item.type==='forward'&&(config.qqForwardReceive??config.qqForward)){
          try{const id=String(d.id??'');if(!id||depth>=4)throw Error('转发层级超限');
            const result=await this.call('get_forward_msg',{id,message_id:id});add('[合并转发，以下是引用资料]');
            (scope.rawSources??=[]).push({kind:'forward',id,data:result});
            for(const node of (result?.messages??[]).slice(0,50)){
              const n=node.data??node;add(String(n.nickname??node.sender?.nickname??'未知').slice(0,40)+':');
              const content=n.message??n.content??node.content;
              const parts=Array.isArray(content)?content:parseCqString(String(content??''));
              const forwarded=snapshotOf({messageId:scope.sourceId+'/forward/'+id+'/'+(scope.forwards?.length??0),
                author:identity(n.uin??n.user_id??node.sender?.user_id,{nickname:n.nickname??node.sender?.nickname}),
                text:parts.filter(s=>s.type==='text').map(s=>String(s.data?.text??'')).join(''),segments:parts});
              (scope.forwards??=[]).push(forwarded);await walk(parts,depth+1,forwarded);
            }
          }catch{add('[合并转发展开失败]');}
        }else if(item.type==='node'){
          add(String(d.nickname??d.name??'未知').slice(0,40)+':');
          const content=d.message??d.content,parts=Array.isArray(content)?content:parseCqString(String(content??''));
          const forwarded=snapshotOf({messageId:scope.sourceId+'/node/'+index,author:identity(d.uin??d.user_id,{nickname:d.nickname??d.name}),text:parts.filter(s=>s.type==='text').map(s=>String(s.data?.text??'')).join(''),segments:parts});
          (scope.forwards??=[]).push(forwarded);await walk(parts,depth+1,forwarded);
        }
        if(media){media.description=part.text??'';if(media.status==='unresolved')media.status='described';}
      }
    };
    await walk(route.segments??[{type:'text',data:{text:route.text}}]);
    snapshot.expanded=true;
    return {...route,text:lines.join('\n')||route.text,snapshot,images,mediaFailures:failures,prepared:true};
  }
  async outgoing(parsed,route,session,config){
    const q=parsed.qq??{};
    if(!q||typeof q!=='object'||Array.isArray(q)||Object.keys(q).some(k=>!['images','voice','voiceStyle','forward','file','video','replyTo','at','faceId'].includes(k)))throw Error('QQ 输出格式无效');
    const faceId=q.faceId===undefined?undefined:normalizeQQFaceId(q.faceId);
    if(faceId!==undefined&&!(config.stickerSend??config.knowledgeEnabled))throw Error('此聊天未开启表情发送');
    if(q.voiceStyle!==undefined&&(typeof q.voice!=='string'||typeof q.voiceStyle!=='string'||q.voiceStyle.length>300))throw Error('语音情绪说明无效');
    if(('images'in q&&!Array.isArray(q.images))||('forward'in q&&!Array.isArray(q.forward))||('voice'in q&&typeof q.voice!=='string'))throw Error('QQ 输出格式无效');
    const kinds=[Array.isArray(q.images)&&q.images.length>0,typeof q.voice==='string'&&!!q.voice,Array.isArray(q.forward)&&q.forward.length>0,!!q.file,!!q.video].filter(Boolean).length;
    if(kinds>1)throw Error('一次回复只能选择一种多媒体形式');
    if(faceId!==undefined&&(q.images?.length||q.voice||q.forward?.length||q.file||q.video))throw Error('QQ 系统表情只能附加到文字消息');
    if(q.file||q.video){
      if(!(config.qqFileSend??config.qqFiles))throw Error('文件收发未启用');
      const source=q.file??q.video;if(typeof source!=='string')throw Error('附件路径无效');
      const file=path.resolve(session.workspace,source);
      const relative=path.relative(session.workspace,file);
      if(inProtectedDir(session.workspace,file)||(!relative.startsWith('..')&&relative.split(path.sep).some(p=>p.startsWith('.'))))throw Error('不能发送隐藏或受保护文件');
      const bytes=fencedRead(file,[session.workspace,this.dir(route.key)]);
      if(q.file)return {action:route.group?'upload_group_file':'upload_private_file',params:{[route.group?'group_id':'user_id']:route.id,file:'base64://'+bytes.toString('base64'),name:path.basename(file)}};
      return {action:route.group?'send_group_msg':'send_private_msg',params:{[route.group?'group_id':'user_id']:route.id,message:[{type:'video',data:{file:'base64://'+bytes.toString('base64')}}]}};
    }
    if(q.forward?.length){
      if(!(config.qqForwardSend??config.qqForward)||q.forward.length>50)throw Error('合并转发未启用或节点过多');
      const messages=q.forward.map(n=>{
        if(!n||typeof n.content!=='string'||!n.content.trim())throw Error('转发内容不能为空');
        return {type:'node',data:{uin:route.key.split('/')[0],name:String(n.name||'助手').slice(0,24),content:[{type:'text',data:{text:n.content.slice(0,500)}}]}};
      });
      return {action:route.group?'send_forward_msg':'send_private_forward_msg',params:{[route.group?'group_id':'user_id']:route.id,messages}};
    }
    let reply=isSilentReply(parsed.reply)?'':parsed.reply??'',segments=[];
    if(isSilentReply(q.voice))return null;
    const tagged=reply.match(/^\s*\[\[qq_voice\]\]([\s\S]+)\[\[\/qq_voice\]\]\s*$/);
    const voiceText=q.voice??tagged?.[1]??reply;
    if(isSilentReply(voiceText))return null;
    const policy={...voiceDefaults,enabled:config.qqVoiceSend,mode:config.voiceReplyMode,quietHours:config.voiceQuietMode==='never'?{start:0,end:0}:{start:config.voiceQuietStart,end:config.voiceQuietEnd}};
    const hour=Number(new Intl.DateTimeFormat('en-GB',{hour:'2-digit',hourCycle:'h23',timeZone:'Asia/Shanghai'}).format(new Date(this.now())));
    const quiet=config.voiceQuietMode==='always'||(config.voiceQuietMode!=='never'&&(config.voiceQuietStart<config.voiceQuietEnd?hour>=config.voiceQuietStart&&hour<config.voiceQuietEnd:config.voiceQuietStart>config.voiceQuietEnd&&(hour>=config.voiceQuietStart||hour<config.voiceQuietEnd)));
    if(!quiet&&(!route.group||config.groupVoiceSend)&&(q.voice||tagged||config.voiceReplyMode==='voice')&&!textReason(voiceText,policy,new Date(this.now()))){
      try{
        const voiceConfig=q.voiceStyle&&config.voiceProvider==='mimo'?{...config,mimoStyle:[config.mimoStyle,q.voiceStyle].filter(Boolean).join('\n')}:config;
        const result=await this.voice.synthesize(voiceText,voiceConfig),data=this.voice.audio(result.id),info=wavInfo(data);
        if(info.duration_seconds>60||data.length>MAX)throw Error('语音过长');
        segments=[{type:'record',data:{file:'base64://'+data.toString('base64')}}];
      }catch{reply=voiceText;} // Only preparation failure falls back. Never retry an uncertain send.
    }else if(q.voice||tagged)reply=voiceText;
    if(q.images?.length){
      if(!(config.qqImageSend??config.qqImages)||q.images.length>9)throw Error('图片发送未启用或图片过多');
      for(const source of q.images){
        if(typeof source!=='string')throw Error('图片来源格式错误');
        if(!/^https?:\/\//i.test(source)&&inProtectedDir(session.workspace,path.resolve(session.workspace,source)))throw Error('不能发送受保护目录里的图片');
        if(!/^https?:\/\//i.test(source)&&path.resolve(session.workspace,source).split(/[\\/]/).some(p=>['.memory','.git','.credentials','.secrets'].includes(p.toLowerCase())))throw Error('不能发送受保护目录里的图片');
        const bytes=/^https?:\/\//i.test(source)?await this.download(source):fencedRead(path.resolve(session.workspace,source),[session.workspace,this.dir(route.key)]);
        if(!sniffImageMediaType(bytes))throw Error('图片格式不支持');
        segments.push({type:'image',data:{file:'base64://'+bytes.toString('base64')}});
      }
    }
    if(faceId!==undefined)segments.push({type:'face',data:{id:String(faceId)}});
    if(!segments.some(x=>x.type==='record')&&reply.trim()&&reply.trim()!=='[[QQ_SILENT]]'){
      const chars=Array.from(reply),text=[];
      for(let offset=0;offset<chars.length;offset+=4000)text.push({type:'text',data:{text:chars.slice(offset,offset+4000).join('')}});
      segments.unshift(...text);
    }
    if(q.at!=null){
      if(!route.group||!config.mentionSend||!/^\d{5,20}$/.test(String(q.at)))throw Error('此聊天不允许 @ 或成员号码无效');
      const member=await this.call('get_group_member_info',{group_id:route.id,user_id:String(q.at),no_cache:false});
      if(String(member?.user_id)!==String(q.at)||member?.group_id!=null&&String(member.group_id)!==route.id)throw Error('无法确认 @ 的成员');
      if(segments.length)segments.unshift({type:'at',data:{qq:String(q.at)}});
    }
    const replyTo=config.quoteMode==='never'?null:(q.replyTo??(config.quoteMode==='always'?route.qqMessageId:null));
    if(replyTo&&segments.length){await this.reference(route,replyTo);segments.unshift({type:'reply',data:{id:String(replyTo)}});}
    const make=message=>({action:route.group?'send_group_msg':'send_private_msg',params:{[route.group?'group_id':'user_id']:route.id,message}});
    const record=segments.find(x=>x.type==='record');
    if(record){
      // QQ voice bubbles must stand alone: reply/at mixed with record may hide audio.
      const voice={...make([record]),transcript:voiceText};
      const prefix=segments.filter(x=>x.type!=='record');
      if(prefix.length)return {...make([...prefix,{type:'text',data:{text:'语音回复：'}}]),following:[voice]};
      return voice;
    }
    return segments.length?make(segments):null;
  }
}
