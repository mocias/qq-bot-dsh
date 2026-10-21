import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { defaults, readJson, writeJson, validate, publicConfig } from './lib/config.mjs';
import { VoiceService } from './lib/voice-service.mjs';
import { Bridge } from './lib/bridge.mjs';
import { DshClient } from './lib/dsh.mjs';
import { importedStores } from './lib/import-memory.mjs';
import { probeQQ } from './lib/onebot.mjs';
import { MemoryStore } from './lib/memory.mjs';
import {currentRoleState} from './lib/role-state.mjs';
import {Management} from './lib/management.mjs';
import {Knowledge} from './lib/knowledge.mjs';
import {publicDownload} from './lib/media.mjs';
import {sniffImageMediaType} from '../dsh-group-social/lib/images.mjs';
import {publicSearch} from './lib/chat-tools.mjs';
import { DesktopQQ } from './lib/desktop-qq.mjs';
import {policyView,policyRevision,resolveChatConfig} from './lib/chat-policy.mjs';
import {syncNapcat} from './lib/napcat-sync.mjs';
import {QQControl} from './lib/qq-control.mjs';
import {SystemLog} from './lib/system-log.mjs';
import {DiagnosticLogs,redactLog} from './lib/diagnostic-logs.mjs';
import {wakeSeconds} from './lib/timing.mjs';
import {recoverMemoryReset,resetMemories} from './lib/reset-memory.mjs';
import {VoiceProfiles} from './lib/voice-profiles.mjs';
import {PersonaCards,personaIdentity} from './lib/persona-cards.mjs';
import {PromptProfiles} from './lib/prompt-profiles.mjs';
import {exportMemory} from './lib/export-memory.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export function createApp({ root = path.dirname(here), runtime = path.join(here,'.runtime'), voice: injectedVoice, bridge: injectedBridge, qqControl: injectedControl, diagnosticOptions } = {}) {
  const configFile=path.join(runtime,'config.private.json');
  let config=validate(readJson(configFile, defaults));
  recoverMemoryReset(runtime);
  const systemLog=new SystemLog(runtime);
  const voice=injectedVoice || new VoiceService(root,runtime), bridge=injectedBridge || new Bridge(runtime,{voice});
  bridge.systemLog=systemLog;
  const desktop=new DesktopQQ(runtime),management=new Management(runtime);
  const qqControl=injectedControl||new QQControl();
  const diagnosticLogs=new DiagnosticLogs(runtime,qqControl,diagnosticOptions);
  const voiceProfiles=new VoiceProfiles(runtime);
  const personaCards=new PersonaCards(runtime);
  const promptProfiles=new PromptProfiles(runtime);
  function promptPayload(key,personaId){
    if(key)checkKey(key,false,personaId);
    return {...promptProfiles.view(key,personaId),targets:keys().map(key=>({key,...personaCards.view(key)})),
      components:[
        {name:'DSH系统与预设',location:'由DSH管理，包含基础模型指令、已授权工具、审批和工作区上下文。'},
        {name:'QQ提示词',location:'本页编辑：聊天风格、回复范围、持续等待、模拟、主动搭话、委派、交接、发送纠正及非记忆工具说明。'},
        {name:'人设',location:'在人设与记忆页面按人格单独编辑，不纳入本页。'},
        {name:'记忆及记忆维护规则',location:'由当前人格记忆模块注入；记忆正文、人设工具与记忆专用规则不纳入本页。'},
        {name:'动态聊天数据',location:'当前时间、消息、图片、引用、身份代号、知识资料、模拟编号、工具结果及交接记录自动填入，不是可编辑模板。'}]};
  }
  function profilePayload(){const state=voiceProfiles.read();return {...state,profiles:state.profiles.map(p=>({...p,status:voice.status({...config,...p.settings})}))};}
  function checkProfile(settings){if(settings.voiceProvider==='mimo'&&settings.mimoTtsMode==='clone')voice.reference(settings.mimoReferenceId);}
  function previewConfig(input){return input.profileId?{...config,...voiceProfiles.get(input.profileId).settings}:config;}
  let napcatSyncBusy=false,managementNetwork=0;
  async function syncInterface(){
    idleConfig();napcatSyncBusy=true;
    try{return await syncNapcat(config,runtime);}finally{napcatSyncBusy=false;}
  }
  function keys(){
    const values=new Set(),dir=path.join(runtime,'memories');
    if(fs.existsSync(dir))for(const e of fs.readdirSync(dir,{withFileTypes:true}))if(e.isDirectory()&&!e.isSymbolicLink()&&/^[a-f0-9]{64}$/.test(e.name)){const meta=readJson(path.join(dir,e.name,'.runtime','store.json'),null);if(meta?.key)values.add(meta.key);}
    if(config.botQQ){for(const id of config.privateUsers)values.add(config.botQQ+'/private/'+id);for(const id of config.groups)values.add(config.botQQ+'/group/'+id);}
    return [...values];
  }
  function checkKey(key,writing=false,personaId){
    if(!keys().includes(key))throw Error('请选择已配置或已有记忆的聊天');
    if(personaId!==undefined){personaCards.get(key,personaId);if(personaId!==personaCards.view(key).activeId)writing=false;}
    if(writing&&(bridge.jobs?.has(key)||bridge.queues?.has(key)||bridge.maintenance?.has(key)||bridge.startup?.jobs.has(key)))throw Error('该聊天正在处理消息，请稍后编辑');
  }
  function managed(key,personaId){checkKey(key);personaId=personaCards.get(key,personaId).id;return {detail:management.inspect(key,personaId),roleState:currentRoleState(new MemoryStore(runtime,key,personaId)),personas:personaCards.view(key),personaVoice:voiceProfiles.selection(key,personaId),knowledge:new Knowledge(runtime,key,personaId).read(),policy:policyView(config,key).effective,lifecycle:(bridge.summary?.(config)??[]).filter(s=>s.key===key&&(s.personaId??'default')===personaId)};}
  function policyScopes(){
    return ['private','group',...(config.botQQ?[
      ...config.privateUsers.map(id=>config.botQQ+'/private/'+id),
      ...config.groups.map(id=>config.botQQ+'/group/'+id)]:[])];
  }
  function checkPolicyScope(scope){if(!policyScopes().includes(scope))throw Error('请先在连接页配置机器人账号和允许的好友或群');}
  function policyPayload(scope){return {scopes:policyScopes(),overriddenScopes:Object.keys(config.chatPolicy.overrides),...policyView(config,scope)};}
  function idleConfig(){
    if(napcatSyncBusy)throw Error('正在同步 NapCat 接口，请稍候');
    if(bridge.status.state!=='stopped'||bridge.status.active||bridge.startup?.jobs.size||bridge.maintenance?.size||bridge.jobs?.size||bridge.queues?.size||voice.busy)throw Error('请先停止 QQ 连接并等待语音及消息任务完成，再修改配置');
  }
  function audioInput(input,max=12*1024*1024){
    if(typeof input.audio!=='string'||input.audio.length>max||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.audio))throw Error('音频格式不正确');
    return Buffer.from(input.audio,'base64');
  }
  const token=randomBytes(32).toString('hex'), cookie=randomBytes(32).toString('hex');
  const assets = new Map([['/', ['text/html; charset=utf-8','index.html']], ['/app.js',['text/javascript; charset=utf-8','app.js']], ['/style.css',['text/css; charset=utf-8','style.css']]]);
  for(const [url,file] of [['/prompt-editor.js','prompt-editor.js'],['/memory-budget.js','memory-budget.js'],['/memory-viewer.js','memory-viewer.js'],['/memory-layout.js','../lib/legacy-memory/graph-layout.js'],['/memory-view.js','../../dsh-plugin-memory-source/lib/graph-view.js']])assets.set(url,['text/javascript; charset=utf-8',file]);
  function json(res,status,value) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); }
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw Error('请求需要使用 JSON');
    let size=0, chunks=[];
    for await (const chunk of req) { size+=chunk.length; if(size>12*1024*1024) throw Error('请求过大'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  const server=http.createServer(async (req,res) => {
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const origin='http://127.0.0.1:'+server.address().port;
    const cookieName='qqrsi_'+server.address().port;
    if (req.headers.host !== new URL(origin).host) { json(res,403,{error:'请使用 127.0.0.1 打开面板'}); return; }
    const url=new URL(req.url,origin);
    if (req.headers.origin && req.headers.origin !== origin) { json(res,403,{error:'不允许跨站请求'}); return; }
    if (req.method==='GET' && url.pathname==='/login' && url.searchParams.get('token')===token) {
      res.writeHead(303,{'Location':'/','Set-Cookie':`${cookieName}=${cookie}; HttpOnly; SameSite=Strict; Path=/`}); res.end(); return;
    }
    if(req.method==='GET'&&url.pathname==='/welcome.css'){
      res.writeHead(200,{'Content-Type':'text/css; charset=utf-8'});res.end(fs.readFileSync(path.join(here,'public','welcome.css')));return;
    }
    if (!(req.headers.cookie || '').split(';').some(x=>x.trim()===`${cookieName}=${cookie}`)) {
      if(req.method==='GET'&&['/','/login'].includes(url.pathname)){
        res.writeHead(401,{'Content-Type':'text/html; charset=utf-8'});res.end(fs.readFileSync(path.join(here,'public','welcome.html')));return;
      }
      json(res,401,{error:'面板登录已失效，请双击项目目录中的“打开面板.cmd”重新打开。配置和记忆仍保存在本机。'}); return;
    }
    if (req.method==='POST' && (req.headers.origin!==origin || req.headers['x-qq-rsi']!=='panel')) { json(res,403,{error:'请求来源校验失败'}); return; }
    try {
      if(req.method==='POST'&&url.pathname==='/api/service/shutdown'){
        idleConfig();
        json(res,200,{stopping:true});
        bridge.stop();server.close();
        return;
      }
      if (req.method==='GET' && assets.has(url.pathname)) {
        const [type,file]=assets.get(url.pathname); res.writeHead(200,{'Content-Type':type}); res.end(fs.readFileSync(path.join(here,'public',file))); return;
      }
      if (req.method==='GET' && url.pathname==='/api/status') { json(res,200,{config:publicConfig(config),voice:voice.status(config),bridge:{...bridge.status,startups:bridge.startup?.summary()??[]},lifecycle:bridge.summary?.(config)??[],imports:importedStores(runtime)}); return; }
      if(req.method==='GET'&&url.pathname==='/api/prompts'){
        json(res,200,promptPayload(url.searchParams.get('key')||undefined,url.searchParams.get('personaId')||undefined));return;
      }
      if(req.method==='GET'&&url.pathname==='/api/manage/export'){
        const key=url.searchParams.get('key'),personaId=url.searchParams.get('personaId');checkKey(key,false,personaId);
        const archive=exportMemory(runtime,key,personaId);res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':"attachment; filename=persona-memory.zip; filename*=UTF-8''"+encodeURIComponent(archive.filename),'Content-Length':archive.bytes.length,'Cache-Control':'no-store'});res.end(archive.bytes);return;
      }
      if(req.method==='GET'&&url.pathname==='/api/logs'){json(res,200,systemLog.read({level:url.searchParams.get('level')??'',component:url.searchParams.get('component')??''}));return;}
      if(req.method==='GET'&&url.pathname==='/api/logs/related'){
        json(res,200,{...diagnosticLogs.read(config),flow:systemLog.read({component:'flow'}),dshEvents:systemLog.read({component:'dsh'}),status:{state:bridge.status.state,channels:bridge.status.channels,lastObservedAt:bridge.status.lastObservedAt,lastReceivedAt:bridge.status.lastReceivedAt,lastSentAt:bridge.status.lastSentAt,lastError:redactLog(bridge.status.lastError||'',diagnosticLogs.secrets(config))}});return;
      }
      if(req.method==='GET'&&url.pathname==='/api/chat-policy'){
        const scope=url.searchParams.get('scope')??'private';checkPolicyScope(scope);
        json(res,200,policyPayload(scope));return;
      }
      if(req.method==='GET'&&url.pathname==='/api/chat-state'){
        const key=url.searchParams.get('key');checkPolicyScope(key);
        if(!key.includes('/'))throw Error('请选择具体好友或群');
        const inbox=bridge.inbox(key);
        json(res,200,{key,wake:inbox.read().wake,sleeping:inbox.sleeping(),...inbox.list({unread:true,limit:20})});return;
      }
      if(req.method==='GET'&&url.pathname==='/api/voice/references'){json(res,200,{references:voice.listReferences(),deleted:voice.listReferences({deleted:true})});return;}
      if(req.method==='GET'&&url.pathname==='/api/voice/profiles'){json(res,200,profilePayload());return;}
      if(req.method==='GET'&&url.pathname.startsWith('/api/voice/reference/')){
        const {meta,bytes}=voice.reference(url.pathname.slice('/api/voice/reference/'.length));
        res.writeHead(200,{'Content-Type':meta.format==='mp3'?'audio/mpeg':'audio/wav','Content-Length':bytes.length});res.end(bytes);return;
      }
      if(req.method==='GET'&&url.pathname==='/api/memory'){
        const dir=path.join(runtime,'memories'),keys=[];
        if(fs.existsSync(dir))for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
          if(!entry.isDirectory()||!/^[0-9a-f]{64}$/.test(entry.name))continue;
          const meta=readJson(path.join(dir,entry.name,'.runtime','store.json'),null);if(meta?.key)keys.push(meta.key);
        }
        for(const item of importedStores(runtime))if(!keys.includes(item.key))keys.push(item.key);
        const key=url.searchParams.get('key');
        if(key&&!keys.includes(key))throw Error('该聊天尚无记忆库');
        json(res,200,{keys,detail:key?new MemoryStore(runtime,key).inspect():null});return;
      }
      if(req.method==='GET'&&url.pathname==='/api/manage'){
        const key=url.searchParams.get('key'),allKeys=keys();json(res,200,{keys:allKeys,storedKeys:allKeys.filter(k=>fs.existsSync(path.join(runtime,'memories',personaIdentity(runtime,k).scope,'.runtime','store.json'))),connectedKeys:policyScopes().filter(x=>x.includes('/')),currentBot:config.botQQ,...(key?managed(key,url.searchParams.get('personaId')??undefined):{})});return;
      }
      if(req.method==='GET'&&url.pathname==='/api/sticker/image'){
        const key=url.searchParams.get('key');checkKey(key);const item=new Knowledge(runtime,key,url.searchParams.get('personaId')??undefined).sticker(url.searchParams.get('id'));
        const bytes=await publicDownload(item.url),type=sniffImageMediaType(bytes);if(!type)throw Error('不支持的图片');res.writeHead(200,{'Content-Type':type});res.end(bytes);return;
      }
      if (req.method==='GET' && url.pathname.startsWith('/api/audio/')) {
        const audio=voice.audio(url.pathname.slice('/api/audio/'.length)); res.writeHead(200,{'Content-Type':'audio/wav','Content-Length':audio.length}); res.end(audio); return;
      }
      if (req.method!=='POST') { json(res,404,{error:'页面不存在'}); return; }
      const input=await body(req);
      if(url.pathname==='/api/prompts'){
        if(Object.keys(input).some(k=>!['key','personaId','revision','overrides'].includes(k)))throw Error('提示词保存参数无效');
        if(input.key){
          checkKey(input.key,true,input.personaId);
          const active=personaCards.view(input.key).activeId===input.personaId;
          if(active&&(bridge.status.state==='connecting'||bridge.status.channels?.[input.key.split('/')[1]]||bridge.awaitingExit?.(input.key)))throw Error('请先停止此人格所在类型的接收并等待任务结束，再保存提示词');
        }else idleConfig();
        promptProfiles.save(input);json(res,200,promptPayload(input.key,input.personaId));return;
      }
      if(url.pathname==='/api/persona-cards/rename'){
        checkKey(input.key,true,input.personaId);personaCards.rename(input);json(res,200,managed(input.key,input.personaId));return;
      }
      const started=Date.now();
      res.once('finish',()=>systemLog.record(res.statusCode<400?'operation.completed':'operation.failed',{level:res.statusCode<400?'info':'error',component:url.pathname.includes('/voice/')?'voice':url.pathname.includes('/qq/')||url.pathname.includes('/bridge/')?'qq':url.pathname.includes('/manage/')?'memory':'panel',operation:url.pathname,durationMs:Date.now()-started}));
      if(url.pathname==='/api/persona-cards/create'){
        checkKey(input.key);const card=personaCards.create(input);
        json(res,200,managed(input.key,card.id));return;
      }
      if(url.pathname==='/api/persona-cards/assign'){
        checkPolicyScope(input.key);if(!input.key.includes('/'))throw Error('请选择具体聊天');
        if(managementNetwork)throw Error('请等待资料查询或收藏操作完成后切换人格');
        bridge.configurePersona(input);json(res,200,managed(input.key,input.personaId));return;
      }
      if(url.pathname==='/api/manage/reset'){
        idleConfig();
        if(managementNetwork)throw Error('正在进行资料查询或收藏操作，请完成后重置');
        const scope=input.scope;
        if(scope!=='account')checkKey(scope,true);
        if(input.confirm!==`RESET ${scope==='account'?config.botQQ:scope}`)throw Error('请先确认重置范围');
        const selected=scope==='account'?keys().filter(key=>key.split('/')[0]===config.botQQ):[scope];
        const result=resetMemories(runtime,bridge,selected);
        systemLog.record('memory.reset',{component:'memory',count:result.count});
        json(res,200,result);return;
      }
      if(url.pathname==='/api/voice/profiles/save'){
        idleConfig();const settings=voiceProfiles.settings(input.settings);checkProfile(settings);
        const profile=voiceProfiles.save({...input,settings});json(res,200,{profile,...profilePayload()});return;
      }
      if(url.pathname==='/api/voice/profiles/delete'||url.pathname==='/api/voice/profiles/restore'){
        idleConfig();const restore=url.pathname.endsWith('/restore');
        if(restore){const profile=voiceProfiles.read().profiles.find(p=>p.id===input.id);if(!profile)throw Error('预设不存在');checkProfile(profile.settings);}
        voiceProfiles.archive({...input,restore});json(res,200,profilePayload());return;
      }
      if(url.pathname==='/api/manage/open'||url.pathname==='/api/chat-target'){
        if(!config.botQQ||!['private','group'].includes(input.kind)||typeof input.id!=='string'||!/^\d{5,20}$/.test(input.id))throw Error('请先配置机器人账号，并填写有效的好友 QQ 或群号');
        const key=config.botQQ+'/'+input.kind+'/'+input.id;
        if(url.pathname==='/api/manage/open'){
          new MemoryStore(runtime,key);
          json(res,200,{key,...managed(key)});return;
        }
        idleConfig();
        const field=input.kind==='private'?'privateUsers':'groups',values=config[field].filter(x=>x!==input.id);
        if(!input.remove)values.push(input.id);
        const policy=structuredClone(config.chatPolicy);if(input.remove)delete policy.overrides[key];
        const next=validate({[field]:values,chatPolicy:policy},config);writeJson(configFile,next);config=next;
        json(res,200,{config:publicConfig(config),key});return;
      }
      if(url.pathname.startsWith('/api/manage/')){
        if(input.personaId===undefined&&personaCards.view(input.key).cards.length>1)throw Error('请明确选择人格卡后再保存');
        if(['/api/manage/research','/api/manage/collect','/api/manage/favorites'].includes(url.pathname)){managementNetwork++;res.once('finish',()=>managementNetwork--);}
        checkKey(input.key,true,input.personaId);
        input.personaId=personaCards.get(input.key,input.personaId).id;
        const knowledge=new Knowledge(runtime,input.key,input.personaId);
        if(url.pathname==='/api/manage/voice'){
          idleConfig();if(input.profileId)checkProfile(voiceProfiles.get(input.profileId).settings);
          voiceProfiles.assign(input);
        }else if(url.pathname==='/api/manage/persona')management.savePersona(input);
        else if(url.pathname==='/api/manage/page')management.savePage(input);
        else if(url.pathname==='/api/manage/knowledge')knowledge.update(input);
        else if(url.pathname==='/api/manage/research'){
          const before=knowledge.read(),entry=before.slang.find(x=>x.id===input.id);if(!entry||input.revision!==before.revision)throw Error('词条已变化，请重新加载');
          const result=await publicSearch(entry.term+' 网络用语 含义');checkKey(input.key,true);const state=knowledge.read();if(state.revision!==before.revision)throw Error('资料已更新，请重新加载');
          state.slang.find(x=>x.id===input.id).sources=result.sources;knowledge.save(state);
        }else if(url.pathname==='/api/manage/favorites'){
          if(bridge.config?.botQQ!==input.key.split('/')[0]&&bridge.status.account!==input.key.split('/')[0])throw Error('当前登录账号与知识库不匹配');
          const result=await bridge.call('fetch_custom_face_detail',{count:100});checkKey(input.key,true);knowledge.addFavorites(Array.isArray(result)?result:result?.emojiInfoList);
        }else if(url.pathname==='/api/manage/collect'){
          if(!policyScopes().includes(input.key)||!resolveChatConfig(config,input.key).stickerCollect)throw Error('请先为此聊天开启“收藏到 QQ”功能');
          if(bridge.config?.botQQ!==input.key.split('/')[0]&&bridge.status.account!==input.key.split('/')[0])throw Error('当前登录账号与知识库不匹配');
          const item=knowledge.sticker(input.id),bytes=await publicDownload(item.url);if(!sniffImageMediaType(bytes))throw Error('表情格式不支持');
          await bridge.call('add_custom_face',{file:'base64://'+bytes.toString('base64')});
        }else throw Error('未知管理操作');
        json(res,200,managed(input.key,input.personaId));
      }else if(url.pathname==='/api/chat-wake'){
        checkPolicyScope(input.key);if(!input.key.includes('/'))throw Error('请选择具体好友或群');
        checkKey(input.key,true);
        if(bridge.outbox?.has(input.key)||bridge.ambient?.has(input.key))throw Error('此聊天仍有待处理消息，请稍后操作');
        if(!policyView(config,input.key).effective.wakeEnabled)throw Error('请先保存启用潜水与唤醒');
        json(res,200,bridge.inbox(input.key).setWake(input.mode,wakeSeconds(input)));
      }else if(url.pathname==='/api/chat-policy'){
        idleConfig();checkPolicyScope(input.scope);
        if(input.revision!==policyRevision(config))throw Error('聊天设置已变化，请重新加载后保存');
        const policy=structuredClone(config.chatPolicy);
        if(input.scope==='private'||input.scope==='group')policy[input.scope]=input.reset?{}:input.patch;
        else if(input.reset||(input.patch&&typeof input.patch==='object'&&!Array.isArray(input.patch)&&!Object.keys(input.patch).length))delete policy.overrides[input.scope];
        else policy.overrides[input.scope]=input.patch;
        if(!input.reset&&(!input.patch||typeof input.patch!=='object'))throw Error('缺少聊天设置');
        const next=validate({chatPolicy:policy},config);
        writeJson(configFile,next);config=next;
        json(res,200,policyPayload(input.scope));
      }else if (url.pathname==='/api/config'||url.pathname==='/api/voice/config') {
        idleConfig();
        const voiceFields=['voice','model','voiceProvider','mimoApiKey','mimoTtsMode','mimoVoice','mimoReferenceId','mimoStyle','mimoDesign','mimoAsrLanguage','clearMimoApiKey'];
        const patch=url.pathname==='/api/voice/config'?Object.fromEntries(Object.entries(input).filter(([key])=>voiceFields.includes(key))):input;
        const next=validate(patch,config); voice.checkConfig?.(next);
        writeJson(configFile,next); config=next;
        let napcatSync;
        if(url.pathname==='/api/config'&&['botQQ','qqUrl','qqToken','clearQqToken','napcatFrameworkDir'].some(k=>Object.hasOwn(input,k))){
          try{napcatSync=await syncInterface();}catch(error){napcatSync={state:'pending',message:'面板已保存，但接口未同步：'+error.message};}
        }
        json(res,200,{config:publicConfig(config),napcatSync});
      } else if(url.pathname==='/api/voice/references'){
        json(res,200,{reference:voice.uploadReference(audioInput(input),input.name)});
      } else if(url.pathname==='/api/voice/reference/delete'||url.pathname==='/api/voice/reference/restore'){
        idleConfig();const restore=url.pathname.endsWith('/restore');
        if(!restore&&config.mimoTtsMode==='clone'&&config.mimoReferenceId===input.id)throw Error('这是已保存配置正在使用的参考录音，请先选择其他音色或预置音色并保存');
        if(!restore&&voiceProfiles.referenceUsed(input.id))throw Error('语音预设或某个人设仍在使用此录音，请先修改相应配置');
        const reference=voice.archiveReference(input.id,restore);
        if(!restore&&config.mimoReferenceId===input.id){const next=validate({mimoReferenceId:''},config);writeJson(configFile,next);config=next;}
        json(res,200,{reference});
      } else if (url.pathname==='/api/voice/synthesize') json(res,200,await voice.synthesize(input.text,previewConfig(input)));
      else if (url.pathname==='/api/voice/transcribe') {
        json(res,200,await voice.transcribe(audioInput(input),previewConfig(input)));
      } else if (url.pathname==='/api/dsh/native-status') {
        const dsh=new DshClient(config);
        try {json(res,200,await dsh.nativeStatus());} finally {dsh.close();}
      } else if (url.pathname==='/api/dsh/probe') {
        const dsh=new DshClient(config);
        try { const presets=await dsh.probe(); json(res,200,{ok:true,presets}); } finally { dsh.close(); }
      } else if(url.pathname==='/api/qq/probe') json(res,200,await probeQQ(config));
      else if(url.pathname==='/api/qq/control/status')json(res,200,await qqControl.status(config));
      else if(url.pathname==='/api/qq/control/qrcode'){idleConfig();json(res,200,await qqControl.qrcode(config));}
      else if(url.pathname==='/api/qq/control/contacts')json(res,200,await qqControl.contacts(config,input.kind));
      else if(url.pathname==='/api/qq/desktop-check') json(res,200,await desktop.inspect(config));
      else if(url.pathname==='/api/qq/sync') json(res,200,await syncInterface());
      else if(url.pathname==='/api/qq/desktop-start') { await syncInterface();json(res,200,await desktop.start(config)); }
      else if(url.pathname==='/api/session/new'){
        if(typeof input.key!=='string'||!/^\d{5,20}\/(?:private|group)\/\d{5,20}$/.test(input.key))throw Error('请选择一个现有聊天');
        if(input.personaId&&input.personaId!==personaCards.view(input.key).activeId)throw Error('只能为当前正在使用的人格开启新会话');
        json(res,200,await bridge.newConversation(input.key));
      }
      else if (url.pathname==='/api/bridge/start') {
        const kind=input.kind??'all';if(!['all','private','group'].includes(kind))throw Error('请选择私聊、群聊或全部');
        if(bridge.status.state==='stopped')await syncInterface();
        await bridge.start(config,kind,{resumeCompleted:input.resumeCompleted===true});json(res,200,bridge.status);
      }
      else if (url.pathname==='/api/bridge/resume') {
        if(typeof input.key!=='string'||!bridge.state.maintenanceInbox[input.key])throw Error('请选择已有消息队列');
        // Launch asynchronously: an accepted continuous conversation can run for minutes.
        const resumed=bridge.resumeDeferred(input.key);resumed?.catch(error=>bridge.reportError(error.message));json(res,200,{resumed:true});
      }
      else if (url.pathname==='/api/bridge/stop') { bridge.stop(input.kind??'all'); json(res,200,bridge.status); }
      else json(res,404,{error:'接口不存在'});
    } catch(error) { json(res,400,{error:error instanceof SyntaxError ? '数据格式不正确' : error.message}); }
  });
  server.requestTimeout=200000; server.headersTimeout=10000;
  server.on('listening',()=>systemLog.record('service.started'));
  server.on('close',()=>{diagnosticLogs.close();systemLog.record('service.stopped');});
  server.on('error',()=>systemLog.record('service.error',{level:'error'}));
  return {server, bridge, token, runtime, loginUrl:()=>`http://127.0.0.1:${server.address().port}/login?token=${token}`};
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const app=createApp(); const port=Number(process.env.QQ_RSI_PORT || 3199);
  app.server.listen(port,'127.0.0.1',()=>{
    writeJson(path.join(app.runtime,'launch.private.json'),{pid:process.pid,url:app.loginUrl(),startedAt:new Date().toISOString()});
    console.log('QQ RSI 独立服务已启动（QQ 默认停止）。\n配置面板：'+app.loginUrl());
  });
  app.server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'端口已占用，请关闭旧进程或设置 QQ_RSI_PORT':'服务启动失败');process.exitCode=1;});
  function stop(){app.bridge.stop();app.server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),2000).unref();}
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
