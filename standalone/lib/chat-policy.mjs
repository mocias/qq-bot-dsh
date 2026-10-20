import {migrateIntervals} from './timing.mjs';
import {createHash} from 'node:crypto';

const bool=(label,section,kinds)=>({type:'boolean',label,section,kinds});
const number=(label,section,min,max)=>({type:'number',label,section,min,max});
export const policyFields={
  messageToolsEnabled:{...bool('消息查询、未读管理与统一回复工具','消息功能'),help:'仅查询本机接入后保留的本聊天最近500条消息；允许群的未提及消息也进入索引，但不会因此自动回复。'},
  quoteMode:{type:'select',label:'引用回复',section:'消息功能',options:{auto:'按需引用',never:'不发送引用',always:'普通回复默认引用当前消息'}},
  mentionSend:bool('允许群内 @ 指定成员','消息功能',['group']),
  bubbleMinSeconds:{...number('气泡随机间隔最短（秒）','消息功能',1,60),help:'不同话题分成独立 QQ 消息；每条可分别引用、@ 或不 @。群发送最短间隔更长时优先遵守群限制。'},
  bubbleMaxSeconds:number('气泡随机间隔最长（秒）','消息功能',1,60),
  pokeReceive:bool('被拍一拍时允许回应','消息功能'),
  pokeSend:bool('允许发送拍一拍','消息功能'),
  wakeEnabled:{...bool('启用潜水与唤醒','潜水与唤醒'),help:'潜水期间暂停被动接话和定时搭话；明确预约的提醒照常投递，不等潜水结束。直接私聊、@、引用机器人及已启用的拍一拍仍可唤醒。到期只恢复原调度。'},
  wakeSpeakers:{type:'ids',label:'潜水唤醒群成员（每行一个 QQ）',section:'潜水与唤醒',kinds:['group']},
  preset:{type:'string',label:'DSH 对话预设 ID',section:'会话与记忆',max:200,help:'填写 DSH 中实际存在的预设 ID，不是群名、人设名或对话名称。可在“连接与配置”检查 DSH 连接并查看可用预设。群专用预设须先在 DSH 创建；启动前会校验。'},
  permissionPreset:{type:'select',label:'新对话默认权限',section:'会话与记忆',options:{'':'沿用 DSH 默认','read-only':'只读','workspace-write':'工作区内读写，越界需审批','danger-full-access':'完整访问，不请求审批'},help:'仅用于此聊天以后新建、手动开启或自动轮换的对话，不修改当前对话。完整访问会扩大 DSH 的文件访问权限；QQ 发送范围和本服务记忆工具规则仍保留。新建前核对 DSH 支持的权限，应用失败不会开始聊天。'},
  messagePolicy:{type:'select',label:'新消息处理',section:'会话与记忆',options:{queue:'排队等待',steer:'插入当前回合'}},
  memoryEnabled:{...bool('长期记忆','会话与记忆'),help:'私聊与群聊均可自动记住有来源的稳定事实和偏好，无需每次说“记住”。不同聊天独立保存；模型提出更新，服务校验来源后写入。'},
  memoryAutoInject:{...bool('新会话开始时注入本聊天记忆','会话与记忆'),help:'人设、记忆快照和工具协议在新会话首次输入时加载一次；之后只传最新消息段。人设在面板被修改时会单独通知一次。'},
  memoryRegisterSkill:bool('新会话加载原 memory 操作协议','会话与记忆'),
  memoryActiveOnly:bool('仅最近活跃聊天的新会话注入记忆','会话与记忆'),
  memoryBootMaxChars:number('启动资料预算（字数）','会话与记忆',1000,30000),
  memoryPageMaxChars:number('相关记忆页预算（字数）','会话与记忆',1000,30000),
  memoryIdleSeconds:number('有新压缩后，连续空闲多久整理（秒）','会话与记忆',1,604800),
  rotationEnabled:{...bool('记忆整理成功后自动轮换会话','会话与记忆'),help:'私聊和群聊均支持。达到成功压缩次数、连续空闲且记忆已落盘后，在原工作区开启新会话；保留长期记忆和旧会话。'},
  rotateAfterCompactions:number('轮换前成功压缩次数','会话与记忆',1,10080),
  imageReceive:bool('接收图片并交给模型理解','消息功能'),
  imageSend:bool('允许发送图片','消息功能'),
  forwardReceive:bool('读取合并转发','消息功能'),
  forwardSend:bool('允许发送合并转发','消息功能'),
  fileReceive:bool('接收文件与视频附件','消息功能'),
  fileSend:bool('允许发送文件与视频附件','消息功能'),
  voiceReceive:bool('识别收到的语音','消息功能'),
  voiceSend:bool('允许语音回复','消息功能'),
  voiceReplyMode:{type:'select',label:'语音回复偏好',section:'消息功能',options:{auto:'助手按内容选择',text:'只用文字',voice:'适合时优先语音'}},
  voiceQuietMode:{type:'select',label:'语音安静模式',section:'消息功能',options:{scheduled:'按时段安静',always:'始终安静（不发语音）',never:'关闭安静限制（全天可用语音）'},help:'安静模式优先于语音回复偏好。关闭安静限制仍需开启“允许语音回复”，不代表每条消息都发语音。'},
  voiceQuietStart:number('自动语音安静时段开始（小时）','消息功能',0,23),
  voiceQuietEnd:number('自动语音安静时段结束（小时）','消息功能',0,23),
  stickerLearn:bool('记录表情并学习含义','表情与黑话'),
  stickerSend:bool('允许助手选择已存表情发送','表情与黑话'),
  stickerCollect:{...bool('允许面板将此聊天的表情收藏到 QQ','表情与黑话'),help:'仅允许手动点击“收藏到 QQ”；通过已连接的 QQ 接口，收藏到当前机器人账号的 QQ 表情库。不会自动收藏全部图片，也不会发送消息。'},
  slangLearn:bool('学习群聊黑话（只提交待审核候选）','表情与黑话',['group']),
  proactiveEnabled:{...bool('定时主动搭话','定时搭话与追忆'),help:'按时间检查：私聊从长期记忆中追忆；群聊读取近期聊天寻找话题。不需要刚收到消息，也可以选择不发言。'},
  proactiveMinSeconds:number('主动搭话最短间隔（秒）','定时搭话与追忆',1,604800),
  proactiveMaxSeconds:number('主动搭话最长间隔（秒）','定时搭话与追忆',1,604800),
  proactiveMaxPerDay:number('每日最多主动尝试次数','定时搭话与追忆',0,100),
  proactiveMaxPerSession:number('每个会话最多主动尝试次数（0 不限）','定时搭话与追忆',0,100),
  proactiveStart:{type:'time',label:'主动消息开始时间（北京时间）',section:'定时搭话与追忆'},
  proactiveEnd:{type:'time',label:'主动消息结束时间（北京时间）',section:'定时搭话与追忆'},
  groupAmbientEnabled:{...bool('收到未 @ 的群消息时择机接话','群消息触发接话',['group']),help:'由新群消息触发：合并一段消息后判断是否接话。与定时搭话共用队列和群发送限额；有新群消息时优先处理消息。'},
  groupAmbientDelaySeconds:{...number('群消息合并等待（秒）','群消息触发接话',1,10080),kinds:['group']},
  groupAmbientMinSeconds:{...number('自主参与判断最短间隔（秒）','群消息触发接话',1,604800),kinds:['group']},
  groupMinReplyGapSeconds:{...number('两次发送最短间隔（秒，0 不限制）','群消息触发接话',0,10080),kinds:['group']},
  groupMaxRepliesPerHour:{...number('每小时最大发送次数（0 不限制）','群消息触发接话',0,10080),kinds:['group']},
  groupToolsEnabled:bool('群聊专用搜索、记忆与工作区工具','群消息触发接话',['group']),
  adminUsers:{type:'ids',label:'允许使用 QQ 控制命令的管理员（每行一个）',section:'控制与提醒'},
  remindersEnabled:{...bool('接收 DSH 定时任务的完成结果','控制与提醒'),help:'DSH 闹钟是 DSH 的 schedule 定时任务插件。此开关只把属于本聊天的任务结果转发到 QQ，不负责创建任务，也不是定时主动搭话。离线结果不补发。'},
};
export const kindOf=scope=>scope==='private'||scope==='group'?scope:scope.split('/')[1];
export const fieldsFor=kind=>Object.fromEntries(Object.entries(policyFields).filter(([,s])=>!s.kinds||s.kinds.includes(kind)));
function baseline(config,kind){
  const group=kind==='group',prefix=group?'groupProactive':'recall';
  const result={
    preset:config[group?'groupPreset':'privatePreset'],messagePolicy:config[group?'groupMessagePolicy':'privateMessagePolicy'],
    imageReceive:config.qqImages,imageSend:config.qqImages,forwardReceive:config.qqForward,forwardSend:config.qqForward,
    fileReceive:config.qqFiles,fileSend:config.qqFiles,voiceReceive:config.qqVoiceReceive,voiceSend:group?false:config.qqVoiceSend,
    stickerLearn:config.knowledgeEnabled,stickerSend:config.knowledgeEnabled,stickerCollect:false,slangLearn:config.knowledgeEnabled,
    proactiveEnabled:config[prefix+'Enabled'],proactiveMinSeconds:config[prefix+'MinSeconds'],proactiveMaxSeconds:config[prefix+'MaxSeconds'],proactiveMaxPerDay:config[prefix+'MaxPerDay'],
  };
  return Object.fromEntries(Object.keys(fieldsFor(kind)).map(key=>[key,key in result?result[key]:config[key]]));
}
export function policyView(config,scope){
  const kind=kindOf(scope),base=baseline(config,kind),defaults=config.chatPolicy?.[kind]??{};
  const inherited={...base,...defaults},override=scope===kind?defaults:config.chatPolicy?.overrides?.[scope]??{};
  return {scope,kind,inherited:scope===kind?base:inherited,override,effective:{...inherited,...override},fields:fieldsFor(kind),revision:policyRevision(config)};
}
export function policyRevision(config){
  return createHash('sha256').update(JSON.stringify([baseline(config,'private'),baseline(config,'group'),config.chatPolicy??{}])).digest('hex');
}
function patch(value,kind){
  value=migrateIntervals(value);
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('聊天设置必须是对象');
  const fields=fieldsFor(kind),out={};
  for(const [key,v] of Object.entries(value)){
    // Retired keyword wake settings must not prevent loading older configurations.
    if(key==='wakeKeywords')continue;
    const s=Object.hasOwn(fields,key)?fields[key]:null;if(!s)throw Error('此聊天域不支持设置：'+key);
    if(s.type==='boolean'&&typeof v!=='boolean'||s.type==='number'&&(!Number.isInteger(v)||v<s.min||v>s.max))throw Error(s.label+'格式或范围不正确');
    if(s.type==='select'&&(typeof v!=='string'||!Object.hasOwn(s.options,v)))throw Error(s.label+'无效');
    if(s.type==='string'&&(typeof v!=='string'||v.length>s.max))throw Error(s.label+'过长或格式不正确');
    if(s.type==='time'&&(typeof v!=='string'||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v)))throw Error('时间格式应为 HH:mm');
    if(s.type==='ids'&&(!Array.isArray(v)||v.length>100||v.some(x=>typeof x!=='string'||!/^\d{5,20}$/.test(x))))throw Error('管理员号码格式不正确');
    out[key]=typeof v==='string'?v.trim():Array.isArray(v)?[...new Set(v)]:v;
  }
  return out;
}
export function validateChatPolicy(value,config){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['private','group','overrides'].includes(k)))throw Error('聊天域配置格式不正确');
  const out={private:patch(value.private??{},'private'),group:patch(value.group??{},'group'),overrides:{}};
  const overrides=value.overrides??{};
  if(!overrides||typeof overrides!=='object'||Array.isArray(overrides)||Object.keys(overrides).length>200)throw Error('独立聊天配置过多或格式不正确');
  for(const [scope,p] of Object.entries(overrides)){
    if(!/^\d{5,20}\/(?:private|group)\/\d{5,20}$/.test(scope))throw Error('聊天域标识不正确');
    out.overrides[scope]=patch(p,kindOf(scope));
  }
  for(const scope of ['private','group',...Object.keys(out.overrides)]){
    const p=policyView({...config,chatPolicy:out},scope).effective;
    if(p.bubbleMaxSeconds<p.bubbleMinSeconds)throw Error('气泡最长间隔不能小于最短间隔');
    if(p.proactiveMaxSeconds<p.proactiveMinSeconds)throw Error('主动搭话最长间隔不能小于最短间隔');
  }
  return out;
}
export function resolveChatConfig(config,route){
  const key=typeof route==='string'?route:route.key;
  if(config._policyKey===key)return config;
  const kind=kindOf(key),group=kind==='group',p=policyView(config,key).effective;
  return {...config,...Object.fromEntries(Object.entries(p).filter(([k])=>k in config)),
    _policyKey:key,chatFeatures:p,
    [group?'groupPreset':'privatePreset']:p.preset,[group?'groupMessagePolicy':'privateMessagePolicy']:p.messagePolicy,
    qqImageReceive:p.imageReceive,qqImageSend:p.imageSend,qqForwardReceive:p.forwardReceive,qqForwardSend:p.forwardSend,
    qqFileReceive:p.fileReceive,qqFileSend:p.fileSend,qqVoiceReceive:p.voiceReceive,qqVoiceSend:p.voiceSend,
    groupVoiceSend:group&&p.voiceSend,stickerLearn:p.stickerLearn,stickerSend:p.stickerSend,stickerCollect:p.stickerCollect,
    slangLearn:group&&p.slangLearn,knowledgeEnabled:p.stickerLearn||p.stickerSend||(group&&p.slangLearn),
    [group?'groupProactiveEnabled':'recallEnabled']:p.proactiveEnabled,
    [group?'groupProactiveMinSeconds':'recallMinSeconds']:p.proactiveMinSeconds,
    [group?'groupProactiveMaxSeconds':'recallMaxSeconds']:p.proactiveMaxSeconds,
    [group?'groupProactiveMaxPerDay':'recallMaxPerDay']:p.proactiveMaxPerDay};
}
