const $=id=>document.getElementById(id);
const fields=['dshUrl','dshLocalAuth','dshToken','botQQ','qqUrl','qqToken','privateUsers','groups','privatePreset','groupPreset','voice','model','memoryEnabled','rotationEnabled','memoryIdleMinutes','rotateAfterCompactions','privateMessagePolicy','groupMessagePolicy'];
const switches=['memoryEnabled','rotationEnabled','dshLocalAuth'],numbers=['memoryIdleMinutes','rotateAfterCompactions'];
fields.push('qqImages','qqForward','qqVoiceReceive','qqVoiceSend','qqMediaRoots','ffmpegPath','voiceReplyMode','voiceQuietStart','voiceQuietEnd','recallEnabled','recallMinMinutes','recallMaxMinutes','recallMaxPerDay','groupProactiveEnabled','groupProactiveMinMinutes','groupProactiveMaxMinutes','groupProactiveMaxPerDay','proactiveStart','proactiveEnd','qqExecutable','napcatFrameworkDir');
switches.push('qqImages','qqForward','qqVoiceReceive','qqVoiceSend','recallEnabled','groupProactiveEnabled');
numbers.push('voiceQuietStart','voiceQuietEnd','recallMinMinutes','recallMaxMinutes','recallMaxPerDay','groupProactiveMinMinutes','groupProactiveMaxMinutes','groupProactiveMaxPerDay');
fields.push('adminUsers','qqFiles','groupAmbientEnabled','groupToolsEnabled','knowledgeEnabled','remindersEnabled','groupAmbientDelaySeconds','groupAmbientMinMinutes');
switches.push('qqFiles','groupAmbientEnabled','groupToolsEnabled','knowledgeEnabled','remindersEnabled');numbers.push('groupAmbientDelaySeconds','groupAmbientMinMinutes');
let generatedUrl='', initialized=false;
fields.push('groupMinReplyGapSeconds','groupMaxRepliesPerHour');
numbers.push('groupMinReplyGapSeconds','groupMaxRepliesPerHour');
function notice(text,error=false){$('notice').textContent=text;$('notice').classList.toggle('error',error);}
async function request(url,body){const response=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-QQ-RSI':'panel'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error||'请求失败');return result;}
function fill(config){for(const field of fields){if(field.endsWith('Token')){$(field).value='';continue;}if(switches.includes(field)){$(field).checked=config[field];continue;}$(field).value=Array.isArray(config[field])?config[field].join('\n'):config[field];}$('dsh-key-state').textContent=config.dshTokenConfigured?'已保存':'未配置';$('qq-key-state').textContent=config.qqTokenConfigured?'已保存':'未配置';}
async function refresh(){const status=await request('/api/status');if(!initialized){fill(status.config);initialized=true;}$('service-status').textContent='● 独立服务已运行';$('tts-status').textContent=status.voice.ttsReady?'组件已就绪':'组件未找到';$('asr-status').textContent=status.voice.asrReady?'本地模型已就绪':'模型或环境未找到';$('model-label').textContent='Whisper '+status.config.model;$('bridge-status').textContent=status.bridge.state==='running'?'QQ '+(status.bridge.account||'')+' 已连接':status.bridge.state==='connecting'?'正在连接 QQ':'QQ 连接已停止';$('bridge-detail').textContent=status.bridge.lastError||`待处理消息：${status.bridge.active} · 启动后接收名单内已启用的消息`;$('start').disabled=status.bridge.state!=='stopped';$('stop').disabled=status.bridge.state==='stopped';$('memory-import-status').textContent=(status.imports?.length?'已导入 '+status.imports.length+' 份隔离的旧记忆备份。':'尚未导入旧记忆。');$('lifecycle-status').textContent=status.lifecycle?.length?status.lifecycle.map(s=>s.key+' · 已压缩 '+s.compactions+' 次 / 待整理 '+s.pendingCompactions+' 次'+(s.maintenance?' · 正在后台整理':'')+(s.blocked?' · 上次任务中断，下一条消息将隔离旧会话':'')).join('\n'):'连接 QQ 后显示当前会话的记忆与压缩状态。';return status;}
async function action(button,work){button.disabled=true;notice('正在处理，请稍候…');try{await work();}catch(error){notice(error.message,true);}finally{button.disabled=false;await refresh().catch(()=>{});}}
for(const tab of document.querySelectorAll('[data-tab]'))tab.addEventListener('click',()=>{const voice=tab.dataset.tab==='voice';for(const name of ['voice','connections','manage'])$(name+'-tab').hidden=tab.dataset.tab!==name;document.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',x===tab));$('page-title').textContent=voice?'先让声音被听见。':'每个连接，都在掌握中。';$('page-subtitle').textContent=voice?'用已有的本地模型，完成第一次语音合成与识别。':'独立管理 QQ 入口、DSH 后端与本地语音。';if(tab.dataset.tab==='manage'){$('page-title').textContent='让记忆和理解慢慢积累。';$('page-subtitle').textContent='管理当前聊天的人设、长期记忆、表情和黑话。';}notice('');});
$('config-form').addEventListener('submit',event=>{event.preventDefault();const data={};for(const field of fields)data[field]=switches.includes(field)?$(field).checked:numbers.includes(field)?Number($(field).value):field==='qqMediaRoots'?$(field).value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean):['privateUsers','groups','adminUsers'].includes(field)?$(field).value.split(/[\s,，]+/).filter(Boolean):$(field).value;action(event.submitter,async()=>{const result=await request('/api/config',data);fill(result.config);notice('配置已保存。');});});
$('synthesize').addEventListener('click',()=>action($('synthesize'),async()=>{const result=await request('/api/voice/synthesize',{text:$('speech-text').value});generatedUrl=result.audioUrl;$('audio-player').src=generatedUrl;$('audio-result').hidden=false;notice('语音已生成，可以试听或继续识别。');}));
async function recognize(buffer){$('voice-progress').textContent='正在本机识别，首次加载模型可能需要稍等…';try{const bytes=new Uint8Array(buffer);let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));const result=await request('/api/voice/transcribe',{audio:btoa(binary)});$('transcript').value=result.text;notice(`识别完成 · ${result.model} 模型 · ${Number(result.duration).toFixed(1)} 秒音频`);}finally{$('voice-progress').textContent='CPU 本地推理';}}
$('transcribe').addEventListener('click',()=>action($('transcribe'),async()=>{const file=$('audio-file').files[0];if(!file)throw Error('请先选择 WAV 音频');if(file.size>8*1024*1024)throw Error('文件不能超过 8 MiB');await recognize(await file.arrayBuffer());}));
$('recognize-generated').addEventListener('click',()=>action($('recognize-generated'),async()=>{const response=await fetch(generatedUrl);if(!response.ok)throw Error('生成的音频已过期，请重新生成');await recognize(await response.arrayBuffer());}));
$('probe').addEventListener('click',()=>action($('probe'),async()=>{const result=await request('/api/dsh/probe',{});$('presets').hidden=false;$('presets').textContent=JSON.stringify(result.presets,null,2);notice('DSH 连接成功，下方显示可用预设。');}));
$('start').addEventListener('click',()=>action($('start'),async()=>{await request('/api/bridge/start',{});notice('QQ 连接已启动。');}));
$('stop').addEventListener('click',()=>action($('stop'),async()=>{await request('/api/bridge/stop',{});notice('QQ 连接已停止。');}));
refresh().catch(error=>notice(error.message,true));setInterval(()=>refresh().catch(()=>{$('service-status').textContent='服务连接中断';}),5000);

