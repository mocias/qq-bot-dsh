import {renderHealth,renderGraph} from './memory-viewer.js';
const $=id=>document.getElementById(id);
let policyData=null,policyLoad=0;
const policyDrafts=new Map();
function readPolicyPatch(){
  if(!policyData)return {};
  const patch={},specific=policyData.scope!==policyData.kind;
  for(const [key,spec] of Object.entries(policyData.fields)){
    if(specific&&!$('override-'+key).checked)continue;
    const input=$('policy-'+key);
    patch[key]=spec.type==='boolean'?input.checked:spec.type==='number'?Number(input.value):spec.type==='ids'?input.value.split(/[\s,，]+/).filter(Boolean):input.value;
  }
  return patch;
}
function stashPolicy(){
  if(!policyData)return;
  const patch=readPolicyPatch(),saved=policyData.savedPatch;
  const same=Object.keys(patch).length===Object.keys(saved).length&&Object.entries(patch).every(([key,value])=>JSON.stringify(value)===JSON.stringify(saved[key]));
  if(same)policyDrafts.delete(policyData.scope);
  else policyDrafts.set(policyData.scope,{...policyData,override:patch});
}
function paintPolicy(data){
  policyData={...data,savedPatch:data.savedPatch??(data.scope===data.kind?data.effective:data.override)};
  const specific=data.scope!==data.kind,container=$('policy-fields');container.replaceChildren();
  const cards=new Map();
  $('policy-context').textContent=specific?'只影响此聊天；未勾选“单独设置”的项目继承'+(data.kind==='group'?'群聊':'私聊')+'默认值。':'作为'+(data.kind==='group'?'所有群聊':'所有私聊')+'的默认规则；独立覆盖的字段优先。';
  $('policy-reset').textContent=specific?'清除本聊天覆盖，全部继承':'恢复升级时的默认规则';
  $('policy-delete').hidden=!specific;$('target-remove').hidden=!specific;
  $('policy-delete').disabled=!Object.keys(data.override).length;
  for(const option of $('policy-scope').options)if(option.value.includes('/'))option.textContent=chatLabel(option.value)+(data.overriddenScopes?.includes(option.value)?' · 独立设置':' · 继承默认');
  $('policy-state').textContent=policyDrafts.has(data.scope)?'有未保存修改；切换聊天会暂存草稿。':'已加载保存的设置。';
  for(const [key,spec] of Object.entries(data.fields)){
    if(!cards.has(spec.section)){const card=element('article');card.className='card';card.append(element('h2',spec.section));cards.set(spec.section,card);container.append(card);}
    const row=element('div');row.className='policy-row';
    const label=element('label',spec.label);label.htmlFor='policy-'+key;
    const input=element(spec.type==='ids'?'textarea':spec.type==='select'?'select':'input');input.id='policy-'+key;
    if(spec.type==='select')for(const [value,text]of Object.entries(spec.options))input.append(new Option(text,value));
    else if(spec.type!=='ids'){input.type=spec.type==='boolean'?'checkbox':spec.type==='string'?'text':spec.type; if(spec.type==='number'){input.min=spec.min;input.max=spec.max;input.required=true;}if(spec.max&&spec.type==='string')input.maxLength=spec.max;}
    else input.rows=3;
    const overridden=Object.hasOwn(data.override,key),value=overridden?data.override[key]:data.inherited[key];
    const setValue=v=>{if(spec.type==='boolean')input.checked=!!v;else input.value=Array.isArray(v)?v.join('\n'):v??'';};
    setValue(value);
    if(spec.type==='boolean'){label.className='switch';label.prepend(input);row.append(label);}else row.append(label,input);
    if(specific){
      const toggle=element('input');toggle.type='checkbox';toggle.id='override-'+key;toggle.checked=overridden;toggle.setAttribute('aria-label','单独设置：'+spec.label);
      const owner=element('label','单独设置');owner.className='switch override-toggle';owner.prepend(toggle);
      const source=element('small',overridden?'使用本聊天设置':'继承'+(data.kind==='group'?'群聊':'私聊')+'默认');
      input.disabled=!overridden;
      toggle.onchange=()=>{input.disabled=!toggle.checked;if(!toggle.checked)setValue(data.inherited[key]);source.textContent=toggle.checked?'使用本聊天设置':'继承'+(data.kind==='group'?'群聊':'私聊')+'默认';};
      row.append(owner,source);
    }
    cards.get(spec.section).append(row);
  }
  $('policy-save').disabled=false;$('policy-reset').disabled=false;
}
async function loadPolicy(scope,force=false){
  const serial=++policyLoad;$('policy-save').disabled=true;$('policy-reset').disabled=true;
  const data=await request('/api/chat-policy?scope='+encodeURIComponent(scope));
  if(serial!==policyLoad)return;
  $('policy-scope').replaceChildren();
  for(const key of data.scopes)$('policy-scope').append(new Option(key==='private'?'私聊默认设置':key==='group'?'群聊默认设置':chatLabel(key)+(data.overriddenScopes?.includes(key)?' · 独立设置':' · 继承默认'),key));
  $('policy-scope').value=scope;
  if(force)policyDrafts.delete(scope);
  paintPolicy(policyDrafts.get(scope)??data);
}
$('policy-scope').onchange=()=>{stashPolicy();loadPolicy($('policy-scope').value).catch(e=>notice(e.message,true));};
$('policy-reload').onclick=()=>action($('policy-reload'),()=>loadPolicy($('policy-scope').value,true));
$('policy-form').onsubmit=event=>{
  event.preventDefault();if(!policyData)return;
  const input={scope:policyData.scope,revision:policyData.revision,patch:readPolicyPatch()};
  action(event.submitter,async()=>{
    const data=await request('/api/chat-policy',input);policyDrafts.delete(input.scope);
    if($('policy-scope').value===input.scope)paintPolicy(data);
    $('policy-state').textContent='已保存当前聊天域。';
    notice('当前聊天域已保存，其他聊天的独立设置保持不变。');
  });
};
$('policy-reset').onclick=()=>action($('policy-reset'),async()=>{
  const scope=policyData.scope,data=await request('/api/chat-policy',{scope,revision:policyData.revision,reset:true});
  policyDrafts.delete(scope);if($('policy-scope').value===scope)paintPolicy(data);
  notice('已恢复继承，记忆和聊天记录保持不变。');
  await loadPolicy(scope,true);$('policy-state').textContent='已删除独立设置并恢复继承；记忆保持不变。';
});
$('policy-delete').onclick=async()=>{if(await confirmAction('删除此聊天的独立设置并恢复默认规则？人设、记忆和聊天记录会保留。'))$('policy-reset').click();};
$('policy-form').addEventListener('input',()=>{$('policy-state').textContent='有未保存修改，请保存当前聊天域。';});
$('target-remove').onclick=()=>action($('target-remove'),async()=>{
  if(!await confirmAction('从机器人接收名单移除此聊天，同时移除独立设置？历史记忆会保留，可在人设与记忆中继续查看。'))return;
  const key=policyData.scope,[,kind,id]=key.split('/');
  const result=await request('/api/chat-target',{kind,id,remove:true});fill(result.config);
  policyDrafts.delete(key);await loadPolicy(kind,true);notice('已移除聊天接入，历史记忆仍保留。');
});
const voiceFields=['voiceProvider','voice','model','mimoApiKey','mimoTtsMode','mimoVoice','mimoReferenceId','mimoStyle','mimoAsrLanguage'];
function voiceOptions(){
  const mimo=$('voiceProvider').value==='mimo';
  $('local-options').hidden=mimo;$('mimo-options').hidden=!mimo;
  const clone=$('mimoTtsMode').value==='clone';
  $('preset-options').hidden=clone;$('clone-options').hidden=!clone;
}
function referencePreview(){
  const id=$('mimoReferenceId').value;
  $('reference-preview').hidden=!id;
  if(id)$('reference-preview').src='/api/voice/reference/'+encodeURIComponent(id);
  else $('reference-preview').removeAttribute('src');
}
async function loadReferences(selected){
  const {references,deleted=[]}=await request('/api/voice/references');
  const select=$('mimoReferenceId');select.replaceChildren(new Option('请上传或选择录音',''));
  for(const ref of references)select.append(new Option(ref.name+' · '+ref.format.toUpperCase(),ref.id));
  select.value=selected||'';referencePreview();
  $('reference-deleted').replaceChildren(new Option(deleted.length?'选择要恢复的录音':'没有已删除录音',''));
  for(const ref of deleted)$('reference-deleted').append(new Option(ref.name+' · '+ref.format.toUpperCase(),ref.id));
  $('reference-restore').disabled=!deleted.length;$('reference-delete').disabled=!select.value;
}
async function fillVoice(config){
  for(const field of voiceFields)if(field!=='mimoReferenceId')$(field).value=field==='mimoApiKey'?'':config[field];
  $('mimo-key-state').textContent=config.mimoApiKeyConfigured?'已保存（不回显）':'未配置';
  $('mimo-clear').hidden=!config.mimoApiKeyConfigured;
  await loadReferences(config.mimoReferenceId);voiceOptions();
  $('voice-saved-state').textContent='已保存：'+(config.voiceProvider==='mimo'?'MiMo API':'本地模式');
}
function paintVoiceStatus({config,voice}){
  const mimo=config.voiceProvider==='mimo';
  $('tts-label').textContent=mimo?(config.mimoTtsMode==='clone'?'MiMo 参考音色':'MiMo 预置音色'):'Windows 中文语音';
  $('tts-status').textContent=voice.ttsReady?(mimo?'已配置 · 请生成语音验证':'组件已就绪'):(mimo?'密钥或参考录音未配置':'组件未找到');
  $('asr-status').textContent=voice.asrReady?(mimo?'已配置 · 请识别音频验证':'本地模型已就绪'):(mimo?'密钥未配置':'模型或环境未找到');
  $('model-label').textContent=mimo?'MiMo v2.5 ASR':'Whisper '+config.model;
  $('processing-label').textContent=mimo?'MiMo 云端处理':'全部留在本机';
  $('processing-detail').textContent=mimo?'使用你的 API 额度 · 此处测试不发送 QQ':'无需云端密钥 · 此处测试不发送 QQ';
  if(!voice.busy)$('voice-progress').textContent=mimo?'MiMo 云端识别':'CPU 本地推理';
  $('audio-file').accept=mimo?'.wav,.mp3,audio/wav,audio/mpeg':'.wav,audio/wav';
  $('upload-format').textContent=(mimo?'WAV / MP3':'WAV')+' 格式 · 不超过 8 MiB';
}
function encodeAudio(buffer){
  const bytes=new Uint8Array(buffer);let binary='';
  for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
  return btoa(binary);
}
$('voiceProvider').onchange=voiceOptions;$('mimoTtsMode').onchange=voiceOptions;
$('mimoReferenceId').onchange=()=>{referencePreview();$('reference-delete').disabled=!$('mimoReferenceId').value;};
$('voice-config-form').addEventListener('input',()=>{$('voice-saved-state').textContent='有未保存修改；QQ 仍使用上次保存的配置。';});
$('config-form').addEventListener('input',()=>{$('config-saved-state').textContent='有未保存修改，请保存连接配置。';});
$('reference-delete').onclick=()=>action($('reference-delete'),async()=>{
  const id=$('mimoReferenceId').value;if(!id)throw Error('请先选择录音');
  if(!await confirmAction('将所选录音移到已删除列表？之后可以恢复。'))return;
  await request('/api/voice/reference/delete',{id});await loadReferences('');
  $('reference-state').textContent='录音已删除，可在下方恢复。若要使用其他参考音色，请选择后保存语音配置。';notice('录音已移到可恢复列表。');
});
$('reference-restore').onclick=()=>action($('reference-restore'),async()=>{
  const id=$('reference-deleted').value;if(!id)throw Error('请选择要恢复的录音');
  await request('/api/voice/reference/restore',{id});await loadReferences(id);
  $('reference-state').textContent='录音已恢复并选中。保存语音配置后才用于合成。';$('voice-saved-state').textContent='已选择恢复的录音，尚未保存音色选择。';notice('录音已恢复。');
});
$('voice-config-form').addEventListener('submit',event=>{
  event.preventDefault();action(event.submitter,async()=>{
    const result=await request('/api/voice/config',Object.fromEntries(voiceFields.map(field=>[field,$(field).value])));
    await fillVoice(result.config);notice('语音配置已保存。可在下方生成语音或上传音频验证。');
  });
});
$('mimo-clear').onclick=()=>action($('mimo-clear'),async()=>{
  const result=await request('/api/voice/config',{voiceProvider:'local',clearMimoApiKey:true});
  await fillVoice(result.config);notice('MiMo 密钥已清除，已切回本地模式。');
});
$('reference-upload').onclick=()=>action($('reference-upload'),async()=>{
  const file=$('reference-file').files[0];if(!file)throw Error('请先选择参考录音');
  if(file.size>7*1024*1024)throw Error('参考录音不能超过 7 MiB');
  const result=await request('/api/voice/references',{name:$('reference-name').value,audio:encodeAudio(await file.arrayBuffer())});
  await loadReferences(result.reference.id);$('reference-file').value='';$('reference-name').value='';
  $('reference-state').textContent='录音文件已保存到本机。音色选择尚未保存，请点击“保存语音配置”。';
  notice('参考录音已保存在本机，请保存语音配置以使用此音色。');
});
const fields=['dshUrl','dshLocalAuth','dshToken','botQQ','qqUrl','qqToken','privateUsers','groups','qqExecutable','napcatFrameworkDir','qqMediaRoots','ffmpegPath'];
const switches=['dshLocalAuth'],numbers=[];
let generatedUrl='',initialized=false;
function notice(text,error=false){$('notice').textContent=text;$('notice').classList.toggle('error',error);}
async function request(url,body){const response=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-QQ-RSI':'panel'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error||'请求失败');return result;}
function fill(config,selected=fields){for(const field of selected){if(field.endsWith('Token')){$(field).value='';continue;}if(switches.includes(field)){$(field).checked=config[field];continue;}$(field).value=Array.isArray(config[field])?config[field].join('\n'):config[field];}$('dsh-key-state').textContent=config.dshTokenConfigured?'已保存':'未配置';$('qq-key-state').textContent=config.qqTokenConfigured?'已保存':'未配置';}
async function refresh(){const status=await request('/api/status');if(!initialized){fill(status.config);await fillVoice(status.config);initialized=true;}$('service-status').textContent='● 独立服务已运行';paintVoiceStatus(status);$('bridge-status').textContent=status.bridge.state==='running'?'QQ '+(status.bridge.account||'')+' 已连接':status.bridge.state==='connecting'?'正在连接 QQ':'QQ 连接已停止';$('bridge-detail').textContent=status.bridge.lastError||`待处理消息：${status.bridge.active} · 启动后接收名单内已启用的消息`;$('start').disabled=status.bridge.state!=='stopped';$('stop').disabled=status.bridge.state==='stopped';paintLife(status);return status;}
async function action(button,work){button.disabled=true;notice('正在处理，请稍候…');try{await work();if($('notice').textContent==='正在处理，请稍候…')notice('操作已完成。');}catch(error){notice(error.message,true);}finally{button.disabled=false;if(button.id==='reference-delete')button.disabled=!$('mimoReferenceId').value;if(button.id==='reference-restore')button.disabled=$('reference-deleted').options.length<=1;await refresh().catch(()=>{});}}
const pages={
  voice:['语音与通话','选择语音服务、配置音色并试听；实时通话后续接入。'],
  connections:['连接与配置','管理 DSH、QQ 消息入口与桌面 QQ 连接。'],
  chat:['会话与聊天','管理会话轮换、多媒体消息、主动搭话与群聊能力。'],
  manage:['人设与记忆','查看记忆库，管理聊天人设、长期记忆、表情与黑话。'],
  qq:['QQ 控制','管理桌面 QQ、NapCat 登录与 OneBot 接入。'],
};
for(const tab of document.querySelectorAll('[data-tab]'))tab.addEventListener('click',()=>{
  const name=tab.dataset.tab;
  for(const page of Object.keys(pages))$(page+'-tab').hidden=page!==name;
  document.querySelectorAll('[data-tab]').forEach(x=>{x.classList.toggle('active',x===tab);x.setAttribute('aria-current',x===tab?'page':'false');});
  [$('page-title').textContent,$('page-subtitle').textContent]=pages[name];notice('');
  if(name==='chat'&&!policyData)loadPolicy($('policy-scope').value).catch(e=>notice(e.message,true));
  if(name==='manage')loadManagedKeys().catch(e=>notice(e.message,true));
  if(name==='qq')refreshQQ().catch(e=>notice(e.message,true));
});
for(const formId of ['config-form'])$(formId).addEventListener('submit',event=>{
  event.preventDefault();const selected=fields.filter(field=>event.currentTarget.contains($(field))),data={};
  for(const field of selected)data[field]=switches.includes(field)?$(field).checked:numbers.includes(field)?Number($(field).value):field==='qqMediaRoots'?$(field).value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean):['privateUsers','groups','adminUsers'].includes(field)?$(field).value.split(/[\s,，]+/).filter(Boolean):$(field).value;
  action(event.submitter,async()=>{const result=await request('/api/config',data);fill(result.config,selected);$('config-saved-state').textContent='连接配置已保存。'+(result.napcatSync?.message??'');notice($('config-saved-state').textContent,result.napcatSync?.state==='pending');});
});
$('synthesize').addEventListener('click',()=>action($('synthesize'),async()=>{const result=await request('/api/voice/synthesize',{text:$('speech-text').value});generatedUrl=result.audioUrl;$('audio-player').src=generatedUrl;$('audio-result').hidden=false;notice('语音已生成，可以试听或继续识别。');}));
async function recognize(buffer){$('voice-progress').textContent='正在使用已保存的服务识别，请稍候…';try{const bytes=new Uint8Array(buffer);let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));const result=await request('/api/voice/transcribe',{audio:btoa(binary)});$('transcript').value=result.text;notice(`识别完成 · ${result.model} 模型 · ${Number.isFinite(result.duration)?result.duration.toFixed(1)+' 秒音频':'识别完成'}`);}finally{$('voice-progress').textContent='使用已保存的语音服务';}}
$('transcribe').addEventListener('click',()=>action($('transcribe'),async()=>{const file=$('audio-file').files[0];if(!file)throw Error('请先选择音频');if(file.size>8*1024*1024)throw Error('文件不能超过 8 MiB');await recognize(await file.arrayBuffer());}));
$('recognize-generated').addEventListener('click',()=>action($('recognize-generated'),async()=>{const response=await fetch(generatedUrl);if(!response.ok)throw Error('生成的音频已过期，请重新生成');await recognize(await response.arrayBuffer());}));
$('probe').addEventListener('click',()=>action($('probe'),async()=>{const result=await request('/api/dsh/probe',{});$('presets').hidden=false;$('presets').textContent=JSON.stringify(result.presets,null,2);notice('DSH 连接成功，下方显示可用预设。');}));
$('start').addEventListener('click',()=>action($('start'),async()=>{await request('/api/bridge/start',{});notice('QQ 连接已启动。');}));
$('stop').addEventListener('click',()=>action($('stop'),async()=>{await request('/api/bridge/stop',{});notice('QQ 连接已停止。');}));
refresh().catch(error=>notice(error.message,true));setInterval(()=>refresh().catch(()=>{$('service-status').textContent='服务连接中断';}),5000);

