import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {readJson,writeJson,validate,defaults} from './config.mjs';
import {MemoryStore} from './memory.mjs';
import {personaIdentity} from './persona-cards.mjs';

export const voiceSettingFields=['voiceProvider','voice','model','mimoTtsMode','mimoVoice','mimoReferenceId','mimoStyle','mimoDesign','mimoAsrLanguage'];
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class VoiceProfiles {
  constructor(runtime){this.runtime=runtime;this.file=path.join(runtime,'voice-profiles.private.json');}
  read(){return readJson(this.file,{revision:0,profiles:[]});}
  settings(input){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!voiceSettingFields.includes(k)))throw Error('语音预设只能保存音色和服务选项，不包含密钥');
    const checked=validate(input);
    if(checked.voiceProvider==='mimo'&&checked.mimoTtsMode==='design'&&!checked.mimoDesign)throw Error('请填写音色设计描述');
    if(checked.voiceProvider==='mimo'&&checked.mimoTtsMode==='clone'&&!checked.mimoReferenceId)throw Error('音色克隆需要选择参考录音');
    return Object.fromEntries(voiceSettingFields.map(k=>[k,checked[k]??defaults[k]]));
  }
  get(id){const profile=this.read().profiles.find(p=>p.id===id&&!p.deletedAt);if(!profile)throw Error('语音预设不存在或已删除');return profile;}
  save({id,name,settings,revision}){
    const state=this.read();if(revision!==state.revision)throw Error('语音预设已变化，请重新加载后保存');
    if(typeof name!=='string'||!name.trim()||name.length>80)throw Error('请填写 1–80 字的预设名称');
    let profile=id?state.profiles.find(p=>p.id===id&&!p.deletedAt):null;
    if(id&&!profile)throw Error('语音预设不存在或已删除');
    if(!profile){if(state.profiles.filter(p=>!p.deletedAt).length>=50)throw Error('最多保存 50 个语音预设');profile={id:randomUUID()};state.profiles.push(profile);}
    Object.assign(profile,{name:name.trim(),settings:this.settings(settings),updatedAt:new Date().toISOString()});
    state.revision++;writeJson(this.file,state);return profile;
  }
  archive({id,revision,restore=false}){
    const state=this.read();if(revision!==state.revision)throw Error('语音预设已变化，请重新加载');
    const profile=state.profiles.find(p=>p.id===id);if(!profile)throw Error('语音预设不存在');
    if(restore){if(state.profiles.filter(p=>!p.deletedAt).length>=50)throw Error('最多保存 50 个语音预设');delete profile.deletedAt;}
    else profile.deletedAt=new Date().toISOString();
    state.revision++;writeJson(this.file,state);return profile;
  }
  selection(key,personaId){
    const store=new MemoryStore(this.runtime,key,personaId),saved=readJson(store.safe('.runtime/persona-voice.json'),null);
    return {saved,revision:hash(saved)};
  }
  assign({key,personaId,profileId,revision}){
    if(typeof profileId!=='string')throw Error('请选择语音预设或沿用全局默认');
    const previous=this.selection(key,personaId);if(previous.revision!==revision)throw Error('此人设的语音配置已变化，请刷新后保存');
    const saved=profileId?{profileId,...this.get(profileId),savedAt:new Date().toISOString()}:null;
    if(saved){delete saved.id;delete saved.updatedAt;}
    writeJson(new MemoryStore(this.runtime,key,personaId).safe('.runtime/persona-voice.json'),saved);
    return this.selection(key,personaId);
  }
  resolve(config,key){
    // Read only: resolving a voice must not create a memory library when disabled.
    const {scope}=personaIdentity(this.runtime,key),dir=path.join(this.runtime,'memories',scope);
    const file=path.join(dir,'.runtime','persona-voice.json');
    for(const target of [dir,path.dirname(file),file])if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw Error('人设语音配置路径无效');
    const saved=readJson(file,null);
    return saved?{...config,...this.settings(saved.settings)}:config;
  }
  referenceUsed(id){
    const uses=settings=>settings?.voiceProvider==='mimo'&&settings.mimoTtsMode==='clone'&&settings.mimoReferenceId===id;
    if(this.read().profiles.some(p=>!p.deletedAt&&uses(p.settings)))return true;
    const dir=path.join(this.runtime,'memories');if(!fs.existsSync(dir))return false;
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      if(!entry.isDirectory()||entry.isSymbolicLink()||!/^[a-f0-9]{64}$/.test(entry.name))continue;
      const file=path.join(dir,entry.name,'.runtime','persona-voice.json');
      if(fs.existsSync(file)&&!fs.lstatSync(file).isSymbolicLink()&&uses(readJson(file,null)?.settings))return true;
    }
    return false;
  }
}
