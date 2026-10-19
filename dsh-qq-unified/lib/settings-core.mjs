import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {voiceApiDefaults,planAsrChange} from './voice-api-settings.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy=value=>JSON.parse(JSON.stringify(value??null));
const bool=value=>{if(typeof value!=='boolean')throw Error('请填写开关值');return value;};
const number=(min,max)=>value=>{if(!Number.isInteger(value)||value<min||value>max)throw Error(`数值必须为 ${min}–${max} 的整数`);return value;};
const text=(max=200)=>value=>{if(typeof value!=='string'||value.length>max)throw Error('文字格式或长度不正确');return value;};
const choice=values=>value=>{if(!values.includes(value))throw Error('不支持的选项');return value;};
const clock=value=>{if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))throw Error('时间格式须为 HH:MM');return value;};
const zone=value=>{text(100)(value);new Intl.DateTimeFormat('en',{timeZone:value}).format();return value;};
const fields={
  private:{splitShortTextBubbles:bool,queueNoticeEnabled:bool,interimMessages:bool,compactionRotationEnabled:bool,ownerSteer:bool},
  group:{enabled:bool,proactiveEnabled:bool,timeZone:zone,activeStart:clock,activeEnd:clock,minReplyGapSeconds:number(0,3600),
    ambientCheckMinutes:number(0,1440),maxRepliesPerHour:number(0,1000),maxAmbientPerHour:number(0,1000),maxProactivePerDay:number(0,100),
    proactiveMinMinutes:number(1,10080),proactiveMaxMinutes:number(1,10080),directDebounceMs:number(0,60000),ambientDebounceMs:number(0,60000)},
  groupModel:{modelProvider:text(128),modelId:text(128),reasoningEffort:choice(['low','medium','high','max']),personaEvolution:bool},
  voice:{enabled:bool,mode:choice(['text','auto','voice']),maxCharacters:number(1,300),quietStart:number(0,23),quietEnd:number(0,23),voice:text(200)},
  voiceApi:{ttsProvider:choice(['windows','mimo']),asrEnabled:bool,apiKey:value=>{text(2048)(value);if(/[\r\n]/.test(value))throw Error('密钥不能含换行');return value.trim();},mimoVoice:choice(['mimo_default','冰糖','茉莉','苏打','白桦','Mia','Chloe','Milo','Dean']),mimoStyle:text(2000),timeoutMs:number(1000,120000)},
  proactive:{enabled:bool,activeStart:clock,activeEnd:clock,intervalMinMinutes:number(1,10080),intervalMaxMinutes:number(1,10080),maxPerDay:number(0,100),autonomousActions:bool,desktopIdleSeconds:number(0,86400)},
  memory:{digestNudgeEnabled:bool,digestNudgeMode:choice(['compaction-idle','conversation-idle']),digestIdleMinutes:number(1,10080),digestRotateAfterCompactions:number(1,1000),digestMinTurns:number(1,1000)},
  connection:{url:value=>{text(1000)(value);const u=new URL(value);if(!['ws:','wss:'].includes(u.protocol)||u.username||u.password)throw Error('连接地址须为 ws:// 或 wss://');return value;},accessToken:text(2048)},
  privatePersona:{content:text(30000)},groupPersona:{content:text(30000)},
};

export function validatePatch(section,patch){
  if(!Object.hasOwn(fields,section)||!patch||typeof patch!=='object'||Array.isArray(patch))throw Error('未知设置分区');
  const clean={};for(const [key,value]of Object.entries(patch)){if(!Object.hasOwn(fields[section],key))throw Error(`不能修改字段：${key}`);clean[key]=fields[section][key](value);}
  if(Object.keys(clean).length===0)return clean;
  if(section.endsWith('Persona')&&(!clean.content||!clean.content.trim()))throw Error('人设不能为空');
  return clean;
}

/** Fixed owner-controlled files only; UI payloads never supply paths. */
export function checkedFile(root,file){
  const base=path.resolve(root),target=path.resolve(file),relative=path.relative(base,target);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('配置路径越出工作区');
  let current=path.parse(target).root;
  for(const segment of target.slice(current.length).split(path.sep).filter(Boolean)){
    if(segment.includes(':')||/[. ]$/.test(segment)||segment.includes('\0'))throw Error('配置路径无效');
    current=path.join(current,segment);if(!fs.existsSync(current))continue;
    const s=fs.lstatSync(current);if(s.isSymbolicLink()||(s.isFile()&&s.nlink>1))throw Error('配置文件不允许链接或硬链接');
  }
  return target;
}
function read(root,file,fallback){const p=checkedFile(root,file);if(!fs.existsSync(p))return fallback;if(fs.statSync(p).size>1024*1024)throw Error('配置文件过大');return fs.readFileSync(p,'utf8');}
function json(root,file,fallback={}){const data=read(root,file,null);return data===null?fallback:JSON.parse(data);}
function write(root,file,content){const p=checkedFile(root,file);fs.mkdirSync(path.dirname(p),{recursive:true});const tmp=checkedFile(root,p+'.'+randomUUID()+'.tmp');fs.writeFileSync(tmp,content,{flag:'wx'});try{checkedFile(root,p);fs.renameSync(tmp,p);}catch(error){try{fs.unlinkSync(tmp)}catch{}throw error;}}
function project(value,keys){return Object.fromEntries(keys.filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));}