$('qq-probe').addEventListener('click',()=>action($('qq-probe'),async()=>{const result=await request('/api/qq/probe',{});notice('QQ '+result.account+' 在线，登录账号验证通过。');}));
$('desktop-check').addEventListener('click',()=>action($('desktop-check'),async()=>{const result=await request('/api/qq/desktop-check',{});notice(result.message);}));
$('desktop-sync').addEventListener('click',()=>action($('desktop-sync'),async()=>{const result=await request('/api/qq/sync',{});notice(result.message,result.state==='pending');}));
$('desktop-start').addEventListener('click',()=>action($('desktop-start'),async()=>{const result=await request('/api/qq/desktop-start',{});notice(result.message);}));
$('new-conversation').addEventListener('click',()=>action($('new-conversation'),async()=>{
 const {key}=managedInput();await request('/api/session/new',{key});await reloadManaged();notice('已开启新会话，沿用同一工作区和记忆库。');
}));
let managementData=null,loadedKey='',manageSerial=0,currentBot='',manageBusy=false;
const element=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
function pageSelect(){const page=managementData.detail.pages.find(p=>p.name===$('page-select').value);$('page-path').value=page?.name??'';$('page-text').value=page?.text??'';$('page-state').textContent=page?'已加载此页。':'新页面尚未保存。';}
function memoryDirty(){
  if(!managementData||!loadedKey)return false;
  const page=managementData.detail.pages.find(p=>p.name===$('page-path').value);
  return $('persona-text').value!==managementData.detail.persona||$('page-text').value!==(page?.text??'')||(!page&&!!$('page-path').value);
}
function managedInput(){if(!loadedKey||loadedKey!==$('manage-key').value)throw Error('请先加载选中聊天的资料');return {key:loadedKey};}
function paintManaged(data){
 if(data.detail.key!==loadedKey||$('manage-key').value!==loadedKey)return;
 const prior=managementData?.detail;
 const draft=prior?.key===loadedKey?{
   persona:$('persona-text').value!==prior.persona?$('persona-text').value:null,
   path:$('page-path').value,text:$('page-text').value,
   pageDirty:$('page-text').value!==(prior.pages.find(p=>p.name===$('page-path').value)?.text??'')||(!prior.pages.some(p=>p.name===$('page-path').value)&&!!$('page-path').value),
 }:null;
 managementData=data;$('manage-content').hidden=false;$('new-conversation').disabled=false;
 $('slang-card').hidden=!loadedKey.includes('/group/');
 $('memory-overview').textContent=chatLabel(loadedKey)+' · 长期记忆：'+(data.policy?.memoryEnabled?'开启':'关闭')+' · 原 dsh-plugin-memory 核心适配。此处修改仅影响选中的聊天。';
 $('memory-directory').value=data.detail.insights.store;
 $('memory-settings-summary').textContent='自动注入：'+(data.policy?.memoryAutoInject?'开启':'关闭')+' · memory 操作协议：'+(data.policy?.memoryRegisterSkill?'开启':'关闭')+' · 仅最近活跃聊天注入：'+(data.policy?.memoryActiveOnly?'开启':'关闭')+' · 主动追忆：'+(data.policy?.proactiveEnabled?'开启':'关闭');
 $('memory-settings').disabled=loadedKey.split('/')[0]!==currentBot;
 paintLife({lifecycle:data.lifecycle??[]});$('persona-text').value=data.detail.persona;
 $('persona-state').textContent='已加载此聊天人设。';
 const old=$('page-select').value;$('page-select').replaceChildren();const fresh=element('option','＋ 新建页面');fresh.value='';$('page-select').append(fresh);
 for(const page of data.detail.pages){const o=element('option',page.name);o.value=page.name;$('page-select').append(o);}if(data.detail.pages.some(p=>p.name===old))$('page-select').value=old;pageSelect();
 if(draft?.persona!==null&&draft?.persona!==undefined&&draft.persona!==data.detail.persona){$('persona-text').value=draft.persona;$('persona-state').textContent='人设草稿尚未保存。';}
 if(draft?.pageDirty&&draft.text!==(data.detail.pages.find(p=>p.name===draft.path)?.text??'')){$('page-path').value=draft.path;$('page-text').value=draft.text;$('page-state').textContent='记忆正文草稿尚未保存。';}
 renderGraph($('memory-graph'),data.detail.graph,async id=>{
   $('graph-selection').textContent='已选择：'+id;
   if(data.detail.pages.some(p=>p.name===id)){if(memoryDirty()&&!await confirmAction('切换页面将放弃当前未保存的记忆正文，继续？'))return;$('page-select').value=id;pageSelect();$('page-text').focus();}
   else $('graph-selection').textContent+=' · 元信息节点，只读。';
 });
 renderHealth($('manage-health'),data.detail.insights);$('graph-selection').textContent='';
 const stickers=$('stickers');stickers.replaceChildren();
 for(const item of data.knowledge.stickers){const card=element('div');card.className='library-item';const img=element('img');img.alt=item.note||'收藏表情';img.loading='lazy';img.src='/api/sticker/image?key='+encodeURIComponent(loadedKey)+'&id='+encodeURIComponent(item.id);card.append(img);
 const note=element('input');note.value=item.note;note.setAttribute('aria-label','表情含义');note.maxLength=300;
 const tags=element('input');tags.value=item.tags.join(' ');tags.setAttribute('aria-label','表情标签');
 const save=element('button','保存表情笔记');save.className='secondary';save.onclick=()=>action(save,async()=>{paintManaged(await request('/api/manage/knowledge',{...managedInput(),id:item.id,kind:'sticker',revision:managementData.knowledge.revision,note:note.value,tags:tags.value.split(/\s+/).filter(Boolean)}));notice('表情笔记已保存。');});
 const collect=element('button','收藏到 QQ');collect.className='secondary';collect.disabled=!data.policy?.stickerCollect;collect.title=data.policy?.stickerCollect?'':'请先为此聊天开启收藏到 QQ 功能';collect.onclick=()=>action(collect,async()=>{paintManaged(await request('/api/manage/collect',{...managedInput(),id:item.id}));notice('QQ 已确认收藏请求。');});
 card.append(note,tags,save,collect);stickers.append(card);}
 if(!data.knowledge.stickers.length)stickers.append(element('p','还没有表情记录。'));
 const slang=$('slang');slang.replaceChildren();for(const item of data.knowledge.slang){const card=element('div');card.className='library-item';card.append(element('h3',item.term));const meaning=element('textarea');meaning.value=item.meaning;meaning.setAttribute('aria-label','黑话含义');const status=element('select');status.setAttribute('aria-label','审核状态');for(const [value,title]of [['candidate','待审核'],['confirmed','已确认'],['rejected','已否决']]){const o=element('option',title);o.value=value;status.append(o);}status.value=item.status;
 const save=element('button','保存审核');save.className='secondary';save.onclick=()=>action(save,async()=>{paintManaged(await request('/api/manage/knowledge',{...managedInput(),id:item.id,kind:'slang',revision:managementData.knowledge.revision,meaning:meaning.value,status:status.value}));notice('词条已保存。');});
 const research=element('button','公开查证');research.className='secondary';research.onclick=()=>action(research,async()=>{paintManaged(await request('/api/manage/research',{...managedInput(),id:item.id,revision:managementData.knowledge.revision}));notice('已取得公开资料，含义仍需人工核对。');});card.append(meaning,status,save,research);
 for(const source of item.sources??[]){const link=element('a',source.title||source.url);link.href=source.url;link.target='_blank';link.rel='noreferrer noopener';card.append(link);}card.append(element('small','来源：'+item.evidence.join(', ')));slang.append(card);}
 if(!data.knowledge.slang.length)slang.append(element('p','还没有候选黑话。'));
}
function chatLabel(key){const [,kind,id]=key.split('/');return (kind==='group'?'群聊 ':'好友 ')+id;}
async function loadManagedKeys(){
 const old=$('manage-key').value,data=await request('/api/manage');currentBot=data.currentBot;
 const keys=data.keys.filter(key=>$('memory-history').checked||key.split('/')[0]===currentBot);
 $('memory-account').textContent='当前机器人账号：'+(currentBot||'未配置')+'。每个好友和群独立保存；历史账号资料不会自动转给当前账号。';
 $('manage-key').replaceChildren(new Option('请选择好友或群',''));
 for(const key of keys)$('manage-key').append(new Option(chatLabel(key)+(key.split('/')[0]===currentBot?'':' · 历史账号 '+key.split('/')[0]),key));
 if(keys.includes(old))$('manage-key').value=old;
 else {loadedKey='';managementData=null;$('manage-content').hidden=true;++manageSerial;}
 $('manage-empty').textContent=keys.length?'选择即加载；切换不会覆盖、复制或合并任何记忆。':'还没有此账号的聊天资料。填写好友 QQ 或群号即可打开独立记忆库。';
}
function paintLife(status){
 if(!loadedKey)return;
 const sessions=(status.lifecycle??[]).filter(s=>s.key===loadedKey);
 $('lifecycle-status').textContent=sessions.length?sessions.map(s=>'已压缩 '+s.compactions+' 次 · 待整理 '+s.pendingCompactions+' 次'+(s.maintenance?' · 整理中':'')+(s.blocked?' · 旧回合已隔离':'')).join('\n'):'此聊天暂无运行会话；记忆库可独立管理。';
}
async function reloadManaged(){
  const key=$('manage-key').value,serial=++manageSerial;loadedKey='';managementData=null;
  $('manage-content').hidden=true;$('new-conversation').disabled=true;
  if(!key){$('manage-empty').textContent='请选择好友或群，或输入号码打开记忆。';return;}
  $('manage-empty').textContent='正在加载 '+chatLabel(key)+' 的独立资料…';
  try{const data=await request('/api/manage?key='+encodeURIComponent(key));if(serial!==manageSerial||$('manage-key').value!==key)return;
    loadedKey=key;paintManaged(data);$('manage-empty').textContent='已加载 '+chatLabel(key)+'。此页保存只修改该聊天，其他好友和群的记忆不受影响。';
  }catch(error){if(serial===manageSerial){$('manage-empty').textContent='加载失败：'+error.message;throw error;}}
}
$('manage-key').onchange=async()=>{
  if(manageBusy||(memoryDirty()&&!await confirmAction('当前人设或记忆有未保存修改，放弃修改并切换聊天？'))){$('manage-key').value=loadedKey;return;}
  reloadManaged().catch(e=>notice(e.message,true));
};
$('memory-history').onchange=async()=>{if(memoryDirty()&&!await confirmAction('当前有未保存修改，放弃并更新聊天列表？')){$('memory-history').checked=!$('memory-history').checked;return;}loadManagedKeys().catch(e=>notice(e.message,true));};
$('memory-open').onclick=()=>action($('memory-open'),async()=>{
  if(manageBusy)throw Error('请等待当前保存完成');
  if(memoryDirty()&&!await confirmAction('当前有未保存修改，放弃并打开另一份记忆？'))return;
  const result=await request('/api/manage/open',{kind:$('memory-kind').value,id:$('memory-id').value.trim()});
  await loadManagedKeys();$('manage-key').value=result.key;await reloadManaged();
});
$('memory-settings').onclick=()=>action($('memory-settings'),async()=>{
  const key=loadedKey;if(!key)return;document.querySelector('[data-tab="chat"]').click();
  try{await loadPolicy(key);}catch{await loadPolicy(key.split('/')[1]);notice('此聊天尚未加入接收名单，已打开对应默认记忆规则。独立设置需先加入名单。');}
});
$('persona-text').addEventListener('input',()=>{$('persona-state').textContent='未保存；仅影响当前聊天。';});
for(const id of ['page-path','page-text'])$(id).addEventListener('input',()=>{$('page-state').textContent='未保存；仅影响当前聊天。';});
$('manage-load').onclick=()=>action($('manage-load'),async()=>{if(memoryDirty()&&!await confirmAction('刷新会放弃未保存的人设或记忆修改，继续？'))return;await reloadManaged();notice('已刷新此聊天的人设与记忆。');});
$('page-select').onchange=async()=>{const page=managementData?.detail.pages.find(p=>p.name===$('page-path').value);if($('page-text').value!==(page?.text??'')&&!await confirmAction('当前记忆正文尚未保存，放弃并切换页面？')){$('page-select').value=page?.name??'';return;}pageSelect();};
$('persona-save').onclick=()=>action($('persona-save'),async()=>{manageBusy=true;try{paintManaged(await request('/api/manage/persona',{...managedInput(),text:$('persona-text').value,revision:managementData.detail.personaRevision}));$('persona-state').textContent='人设已保存，下次消息生效。';notice('人设已保存，下次消息生效。');}finally{manageBusy=false;}});
async function savePage(forget){const page=$('page-path').value,old=managementData.detail.pages.find(p=>p.name===page);manageBusy=true;try{paintManaged(await request('/api/manage/page',{...managedInput(),page,text:$('page-text').value,revision:old?.revision??managementData.detail.emptyRevision,forget}));$('page-state').textContent=forget?'已忘记此页，历史备份保留。':'记忆页已保存。';notice($('page-state').textContent);}finally{manageBusy=false;}}
$('page-save').onclick=()=>action($('page-save'),()=>savePage(false));$('page-forget').onclick=()=>action($('page-forget'),()=>savePage(true));
$('favorites-sync').onclick=()=>action($('favorites-sync'),async()=>{paintManaged(await request('/api/manage/favorites',managedInput()));notice('收藏表情已导入当前聊天。');});

