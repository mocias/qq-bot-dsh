import {qrLoginWatcher} from './qr-login.js';
import {mountPromptEditor} from './prompt-editor.js';
import {renderHealth,renderGraph} from './memory-viewer.js';
import {mountMemoryBudget} from './memory-budget.js';
const $=id=>document.getElementById(id);
let chatContext={kind:'',key:'',personaId:''},contextTargets=[],contextBusy=false,pageLoad=0;
const inContext=key=>!chatContext.kind||key.split('/')[1]===chatContext.kind;
function paintContext(){
  const active=contextTargets.find(t=>t.key===chatContext.key);const card=active?.cards.find(c=>c.id===chatContext.personaId);
  $('editing-chat-label').textContent=chatContext.key?chatLabel(chatContext.key)+' · '+(card?.name||'当前人格')+(active&&chatContext.personaId!==active.activeId?'（预览，未绑定）':'（实际绑定）'):(chatContext.kind==='private'?'私聊默认配置':chatContext.kind==='group'?'群聊默认配置':'全局默认配置');
  $('context-kind').value=chatContext.kind;
  const targets=contextTargets.filter(t=>inContext(t.key));
  $('context-target').replaceChildren(new Option('类型默认 / 全部对象',''),...targets.map(t=>new Option(chatLabel(t.key),t.key)));
  $('context-target').value=chatContext.key;
  $('context-persona').replaceChildren(new Option('默认规则 / 未选择人格',''));
  for(const t of targets.filter(t=>!chatContext.key||t.key===chatContext.key))for(const c of t.cards)
    $('context-persona').add(new Option(c.name+' · '+chatLabel(t.key)+(c.id===t.activeId?' · 当前使用':''),JSON.stringify([t.key,c.id])));
  $('context-persona').value=chatContext.key&&chatContext.personaId?JSON.stringify([chatContext.key,chatContext.personaId]):'';
}
function setContext(value){
  const key=value.key||'',kind=key?key.split('/')[1]:value.kind||'';
  chatContext={kind,key,personaId:value.personaId||''};paintContext();
  // Loading a chat from 人设与记忆 changes the edited scope too, so the model card
  // must follow instead of keeping the previous scope label and values.
  if(!$('model-settings').hidden)loadModelSettings(document.querySelector('[data-tab].active')?.dataset.tab).catch(error=>notice(error.message,true));
}
async function loadContextTargets(){const data=await request('/api/prompts');contextTargets=data.targets;paintContext();}
async function applyContext(){
  const page=document.querySelector('[data-tab].active')?.dataset.tab;
  if(page==='chat'){
    stashPolicy();
    if(chatContext.key||chatContext.kind)await loadPolicy(chatContext.key||chatContext.kind);
    else{
      $('policy-form').hidden=true;$('policy-context').textContent='请在上方选择私聊、群聊或具体人格，再编辑对应设置。全部类型用于浏览和选择，不会同时修改两种聊天。';
      $('policy-state').textContent='尚未选择配置范围。';
      for(const id of ['policy-delete','target-remove','policy-reload'])$(id).hidden=true;
    }
  }
  await loadModelSettings(page);
  if(page==='prompts')await promptEditor.load();
  if(page==='manage'){
    await loadManagedKeys();$('manage-key').value=chatContext.key;$('memory-id').value=chatContext.key;
    await reloadManaged(chatContext.personaId||undefined);
  }
}
async function changeContext(value){
  if(contextBusy||promptEditor.isBusy()||manageBusy){paintContext();return;}
  if(memoryDirty()&&!await confirmAction('当前人设或记忆有未保存修改，放弃后切换配置范围？')){paintContext();return;}
  contextBusy=true;
  for(const id of ['context-kind','context-target','context-persona'])$(id).disabled=true;
  try{
    if(memoryDirty()){managementData=null;loadedKey='';$('manage-content').hidden=true;}
    setContext(value);await applyContext();
  }catch(e){notice(e.message,true);}finally{contextBusy=false;for(const id of ['context-kind','context-target','context-persona'])$(id).disabled=false;}
}
$('context-kind').onchange=()=>changeContext({kind:$('context-kind').value});
$('context-target').onchange=()=>changeContext({kind:chatContext.kind,key:$('context-target').value});
$('context-persona').onchange=()=>{const value=$('context-persona').value;const [key,personaId]=value?JSON.parse(value):[chatContext.key,''];changeContext({kind:chatContext.kind,key,personaId});};
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
  $('policy-context').textContent=(specific?'只影响此聊天；未勾选“单独设置”的项目继承'+(data.kind==='group'?'群聊':'私聊')+'默认值。':'作为'+(data.kind==='group'?'所有群聊':'所有私聊')+'的默认规则；独立覆盖的字段优先。')+'';
  $('policy-reset').textContent=specific?'清除本聊天覆盖，全部继承':'恢复升级时的默认规则';
  $('policy-delete').hidden=!specific;$('target-remove').hidden=!specific;
  $('policy-delete').disabled=!Object.keys(data.override).length;
  for(const option of $('policy-scope').options)if(option.value.includes('/'))option.textContent=chatLabel(option.value)+(data.overriddenScopes?.includes(option.value)?' · 独立设置':' · 继承默认');
  $('policy-state').textContent=policyDrafts.has(data.scope)?'有未保存修改；切换聊天会暂存草稿。':'已加载保存的设置。';
  for(const [key,spec] of Object.entries(data.fields)){
    if(!cards.has(spec.section)){const card=element('details');card.className='card policy-section';card.append(element('summary',spec.section));cards.set(spec.section,card);container.append(card);}
    const row=element('div');row.className='policy-row';
    const label=element('label',spec.label);label.htmlFor='policy-'+key;
    const input=element(spec.type==='ids'?'textarea':spec.type==='select'?'select':'input');input.id='policy-'+key;
    if(spec.type==='select')for(const [value,text]of Object.entries(spec.options))input.append(new Option(text,value));
    else if(spec.type!=='ids'){input.type=spec.type==='boolean'?'checkbox':spec.type==='string'?'text':spec.type; if(spec.type==='number'){input.min=spec.min;if(spec.max!==undefined)input.max=spec.max;input.required=true;}if(spec.max&&spec.type==='string')input.maxLength=spec.max;}
    else input.rows=3;
    const overridden=Object.hasOwn(data.override,key),value=overridden?data.override[key]:data.inherited[key];
    const setValue=v=>{if(spec.type==='boolean')input.checked=!!v;else input.value=Array.isArray(v)?v.join('\n'):v??'';};
    setValue(value);
    if(spec.type==='boolean'){label.className='switch';label.prepend(input);row.append(label);}else row.append(label,input);
    if(spec.help)row.append(element('p',spec.help));
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
  mountMemoryBudget($,{key:specific?data.scope:null,personaId:chatContext.key===data.scope?chatContext.personaId:undefined,request});
  const updateQuiet=()=>{for(const key of ['voiceQuietStart','voiceQuietEnd'])$('policy-'+key).closest('.policy-row').hidden=$('policy-voiceQuietMode').value!=='scheduled';};
  $('policy-voiceQuietMode').addEventListener('change',updateQuiet);
  $('override-voiceQuietMode')?.addEventListener('change',updateQuiet);updateQuiet();
  if(specific){
    const card=element('details');card.className='card policy-section';
    card.append(element('summary','消息与参与状态'),element('p','仅本聊天。未读是机器人本地处理进度，不是 QQ 客户端的已读回执；最多保留最近 500 条。'));
    const state=element('p','正在读取未读和潜水状态……'),preview=element('pre'),actions=element('div');
    actions.className='actions';preview.className='chat-inbox-preview';state.setAttribute('role','status');
    const key=data.scope;
    const refresh=async()=>{
      const value=await request('/api/chat-state?key='+encodeURIComponent(key));
      state.textContent=`未读 ${value.unreadCount} 条；${value.sleeping?'潜水至 '+new Date(value.wake.until).toLocaleString():'活跃'}。`+(value.truncatedBeforeSeq?'更早记录已超出保留上限。':'');
      preview.textContent=value.messages.map(m=>`#${m.seq} · ${m.sender?.nickname||m.sender?.qq||m.sender}：${m.text}${m.textTruncated?'（摘要）':''}`).join('\n');
    };
    for(const [label,mode]of [['刷新状态',null],['潜水 1800 秒','diving'],['立即唤醒','active']]){
      const button=element('button',label);button.type='button';button.className='secondary';
      button.onclick=async()=>{button.disabled=true;try{if(mode)await request('/api/chat-wake',{key,mode,seconds:1800});await refresh();}catch(error){state.textContent=error.message;}finally{button.disabled=false;}};
      actions.append(button);
    }
    card.append(actions,state,preview);container.append(card);
    refresh().catch(error=>{state.textContent=error.message;});
  }
}
async function loadPolicy(scope,force=false){
  const serial=++policyLoad;$('policy-save').disabled=true;$('policy-reset').disabled=true;
  const data=await request('/api/chat-policy?scope='+encodeURIComponent(scope));
  if(serial!==policyLoad)return;
  $('policy-form').hidden=false;$('policy-reload').hidden=false;
  $('policy-scope').replaceChildren();
  for(const key of data.scopes.filter(k=>!chatContext.kind||(k.includes('/')?k.split('/')[1]:k)===chatContext.kind))$('policy-scope').append(new Option(key==='private'?'私聊默认设置':key==='group'?'群聊默认设置':chatLabel(key)+(data.overriddenScopes?.includes(key)?' · 独立设置':' · 继承默认'),key));
  $('policy-scope').value=scope;
  if(force)policyDrafts.delete(scope);
  paintPolicy(policyDrafts.get(scope)??data);
}
$('policy-scope').onchange=()=>{stashPolicy();const key=$('policy-scope').value;setContext(key.includes('/')?{key}:{kind:key});loadPolicy(key).catch(e=>notice(e.message,true));};
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
const voiceFields=['voiceProvider','voice','model','mimoApiKey','mimoTtsMode','mimoVoice','mimoReferenceId','mimoStyle','mimoDesign','mimoAsrLanguage'];
let voiceProfileData={revision:0,profiles:[]},voiceFormDirty=false,defaultVoiceConfig=null;
function voiceSettings(){return Object.fromEntries(voiceFields.filter(k=>k!=='mimoApiKey').map(k=>[k,$(k).value]));}
async function loadVoiceProfiles(selected=$('voice-profile').value){
  voiceProfileData=await request('/api/voice/profiles');
  $('voice-profile').replaceChildren(new Option('全局默认语音配置',''));
  $('voice-profile-deleted').replaceChildren(new Option('选择要恢复的预设',''));
  for(const p of voiceProfileData.profiles)(p.deletedAt?$('voice-profile-deleted'):$('voice-profile')).append(new Option(p.name,p.id));
  $('voice-profile').value=selected;updateProfileButtons();
}
function updateProfileButtons(){
 const selected=$('voice-profile').value;
 $('voice-profile-save').disabled=!selected;$('voice-profile-delete').disabled=!selected;
 $('voice-profile-restore').disabled=$('voice-profile-deleted').options.length<=1;
 $('voice-preview-context').textContent='下方试听使用已保存的'+(selected?'预设：'+($('voice-profile').selectedOptions[0]?.textContent??''):'全局默认')+'。不会使用未保存的编辑，也不会发送 QQ。';
}
async function loadProfileEditor(){
 const profile=voiceProfileData.profiles.find(p=>p.id===$('voice-profile').value&&!p.deletedAt);
 const config={...defaultVoiceConfig,...(profile?.settings??{})};
 await fillVoice(config,false);
 $('voice-profile-name').value=profile?.name??'';
 $('voice-profile-state').textContent=profile?'已载入预设；修改后可更新或另存，不会自动影响已绑定人设。':'正在编辑全局默认；也可以另存为命名预设。';
 updateProfileButtons();voiceFormDirty=false;$('voice-profile').dataset.loaded=$('voice-profile').value;
}
$('voice-profile-name').addEventListener('input',()=>{voiceFormDirty=true;});
$('voice-profile').onchange=async()=>{
 if(voiceFormDirty&&!await confirmAction('切换预设会放弃下方尚未保存的语音编辑，继续？')){$('voice-profile').value=$('voice-profile').dataset.loaded??'';return;}
 try{await loadProfileEditor();$('voice-profile').dataset.loaded=$('voice-profile').value;}catch(e){notice(e.message,true);}
};
async function saveVoiceProfile(copy){
 if($('mimoApiKey').value.trim())throw Error('密钥尚未保存，请先点击“保存为全局默认与密钥”。预设不保存密钥。');
 const result=await request('/api/voice/profiles/save',{id:copy?undefined:$('voice-profile').value,name:$('voice-profile-name').value,settings:voiceSettings(),revision:voiceProfileData.revision});
 await loadVoiceProfiles(result.profile.id);await loadProfileEditor();$('voice-profile').dataset.loaded=result.profile.id;
 notice('语音预设已保存。可在人设与记忆中选择；已保存的人设副本保持不变。');
}
$('voice-profile-create').onclick=()=>action($('voice-profile-create'),()=>saveVoiceProfile(true));
$('voice-profile-save').onclick=()=>action($('voice-profile-save'),()=>saveVoiceProfile(false));
$('voice-profile-delete').onclick=()=>action($('voice-profile-delete'),async()=>{
 if(!await confirmAction('删除此公共语音预设？可以恢复，已保存的人设语音副本保持不变。'))return;
 await request('/api/voice/profiles/delete',{id:$('voice-profile').value,revision:voiceProfileData.revision});
 await loadVoiceProfiles('');await loadProfileEditor();notice('预设已移至已删除列表，人设独立副本保留。');
});
$('voice-profile-restore').onclick=()=>action($('voice-profile-restore'),async()=>{
 const id=$('voice-profile-deleted').value;if(!id)throw Error('请选择要恢复的预设');
 await request('/api/voice/profiles/restore',{id,revision:voiceProfileData.revision});await loadVoiceProfiles(id);await loadProfileEditor();notice('语音预设已恢复。');
});
function voiceOptions(){
  const mimo=$('voiceProvider').value==='mimo';
  $('local-options').hidden=mimo;$('mimo-options').hidden=!mimo;
  const clone=$('mimoTtsMode').value==='clone';
  const design=$('mimoTtsMode').value==='design';
  $('preset-options').hidden=clone||design;$('clone-options').hidden=!clone;$('design-options').hidden=!design;
  $('mimoDesign').required=mimo&&design;
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
async function fillVoice(config,asDefault=true){
  if(asDefault){defaultVoiceConfig=config;await loadVoiceProfiles('');$('voice-profile').dataset.loaded='';}
  for(const field of voiceFields)if(field!=='mimoReferenceId')$(field).value=field==='mimoApiKey'?'':config[field];
  $('mimo-key-state').textContent=config.mimoApiKeyConfigured?'已保存（不回显）':'未配置';
  $('mimo-clear').hidden=!config.mimoApiKeyConfigured;
  await loadReferences(config.mimoReferenceId);voiceOptions();
  $('voice-saved-state').textContent='已载入：'+(config.voiceProvider==='mimo'?'MiMo API':'本地模式')+'；修改后请选择保存为默认或存为预设。';voiceFormDirty=false;
}
function paintVoiceStatus({config,voice}){
  defaultVoiceConfig=config;
  const selected=voiceProfileData.profiles.find(p=>p.id===$('voice-profile').value&&!p.deletedAt);
  if(selected){config={...config,...selected.settings};voice={...selected.status,busy:voice.busy};}
  const mimo=config.voiceProvider==='mimo';
  $('tts-label').closest('article').dataset.state=voice.ttsReady?(mimo?'configured':'ready'):'missing';
  $('model-label').closest('article').dataset.state=voice.asrReady?(mimo?'configured':'ready'):'missing';
  $('tts-label').textContent=mimo?(config.mimoTtsMode==='clone'?'MiMo 音色克隆':config.mimoTtsMode==='design'?'MiMo 音色设计':'MiMo 预置音色'):'Windows 中文语音';
  $('tts-status').textContent=voice.ttsReady?(mimo?'已配置 · 请生成语音验证':'组件已就绪'):(mimo?'密钥、音色描述或参考录音未就绪':'组件未找到');
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
$('voice-config-form').addEventListener('input',()=>{voiceFormDirty=true;$('voice-saved-state').textContent='有未保存修改；试听和 QQ 仍使用已保存的配置。';});
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
    await fillVoice(result.config);notice('全局默认语音配置与密钥已保存；人设的独立语音副本保持不变。');
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
const fields=['dshUrl','dshLocalAuth','dshToken','botQQ','qqBackend','qqUrl','qqToken','privateUsers','groups','qqExecutable','napcatFrameworkDir','qqMediaRoots','ffmpegPath'];
const switches=['dshLocalAuth'],numbers=[];
let generatedUrl='',initialized=false;
let qqBackendMode='shell',qqShellReceiveState=null;
function notice(text,error=false){$('notice').textContent=text;$('notice').classList.toggle('error',error);}
async function request(url,body){const response=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-QQ-RSI':'panel'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error||'请求失败');return result;}
function paintBackend(){const external=$('qqBackend').value==='external';document.querySelectorAll('[data-qq-backend]').forEach(el=>{el.hidden=el.dataset.qqBackend!==(external?'external':'shell');});$('qqUrl').required=external;}
function fill(config,selected=fields){for(const field of selected){if(field.endsWith('Token')){$(field).value='';continue;}if(switches.includes(field)){$(field).checked=config[field];continue;}$(field).value=Array.isArray(config[field])?config[field].join('\n'):config[field];}$('dsh-key-state').textContent=config.dshTokenConfigured?'已保存':'未配置';$('qq-key-state').textContent=config.qqTokenConfigured?'已保存':'未配置';paintBackend();}
$('qqBackend').onchange=paintBackend;
async function refresh(){const status=await request('/api/status');qqBackendMode=status.config.qqBackend||'shell';if(qqBackendMode==='shell'&&!qqShellReceiveState)qqShellReceiveState={allowed:false,reason:'QQ Shell 组件与进程状态尚未核实，接收保持停止。'};if(!initialized){fill(status.config);await fillVoice(status.config);initialized=true;}$('validation-state').hidden=!status.validationMessage;$('validation-state').textContent=status.validationMessage||'';$('service-status').textContent='独立服务已运行';$('sidebar-bridge-state').textContent=status.bridge.state==='running'?'QQ 接收运行中':status.bridge.state==='connecting'?'QQ 正在连接':'QQ 接收已停止';$('sidebar-bridge-state').parentElement.dataset.state=status.bridge.state;paintVoiceStatus(status);$('bridge-status').textContent=status.bridge.state==='running'?'QQ '+(status.bridge.account||'')+' 已连接':status.bridge.state==='connecting'?'正在连接 QQ':'QQ 连接已停止';$('bridge-detail').textContent=status.bridge.lastError||`待处理消息：${status.bridge.active} · 启动后接收名单内已启用的消息`;$('start').disabled=status.bridge.state!=='stopped';$('stop').disabled=status.bridge.state==='stopped';paintChannels(status.bridge);paintLife(status);return status;}
async function action(button,work){button.disabled=true;notice('正在处理，请稍候…');try{await work();if($('notice').textContent==='正在处理，请稍候…')notice('操作已完成。');}catch(error){notice(error.message,true);}finally{button.disabled=false;if(button.id==='persona-apply'&&managementData)paintPersonaCards(managementData);if(button.id.startsWith('voice-profile-'))updateProfileButtons();if(button.id==='reference-delete')button.disabled=!$('mimoReferenceId').value;if(button.id==='reference-restore')button.disabled=$('reference-deleted').options.length<=1;await refresh().catch(()=>{});if(button.id.startsWith('qq-version-'))paintVersionActions();}}
const promptEditor=mountPromptEditor({request,notice,getContext:()=>chatContext,onSelect:setContext});
const pages={
  directory:['聊天列表','按聊天对象管理人格、模型与接收状态。'],
  voice:['语音与通话','选择语音服务、配置音色，让每个人格拥有自己的声音。'],
  connections:['连接与配置','连接 DSH，选择 QQ 接入方式和允许的聊天。'],
  prompts:['提示词配置','查看和修改共用规则，为每个人格设置独立覆盖。'],
  chat:['会话与聊天','管理会话轮换、多媒体消息、主动搭话与群聊能力。'],
  manage:['人设与记忆','查看记忆库，管理聊天人设、长期记忆、表情与黑话。'],
  qq:['QQ 控制','准备 QQ 组件、扫码登录，核验账号后手动启用接收。'],
  messages:['QQ 消息监控','查看私聊、群聊及各人格的收发记录。'],
  logs:['运行日志','查看本服务的运行事件、处理结果与故障记录。'],
  manual:['说明书',''],
};
for(const tab of document.querySelectorAll('[data-tab]'))tab.addEventListener('click',async()=>{
  if(contextBusy||promptEditor.isBusy()||manageBusy)return;
  const navigation=++pageLoad;
  const name=tab.dataset.tab;
  if(name!=='qq')qrWatcher.stop();
  for(const page of Object.keys(pages))$(page+'-tab').hidden=page!==name;
  document.querySelectorAll('[data-tab]').forEach(x=>{x.classList.toggle('active',x===tab);x.setAttribute('aria-current',x===tab?'page':'false');});
  [$('page-title').textContent,$('page-subtitle').textContent]=pages[name];notice('');
  $('page-context').textContent=pages[name][0];
  window.scrollTo({top:0});
  $('chat-context').hidden=!['chat','prompts','manage'].includes(name);
  $('model-settings').hidden=name!=='chat';
  if(['chat','prompts','manage'].includes(name)){
    try{await loadContextTargets();if(navigation!==pageLoad||name==='manage'&&memoryDirty())return;await applyContext();}catch(e){if(navigation===pageLoad)notice(e.message,true);}
  }
  if(name==='directory')loadDirectory().catch(e=>notice(e.message,true));
  if(name==='qq')refreshQQ().catch(e=>notice(e.message,true));
  if(name==='logs'){loadLogs().catch(e=>notice(e.message,true));refreshQQ().catch(e=>notice(e.message,true));}
  if(name==='messages')refreshMessages().catch(e=>notice(e.message,true));
  if(name==='connections')checkNativePlugin();
});
for(const formId of ['config-form'])$(formId).addEventListener('submit',event=>{
  event.preventDefault();const selected=fields.filter(field=>event.currentTarget.contains($(field))),data={};
  for(const field of selected)data[field]=switches.includes(field)?$(field).checked:numbers.includes(field)?Number($(field).value):field==='qqMediaRoots'?$(field).value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean):['privateUsers','groups','adminUsers'].includes(field)?$(field).value.split(/[\s,，]+/).filter(Boolean):$(field).value;
  action(event.submitter,async()=>{const result=await request('/api/config',data);fill(result.config,selected);qqShellReceiveState=null;$('config-saved-state').textContent='连接配置已保存。'+(result.napcatSync?.message??'');notice($('config-saved-state').textContent,result.napcatSync?.state==='pending');await refreshQQ();});
});
$('synthesize').addEventListener('click',()=>action($('synthesize'),async()=>{const result=await request('/api/voice/synthesize',{text:$('speech-text').value,profileId:$('voice-profile').value});generatedUrl=result.audioUrl;$('audio-player').src=generatedUrl;$('audio-result').hidden=false;notice('语音已生成，可以试听或继续识别。');}));
async function recognize(buffer){$('voice-progress').textContent='正在使用已保存的服务识别，请稍候…';try{const bytes=new Uint8Array(buffer);let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));const result=await request('/api/voice/transcribe',{audio:btoa(binary),profileId:$('voice-profile').value});$('transcript').value=result.text;notice(`识别完成 · ${result.model} 模型 · ${Number.isFinite(result.duration)?result.duration.toFixed(1)+' 秒音频':'识别完成'}`);}finally{$('voice-progress').textContent='使用已保存的语音服务';}}
$('transcribe').addEventListener('click',()=>action($('transcribe'),async()=>{const file=$('audio-file').files[0];if(!file)throw Error('请先选择音频');if(file.size>8*1024*1024)throw Error('文件不能超过 8 MiB');await recognize(await file.arrayBuffer());}));
$('recognize-generated').addEventListener('click',()=>action($('recognize-generated'),async()=>{const response=await fetch(generatedUrl);if(!response.ok)throw Error('生成的音频已过期，请重新生成');await recognize(await response.arrayBuffer());}));
$('discover-dsh').addEventListener('click',()=>action($('discover-dsh'),async()=>{const result=await request('/api/dsh/discover',{});$('dshUrl').value=result.url;notice('已检测到本机 DSH：'+result.url+(result.reused?'（原地址仍有效）':'（已更新并保存）'));}));
$('probe').addEventListener('click',()=>action($('probe'),async()=>{const result=await request('/api/dsh/probe',{});$('presets').hidden=false;$('presets').textContent=JSON.stringify(result.presets,null,2);notice('DSH 连接成功，下方显示可用预设。');}));
async function checkNativePlugin(){
  const button=$('native-plugin-check');if(button.disabled)return;button.disabled=true;
  $('native-plugin-state').textContent='正在检查…';
  // Clear previous results so a failed refresh cannot display an old success.
  $('native-service-version').textContent='—';$('native-plugin-version').textContent='—';$('native-plugin-mode').textContent='';
  try{
    const data=await request('/api/dsh/native-status',{});
    const labels={ready:'已就绪',disabled:'已关闭',missing:'未安装',unreachable:'未连接',unavailable:'未就绪',mismatch:'版本不一致',unknown:'无法确认'};
    $('native-plugin-state').textContent=(labels[data.state]??'无法确认')+' · '+data.message;
    $('native-service-version').textContent=data.serviceVersion;
    $('native-plugin-version').textContent=data.pluginVersion??'未读取';
    $('native-plugin-mode').textContent='当前调用方式：'+(data.nativeMode?'原生执行请求与工具':'旧版兼容模式')+(data.compatible===true?' · 版本和构建一致':'');
  }catch(error){$('native-plugin-state').textContent='检查失败 · '+error.message;}
  finally{button.disabled=false;}
}
$('native-plugin-check').addEventListener('click',checkNativePlugin);
function shellReceiveGate(data){
 if(data?.backend==='external')return {allowed:true,reason:''};
 const component=data?.runtime?.component,process=data?.runtime?.process;
 if(component?.state==='invalid')return {allowed:false,reason:component.message||data.message||'QQ Shell 本地组件校验失败，接收保持停止。'};
 if(component?.state!=='verified')return {allowed:false,reason:component?.message||data.message||'QQ Shell 组件状态尚未核实，接收保持停止。'};
 if(process?.state==='stopped')return {allowed:false,reason:'请先启动本项目管理的 QQ 登录进程，再启用接收。'};
 if(process?.state!=='running'||process?.owned!==true)return {allowed:false,reason:data?.message||'QQ 登录进程归属或运行状态未确认，接收保持停止。'};
 return {allowed:true,reason:''};
}
function paintChannels(bridge){
 const running=bridge.state==='running',connecting=bridge.state==='connecting',channels=bridge.channels??{},allChannels=bridge.allChannels??channels;
 const receiveBlocked=qqBackendMode==='shell'&&qqShellReceiveState?.allowed!==true;
 const receiveReason=receiveBlocked?(qqShellReceiveState?.reason||'QQ Shell 组件与进程状态尚未核实，接收保持停止。'):'';
 const channelLabel=kind=>running&&channels[kind]?(allChannels[kind]?'全部接收中':'部分聊天接收中'):'已停止';
 const text='私聊：'+channelLabel('private')+' · 群聊：'+channelLabel('group');
 const phases={preparing:'准备整理',digesting:'整理记录',greeting:'旧版招呼阶段（已停用）',publishing:'旧版招呼发送记录',failed:'启动暂停',uncertain:'发送待核实'};
 const startup=(bridge.startups??[]).filter(s=>phases[s.phase]).map(s=>`${s.key.includes('/group/')?'群':'私聊'} ${s.key.split('/').at(-1)}：${phases[s.phase]}${s.batches?' '+s.completed+'/'+s.batches:''} · 排队 ${s.queued} 条`).join('；');
 const detail=(receiveReason?receiveReason+' · ':'')+text+' · 待处理：'+bridge.active+(startup?' · '+startup:'');
 $('bridge-detail').textContent=(bridge.lastError?bridge.lastError+' · ':'')+detail;
 $('qq-control-bridge').textContent=detail;
 for(const prefix of ['', 'qq-control-']){
  $(prefix+'start').disabled=receiveBlocked||connecting||(running&&allChannels.private&&allChannels.group);
  $(prefix+'stop').disabled=bridge.state==='stopped';
  for(const kind of ['private','group']){
   $(prefix+'start-'+kind).disabled=receiveBlocked||connecting||!!(running&&allChannels[kind]);
   $(prefix+'stop-'+kind).disabled=connecting||!(running&&channels[kind]);
  }
 }
}
for(const prefix of ['', 'qq-control-'])for(const kind of ['private','group'])for(const verb of ['start','stop']){
 const button=$(prefix+verb+'-'+kind);
   button.onclick=()=>action(button,async()=>{await request('/api/bridge/'+verb,{kind});notice((kind==='private'?'私聊':'群聊')+(verb==='start'?'接收已启动。':'接收已停止。'));if(prefix==='qq-control-')await refreshQQ();});
}
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
let managementData=null,loadedKey='',manageSerial=0,currentBot='',manageBusy=false,managedKeys=[],storedKeys=[];
const element=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
function pageSelect(){const page=managementData.detail.pages.find(p=>p.name===$('page-select').value);$('page-path').value=page?.name??'';$('page-text').value=page?.text??'';$('page-state').textContent=page?'已加载此页。':'新页面尚未保存。';}
function memoryDirty(){
  if(!managementData||!loadedKey)return false;
  const page=managementData.detail.pages.find(p=>p.name===$('page-path').value);
  return $('persona-display-name').value!==managementData.detail.personaName||$('persona-text').value!==managementData.detail.persona||$('page-text').value!==(page?.text??'')||(!page&&!!$('page-path').value)||$('persona-voice-profile').value!==(managementData.personaVoice?.saved?'__saved__':'');
}
function managedInput(){if(!loadedKey||loadedKey!==$('manage-key').value||managementData?.detail.personaId!==$('persona-card').value)throw Error('请先加载选中人格的资料');return {key:loadedKey,personaId:managementData.detail.personaId};}
function paintManaged(data){
 if(data.detail.key!==loadedKey||$('manage-key').value!==loadedKey)return;
 const prior=managementData?.detail;
 const draft=prior?.key===loadedKey&&prior.personaId===data.detail.personaId?{
   name:$('persona-display-name').value!==prior.personaName?$('persona-display-name').value:null,
   voice:$('persona-voice-profile').value!==(managementData.personaVoice?.saved?'__saved__':'')?$('persona-voice-profile').value:null,
   persona:$('persona-text').value!==prior.persona?$('persona-text').value:null,
   path:$('page-path').value,text:$('page-text').value,
   pageDirty:$('page-text').value!==(prior.pages.find(p=>p.name===$('page-path').value)?.text??'')||(!prior.pages.some(p=>p.name===$('page-path').value)&&!!$('page-path').value),
 }:null;
 managementData=data;$('manage-content').hidden=false;$('new-conversation').disabled=data.detail.personaId!==data.personas.activeId;
 paintPersonaCards(data);
 $('persona-display-name').value=draft?.name??data.detail.personaName;
 $('memory-export').hidden=false;$('memory-export').href='/api/manage/export?'+new URLSearchParams({key:loadedKey,personaId:data.detail.personaId});
 const role=$('role-state');role.replaceChildren();
 if(data.roleState){
  role.append(element('p','更新于 '+new Date(data.roleState.savedAt).toLocaleString()+' · 已保存到本人格长期记忆'));
  for(const [key,label] of Object.entries({activity:'正在做什么',mood:'情绪',attention:'注意力',progress:'事情进展',nextIntent:'下一步打算'}))role.append(element('p',label+'：'+data.roleState[key]));
 }else role.append(element('p','尚无已保存的角色推演。开启接收和长期记忆后，定时推演将逐次保存。'));
 paintPersonaVoice(data.personaVoice);
 if(draft?.voice!==null&&draft?.voice!==undefined){$('persona-voice-profile').value=draft.voice;$('persona-voice-state').textContent+=' 另有未保存的语音选择。';}
 $('memory-reset').disabled=false;
 populateMemoryNumbers();$('memory-id').value=loadedKey;
 $('slang-card').hidden=!loadedKey.includes('/group/');
 $('memory-overview').textContent=chatLabel(loadedKey)+' · '+data.detail.personaName+' · 长期记忆：'+(data.policy?.memoryEnabled?'开启':'关闭')+'。此处修改仅影响这张人格卡。';
 $('memory-directory').value=data.detail.insights.store;
 $('memory-settings-summary').textContent='新会话记忆注入：'+(data.policy?.memoryAutoInject?'开启':'关闭')+' · memory 操作协议：'+(data.policy?.memoryRegisterSkill?'开启':'关闭')+' · 仅最近活跃聊天注入：'+(data.policy?.memoryActiveOnly?'开启':'关闭')+' · 主动追忆：'+(data.policy?.proactiveEnabled?'开启':'关闭');
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
 const history=data.detail.history;
 $('manage-health').append(element('p',history?.state==='ready'?'本地 Git 历史已保存 · '+history.commit.slice(0,8):history?.state==='unavailable'?history.message:'本地 Git 历史将在首次保存记忆或人设时建立；仅保存在本机。'));
 const stickers=$('stickers');stickers.replaceChildren();
 for(const item of data.knowledge.stickers){const card=element('div');card.className='library-item';const img=element('img');img.alt=item.note||'收藏表情';img.loading='lazy';img.src='/api/sticker/image?key='+encodeURIComponent(loadedKey)+'&personaId='+encodeURIComponent(data.detail.personaId)+'&id='+encodeURIComponent(item.id);card.append(img);
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
 await loadVoiceProfiles();
 const old=$('manage-key').value,data=await request('/api/manage');currentBot=data.currentBot;
 storedKeys=data.storedKeys;
 const keys=data.keys.filter(key=>inContext(key)&&($('memory-history').checked||data.connectedKeys.includes(key)));managedKeys=keys;
 $('memory-account').textContent='当前机器人账号：'+(currentBot||'未配置')+'。每个好友和群独立保存；历史账号资料不会自动转给当前账号。';
 $('manage-key').replaceChildren(new Option('请选择好友或群',''));
 for(const key of keys)$('manage-key').append(new Option(chatLabel(key)+(key.split('/')[0]===currentBot?'':' · 历史账号 '+key.split('/')[0]),key));
 if(keys.includes(old))$('manage-key').value=old;
 else {loadedKey='';managementData=null;$('manage-content').hidden=true;$('memory-reset').disabled=true;++manageSerial;}
 populateMemoryNumbers();
 $('manage-empty').textContent=keys.length?'选择即加载；切换不会覆盖、复制或合并任何记忆。':'没有已接入聊天。请在 QQ 控制中加入接收名单，或勾选查看历史资料。';
}
function paintPersonaVoice(selection){
 const saved=selection?.saved,select=$('persona-voice-profile');
 select.replaceChildren(new Option('沿用全局默认',''));
 if(saved)select.append(new Option('当前独立配置：'+saved.name,'__saved__'));
 for(const p of voiceProfileData.profiles.filter(p=>!p.deletedAt))select.append(new Option(p.name,p.id));
 select.value=saved?'__saved__':'';
 const settings=saved?.settings;
 $('persona-voice-state').textContent=saved?'已独立保存：'+saved.name+' · '+(settings.voiceProvider==='local'?'本地语音':settings.mimoTtsMode==='design'?'MiMo 音色设计':settings.mimoTtsMode==='clone'?'MiMo 音色克隆':'MiMo 预置音色')+(settings.mimoTtsMode==='design'?' · '+settings.mimoDesign:''):'当前沿用全局默认语音配置。';
}
$('persona-voice-profile').onchange=()=>{$('persona-voice-state').textContent='语音选择尚未保存；仅影响当前聊天人设。';};
$('persona-voice-library').onclick=()=>document.querySelector('[data-tab="voice"]').click();
$('persona-voice-save').onclick=()=>action($('persona-voice-save'),async()=>{
 const input=managedInput(),profileId=$('persona-voice-profile').value;
 if(profileId==='__saved__'){notice('当前独立配置已经保存。若要采用公共预设的新版本，请重新选择该预设。');return;}
 manageBusy=true;
 try{
  const data=await request('/api/manage/voice',{...input,profileId,revision:managementData.personaVoice.revision});
  if(loadedKey!==input.key||managementData?.detail.personaId!==input.personaId)return;
  // Mark only this choice as acknowledged; preserve unrelated persona/page drafts.
  managementData.personaVoice=data.personaVoice;paintPersonaVoice(data.personaVoice);paintManaged(data);
  notice(profileId?'此人设的语音副本已保存，下次处理消息生效。':'已清除独立语音选择，沿用全局默认。');
 }finally{manageBusy=false;}
});
function populateMemoryNumbers(){
 const old=$('memory-id').value;
 $('memory-id').replaceChildren(new Option('请选择好友或群',''));
 for(const key of managedKeys)$('memory-id').append(new Option(chatLabel(key)+(storedKeys.includes(key)?' · 已有资料':' · 尚无资料')+(key.split('/')[0]===currentBot?'':' · 历史账号 '+key.split('/')[0]),key));
 if(managedKeys.includes(old))$('memory-id').value=old;
}
$('memory-id').onchange=()=>{if($('memory-id').value)$('memory-open').click();};
function paintLife(status){
 if(!loadedKey)return;
 const sessions=(status.lifecycle??[]).filter(s=>s.key===loadedKey&&(s.personaId??'default')===managementData?.detail.personaId);
 $('lifecycle-status').textContent=sessions.length?sessions.map(s=>(s.title?s.title+' · ':'')+(s.absence?'来信空闲 '+Math.floor(s.absence.seconds/60)+' 分钟 / '+Math.ceil(s.absence.thresholdSeconds/60)+' 分钟 · '+({active:'对话中',handoff:'保存交接中',digest:'整理记忆中',asleep:'已休眠'}[s.absence.phase]??s.absence.phase)+' · ':'')+'已压缩 '+s.compactions+' 次 · 待整理 '+s.pendingCompactions+' 次'+(s.maintenance?' · 整理中':'')+(s.blocked?' · 旧回合已隔离':'')+(s.workspace?'\n工作区：'+s.workspace:'')).join('\n'):'此聊天暂无运行会话；记忆库可独立管理。';
}
async function reloadManaged(personaId){
  const key=$('manage-key').value,serial=++manageSerial;loadedKey='';managementData=null;
  $('memory-export').hidden=true;$('manage-content').hidden=true;$('new-conversation').disabled=true;
  $('memory-reset').disabled=true;
  $('persona-apply').disabled=true;$('persona-card').disabled=true;$('persona-card-create').disabled=true;
  if(!key){$('manage-empty').textContent='请选择好友或群，或输入号码打开记忆。';return;}
  $('manage-empty').textContent='正在加载 '+chatLabel(key)+' 的独立资料…';
  try{const data=await request('/api/manage?key='+encodeURIComponent(key)+(personaId?'&personaId='+encodeURIComponent(personaId):''));if(serial!==manageSerial||$('manage-key').value!==key)return;
    loadedKey=key;paintManaged(data);setContext({key,personaId:data.detail.personaId});$('manage-empty').textContent='已加载 '+chatLabel(key)+' · '+data.detail.personaName+'。选择预览不会切换正在使用的人格。';
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
  const key=$('memory-id').value;if(!key)throw Error('请先选择已接入的好友或群');
  const personaId=key===loadedKey?managementData?.detail.personaId:undefined;
  $('manage-key').value=key;await reloadManaged(personaId);
});
function paintPersonaCards(data){
 $('persona-reuse-source').replaceChildren(...(data.reusablePersonas??[]).filter(c=>c.key!==loadedKey).map(c=>new Option(c.name+' · '+chatLabel(c.key),JSON.stringify([c.key,c.id]))));
 $('persona-reuse').disabled=!$('persona-reuse-source').options.length;

 const target=contextTargets.find(t=>t.key===loadedKey);
 if(target){target.cards=data.personas.cards;target.activeId=data.personas.activeId;paintContext();}
 const selected=data.detail.personaId,active=data.personas.activeId;
 $('persona-card').replaceChildren(...data.personas.cards.map(c=>new Option(c.name+(c.id===active?' · 当前使用':''),c.id)));
 $('persona-card').value=selected;$('persona-card').disabled=false;$('persona-card-create').disabled=false;
 $('persona-apply').disabled=selected===active||loadedKey.split('/')[0]!==currentBot;
 const activeName=data.personas.cards.find(c=>c.id===active)?.name??'';
 $('manage-empty').textContent='已加载 '+chatLabel(loadedKey)+' · '+data.detail.personaName+'。选择预览不会切换正在使用的人格。';
 $('persona-card-state').textContent=selected===active?'当前使用：'+activeName+'。人设和记忆独立保存。':'当前使用：'+activeName+'；正在预览：'+data.detail.personaName+'。点击“确定配置”才会切换。';
}
$('persona-card').onchange=async()=>{
 const previous=managementData?.detail.personaId,selected=$('persona-card').value;
 if(manageBusy||(memoryDirty()&&!await confirmAction('当前人格有未保存的修改，放弃修改并查看另一张人格卡？'))){$('persona-card').value=previous??'';return;}
 reloadManaged(selected).catch(e=>notice(e.message,true));
};
$('persona-reuse').onclick=()=>action($('persona-reuse'),async()=>{
 const key=loadedKey;if(!key||!managementData)throw Error('请先选择聊天');
 const [sourceKey,sourcePersonaId]=JSON.parse($('persona-reuse-source').value);
 const data=await request('/api/persona-cards/reuse',{key,sourceKey,sourcePersonaId,revision:managementData.personas.revision});
 paintManaged(data);setContext({key,personaId:data.detail.personaId});notice('已加入共享人格；人设和记忆共用，点击确定配置后使用。');
});
$('persona-card-create').onclick=()=>action($('persona-card-create'),async()=>{
 if(manageBusy)throw Error('请等待当前保存完成');
 if(memoryDirty())throw Error('请先保存当前人格的修改，再创建新卡');
 const {key}=managedInput();manageBusy=true;
 try{const data=await request('/api/persona-cards/create',{key,name:$('persona-card-name').value,revision:managementData.personas.revision});
   managementData=null;paintManaged(data);setContext({key,personaId:data.detail.personaId});$('persona-card-name').value='';$('persona-create-dialog').close();notice('人格卡已创建，可在下方编辑人设；尚未切换使用。');
 }catch(error){$('persona-create-error').textContent=error.message;throw error;}finally{manageBusy=false;}
});
$('persona-apply').onclick=()=>action($('persona-apply'),async()=>{
 if(manageBusy)throw Error('请等待当前保存完成');
 if(memoryDirty())throw Error('请先保存人设、记忆或语音修改，再确定配置');
 const input=managedInput();manageBusy=true;
 try{const data=await request('/api/persona-cards/assign',{...input,revision:managementData.personas.revision});paintManaged(data);notice('已配置为 '+data.detail.personaName+'。启动接收后使用这张人格卡。');}
 finally{manageBusy=false;}
});
async function resetMemory(account){
 if(manageBusy)throw Error('请等待当前保存完成');
 const scope=account?'account':managedInput().key;
 const target=account?'当前机器人 '+currentBot+' 下的全部聊天（包括未接入的历史资料）':chatLabel(scope);
 if(!await confirmAction('确认重置 '+target+' 的全部记忆？包括人设及其语音选择、长期记忆、表情笔记、黑话及当前会话上下文。未保存草稿将丢弃。旧资料保存在本机备份中；其他机器人账号、QQ 聊天记录和语音配置不受影响。'))return;
 const result=await request('/api/manage/reset',{scope,confirm:'RESET '+(account?currentBot:scope)});
 loadedKey='';managementData=null;++manageSerial;$('manage-content').hidden=true;
 await loadManagedKeys();if(!account){$('manage-key').value=scope;await reloadManaged();}
 notice('已重置 '+result.count+' 个聊天的全部记忆。备份编号：'+result.backupId+'。下次收到消息会建立新会话。');
}
$('memory-reset').onclick=()=>action($('memory-reset'),()=>resetMemory(false));
$('memory-reset-account').onclick=()=>action($('memory-reset-account'),()=>resetMemory(true));

const logNames={'service.started':'服务启动','service.stopped':'服务停止','service.error':'服务异常','operation.completed':'操作完成','operation.failed':'操作失败','memory.reset':'记忆已重置','bridge.start.requested':'正在启动 QQ 接收','bridge.connected':'QQ 连接成功','bridge.stopped':'QQ 接收已停止','bridge.error':'QQ 处理异常（详情见连接状态）','turn.started':'Agent 回合开始','turn.completed':'Agent 回合结束','turn.failed':'Agent 回合失败','message.accepted':'已接收一条名单内消息','maintenance.started':'记忆整理开始','maintenance.completed':'记忆整理结束','maintenance.failed':'记忆整理失败','message.sent':'消息投递成功','message.failed':'消息投递失败','message.unknown':'消息投递结果未知'};
Object.assign(logNames,{'session.created':'首次创建对话','session.recovered':'上次模型执行状态不确定，隔离旧会话后创建对话','session.rotated':'已完成记忆整理，按压缩次数轮换对话','session.manual':'面板或 QQ 命令手动创建对话','session.uncertain':'模型回合状态不确定；下次输入将隔离旧会话','session.local_error':'本地回复处理失败；模型已结束，保留当前会话','context.initialized':'新会话已注入人设、记忆与工具协议','context.messages':'已提交最新消息段（沿用已有会话资料）','input.observed':'收到名单内 QQ 消息，已进入路由','input.channel_disabled':'收到消息，但对应私聊/群聊接收未启动','input.mention_required':'已索引；未开启群聊自主参与，等待 @ 或引用机器人','input.diving':'已索引；潜水期间不触发普通群消息','ambient.buffered':'等待合并群消息','ambient.cooldown':'未提交 DSH：自主参与判断间隔尚未结束（剩余）','ambient.busy':'未提交 DSH：该聊天已有任务；消息保留在索引','ambient.submitted':'合并完成，提交 Agent','delivery.hourly_limit':'未投递：达到群聊每小时回复上限','delivery.gap':'等待群聊最短发送间隔','delivery.rate_limit':'未投递：群聊发送频率限制','stream.failed':'DSH 回合中断或失败','stream.snapshot':'DSH 会话订阅已就绪','stream.turn.start':'DSH 回合开始','stream.user.message':'DSH 已接收输入','stream.assistant.message':'DSH 产生一段正式回复','stream.turn.end':'DSH 回合结束','stream.tool.call':'DSH 调用工具','stream.tool.result':'DSH 工具完成','stream.approval.request':'DSH 请求审批'});
function logLabel(event){
 if(logNames[event])return logNames[event];
 const match=event.match(/^rpc\.(.+)\.(started|completed|failed)$/);
 return match?'DSH '+match[1].replaceAll('.','/')+' · '+({started:'请求开始',completed:'请求成功',failed:'请求失败'})[match[2]]:event;
}
function logText(entries){return entries.map(e=>`${new Date(e.time).toLocaleString('zh-CN')} [${e.level}] [${e.component}] ${logLabel(e.event)}${e.chat?' · '+e.chat:''}${e.operation?' '+e.operation:''}${e.count!==undefined?' · 数量 '+e.count:''}${e.durationMs!==undefined?' · '+Math.ceil(e.durationMs/1000)+' 秒':''}`).join('\n')||'暂无记录。';}
function renderLogFiles(id,files){
 const target=$(id),opened=new Set([...target.querySelectorAll('details[open]')].map(e=>e.dataset.name));target.replaceChildren();
 if(!files.length){target.textContent='未发现日志文件（可能未启用文件日志）。';return;}
 for(const file of files){const detail=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');detail.className='log-file';detail.dataset.name=file.name;detail.open=opened.has(file.name);summary.textContent=file.name+(file.updatedAt?' · '+new Date(file.updatedAt).toLocaleString('zh-CN'):'');pre.className='related-log';pre.textContent=file.error||file.text||'此文件为空。';if(file.truncated)pre.textContent='（仅显示文件末尾）\n'+pre.textContent;detail.append(summary,pre);target.append(detail);}
}
let logsLoading=false;
async function loadLogs(){
 if(logsLoading)return;logsLoading=true;
 try{
 const level=$('log-level').value,component=$('log-component').value;
 const results=await Promise.allSettled([request('/api/logs?level='+encodeURIComponent(level)+'&component='+encodeURIComponent(component)),request('/api/logs/related')]);
 if(level!==$('log-level').value||component!==$('log-component').value)return;
 if(results[0].status==='fulfilled'){const data=results[0].value;$('system-logs').textContent=logText(data.entries);$('logs-state').textContent=(data.writeFailed?'日志写入异常，请检查目录权限。':'')+'已加载 '+data.entries.length+' 条 · '+new Date().toLocaleTimeString('zh-CN');}else $('logs-state').textContent='系统日志暂时无法刷新';
 if(results[1].status==='fulfilled'){
 const data=results[1].value,state=data.status,when=v=>v?new Date(v).toLocaleString('zh-CN'):'暂无记录';
 $('flow-status').textContent=`连接：${state.state==='running'?'运行中':'已停止'} · 私聊${state.channels?.private?'已启动':'未启动'} · 群聊${state.channels?.group?'已启动':'未启动'}。最近收到：${when(state.lastObservedAt)}；最近提交处理：${when(state.lastReceivedAt)}；最近发出：${when(state.lastSentAt)}。${state.lastError||''}`;
 $('flow-logs').textContent=logText(data.flow.entries);$('dsh-logs').textContent=logText(data.dshEvents.entries);
 $('napcat-log-status').textContent=data.napcat.state;$('napcat-logs').textContent=data.napcat.entries.map(e=>e.text).join('\n')||'等待新的 NapCat 日志。';
 renderLogFiles('dsh-log-files',data.dsh.files);renderLogFiles('napcat-log-files',data.napcat.files);renderLogFiles('process-log-files',data.process.files);
 }else $('flow-status').textContent='相关日志暂时无法刷新；上次结果可能已过期。';
 }finally{logsLoading=false;}
}
$('logs-refresh').onclick=()=>action($('logs-refresh'),loadLogs);
$('log-level').onchange=$('log-component').onchange=()=>loadLogs().catch(e=>notice(e.message,true));
setInterval(()=>{if(!$('logs-tab').hidden&&$('logs-auto').checked)loadLogs().catch(()=>{$('logs-state').textContent='日志暂时无法刷新';});},5000);
$('memory-settings').onclick=()=>action($('memory-settings'),async()=>{
  const key=loadedKey;if(!key)return;document.querySelector('[data-tab="chat"]').click();
  try{await loadPolicy(key);}catch{await loadPolicy(key.split('/')[1]);notice('此聊天尚未加入接收名单，已打开对应默认记忆规则。独立设置需先加入名单。');}
});
$('persona-text').addEventListener('input',()=>{$('persona-state').textContent='未保存；仅影响当前聊天。';});
for(const id of ['page-path','page-text'])$(id).addEventListener('input',()=>{$('page-state').textContent='未保存；仅影响当前聊天。';});
$('manage-load').onclick=()=>action($('manage-load'),async()=>{if(memoryDirty()&&!await confirmAction('刷新会放弃未保存的人设或记忆修改，继续？'))return;await reloadManaged(managementData?.detail.personaId);notice('已刷新此人格的人设与记忆。');});
$('page-select').onchange=async()=>{const page=managementData?.detail.pages.find(p=>p.name===$('page-path').value);if($('page-text').value!==(page?.text??'')&&!await confirmAction('当前记忆正文尚未保存，放弃并切换页面？')){$('page-select').value=page?.name??'';return;}pageSelect();};
$('persona-save').onclick=()=>action($('persona-save'),async()=>{manageBusy=true;try{paintManaged(await request('/api/manage/persona',{...managedInput(),text:$('persona-text').value,revision:managementData.detail.personaRevision}));$('persona-state').textContent='人设已保存，下次消息生效。';notice('人设已保存，下次消息生效。');}finally{manageBusy=false;}});
async function savePage(forget){const page=$('page-path').value,old=managementData.detail.pages.find(p=>p.name===page);manageBusy=true;try{paintManaged(await request('/api/manage/page',{...managedInput(),page,text:$('page-text').value,revision:old?.revision??managementData.detail.emptyRevision,forget}));$('page-state').textContent=forget?'已忘记此页，历史备份保留。':'记忆页已保存。';notice($('page-state').textContent);}finally{manageBusy=false;}}
$('page-save').onclick=()=>action($('page-save'),()=>savePage(false));$('page-forget').onclick=()=>action($('page-forget'),()=>savePage(true));
$('favorites-sync').onclick=()=>action($('favorites-sync'),async()=>{paintManaged(await request('/api/manage/favorites',managedInput()));notice('收藏表情已导入当前聊天。');});

let qqVersionData=null,qqVersionGate={allowed:false,reason:'请先刷新状态'},qqVersionBusy=false;
function paintVersionActions(){
 const selected=qqVersionData?.catalog?.find(item=>item.id===$('qq-version-select').value),blocked=qqVersionBusy||!qqVersionGate.allowed;
 $('qq-version-install').disabled=blocked||!selected||selected.installed&&selected.componentState==='verified';
 $('qq-version-activate').disabled=blocked||qqVersionGate.activationAllowed!==true||!selected||!selected.installed||selected.active||selected.componentState!=='verified';
 $('qq-version-rollback').disabled=blocked||qqVersionGate.activationAllowed!==true||qqVersionData?.canRollback!==true;
 $('qq-version-detail').textContent=selected?`NapCat ${selected.version} · QQ ${selected.qqVersion||'版本未提供'} · ${selected.componentState==='invalid'?'校验失败，无法使用':selected.active?'当前使用':selected.installed?'已准备，尚未使用':'尚未准备'}${selected.previous?' · 前一个版本':''}`:'当前没有可选择的受控版本。';
 $('qq-version-gate').textContent=qqVersionBusy?'版本操作正在进行，请等待结果。':!qqVersionGate.allowed?qqVersionGate.reason||'暂时不能执行版本操作。':!qqVersionGate.activationAllowed?'可准备组件；'+qqVersionGate.activationReason:'可准备或切换版本；操作后接收继续保持停止。';
}
function paintVersions(data){
 qqVersionData=data.runtime?.versions??null;qqVersionGate=data.management??{allowed:false,reason:'组件版本管理尚未就绪，请刷新状态'};
 const catalog=qqVersionData?.catalog??[],name=id=>catalog.find(item=>item.id===id)?.version||'未设置',previous=$('qq-version-select').value;
 $('qq-version-current').textContent='当前使用：'+(qqVersionData?.activeId?'NapCat '+name(qqVersionData.activeId):'尚未激活组件');
 $('qq-version-previous').textContent='前一个版本：'+(qqVersionData?.previousId?'NapCat '+name(qqVersionData.previousId)+(qqVersionData.canRollback?'':'（当前账号或组件状态暂不允许回退）'):'暂无可回退版本');
 $('qq-version-select').replaceChildren();for(const item of catalog)$('qq-version-select').append(new Option(`NapCat ${item.version}${item.active?' · 当前使用':item.installed?' · 已准备':' · 未准备'}${item.previous?' · 可回退':''}`,item.id));
 if(catalog.some(item=>item.id===previous))$('qq-version-select').value=previous;
 paintVersionActions();
}
$('qq-version-select').onchange=paintVersionActions;
for(const verb of ['install','activate','rollback'])$('qq-version-'+verb).onclick=()=>action($('qq-version-'+verb),async()=>{
 const body=verb==='install'?{versionId:$('qq-version-select').value}:verb==='activate'?{versionId:$('qq-version-select').value,expectedActiveId:qqVersionData?.activeId||'',expectedRevision:qqVersionData?.revision??0}:{expectedActiveId:qqVersionData?.activeId||'',expectedRevision:qqVersionData?.revision??0};
 qqVersionBusy=true;paintVersionActions();$('qq-version-result').textContent=verb==='install'?'正在准备所选版本，当前使用版本保持不变。':verb==='activate'?'正在切换所选版本，接收保持停止。':'正在回到前一个版本，接收保持停止。';
 try{const result=await request('/api/qq/runtime/version/'+verb,body);$('qq-version-result').textContent=result.message||'版本操作已完成，请核对当前使用版本。';notice($('qq-version-result').textContent);await refreshQQ();}
 catch(error){$('qq-version-result').textContent='操作未完成：'+error.message;await refreshQQ().catch(()=>{});throw error;}
 finally{qqVersionBusy=false;paintVersionActions();}
});
let qqRefreshPending=null;
function refreshQQ(){if(qqRefreshPending)return qqRefreshPending;qqRefreshPending=readQQStatus().finally(()=>{qqRefreshPending=null;});return qqRefreshPending;}
async function readQQStatus(){
 qqBackendMode=$('qqBackend').value||qqBackendMode;if(qqBackendMode==='shell'){qqShellReceiveState={allowed:false,reason:'QQ Shell 组件与进程状态正在核实，接收暂不可用。'};}
 const data=await request('/api/qq/control/status',{});
 const shell=data.backend==='shell';document.querySelectorAll('#qq-tab [data-qq-backend]').forEach(el=>{el.hidden=el.dataset.qqBackend!==(shell?'shell':'external');});
 qqBackendMode=shell?'shell':'external';qqShellReceiveState=shell?shellReceiveGate(data):{allowed:true,reason:''};
 paintVersions(data);
 $('qq-control-state').textContent=data.message;
 const phases={missing:'组件待准备',invalid:'组件校验失败',component_invalid:'组件校验失败，接收已阻止',prepared:'组件已准备',installed:'版本已准备，尚未使用',migration_required:'旧组件等待受管迁移',stopped:'登录进程已停止',starting:'登录进程启动中',waiting_login:'等待扫码登录',waiting_interface:'已登录，等待消息接口',account_mismatch:'账号不符，不能启用接收',interface_ready:'账号与接口已就绪',receiving:'接收运行中',blocked:'启动受阻',exit_unconfirmed:'进程退出未确认'};
 $('qq-runtime-phase').textContent=phases[data.phase]||data.phase||'尚未检查';
 const processLabels={stopped:'已停止',running:'运行中',orphaned:'归属未确认',exit_unconfirmed:'退出未确认',unknown:'暂时无法核实'};
 $('qq-runtime-state').textContent=shell?`${data.runtime?.component?.message||''} · 登录进程：${processLabels[data.runtime?.process?.state]||'未知'}`:'';
 const packet=data.runtime?.capabilities?.packet,packetLabels={ready:'PacketBackend 检查就绪；拍一拍实际投递未验证',unavailable:'高级接口暂不可用',unsupported:'当前版本不支持高级接口检查',timeout:'高级接口检查超时',unknown:'高级接口状态未知'};
 $('qq-runtime-capabilities').textContent=shell?(packetLabels[packet?.state]||'高级接口尚未检查；文字接口状态单独核验'):'';
 $('qq-control-account').textContent='面板指定账号：'+(data.expectedAccount||'未配置')+' · 当前登录：'+(data.account||'未知')+' · 登录管理：'+(data.napcatReady?'可用':'不可用')+' · 消息接口：'+(data.interfaceOnline?'在线':'未连接');
 if(data.online){qrWatcher.stop();$('qq-qr-result').hidden=true;$('qq-qr-image').removeAttribute('src');}
 $('qq-qrcode').disabled=!!data.online;
 $('qq-login-card').hidden=!!data.online;
 const status=await request('/api/status');
 $('qq-control-bridge').textContent='机器人接收：'+(status.bridge.state==='running'?'运行中':status.bridge.state==='connecting'?'连接中':'已停止')+' · 待处理：'+status.bridge.active;
 paintChannels(status.bridge);
 paintQQMonitor(data,status);
 try{const logs=await request('/api/logs');paintQQMonitorEvents(logs.entries??[]);}catch{$('qq-monitor-events').textContent='事件暂时读取失败';}
}
$('qq-control-refresh').onclick=()=>action($('qq-control-refresh'),refreshQQ);
for(const [id,verb]of [['qq-runtime-prepare','prepare'],['qq-runtime-start','start'],['qq-runtime-stop','stop']])$(id).onclick=()=>action($(id),async()=>{const result=await request('/api/qq/runtime/'+verb,{});notice(result.message||'操作完成，请查看当前状态。');await refreshQQ();});
for(const [id,url]of [['qq-control-desktop','/api/qq/desktop-start'],['qq-control-sync','/api/qq/sync'],['qq-control-start','/api/bridge/start'],['qq-control-stop','/api/bridge/stop']])$(id).onclick=()=>action($(id),async()=>{const result=await request(url,{});notice(result.message||'操作已完成。');await refreshQQ();});
const qrWatcher=qrLoginWatcher({
 load:()=>request('/api/qq/control/qrcode',{watch:true}),
 isVisible:()=>!$('qq-tab').hidden&&!document.hidden,
 render:result=>{
   $('qq-qr-result').hidden=false;$('qq-qr-message').textContent=result.message;
   $('qq-qr-image').hidden=!result.image;
   if(result.image){if($('qq-qr-image').getAttribute('src')!==result.image)$('qq-qr-image').src=result.image;}
   else $('qq-qr-image').removeAttribute('src');
 },onLogin:refreshQQ
});
$('qq-qrcode').onclick=()=>action($('qq-qrcode'),()=>qrWatcher.start());
window.addEventListener('pagehide',()=>qrWatcher.stop());
document.addEventListener('visibilitychange',()=>{if(document.hidden)qrWatcher.stop();else if(!$('qq-tab').hidden&&!$('qq-qr-result').hidden)qrWatcher.start();});
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

$('persona-rename').onclick=()=>action($('persona-rename'),async()=>{manageBusy=true;try{paintManaged(await request('/api/persona-cards/rename',{...managedInput(),name:$('persona-display-name').value,revision:managementData.personas.revision}));notice('人格名称已保存，新建工作区将使用此名称。');}finally{manageBusy=false;}});
let modelProfileData=null,modelLoadSerial=0;
function modelScopeInput(){return {key:chatContext.key||undefined,personaId:chatContext.personaId||undefined,kind:chatContext.kind||undefined};}
function showModelSelection(value){
 const encoded=value.provider?JSON.stringify([value.provider,value.model]):'';
 if(encoded&&![...$('chat-model').options].some(o=>o.value===encoded))$('chat-model').add(new Option(value.provider+' / '+value.model+'（已保存，未检查可用性）',encoded));
 $('chat-model').value=encoded;$('model-context-window').value=value.contextWindow??0;
}
async function loadModelSettings(page){
 $('model-settings').hidden=page!=='chat';if($('model-settings').hidden)return;
 const serial=++modelLoadSerial,input=modelScopeInput(),query=new URLSearchParams(Object.entries(input).filter(([,v])=>v));
 const data=await request('/api/model-profiles?'+query);if(serial!==modelLoadSerial)return;
 modelProfileData=data;$('model-scope').textContent=input.key?'当前聊天人格：'+chatLabel(input.key):input.kind?(input.kind==='private'?'私聊':'群聊')+'默认模型':'全局默认模型';
 $('model-override').checked=!!data.override;$('model-override').disabled=!input.key&&!input.kind;
 showModelSelection(data.effective);$('model-settings-state').textContent=data.override?'使用当前范围配置。':'沿用上级配置。';
}
$('model-override').onchange=()=>{if(modelProfileData)showModelSelection($('model-override').checked?modelProfileData.override??modelProfileData.effective:modelProfileData.inherited);};
$('model-catalog-refresh').onclick=()=>action($('model-catalog-refresh'),async()=>{
 const saved=$('chat-model').value,window=$('model-context-window').value;
 const catalog=await request('/api/model-catalog');$('chat-model').replaceChildren(new Option('沿用 DSH 默认',''));
 for(const group of catalog.groups??[])for(const model of group.models??[])$('chat-model').add(new Option((group.name??group.id)+' / '+model.name,JSON.stringify([group.id,model.id])));
 if(saved){const [provider,model]=JSON.parse(saved);showModelSelection({provider,model,contextWindow:Number(window)});}
 $('model-settings-state').textContent='已读取 DSH 模型目录；不会提交模型推理。';
});
$('model-settings-save').onclick=()=>action($('model-settings-save'),async()=>{
 if(!modelProfileData)throw Error('请先加载模型设置');
 const input=modelScopeInput(),[provider,model]=$('chat-model').value?JSON.parse($('chat-model').value):['',''];
 const settings=$('model-override').checked?{provider,model,contextWindow:Number($('model-context-window').value)}:null;
 modelProfileData=await request('/api/model-profiles',{...input,revision:modelProfileData.revision,settings});
 $('model-settings-state').textContent='已保存，后续新建会话使用此配置；当前会话不变。';
});
function paintQQMonitor(data,status){
 const b=status.bridge,box=$('qq-monitor-overview');box.replaceChildren();
 const time=v=>v?new Date(v).toLocaleString():'暂无记录';
 for(const [label,value] of [['登录账号',data.account||'未登录'],['账号核验',data.online?(data.accountMatches?'一致':'不一致'):'等待登录'],['消息接口',data.interfaceOnline?'在线':'未连接'],['私聊接收',b.state==='running'&&b.channels?.private!==false?'运行中':'停止'],['群聊接收',b.state==='running'&&b.channels?.group!==false?'运行中':'停止'],['待处理任务',String(b.active??0)],['最近接收',time(b.lastReceivedAt)],['最近发送',time(b.lastSentAt)]])box.append(element('p',label+'：'+value));
 const chats=$('qq-monitor-chats');chats.replaceChildren();
 const rows=(status.lifecycle??[]).filter(s=>s.activePersona);
 if(!rows.length)chats.append(element('p','暂无已建立的聊天会话。登录不代表已开启机器人接收。'));
 for(const row of rows){const stopped=b.state!=='running'||b.channels?.[row.key.split('/')[1]]===false||(Array.isArray(b.chatKeys)&&!b.chatKeys.includes(row.key));const state=stopped?'接收停止':row.blocked?'等待恢复':row.maintenance?'整理记忆':({active:'等待或对话中',handoff:'保存交接',digest:'整理记忆',asleep:'休眠'}[row.absence?.phase]??'就绪');chats.append(element('p',chatLabel(row.key)+' · '+(row.title||'默认人格会话')+' · '+state));}
 $('qq-monitor-updated').textContent='更新于 '+new Date().toLocaleTimeString()+' · 此页每 5 秒检查状态；不自动启动接收。';
}
function paintQQMonitorEvents(entries){const box=$('qq-monitor-events');box.replaceChildren();const rows=entries.filter(e=>!e.event.startsWith('rpc.')&&e.operation!=='/api/qq/control/status'&&e.operation!=='/api/qq/control/qrcode').slice(-12).reverse();if(!rows.length)box.append(element('p','暂无事件'));for(const e of rows)box.append(element('p',new Date(e.time).toLocaleTimeString()+' · '+(e.level==='error'?'错误 · ':e.level==='warn'?'提醒 · ':'')+(logNames[e.event]??e.event)));}
setInterval(()=>{if(!$('logs-tab').hidden&&!document.hidden)refreshQQ().catch(()=>{$('qq-monitor-updated').textContent='状态更新失败，当前展示为旧数据；稍后自动重试。';});},5000);
let monitorSelection=null,monitorBefore,monitorSerial=0,monitorBusy=false,monitorFingerprint="";
async function refreshMessages(older=false){
 const serial=++monitorSerial,selection=monitorSelection?{...monitorSelection}:null;
 const query=new URLSearchParams(selection??{});if($('monitor-search').value)query.set('query',$('monitor-search').value);if(older&&monitorBefore)query.set('before',String(monitorBefore));
 const data=await request('/api/message-monitor?'+query);if(serial!==monitorSerial||$('messages-tab').hidden)return;
 const list=$('monitor-conversations');list.replaceChildren();
 const kind=$('monitor-kind').value;
 for(const chat of data.chats.filter(c=>!kind||c.key.split('/')[1]===kind)){
   const button=element('button',chatLabel(chat.key)+' · '+chat.name+(chat.active?' · 当前人格':' · 历史人格')+'\n'+chat.count+' 条 · 机器人未读 '+chat.unread+'\n'+chat.preview);button.className='monitor-conversation secondary';
   button.setAttribute('aria-pressed',String(selection?.key===chat.key&&selection?.personaId===chat.personaId));
   button.onclick=()=>{monitorSelection={key:chat.key,personaId:chat.personaId};monitorBefore=undefined;refreshMessages().catch(e=>notice(e.message,true));};list.append(button);
 }
 if(!list.children.length)list.append(element('p','当前账号暂无接入记录。'));
 const box=$('monitor-messages');const fingerprint=JSON.stringify([selection,$('monitor-search').value,data.messages]);if(!older&&fingerprint===monitorFingerprint)return;monitorFingerprint=fingerprint;const scrollTop=box.scrollTop;if(!older)box.replaceChildren();
 if(selection){
   const chat=data.chats.find(c=>c.key===selection.key&&c.personaId===selection.personaId);$('monitor-title').textContent=chatLabel(selection.key)+' · '+(chat?.name??'人格');
   const fragment=document.createDocumentFragment();
   for(const m of data.messages??[]){
     const article=document.createElement('article');article.className='monitor-message'+(m.outgoing?' outgoing':'');
     article.append(element('p',(m.outgoing?'发出':'收到')+' · '+(m.sender?.card||m.sender?.nickname||m.sender?.qq||'未知发送者')+' '+(m.sender?.qq??'')+' · '+new Date(m.at).toLocaleString()+' · '+(m.outgoing?'已发送':m.unread?'机器人未读':'机器人已读')));
     if(m.replyTo)article.append(element('blockquote','引用消息 '+(m.replyTo.messageId??'')+(m.replyTo.text?'：'+m.replyTo.text:'')));
     article.append(element('div',m.text||''));
     for(const part of m.segments??[])article.append(element('span',part.kind==='at'?' @'+part.id:' [QQ 表情 '+part.id+']'));
     for(const media of m.media??[]){
       const labels={image:'图片',record:'语音',video:'视频',file:'文件',forward:'合并转发',face:'QQ 表情',json:'分享卡片',xml:'分享卡片'};
       article.append(element('p',(labels[media.kind]??media.kind)+(media.transcript?'：'+media.transcript:'')));
       if(media.url&&media.kind==='image'){const img=document.createElement('img');img.src=media.url;img.alt='消息图片';img.loading='lazy';img.onerror=()=>{img.replaceWith(element('p','图片缓存已清理或不可用'));};article.append(img);}
       else if(media.url&&media.kind==='record'){const audio=document.createElement('audio');audio.controls=true;audio.preload='none';audio.src=media.url;article.append(audio);}
       else if(media.url){const a=element('a','下载附件');a.href=media.url;a.download=media.name;article.append(a);}
       else article.append(element('small','无可展示的本机附件缓存'));
     }
     for(const f of m.forwards??[])article.append(element('blockquote',(f.sender?.nickname||f.sender?.qq||'转发消息')+'：'+(f.text??'')));
     fragment.append(article);
   }
   if(older)box.prepend(fragment);else {box.append(fragment);box.scrollTop=scrollTop;}
   monitorBefore=data.messages?.[0]?.seq; $('monitor-older').hidden=!data.hasMore;
   if(!box.children.length)box.append(element('p','暂无匹配消息。'));
   $('monitor-state').textContent='更新于 '+new Date().toLocaleTimeString()+(data.truncated?' · 更早记录已超过本地保留范围':'')+' · 查看不消耗机器人未读。';
 }else $('monitor-state').textContent='选择左侧聊天查看消息。';
}
$('monitor-kind').onchange=()=>{monitorSelection=null;monitorBefore=undefined;$('monitor-messages').replaceChildren();$('monitor-title').textContent='请选择聊天';$('monitor-older').hidden=true;refreshMessages().catch(e=>notice(e.message,true));};
$('monitor-search').oninput=()=>{monitorBefore=undefined;refreshMessages().catch(e=>notice(e.message,true));};
$('monitor-refresh').onclick=()=>refreshMessages().catch(e=>notice(e.message,true));
$('monitor-older').onclick=()=>{$('monitor-live').checked=false;refreshMessages(true).catch(e=>notice(e.message,true));};
setInterval(async()=>{if(monitorBusy||$('messages-tab').hidden||document.hidden||!$('monitor-live').checked)return;monitorBusy=true;try{await refreshMessages();}catch{$('monitor-state').textContent='更新失败，当前为旧数据；稍后重试。';}finally{monitorBusy=false;}},3000);
let directoryRows=[],directoryLoad=0;
const directoryModel=s=>s?.model?(s.provider+' / '+s.model):'沿用 DSH 默认';
const directoryWindow=s=>s?.contextWindow?new Intl.NumberFormat('zh-CN').format(s.contextWindow)+' tokens':'模型默认窗口';
async function loadDirectory(){const serial=++directoryLoad;const data=await request('/api/chat-directory');if(serial!==directoryLoad)return;directoryRows=data.rows;paintDirectory();}
function paintDirectory(){
 const body=$('directory-rows');body.replaceChildren();const query=$('directory-search').value.trim().toLowerCase(),kind=$('directory-kind').value;
 const rows=directoryRows.filter(r=>(!kind||r.kind===kind)&&(!query||(r.id+' '+r.personaName).toLowerCase().includes(query)));
 $('directory-status').textContent=directoryRows.length?'已接入 '+directoryRows.length+' 个聊天 · 当前显示 '+rows.length+' 个。可逐行启停，批量开关位于 QQ 控制。':'尚未接入聊天，点击“添加聊天”配置好友或群。';
 for(const row of rows){
  const tr=document.createElement('tr');
  const cell=()=>{const td=document.createElement('td');tr.append(td);return td;};
  const target=cell();target.append(element('strong',row.id),element('small',row.kind==='group'?'群聊':'私聊'));
  const persona=cell();persona.append(element('strong',row.personaName+(row.shared?' · 共享':'')));
  const details=document.createElement('details');details.append(element('summary','更换绑定人格'));
  const select=document.createElement('select');select.setAttribute('aria-label',row.id+' 绑定人格');for(const card of row.cards)select.add(new Option(card.name,card.id));select.value=row.personaId;
  const save=element('button','保存绑定');save.className='secondary';save.disabled=!row.canAssign;
  const hint=element('p',row.canAssign?'选择后保存，才会改变实际使用的人格。':'请先停止此聊天接收，并等待任务结束。');hint.className='hint';
  save.onclick=()=>action(save,async()=>{await request('/api/persona-cards/assign',{key:row.key,personaId:select.value,revision:row.revision});await loadDirectory();notice('已更新 '+row.id+' 的人格绑定；原人设与记忆保留。');});
  details.append(select,save,hint);persona.append(details);
  const model=cell();model.append(element('strong',directoryModel(row.configuredModel)),element('small',directoryWindow(row.configuredModel)));
  if(row.currentModel&&JSON.stringify(row.currentModel)!==JSON.stringify(row.configuredModel))model.append(element('small','现有会话：'+directoryModel(row.currentModel)+' · '+directoryWindow(row.currentModel)+'；以上配置用于新会话'));
  if(row.modelWarnings.length)model.append(element('small','现有会话存在模型降级告警，请查看日志'));
  const state=cell();state.append(element('span',row.state==='receiving'?'接收中':row.state==='connecting'?'连接中':'已停止'));if(row.busy)state.append(element('small','有待完成任务'));
  const toggle=element('button',row.receiving?'停止此聊天':'启动此聊天');toggle.className=row.receiving?'secondary':'primary';toggle.disabled=row.state==='connecting'||(!row.receiving&&row.busy);toggle.style.marginTop='10px';
  toggle.onclick=()=>action(toggle,async()=>{await request('/api/bridge/'+(row.receiving?'stop':'start'),{key:row.key,personaId:row.personaId});await loadDirectory();notice(row.id+(row.receiving?' 已停止，其他聊天继续运行。':' 已启动，仅使用该聊天当前绑定的人格。'));});state.append(toggle);
  const controls=cell();for(const [label,page]of [['配置此聊天','manage'],['模型与规则','chat'],['提示词','prompts']]){const b=element('button',label);b.className='secondary';b.onclick=()=>openDirectoryChat(row,page).catch(e=>notice(e.message,true));controls.append(b);}
  body.append(tr);
 }
}
async function openDirectoryChat(row,page){
 if(contextBusy||manageBusy||promptEditor.isBusy())return;
 if(memoryDirty()&&!await confirmAction('当前人设或记忆有未保存修改，放弃后切换聊天？'))return;
 if(memoryDirty()){managementData=null;loadedKey='';$('manage-content').hidden=true;}
 stashPolicy();await loadContextTargets();
 setContext(row.key?{key:row.key,personaId:row.personaId}:{kind:row.kind||''});
 $('context-advanced').open=false;
 document.querySelector('[data-tab="'+page+'"]').click();
}
$('directory-search').oninput=paintDirectory;$('directory-kind').onchange=paintDirectory;
$('directory-refresh').onclick=()=>action($('directory-refresh'),loadDirectory);
$('directory-back').onclick=()=>document.querySelector('[data-tab="directory"]').click();
$('directory-add').onclick=()=>document.querySelector('[data-tab="qq"]').click();
$('directory-default-model').onclick=()=>openDirectoryChat({},'chat');
$('directory-private-default').onclick=()=>openDirectoryChat({kind:'private'},'chat');
$('directory-group-default').onclick=()=>openDirectoryChat({kind:'group'},'chat');
for(const button of document.querySelectorAll('[data-detail-page]'))button.onclick=()=>document.querySelector('[data-tab="'+button.dataset.detailPage+'"]').click();
loadDirectory().catch(e=>notice(e.message,true));

setInterval(()=>{if(!$('directory-tab').hidden&&!document.hidden&&!$('directory-rows').querySelector('details[open]')&&!contextBusy&&!manageBusy)loadDirectory().catch(()=>{$('directory-status').textContent='状态更新失败，请刷新列表。';});},5000);

$('persona-create-open').onclick=()=>{
 if(manageBusy||!managementData||!loadedKey){notice('请先选择聊天并等待资料加载完成。',true);return;}
 if(memoryDirty()){notice('请先保存当前人格的修改，再创建新卡。',true);return;}
 $('persona-create-error').textContent='';$('persona-card-name').value='';
 $('persona-create-target').textContent='所属聊天：'+chatLabel(loadedKey);
 $('persona-card-create').disabled=false;$('persona-create-dialog').showModal();$('persona-card-name').focus();
};
for(const id of ['persona-create-close','persona-create-cancel'])$(id).onclick=()=>{if(!manageBusy)$('persona-create-dialog').close();};
$('persona-create-dialog').addEventListener('cancel',event=>{if(manageBusy)event.preventDefault();});
$('persona-create-form').onsubmit=event=>{event.preventDefault();if(!manageBusy)$('persona-card-create').click();};
