import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {LocalVoice} from './voice.mjs';
import {writeJson, readJson} from './config.mjs';
import {wavInfo} from '../../dsh-companion-voice/lib/core.mjs';

const MAX_AUDIO=8*1024*1024, MAX_REFERENCE=7*1024*1024;
const ENDPOINT='https://api.xiaomimimo.com/v1/chat/completions';
export function audioFormat(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length<12)throw Error('请提供有效的 WAV 或 MP3 音频');
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE'){
    try{wavInfo(bytes);}catch{throw Error('WAV 文件损坏或不是 PCM 格式');}
    return 'wav';
  }
  // MP3 ID3 tag or MPEG audio frame header. The provider validates full decoding.
  if(bytes.toString('ascii',0,3)==='ID3'||(bytes[0]===255&&(bytes[1]&224)===224&&(bytes[1]&6)!==0&&(bytes[2]&240)!==240&&(bytes[2]&12)!==12))return 'mp3';
  throw Error('请提供有效的 WAV 或 MP3 音频');
}
export class VoiceService extends LocalVoice{
  constructor(root,runtime,{fetch:fetcher=globalThis.fetch,timeoutMs=120000}={}){
    super(root,runtime);this.fetch=fetcher;this.timeoutMs=timeoutMs;
    this.references=path.join(runtime,'voice-references');
    fs.mkdirSync(this.references,{recursive:true});
  }
  safeReferenceFile(name){
    const file=path.join(this.references,name);
    if(fs.lstatSync(this.references).isSymbolicLink())throw Error('参考录音目录无效');
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>MAX_REFERENCE)throw Error('参考录音文件无效');
    return file;
  }
  reference(id,{includeDeleted=false}={}){
    if(typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id))throw Error('请选择已上传的参考录音');
    try{
      const meta=readJson(this.safeReferenceFile(id+'.json'),null);
      if(meta.id!==id||!['wav','mp3'].includes(meta.format))throw Error();
      if(meta.deletedAt&&!includeDeleted)throw Error();
      const bytes=fs.readFileSync(this.safeReferenceFile(id+'.'+meta.format));
      if(audioFormat(bytes)!==meta.format)throw Error();
      return {meta,bytes};
    }catch{throw Error('参考录音不存在或已损坏，请重新上传');}
  }
  listReferences({deleted=false}={}){
    const results=[];
    for(const name of fs.readdirSync(this.references)){
      if(!/^[0-9a-f-]{36}\.json$/.test(name))continue;
      try{const meta=this.reference(name.slice(0,-5),{includeDeleted:true}).meta;if(!!meta.deletedAt===deleted)results.push(meta);}catch{}
    }
    return results.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  archiveReference(id,restore=false){
    if(this.busy)throw Error('语音任务进行中，请稍后修改录音');
    const {meta}=this.reference(id,{includeDeleted:true});
    if(restore){if(this.listReferences().length>=20&&!this.listReferences().some(x=>x.id===id))throw Error('参考录音最多保存 20 份');delete meta.deletedAt;}
    else meta.deletedAt=new Date().toISOString();
    writeJson(this.safeReferenceFile(id+'.json'),meta);return meta;
  }
  uploadReference(bytes,name){
    if(!Buffer.isBuffer(bytes)||bytes.length>MAX_REFERENCE)throw Error('参考录音不能超过 7 MiB');
    if(typeof name!=='string'||!name.trim()||name.length>80)throw Error('请填写 1–80 字的音色名称');
    if(this.listReferences().length>=20)throw Error('参考录音最多保存 20 份');
    if(fs.lstatSync(this.references).isSymbolicLink())throw Error('参考录音目录无效');
    const format=audioFormat(bytes),id=randomUUID(),meta={id,name:name.trim(),format,size:bytes.length,createdAt:new Date().toISOString()};
    const file=path.join(this.references,id+'.'+format);
    fs.writeFileSync(file,bytes,{flag:'wx',mode:0o600});
    try{writeJson(path.join(this.references,id+'.json'),meta);}catch(error){fs.unlinkSync(file);throw error;}
    return meta;
  }
  checkConfig(config){
    if(config.voiceProvider!=='mimo')return;
    if(!config.mimoApiKey)throw Error('请先填写并保存 MiMo API Key');
    if(config.mimoTtsMode==='clone')this.reference(config.mimoReferenceId);
  }
  status(config){
    if(config.voiceProvider!=='mimo')return {...super.status(config),provider:'local'};
    let referenceReady=config.mimoTtsMode!=='clone';
    if(!referenceReady)try{this.reference(config.mimoReferenceId);referenceReady=true;}catch{}
    return {busy:this.busy,provider:'mimo',engine:'MiMo API',model:'mimo-v2.5-asr',
      asrReady:!!config.mimoApiKey,ttsReady:!!config.mimoApiKey&&referenceReady,
      credentialVerified:false};
  }
  async call(payload,config){
    if(!config.mimoApiKey)throw Error('请先填写并保存 MiMo API Key');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    try{
      const response=await this.fetch(ENDPOINT,{method:'POST',redirect:'error',signal:controller.signal,
        headers:{'Content-Type':'application/json','api-key':config.mimoApiKey},body:JSON.stringify(payload)});
      if(!response.ok){
        await response.body?.cancel();
        throw Error(({401:'MiMo 密钥无效，请重新配置',403:'MiMo 拒绝访问，请检查密钥权限',429:'MiMo 额度不足或请求过多，请稍后重试'})[response.status]||'MiMo 服务请求失败，请稍后重试');
      }
      const reader=response.body.getReader(),parts=[];let size=0;
      try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>12*1024*1024)throw Error('MiMo 返回内容超过大小限制');parts.push(value);}}
      catch(error){await reader.cancel().catch(()=>{});throw error;}
      let result;try{result=JSON.parse(Buffer.concat(parts).toString());}catch{throw Error('MiMo 返回了无效数据');}
      const choice=result.choices?.[0];
      if(choice?.finish_reason!=='stop')throw Error('MiMo 未完整生成结果，请调整内容后重试');
      return {message:choice.message,usage:result.usage};
    }catch(error){
      if(controller.signal.aborted)throw Error('MiMo 请求超时，请稍后重试');
      // Do not surface remote response bodies or fetch errors containing credentials.
      if(error.message?.startsWith('MiMo '))throw error;
      throw Error('MiMo 网络请求失败，请检查网络和配置');
    }finally{clearTimeout(timer);}
  }
  async synthesize(text,config){
    if(config.voiceProvider!=='mimo')return super.synthesize(text,config);
    if(typeof text!=='string'||!text.trim()||text.length>300)throw Error('请输入 1–300 字的测试文字');
    this.checkConfig(config);
    return this.exclusive(async()=>{
      let voice=config.mimoVoice;
      if(config.mimoTtsMode==='clone'){const {meta,bytes}=this.reference(config.mimoReferenceId);voice=`data:audio/${meta.format};base64,${bytes.toString('base64')}`;}
      const messages=[];
      if(config.mimoStyle)messages.push({role:'user',content:config.mimoStyle});
      messages.push({role:'assistant',content:text});
      const model=config.mimoTtsMode==='clone'?'mimo-v2.5-tts-voiceclone':'mimo-v2.5-tts';
      const {message}=await this.call({model,messages,audio:{format:'wav',voice},stream:false},config);
      const encoded=message?.audio?.data;
      if(typeof encoded!=='string'||encoded.length>Math.ceil(MAX_AUDIO/3)*4||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw Error('MiMo 返回的音频无效');
      const bytes=Buffer.from(encoded,'base64');try{wavInfo(bytes);}catch{throw Error('MiMo 返回的 WAV 音频无效');}
      if(bytes.length>MAX_AUDIO)throw Error('MiMo 音频超过大小限制');
      const id=randomUUID();fs.writeFileSync(path.join(this.dir,id+'.wav'),bytes,{flag:'wx',mode:0o600});
      return {id,audioUrl:'/api/audio/'+id,provider:'MiMo API',model};
    });
  }
  async transcribe(bytes,config){
    if(config.voiceProvider!=='mimo')return super.transcribe(bytes,config);
    if(!Buffer.isBuffer(bytes)||bytes.length>MAX_AUDIO)throw Error('音频不能超过 8 MiB');
    const format=audioFormat(bytes);
    return this.exclusive(async()=>{
      const model='mimo-v2.5-asr';
      const {message,usage}=await this.call({model,messages:[{role:'user',content:[{type:'input_audio',input_audio:{data:`data:audio/${format};base64,${bytes.toString('base64')}`,format}}]}],
        asr_options:{language:config.mimoAsrLanguage},stream:false},config);
      if(typeof message?.content!=='string'||message.content.length>100000)throw Error('MiMo 返回的识别文字无效');
      return {text:message.content,model,provider:'MiMo API',duration:format==='wav'?wavInfo(bytes).duration_seconds:(Number.isFinite(usage?.seconds)?usage.seconds:null)};
    });
  }
  async transcribeRecord(file,config){
    if(config.voiceProvider==='mimo'){
      const bytes=fs.readFileSync(file);if(bytes.length>MAX_AUDIO)throw Error('QQ 语音超过大小限制');
      let format;try{format=audioFormat(bytes);}catch{}
      if(format)return this.transcribe(bytes,config);
    }
    return super.transcribeRecord(file,config);
  }
}