async function refreshQQ(){
 const data=await request('/api/qq/control/status',{});
 $('qq-control-state').textContent=data.message;
 $('qq-control-account').textContent='面板指定账号：'+(data.expectedAccount||'未配置')+' · 当前登录：'+(data.account||'未知')+' · NapCat 管理：'+(data.napcatReady?'可用':'不可用')+' · OneBot：'+(data.interfaceOnline?'在线':'未连接');
 if(data.online){$('qq-qr-result').hidden=true;$('qq-qr-image').removeAttribute('src');}
 $('qq-qrcode').disabled=!!data.online;
 const status=await request('/api/status');
 $('qq-control-bridge').textContent='机器人接收：'+(status.bridge.state==='running'?'运行中':status.bridge.state==='connecting'?'连接中':'已停止')+' · 待处理：'+status.bridge.active;
 $('qq-control-start').disabled=status.bridge.state!=='stopped';$('qq-control-stop').disabled=status.bridge.state==='stopped';
}
$('qq-control-refresh').onclick=()=>action($('qq-control-refresh'),refreshQQ);
for(const [id,url]of [['qq-control-desktop','/api/qq/desktop-start'],['qq-control-sync','/api/qq/sync'],['qq-control-start','/api/bridge/start'],['qq-control-stop','/api/bridge/stop']])$(id).onclick=()=>action($(id),async()=>{const result=await request(url,{});notice(result.message||'操作已完成。');await refreshQQ();});
$('qq-qrcode').onclick=()=>action($('qq-qrcode'),async()=>{
 const result=await request('/api/qq/control/qrcode',{});$('qq-qr-image').src=result.image;$('qq-qr-message').textContent=result.message;$('qq-qr-result').hidden=false;
});
$('qq-contact-kind').onchange=()=>{$('qq-contact').replaceChildren();$('qq-contact-add').disabled=true;$('qq-contact-state').textContent='请读取所选类型的列表。';};
$('qq-contacts-load').onclick=()=>action($('qq-contacts-load'),async()=>{
 const kind=$('qq-contact-kind').value,result=await request('/api/qq/control/contacts',{kind});if(kind!==$('qq-contact-kind').value)return;
 $('qq-contact').replaceChildren();for(const item of result.items)$('qq-contact').append(new Option(item.id+' · '+item.name,item.id));
 $('qq-contact-add').disabled=!result.items.length;$('qq-contact-state').textContent='已读取 '+result.items.length+' 项，尚未修改接收名单。';
});
$('qq-contact-add').onclick=()=>action($('qq-contact-add'),async()=>{
 const result=await request('/api/chat-target',{kind:$('qq-contact-kind').value,id:$('qq-contact').value});fill(result.config);
 $('qq-contact-state').textContent='已加入接收名单。启用范围仍由“会话与聊天”规则决定；机器人不会自动启动。';notice('接收名单已保存。');
});

async function confirmAction(message){
 const dialog=$('confirm-dialog');if(dialog.open)return false;
 $('confirm-message').textContent=message;dialog.returnValue='';
 const decision=new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true}));
 dialog.showModal();return decision;
}
$('confirm-yes').onclick=()=>$('confirm-dialog').close('confirm');
$('confirm-no').onclick=()=>$('confirm-dialog').close('cancel');
