window.__ModuleLoader__.load({id:'dsh-onebot-voice-bridge',factory:require=>{
  const mod=require('react'),React=mod.createElement?mod:mod.default,h=React.createElement;
  const json={parse:value=>JSON.parse(JSON.stringify(value))},str={parse:value=>{if(typeof value!=='string')throw Error('expected string');return value;}};
  const codec=(type,schema=json)=>({mode:'strict',typeSymbol:type,create:()=>schema,schema});
  const param=(name,schema=json)=>({name,wire:name,source:'json',codec:codec(name,schema)});
  const descriptor=(method,parameters=[])=>({id:'dsh-onebot-voice-bridge#qqBridgeSettings/'+method,service:'qqBridgeSettings',namespace:'qqBridgeSettings',method,invocation:{kind:'direct'},parameters,result:codec('QQBridgeSettingsResult')});
  const remoteSpec={package:'dsh-onebot-voice-bridge',descriptors:[descriptor('getSettings'),descriptor('updateSettings',[param('section',str),param('patch'),param('expectedRevision',str)]),descriptor('listModels',[param('provider',str)])]};
  const unwrap=r=>{if(r?.ok===true)return r.value;throw Error(r?.error?.message||'设置服务暂时不可用');};
  const clone=o=>JSON.parse(JSON.stringify(o));
  const keys=['private','group','groupModel','voice','voiceApi','proactive','memory','connection','privatePersona','groupPersona'];
  const field=(key,label,type='boolean',extra={})=>({key,label,type,...extra});
  const forms={
    voiceApi:{title:'MiMo 语音 API',hint:'开启后，待合成文字或收到的语音会发送到小米 MiMo。密钥仅保存于本机，留空保留。关闭 MiMo 识别会恢复切换前的识别配置。此处只处理语音消息。',fields:[field('ttsProvider','语音合成服务','select',{options:[['windows','Windows 本地'],['mimo','小米 MiMo']]}),field('asrEnabled','使用 MiMo 识别收到的语音'),field('apiKey','MiMo API Key（留空保留）','password'),field('mimoVoice','MiMo 音色','select',{options:['mimo_default','冰糖','茉莉','苏打','白桦','Mia','Chloe','Milo','Dean'].map(v=>[v,v])}),field('mimoStyle','语气与风格描述','textarea'),field('timeoutMs','请求超时（毫秒）','number',{min:1000,max:120000})]},
    private:{title:'私聊行为',hint:'你的消息进入原生插话流程；这些选项不改变群聊权限。',fields:[field('ownerSteer','任务进行中接收补充消息'),field('splitShortTextBubbles','短句分成独立气泡'),field('queueNoticeEnabled','显示备用排队提示'),field('interimMessages','发送执行过程中的中间消息'),field('compactionRotationEnabled','达到压缩阈值后自动开启新会话')]},
    proactive:{title:'私聊主动联系',hint:'只向已授权的私人联系人发送。当天次数包含已预留的尝试。',fields:[field('enabled','允许主动联系'),field('activeStart','开始时间','time'),field('activeEnd','结束时间','time'),field('intervalMinMinutes','最短间隔（分钟）','number',{min:1,max:10080}),field('intervalMaxMinutes','最长间隔（分钟）','number',{min:1,max:10080}),field('maxPerDay','每天最多次数','number',{min:0,max:100}),field('autonomousActions','允许已授权的后台小任务'),field('desktopIdleSeconds','电脑空闲要求（秒）','number',{min:0,max:86400})]},
    group:{title:'示例测试群',hint:'时段起止相同表示全天；每小时上限为 0 表示不限。定时主动发言与回应群消息是两个开关。',fields:[field('enabled','自动回应群消息'),field('proactiveEnabled','定时主动参与'),field('activeStart','开始时间','time'),field('activeEnd','结束时间','time'),field('minReplyGapSeconds','最短回复间隔（秒）','number',{min:0,max:3600}),field('ambientCheckMinutes','普通话题检查间隔（分钟）','number',{min:0,max:1440}),field('maxRepliesPerHour','每小时回复上限','number',{min:0,max:1000}),field('maxAmbientPerHour','每小时普通话题回复上限','number',{min:0,max:1000}),field('maxProactivePerDay','每天主动参与上限','number',{min:0,max:100}),field('proactiveMinMinutes','主动参与最短间隔（分钟）','number',{min:1,max:10080}),field('proactiveMaxMinutes','主动参与最长间隔（分钟）','number',{min:1,max:10080}),field('directDebounceMs','连续点名消息合并等待（毫秒）','number',{min:0,max:60000}),field('ambientDebounceMs','普通连续消息合并等待（毫秒）','number',{min:0,max:60000})]},
    groupModel:{title:'群聊模型',hint:'群聊模型独立于私聊。保存模型修改会重载群聊模块，原会话和记忆保留。',fields:[field('modelProvider','模型提供方','provider'),field('modelId','模型','model'),field('reasoningEffort','思考强度','select',{options:[['low','低'],['medium','中'],['high','高'],['max','最高']]}),field('personaEvolution','允许基于群内经历微调语气与习惯')]},
    voice:{title:'私聊语音',hint:'这里只管理语音消息，不涉及拨打电话。免打扰的起止小时相同表示关闭免打扰。',fields:[field('enabled','启用语音回复能力'),field('mode','回复偏好','select',{options:[['text','只用文字'],['auto','自主选择文字或语音'],['voice','优先语音']]}),field('maxCharacters','语音最长字数','number',{min:1,max:300}),field('quietStart','免打扰开始小时','number',{min:0,max:23}),field('quietEnd','免打扰结束小时','number',{min:0,max:23}),field('voice','Windows 语音名称','text')]},
    memory:{title:'私人记忆整理',hint:'整理成功才确认完成。用户继续聊天时让路。自动换会话保留同一工作区、长期记忆与旧记录。',fields:[field('digestNudgeEnabled','启用后台记忆整理'),field('digestNudgeMode','触发依据','select',{options:[['compaction-idle','出现新的上下文压缩'],['conversation-idle','累计多轮新对话']]}),field('digestIdleMinutes','连续空闲时长（分钟）','number',{min:1,max:10080}),field('digestRotateAfterCompactions','新会话阈值（压缩次数）','number',{min:1,max:1000,mode:'compaction-idle'}),field('digestMinTurns','最低新对话轮数','number',{min:1,max:1000,mode:'conversation-idle'})]},
    connection:{title:'QQ 连接',hint:'私聊、群聊共用这一条连接。修改连接地址或令牌会重新连接 QQ。令牌不会显示，留空表示保持原值。',fields:[field('url','OneBot WebSocket 地址','text'),field('accessToken','新访问令牌','password')]},
    privatePersona:{title:'私人人设',hint:'只用于私人工作区；不会复制到群聊。',fields:[field('content','私人人设内容','textarea')]},
    groupPersona:{title:'群聊人设',hint:'只用于群聊工作区。修改人设不会扩展群模型的工具权限。',fields:[field('content','群聊人设内容','textarea')]},
  };
  const CSS=`.qqb{max-width:980px;margin:0 auto;padding:24px;color:inherit;font-size:14px}.qqb h2{margin:0 0 8px;font-size:23px}.qqb p{line-height:1.6}.qqb-muted{opacity:.65;font-size:12px}.qqb-head,.qqb-actions,.qqb-tabs,.qqb-chips{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.qqb-head{justify-content:space-between;margin-bottom:18px}.qqb-tabs{margin:18px 0;border-bottom:1px solid #8884;padding-bottom:10px}.qqb button{border:1px solid #8885;background:transparent;color:inherit;border-radius:8px;padding:7px 12px;cursor:pointer;font:inherit}.qqb button[aria-pressed=true],.qqb button.qqb-primary{background:#3369dd;color:white;border-color:#3369dd}.qqb button:disabled{opacity:.45;cursor:default}.qqb-card{border:1px solid #8884;border-radius:12px;padding:20px;margin:14px 0}.qqb-card h3{margin:0 0 6px;font-size:16px}.qqb-row{display:grid;grid-template-columns:minmax(190px,1fr) minmax(180px,300px);align-items:center;gap:14px;padding:10px 0;border-bottom:1px solid #8882}.qqb-row:last-of-type{border-bottom:0}.qqb input:not([type=checkbox]),.qqb select,.qqb textarea{box-sizing:border-box;width:100%;border:1px solid #8885;border-radius:7px;background:transparent;color:inherit;padding:8px;font:inherit}.qqb select option{color:#171717;background:#fff}.qqb input[type=checkbox]{width:18px;height:18px;justify-self:end;accent-color:#3369dd}.qqb textarea{min-height:300px;line-height:1.6;resize:vertical}.qqb-row.qqb-wide{display:block}.qqb-wide label{display:block;margin-bottom:10px}.qqb-actions{justify-content:flex-end;margin-top:16px}.qqb-path{overflow-wrap:anywhere;font-family:ui-monospace,monospace;font-size:12px}.qqb-chip{border:1px solid #8885;border-radius:99px;padding:4px 9px;font-size:12px}.qqb-good{color:#208557;border-color:#208557}.qqb-warning{color:#b26e18}.qqb-alert{border:1px solid #c65252;background:#c6525210;padding:12px;border-radius:8px;color:#bf4242;white-space:pre-wrap}.qqb-notice{color:#208557;margin:10px 0}.qqb-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.qqb-dirty{color:#b26e18;font-size:12px}.qqb button:focus-visible,.qqb input:focus-visible,.qqb textarea:focus-visible,.qqb select:focus-visible{outline:2px solid #5889e8;outline-offset:2px}@media(max-width:650px){.qqb{padding:14px}.qqb-grid{grid-template-columns:1fr}.qqb-row{grid-template-columns:1fr}.qqb input[type=checkbox]{justify-self:start}.qqb-card{padding:14px}}`;

  function Panel({remote}){
    const [snapshot,setSnapshot]=React.useState(null),[draft,setDraft]=React.useState(null),[tab,setTab]=React.useState('overview');
    const [busy,setBusy]=React.useState(''),[error,setError]=React.useState(''),[notice,setNotice]=React.useState('');
    const [catalog,setCatalog]=React.useState({providers:[],models:[]}),[modelLoading,setModelLoading]=React.useState(false);
    const dirty=section=>snapshot&&draft&&JSON.stringify(snapshot[section])!==JSON.stringify(draft[section]);
    const load=async()=>{setBusy('load');setError('');try{const value=unwrap(await remote.getSettings());setSnapshot(value);setDraft(clone(value));}catch(e){setError(e.message)}finally{setBusy('')}};
    React.useEffect(()=>{void load()},[]);
    const loadModels=async provider=>{setModelLoading(true);try{setCatalog(unwrap(await remote.listModels(provider)))}catch(e){setError('模型列表读取失败：'+e.message)}finally{setModelLoading(false)}};
    React.useEffect(()=>{if(tab==='group'&&draft)void loadModels(draft.groupModel.modelProvider)},[tab]);
    const change=(section,key,value)=>{setDraft(prev=>({...prev,[section]:{...prev[section],[key]:value}}));setNotice('');if(section==='groupModel'&&key==='modelProvider')void loadModels(value);};
    const save=async section=>{
      const patch={};for(const f of forms[section].fields){const value=draft[section]?.[f.key];if(value!==undefined&&JSON.stringify(value)!==JSON.stringify(snapshot[section]?.[f.key]))patch[f.key]=value;}
      if(!Object.keys(patch).length){setNotice('没有需要保存的修改。');return;}
      setBusy(section);setError('');setNotice('');
      try{
        const next=unwrap(await remote.updateSettings(section,patch,snapshot.revision));
        const nextDraft=clone(next);for(const key of keys){if(key!==section&&dirty(key))nextDraft[key]=draft[key];}
        setSnapshot(next);setDraft(nextDraft);setNotice('已保存并生效：'+forms[section].title+'。');
      }catch(e){setError(e.message)}finally{setBusy('')}
    };
    function input(section,f){
      const value=draft[section]?.[f.key],id='qqb-'+section+'-'+f.key;
      const props={id,disabled:!!busy,'aria-label':f.label};
      if(f.type==='boolean')return h('input',{...props,type:'checkbox',checked:value===true,onChange:e=>change(section,f.key,e.target.checked)});
      if(f.type==='textarea')return h('textarea',{...props,value:value??'',maxLength:30000,onChange:e=>change(section,f.key,e.target.value)});
      if(['select','provider','model'].includes(f.type)){
        let options=f.options??(f.type==='provider'?catalog.providers:catalog.models).map(m=>[m.id,m.label]);
        if(value&&!options.some(o=>o[0]===value))options=[[value,value],...options];
        return h('select',{...props,disabled:!!busy||(modelLoading&&f.type!=='select'),value:value??'',onChange:e=>change(section,f.key,e.target.value)},options.length?options.map(o=>h('option',{key:o[0],value:o[0]},o[1])):h('option',{value:''},'请选择'));
      }
      return h('input',{...props,type:f.type,value:value??'',min:f.min,max:f.max,step:f.type==='number'?1:undefined,autoComplete:f.type==='password'?'new-password':undefined,
        placeholder:f.type==='password'?(snapshot.connection.tokenConfigured?'已配置，留空保持':'尚未配置'):undefined,
        onChange:e=>change(section,f.key,f.type==='number'?(e.target.value===''?'':Number(e.target.value)):e.target.value)});
    }
    function card(section){const def=forms[section];return h('section',{className:'qqb-card',key:section},
      h('h3',null,def.title,dirty(section)?h('span',{className:'qqb-dirty'},' · 未保存'):null),h('p',{className:'qqb-muted'},def.hint),
      section==='group'?h('div',{className:'qqb-row'},h('label',{htmlFor:'qqb-all-day'},'全天回复'),h('input',{id:'qqb-all-day',type:'checkbox',disabled:!!busy,checked:draft.group.activeStart===draft.group.activeEnd,onChange:e=>{change('group','activeStart',e.target.checked?'00:00':'09:00');change('group','activeEnd',e.target.checked?'00:00':'23:00')}})):null,
      def.fields.filter(f=>!f.mode||draft.memory.digestNudgeMode===f.mode).map(f=>h('div',{className:'qqb-row'+(f.type==='textarea'?' qqb-wide':''),key:f.key},h('label',{htmlFor:'qqb-'+section+'-'+f.key},f.label),input(section,f))),
      h('div',{className:'qqb-actions'},h('button',{type:'button',disabled:!!busy||!dirty(section),onClick:()=>setDraft(prev=>({...prev,[section]:clone(snapshot[section])}))},'还原本区'),h('button',{className:'qqb-primary',type:'button',disabled:!!busy||!dirty(section),onClick:()=>void save(section)},busy===section?'正在保存…':'保存'+def.title)));
    }
    if(!snapshot||!draft)return h('div',{className:'qqb'},h('h2',null,'QQ 统一设置'),error?h('div',{role:'alert',className:'qqb-alert'},error):h('p',null,'正在读取配置…'),h('button',{onClick:()=>void load()},'重试'));
    const status=snapshot.status,transport=status.transport;
    return h('main',{className:'qqb'},
      h('div',{className:'qqb-head'},h('div',null,h('h2',null,'QQ 统一设置'),h('div',{className:'qqb-muted'},'一个连接，独立的私聊与群聊工作区。')),h('button',{disabled:!!busy,onClick:()=>{if(keys.some(dirty)){setError('请先保存或还原未保存的修改，再刷新。');return;}void load();}},'刷新')),
      h('div',{className:'qqb-chips'},h('span',{className:'qqb-chip '+(transport.connected?'qqb-good':'qqb-warning')},transport.connected?'QQ 已连接':'QQ 未连接'),h('span',{className:'qqb-chip'},'账号 '+snapshot.connection.account),h('span',{className:'qqb-chip'},'共享连接 '+transport.connectionCount),h('span',{className:'qqb-chip '+(status.group.modelReady?'qqb-good':'qqb-warning')},status.group.modelReady?'群模型就绪':'群模型未就绪')),
      h('nav',{className:'qqb-tabs','aria-label':'QQ 设置分区'},[['overview','概览'],['private','私聊'],['group','群聊'],['voice','语音'],['memory','记忆'],['persona','人设'],['connection','连接']].map(([key,label])=>h('button',{type:'button',key,'aria-pressed':tab===key,onClick:()=>setTab(key)},label))),
      error?h('div',{className:'qqb-alert',role:'alert'},error):null,notice?h('div',{className:'qqb-notice',role:'status'},notice):null,
      tab==='overview'?h('div',null,h('div',{className:'qqb-grid'},h('section',{className:'qqb-card'},h('h3',null,'私人工作区'),h('p',{className:'qqb-path'},snapshot.workspaces.private),h('p',null,snapshot.permissions.private),h('p',{className:'qqb-muted'},'默认模型：'+[status.privateDefaultModel?.provider,status.privateDefaultModel?.model].filter(Boolean).join(' / '))),h('section',{className:'qqb-card'},h('h3',null,'群聊工作区'),h('p',{className:'qqb-path'},snapshot.workspaces.group),h('p',null,snapshot.permissions.group),h('p',{className:'qqb-muted'},'模型：'+snapshot.groupModel.modelProvider+' / '+snapshot.groupModel.modelId))),status.group.lastError?h('div',{className:'qqb-alert'},'群聊最近错误：'+status.group.lastError):null,h('p',{className:'qqb-muted'},'策略、人设和语音偏好保存后直接读取；修改连接或群模型会重载对应模块。已有会话与记忆保留。')):null,
      tab==='private'?[card('private'),card('proactive')]:null,tab==='group'?[card('group'),card('groupModel')]:null,
      tab==='voice'?[h('p',{key:'mimo-key-status',className:'qqb-muted'},snapshot.voiceApi.apiKeyConfigured?'MiMo 密钥已配置（尚不代表连接验证成功）':'MiMo 密钥尚未配置'),card('voice'),card('voiceApi')]:null,tab==='memory'?card('memory'):null,tab==='persona'?[card('privatePersona'),card('groupPersona')]:null,tab==='connection'?card('connection'):null);
  }
  const inject=['slots','remote'];
  async function apply(ctx){
    ctx.effect(()=>{const style=document.createElement('style');style.dataset.plugin='qq-unified-settings';style.textContent=CSS;document.head.appendChild(style);return()=>style.remove();});
    const dispose=await ctx.remote.$mount(remoteSpec),remote=ctx.get('remote.qqBridgeSettings');
    if(!remote)throw Error('QQ 统一设置服务未加载');
    ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'qq-unified-settings',order:17,label:()=> 'QQ 统一设置',icon:'settings'},props=>h(Panel,{...props,remote})));
    return()=>{void dispose()};
  }
  return {inject,apply,Panel,remoteSpec,forms};
}});
