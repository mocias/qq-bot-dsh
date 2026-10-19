import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {readApiConfig,mimoSpeech} from './mimo-api.mjs';
const exec=promisify(execFile);
export const VOICE_HOOK=Symbol.for('dsh.companion.voice.reply.v1');
export const OWNER='100000001';
export const OWNER_CHAT=`private:${OWNER}`;
export const defaults={enabled:true,mode:'auto',maxCharacters:180,quietHours:{start:23,end:8},timeZone:'Asia/Shanghai',voice:'Microsoft Huihui Desktop'};
export function ownerSession(id='') {return id===`onebot-private-${OWNER}`||id.startsWith(`onebot-private-${OWNER}-`);}
export function preferenceAllowed(id='') {return ownerSession(id)||(!id.startsWith('onebot-')&&id.length>0);}
export function readPolicy(file){
 const policy={...defaults,...(fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{})};
 if(typeof policy.enabled!=='boolean'||!['auto','text','voice'].includes(policy.mode)||!Number.isInteger(policy.maxCharacters)||policy.maxCharacters<1||policy.maxCharacters>300)throw Error('Invalid voice policy');
 for(const key of ['start','end'])if(!Number.isInteger(policy.quietHours?.[key])||policy.quietHours[key]<0||policy.quietHours[key]>23)throw Error('Invalid quiet hours');
 new Intl.DateTimeFormat('en',{timeZone:policy.timeZone}).format();return policy;
}
export function textReason(text,policy,now=new Date()){
 if(!policy.enabled||policy.mode==='text')return 'text_preference';
 if(!text.trim()||text.length>policy.maxCharacters)return 'length';
 if(/```|https?:\/\/|[a-zA-Z]:[\\/]|(?:^|\n)\s*(?:\d+[.)、]|[-*]\s)|\|\s*---|(?:^|\s)\/[a-z][\w/-]+/m.test(text))return 'technical_content';
 const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:policy.timeZone,hour:'2-digit',hourCycle:'h23'}).format(now));
 const {start,end}=policy.quietHours;
 const quiet=start===end?false:start<end?hour>=start&&hour<end:hour>=start||hour<end;
 if(quiet&&policy.mode!=='voice')return 'quiet_hours';return null;
}
export function writeMode(file,mode){
 if(!['auto','text','voice'].includes(mode))throw Error('Invalid reply mode');
 const policy={...readPolicy(file),mode};fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file+'.tmp',JSON.stringify(policy,null,2)+'\n');fs.renameSync(file+'.tmp',file);return policy;
}
export function wavInfo(buffer){
 if(buffer.length<44||buffer.toString('ascii',0,4)!=='RIFF'||buffer.toString('ascii',8,12)!=='WAVE')throw Error('Synthesis did not produce a WAV file');
 let byteRate=0,size=0,format=0;
 for(let at=12;at+8<=buffer.length;){const tag=buffer.toString('ascii',at,at+4),length=buffer.readUInt32LE(at+4);if(at+8+length>buffer.length)throw Error('Truncated WAV');
  if(tag==='fmt '&&length>=16){format=buffer.readUInt16LE(at+8);byteRate=buffer.readUInt32LE(at+16)}if(tag==='data')size=length;at+=8+length+(length%2);
 }
 if(format!==1||!byteRate||!size)throw Error('Invalid PCM WAV');return {duration_seconds:size/byteRate,bytes:buffer.length};
}
export async function synthesize(text,{runtime,voice,script,signal}={}){
 fs.mkdirSync(runtime,{recursive:true});const id=randomUUID(),request=path.join(runtime,id+'.json'),file=path.join(runtime,id+'.wav');
 fs.writeFileSync(request,JSON.stringify({text,file,voice}));
 try{
  await exec('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-File',script,'-RequestFile',request],{timeout:60000,windowsHide:true,encoding:'utf8',maxBuffer:262144,signal});
  const audio=fs.readFileSync(file);const info=wavInfo(audio);
  if(info.bytes>8*1024*1024||info.duration_seconds>60)throw Error('Generated voice exceeds size or duration limit');
  return {file,audio,info};
 }finally{try{fs.unlinkSync(request)}catch{}}
}
export function createTransport({policyFile,runtime,script,apiConfigFile,tts,now=()=>new Date(),audit=()=>{}}){
 let serial=Promise.resolve();
 return {async prepare(chatId,text){
  if(chatId!==OWNER_CHAT)return {text,reason:'unauthorized_target'};
  const policy=readPolicy(policyFile),reason=textReason(text,policy,now());
  if(reason)return {text,reason};
  const task=serial.catch(()=>{}).then(async()=>{
   const api=apiConfigFile?readApiConfig(apiConfigFile):{ttsProvider:'windows'};
   let result;
   if(tts)result=await tts(text,{runtime,voice:policy.voice,script});
   else if(api.ttsProvider==='mimo'){
    const audio=await mimoSpeech(text,api),info=wavInfo(audio);
    if(info.duration_seconds>60)throw Error('Generated voice exceeds duration limit');
    result={audio,info};
   }else if(api.ttsProvider==='windows')result=await synthesize(text,{runtime,voice:policy.voice,script});
   else throw Error('Unknown voice provider');
   const digest=createHash('sha256').update(text).digest('hex');
   audit({event:'synthesized',text_hash:digest,...result.info});
   return {segments:[{type:'record',data:{file:'base64://'+result.audio.toString('base64')}}],reason:'voice_selected',duration_seconds:result.info.duration_seconds};
  });serial=task;return task;
 }};
}