$('qq-probe').addEventListener('click',()=>action($('qq-probe'),async()=>{const result=await request('/api/qq/probe',{});notice('QQ '+result.account+' 在线，登录账号验证通过。');}));
$('desktop-check').addEventListener('click',()=>action($('desktop-check'),async()=>{const result=await request('/api/qq/desktop-check',{});notice(result.message);}));
$('desktop-start').addEventListener('click',()=>action($('desktop-start'),async()=>{const result=await request('/api/qq/desktop-start',{});notice(result.message);}));
$('new-conversation').addEventListener('click',()=>action($('new-conversation'),async()=>{const key=$('memory-key').value;if(!key)throw Error('请先查看记忆并选择当前聊天');await request('/api/session/new',{key});notice('新会话已开启，长期记忆与旧会话历史均保留。');}));
$('memory-load').addEventListener('click',()=>action($('memory-load'),async()=>{
 const list=await request('/api/memory');const old=$('memory-key').value;
 $('memory-key').replaceChildren();for(const key of list.keys){const option=document.createElement('option');option.value=key;option.textContent=key;$('memory-key').append(option);}
 if(list.keys.includes(old))$('memory-key').value=old;
 const key=$('memory-key').value;if(!key){$('memory-detail').textContent='还没有聊天记忆。';return;}
 const {detail}=await request('/api/memory?key='+encodeURIComponent(key));
 $('memory-detail').textContent='原模块：'+detail.engine+'\n记忆页：'+detail.insights.overview.pages+' · 关系：'+detail.graph.edges.length+'\n'+detail.insights.health.checks.map(c=>(c.ok?'✓ ':'! ')+c.label+'：'+c.detail).join('\n')+'\n\n'+detail.pages.map(p=>p.name+'\n'+p.text).join('\n\n');notice('已读取该聊天的独立记忆。');
}));