export class QQSettingsStore{
  constructor({editor,hub,models,defaultModel}){this.editor=editor;this.hub=hub;this.models=models;this.defaultModel=defaultModel;this.serial=Promise.resolve();}
  entry(id){const e=this.editor.entries().find(e=>e.options.id===id);if(!e)throw Error(`QQ 组件未加载：${id}`);return e;}
  files(){
    const p=this.entry('dsh-onebot').options.config??{},g=this.entry('companion-group-social').options.config??{};
    const privateRoot=p.workspacePath||'D:/qq-bot-dsh/dsh-companion',groupRoot=g.workspacePath||'D:/qq-bot-dsh/dsh-group-100000003';
    if(path.resolve(privateRoot).toLowerCase()===path.resolve(groupRoot).toLowerCase())throw Error('私聊与群聊工作区必须独立');
    const memory=g.root||path.join(groupRoot,'.memory');return {privateRoot,groupRoot,
      groupPolicy:path.join(memory,'policy.json'),groupPersona:g.personaFile||path.join(memory,'PERSONA.md'),
      groupStatus:path.join(g.runtime||path.join(groupRoot,'.runtime'),'status.json'),
      voice:path.join(privateRoot,'.memory','voice.json'),proactive:path.join(privateRoot,'.memory','proactive.json'),
      voiceApi:path.join(privateRoot,'.runtime','voice-api.private.json'),
      privatePersona:path.join(privateRoot,'.memory','SOUL.md')};
  }
  raw(){const f=this.files();return {f,private:this.entry('dsh-onebot').options.config??{},groupModel:this.entry('companion-group-social').options.config??{},memory:this.entry('dsh-memory').options.config??{},
    group:json(f.groupRoot,f.groupPolicy),voice:json(f.privateRoot,f.voice),proactive:json(f.privateRoot,f.proactive),
    voiceApi:json(f.privateRoot,f.voiceApi),
    privatePersona:read(f.privateRoot,f.privatePersona,''),groupPersona:read(f.groupRoot,f.groupPersona,'')};}
  snapshot(){
    const r=this.raw(),f=r.f,status=json(f.groupRoot,f.groupStatus,{});const group={...r.group,activeStart:r.group.activeHours?.start,activeEnd:r.group.activeHours?.end};
    const voice={...r.voice,quietStart:r.voice.quietHours?.start,quietEnd:r.voice.quietHours?.end};
    const proactive={...r.proactive,activeStart:r.proactive.activeHours?.start,activeEnd:r.proactive.activeHours?.end};
    return copy({revision:hash(r),workspaces:{private:f.privateRoot,group:f.groupRoot},
      status:{transport:this.hub?.snapshot?.()??{connected:false,connectionCount:0,subscribers:0},group:{connected:status.connected===true,modelReady:status.modelReady===true,lastError:status.lastError??null,session:status.nativeSession?.id??null},
        privateDefaultModel:this.defaultModel?.()??null},
      private:{splitShortTextBubbles:r.private.splitShortTextBubbles===true,queueNoticeEnabled:r.private.queueNoticeEnabled!==false,interimMessages:r.private.interimMessages===true,
        compactionRotationEnabled:r.private.compactionRotationEnabled===true,ownerSteer:(r.private.directSteerPrivateUsers??[]).includes('100000001')},
      connection:{url:r.private.url??'',tokenConfigured:!!r.private.accessToken,account:String(r.private.botQQ??'')},
      group:project(group,Object.keys(fields.group)),groupModel:{modelProvider:r.groupModel.modelProvider??'',modelId:r.groupModel.modelId??'',reasoningEffort:r.groupModel.reasoningEffort??'high',personaEvolution:r.groupModel.personaEvolution!==false},
      voice:project(voice,Object.keys(fields.voice)),proactive:project(proactive,Object.keys(fields.proactive)),
      voiceApi:{...project({...voiceApiDefaults,...r.voiceApi},Object.keys(fields.voiceApi).filter(k=>k!=='apiKey')),apiKey:'',apiKeyConfigured:!!(r.voiceApi.apiKey||process.env.MIMO_API_KEY)},
      memory:{digestNudgeEnabled:r.memory.digestNudgeEnabled!==false,digestNudgeMode:r.memory.digestNudgeMode??'compaction-idle',digestIdleMinutes:r.memory.digestIdleMinutes??30,digestRotateAfterCompactions:r.memory.digestRotateAfterCompactions??15,digestMinTurns:r.memory.digestMinTurns??3},
      privatePersona:{content:r.privatePersona},groupPersona:{content:r.groupPersona},
      permissions:{private:'电脑工具仅限已授权私人会话；保留宿主审批。',group:'独立工作区；仅群内搜索、受限文件、群记忆和图片工具。无终端、桌面或私聊记忆权限。'}});
  }
  update(section,patch,expectedRevision){const job=this.serial.catch(()=>{}).then(()=>this.apply(section,patch,expectedRevision));this.serial=job;return job;}
  async apply(section,patch,expectedRevision){
    const clean=validatePatch(section,patch),r=this.raw(),f=r.f;if(typeof expectedRevision!=='string'||expectedRevision!==hash(r))throw Error('配置已被其他窗口或机器人更新，请刷新后重新保存。');
    if(!Object.keys(clean).length)return this.snapshot();
    if(section==='voiceApi'){
      const next={...voiceApiDefaults,...r.voiceApi,...clean};
      if(clean.apiKey==='')next.apiKey=r.voiceApi.apiKey??'';
      if((next.ttsProvider==='mimo'||next.asrEnabled)&&!(next.apiKey||process.env.MIMO_API_KEY))throw Error('请先填写 MiMo API Key，或为 DSH 配置 MIMO_API_KEY');
      const change=planAsrChange(r.voiceApi,next,r.private,f.voiceApi);
      write(f.privateRoot,f.voiceApi,JSON.stringify(next,null,2)+'\n');
      try{if(change)await this.editor.edit(this.entry('dsh-onebot'),change);}
      catch{write(f.privateRoot,f.voiceApi,JSON.stringify(r.voiceApi,null,2)+'\n');throw Error('语音识别配置保存失败，已恢复语音 API 配置，请刷新后核对连接状态');}
    }else if(['private','memory','groupModel','connection'].includes(section)){
      const id=section==='memory'?'dsh-memory':section==='groupModel'?'companion-group-social':'dsh-onebot';
      const entry=this.entry(id);let change={...clean};
      if(section==='private'&&Object.hasOwn(change,'ownerSteer')){
        const current=(r.private.directSteerPrivateUsers??[]).filter(id=>id!=='100000001');
        if(change.ownerSteer)current.push('100000001');change.directSteerPrivateUsers=current;delete change.ownerSteer;
      }
      if(section==='connection'&&change.accessToken==='')delete change.accessToken;
      if(section==='groupModel'){
        const merged={...r.groupModel,...change};if(!merged.modelProvider||!merged.modelId)throw Error('请选择完整的模型提供方和模型');
        if(this.models)await this.models(merged.modelProvider,merged.modelId);
      }
      const original=entry.options.config??{};if(JSON.stringify({...original,...change})!==JSON.stringify(original))await this.editor.edit(entry,fresh=>({...fresh,...change}));
    }else if(section.endsWith('Persona')){
      const group=section==='groupPersona',root=group?f.groupRoot:f.privateRoot,file=group?f.groupPersona:f.privatePersona;
      if(read(root,file,'')!==clean.content)write(root,file,clean.content);
    }else{
      const group=section==='group',voice=section==='voice',root=group?f.groupRoot:f.privateRoot,file=group?f.groupPolicy:voice?f.voice:f.proactive;
      const next={...r[section],...clean};
      if(voice){next.quietHours={...r.voice.quietHours};for(const [k,to]of [['quietStart','start'],['quietEnd','end']]){if(Object.hasOwn(clean,k))next.quietHours[to]=clean[k];delete next[k];}}
      else {next.activeHours={...r[section].activeHours};for(const [k,to]of [['activeStart','start'],['activeEnd','end']]){if(Object.hasOwn(clean,k))next.activeHours[to]=clean[k];delete next[k];}}
      if(group&&next.proactiveMaxMinutes<next.proactiveMinMinutes)throw Error('主动发言最长间隔不能小于最短间隔');
      if(section==='proactive'&&next.intervalMaxMinutes<next.intervalMinMinutes)throw Error('最长间隔不能小于最短间隔');
      if(JSON.stringify(next)!==JSON.stringify(r[section]))write(root,file,JSON.stringify(next,null,2)+'\n');
    }
    return this.snapshot();
  }
}
