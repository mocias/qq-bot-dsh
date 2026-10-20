import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { sniffImageMediaType } from '../../dsh-group-social/lib/images.mjs';
import { inProtectedDir } from '../../dsh-group-social/lib/security.mjs';
import { textReason, wavInfo, defaults as voiceDefaults } from '../../dsh-companion-voice/lib/core.mjs';

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
    const images=[],lines=[],failures=[];let count=0,characters=0,imageBytes=0;
    const add=text=>{if(characters>=12000)return;const value=String(text).slice(0,12000-characters);lines.push(value);characters+=value.length;};
    const walk=async(segments,depth=0)=>{
      if(depth>4||!Array.isArray(segments))return;
      for(const item of segments){
        if(++count>100){add('[转发内容过多，已截断]');return;}
        const d=item?.data??{};
        if(item.type==='text')add(d.text??'');
        else if(item.type==='at')add('[@'+String(d.qq??'')+']');
        else if(item.type==='image'&&config.qqImages){
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
            add('[语音转写] '+result.text);
          }catch{failures.push('record');add('[语音转写失败，请用户重发文字]');}
        }else if(item.type==='forward'&&config.qqForward){
          try{const id=String(d.id??'');if(!id||depth>=4)throw Error('转发层级超限');
            const result=await this.call('get_forward_msg',{id,message_id:id});add('[合并转发，以下是引用资料]');
            for(const node of (result?.messages??[]).slice(0,50)){
              const n=node.data??node;add(String(n.nickname??node.sender?.nickname??'未知').slice(0,40)+':');
              const content=n.message??n.content??node.content;
              if(Array.isArray(content))await walk(content,depth+1);else if(typeof content==='string')add(content);
            }
          }catch{add('[合并转发展开失败]');}
        }else if(item.type==='node'){
          add(String(d.nickname??d.name??'未知').slice(0,40)+':');
          const content=d.message??d.content;if(Array.isArray(content))await walk(content,depth+1);else if(typeof content==='string')add(content);
        }
      }
    };
    await walk(route.segments??[{type:'text',data:{text:route.text}}]);
    return {...route,text:lines.join('\n').slice(0,12000)||route.text,images,mediaFailures:failures,prepared:true};
  }
  async outgoing(parsed,route,session,config){
    const q=parsed.qq??{};
    if(!q||typeof q!=='object'||Array.isArray(q)||Object.keys(q).some(k=>!['images','voice','forward'].includes(k)))throw Error('QQ 输出格式无效');
    if(('images'in q&&!Array.isArray(q.images))||('forward'in q&&!Array.isArray(q.forward))||('voice'in q&&typeof q.voice!=='string'))throw Error('QQ 输出格式无效');
    const kinds=[Array.isArray(q.images)&&q.images.length>0,typeof q.voice==='string'&&!!q.voice,Array.isArray(q.forward)&&q.forward.length>0].filter(Boolean).length;
    if(kinds>1)throw Error('一次回复只能选择一种多媒体形式');
    if(q.forward?.length){
      if(!config.qqForward||q.forward.length>50)throw Error('合并转发未启用或节点过多');
      const messages=q.forward.map(n=>{
        if(!n||typeof n.content!=='string'||!n.content.trim())throw Error('转发内容不能为空');
        return {type:'node',data:{uin:route.key.split('/')[0],name:String(n.name||'助手').slice(0,24),content:[{type:'text',data:{text:n.content.slice(0,500)}}]}};
      });
      return {action:route.group?'send_forward_msg':'send_private_forward_msg',params:{[route.group?'group_id':'user_id']:route.id,messages}};
    }
    let reply=parsed.reply??'',segments=[];
    const tagged=reply.match(/^\s*\[\[qq_voice\]\]([\s\S]+)\[\[\/qq_voice\]\]\s*$/);
    const voiceText=q.voice??tagged?.[1]??reply;
    const policy={...voiceDefaults,enabled:config.qqVoiceSend,mode:config.voiceReplyMode,quietHours:{start:config.voiceQuietStart,end:config.voiceQuietEnd}};
    if(!route.group&&(q.voice||tagged||config.voiceReplyMode==='voice')&&!textReason(voiceText,policy,new Date(this.now()))){
      try{
        const result=await this.voice.synthesize(voiceText,config),data=this.voice.audio(result.id),info=wavInfo(data);
        if(info.duration_seconds>60||data.length>MAX)throw Error('语音过长');
        segments=[{type:'record',data:{file:'base64://'+data.toString('base64')}}];
      }catch{reply=voiceText;} // Only preparation failure falls back. Never retry an uncertain send.
    }else if(q.voice||tagged)reply=voiceText;
    if(q.images?.length){
      if(!config.qqImages||q.images.length>9)throw Error('图片发送未启用或图片过多');
      for(const source of q.images){
        if(typeof source!=='string')throw Error('图片来源格式错误');
        if(!/^https?:\/\//i.test(source)&&inProtectedDir(session.workspace,path.resolve(session.workspace,source)))throw Error('不能发送受保护目录里的图片');
        if(!/^https?:\/\//i.test(source)&&path.resolve(session.workspace,source).split(/[\\/]/).some(p=>['.memory','.git','.credentials','.secrets'].includes(p.toLowerCase())))throw Error('不能发送受保护目录里的图片');
        const bytes=/^https?:\/\//i.test(source)?await this.download(source):fencedRead(path.resolve(session.workspace,source),[session.workspace,this.dir(route.key)]);
        if(!sniffImageMediaType(bytes))throw Error('图片格式不支持');
        segments.push({type:'image',data:{file:'base64://'+bytes.toString('base64')}});
      }
    }
    if(!segments.some(x=>x.type==='record')&&reply.trim()&&reply.trim()!=='[[QQ_SILENT]]')segments.unshift({type:'text',data:{text:reply.slice(0,4000)}});
    return segments.length?{action:route.group?'send_group_msg':'send_private_msg',params:{[route.group?'group_id':'user_id']:route.id,message:segments}}:null;
  }
}