let managementData=null,loadedKey='';
const element=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
function pageSelect(){const page=managementData.detail.pages.find(p=>p.name===$('page-select').value);$('page-path').value=page?.name??'';$('page-text').value=page?.text??'';}
function managedInput(){if(!loadedKey||loadedKey!==$('manage-key').value)throw Error('请先加载选中聊天的资料');return {key:loadedKey};}
function paintManaged(data){
 if(data.detail.key!==loadedKey||$('manage-key').value!==loadedKey)return;
 managementData=data;$('manage-content').hidden=false;$('persona-text').value=data.detail.persona;
 const old=$('page-select').value;$('page-select').replaceChildren();const fresh=element('option','＋ 新建页面');fresh.value='';$('page-select').append(fresh);
 for(const page of data.detail.pages){const o=element('option',page.name);o.value=page.name;$('page-select').append(o);}if(data.detail.pages.some(p=>p.name===old))$('page-select').value=old;pageSelect();
 const graph=$('memory-graph');graph.replaceChildren();for(const page of data.detail.pages){const b=element('button',page.name);b.className='secondary';b.onclick=()=>{$('page-select').value=page.name;pageSelect();$('page-text').focus();};graph.append(b);}
 for(const edge of data.detail.graph.edges){graph.append(element('p',String(edge.source)+' → '+String(edge.target)+' · '+edge.kind));}
 $('manage-health').textContent=data.detail.insights.health.checks.map(c=>(c.ok?'✓ ':'! ')+c.label+'：'+c.detail).join('\n');
 const stickers=$('stickers');stickers.replaceChildren();
 for(const item of data.knowledge.stickers){const card=element('div');card.className='library-item';const img=element('img');img.alt=item.note||'收藏表情';img.loading='lazy';img.src='/api/sticker/image?key='+encodeURIComponent(loadedKey)+'&id='+encodeURIComponent(item.id);card.append(img);
 const note=element('input');note.value=item.note;note.setAttribute('aria-label','表情含义');note.maxLength=300;
 const tags=element('input');tags.value=item.tags.join(' ');tags.setAttribute('aria-label','表情标签');
 const save=element('button','保存表情笔记');save.className='secondary';save.onclick=()=>action(save,async()=>{paintManaged(await request('/api/manage/knowledge',{...managedInput(),id:item.id,kind:'sticker',revision:managementData.knowledge.revision,note:note.value,tags:tags.value.split(/\s+/).filter(Boolean)}));notice('表情笔记已保存。');});
 const collect=element('button','收藏到 QQ');collect.className='secondary';collect.onclick=()=>action(collect,async()=>{paintManaged(await request('/api/manage/collect',{...managedInput(),id:item.id}));notice('QQ 已确认收藏请求。');});
 card.append(note,tags,save,collect);stickers.append(card);}
 if(!data.knowledge.stickers.length)stickers.append(element('p','还没有表情记录。'));
 const slang=$('slang');slang.replaceChildren();for(const item of data.knowledge.slang){const card=element('div');card.className='library-item';card.append(element('h3',item.term));const meaning=element('textarea');meaning.value=item.meaning;meaning.setAttribute('aria-label','黑话含义');const status=element('select');status.setAttribute('aria-label','审核状态');for(const [value,title]of [['candidate','待审核'],['confirmed','已确认'],['rejected','已否决']]){const o=element('option',title);o.value=value;status.append(o);}status.value=item.status;
 const save=element('button','保存审核');save.className='secondary';save.onclick=()=>action(save,async()=>{paintManaged(await request('/api/manage/knowledge',{...managedInput(),id:item.id,kind:'slang',revision:managementData.knowledge.revision,meaning:meaning.value,status:status.value}));notice('词条已保存。');});
 const research=element('button','公开查证');research.className='secondary';research.onclick=()=>action(research,async()=>{paintManaged(await request('/api/manage/research',{...managedInput(),id:item.id,revision:managementData.knowledge.revision}));notice('已取得公开资料，含义仍需人工核对。');});card.append(meaning,status,save,research);
 for(const source of item.sources??[]){const link=element('a',source.title||source.url);link.href=source.url;link.target='_blank';link.rel='noreferrer noopener';card.append(link);}card.append(element('small','来源：'+item.evidence.join(', ')));slang.append(card);}
 if(!data.knowledge.slang.length)slang.append(element('p','还没有候选黑话。'));
}
$('manage-key').onchange=()=>{$('manage-content').hidden=true;};
$('manage-load').onclick=()=>action($('manage-load'),async()=>{const old=$('manage-key').value,list=await request('/api/manage');$('manage-key').replaceChildren();for(const key of list.keys){const option=element('option',key);option.value=key;$('manage-key').append(option);}if(list.keys.includes(old))$('manage-key').value=old;loadedKey=$('manage-key').value;if(!loadedKey){notice('请先配置聊天名单或导入记忆。');return;}paintManaged(await request('/api/manage?key='+encodeURIComponent(loadedKey)));notice('资料已加载。');});
$('page-select').onchange=pageSelect;
$('persona-save').onclick=()=>action($('persona-save'),async()=>{paintManaged(await request('/api/manage/persona',{...managedInput(),text:$('persona-text').value,revision:managementData.detail.personaRevision}));notice('人设已保存，下次消息生效。');});
async function savePage(forget){const page=$('page-path').value,old=managementData.detail.pages.find(p=>p.name===page);paintManaged(await request('/api/manage/page',{...managedInput(),page,text:$('page-text').value,revision:old?.revision??managementData.detail.emptyRevision,forget}));notice(forget?'已从活动记忆移除，保留历史备份。':'记忆页已保存。');}
$('page-save').onclick=()=>action($('page-save'),()=>savePage(false));$('page-forget').onclick=()=>action($('page-forget'),()=>savePage(true));
$('favorites-sync').onclick=()=>action($('favorites-sync'),async()=>{paintManaged(await request('/api/manage/favorites',managedInput()));notice('收藏表情已导入当前聊天。');});
