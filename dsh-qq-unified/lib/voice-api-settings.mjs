import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const voiceApiDefaults={ttsProvider:'windows',asrEnabled:false,mimoVoice:'mimo_default',mimoStyle:'',timeoutMs:60000};
const sttKeys=['sttEnabled','sttEngine','sttCommand','sttArgs','sttTimeoutMs'];
export function transcriptionScript(){
  const here=path.dirname(fileURLToPath(import.meta.url));
  const candidates=[path.join(here,'voice','transcribe-mimo.mjs'),path.resolve(here,'../../dsh-companion-voice/lib/transcribe-mimo.mjs')];
  const found=candidates.find(file=>fs.existsSync(file));
  if(!found)throw Error('MiMo 语音识别脚本缺失，请重新构建统一插件');
  return found;
}
export function planAsrChange(previous,next,profile,configFile){
  const was=previous.asrEnabled===true,enabled=next.asrEnabled===true;
  if(!was&&!enabled)return null;
  // Do not silently replace a different ASR configuration edited outside this panel.
  if(was&&(profile.sttEngine!=='custom'||!Array.isArray(profile.sttArgs)||!profile.sttArgs.includes(configFile)))throw Error('语音识别配置已在其他位置改变，请先核对再切换');
  if(enabled){
    if(!was)next.previousStt=Object.fromEntries(sttKeys.map(key=>[key,{present:Object.hasOwn(profile,key),value:profile[key]??null}]));
    const script=transcriptionScript();
    const change={sttEnabled:true,sttEngine:'custom',sttCommand:process.versions.electron?'node':process.execPath,
      sttArgs:[script,'--file','{file}','--out','{out}','--config',configFile],sttTimeoutMs:next.timeoutMs+5000};
    return fresh=>({...fresh,...change});
  }
  if(!previous.previousStt)throw Error('缺少原语音识别配置备份，无法自动恢复');
  delete next.previousStt;
  return fresh=>{const restored={...fresh};for(const key of sttKeys){const old=previous.previousStt[key];if(old?.present)restored[key]=old.value;else delete restored[key];}return restored;};
}
