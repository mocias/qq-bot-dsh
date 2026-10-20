import {createHash} from 'node:crypto';

const bool=(label,section,kinds)=>({type:'boolean',label,section,kinds});
const number=(label,section,min,max)=>({type:'number',label,section,min,max});
export const policyFields={
  preset:{type:'string',label:'DSH 对话预设名称',section:'会话与记忆',max:200},
  messagePolicy:{type:'select',label:'新消息处理',section:'会话与记忆',options:{queue:'排队等待',steer:'插入当前回合'}},
  memoryEnabled:bool('长期记忆','会话与记忆'),
  memoryIdleMinutes:number('有新压缩后，连续空闲多久整理（分钟）','会话与记忆',1,10080),
  rotationEnabled:bool('记忆整理成功后自动轮换会话','会话与记忆',['private']),
  rotateAfterCompactions:{...number('轮换前成功压缩次数','会话与记忆',1,10080),kinds:['private']},
  imageReceive:bool('接收图片并交给模型理解','消息功能'),
  imageSend:bool('允许发送图片','消息功能'),
  forwardReceive:bool('读取合并转发','消息功能'),
  forwardSend:bool('允许发送合并转发','消息功能'),
  fileReceive:bool('接收文件与视频附件','消息功能'),
  fileSend:bool('允许发送文件与视频附件','消息功能'),
  voiceReceive:bool('识别收到的语音','消息功能'),
  voiceSend:bool('允许语音回复','消息功能'),
  voiceReplyMode:{type:'select',label:'语音回复偏好',section:'消息功能',options:{auto:'助手按内容选择',text:'只用文字',voice:'适合时优先语音'}},
  voiceQuietStart:number('自动语音安静时段开始（小时）','消息功能',0,23),
  voiceQuietEnd:number('自动语音安静时段结束（小时）','消息功能',0,23),
  stickerLearn:bool('记录表情并学习含义','表情与黑话'),
  stickerSend:bool('允许助手选择已存表情发送','表情与黑话'),
  stickerCollect:bool('允许面板将此聊天的表情收藏到 QQ','表情与黑话'),
  slangLearn:bool('学习群聊黑话（只提交待审核候选）','表情与黑话',['group']),
  proactiveEnabled:bool('定时主动搭话','主动参与'),
  proactiveMinMinutes:number('主动搭话最短间隔（分钟）','主动参与',1,10080),
  proactiveMaxMinutes:number('主动搭话最长间隔（分钟）','主动参与',1,10080),
  proactiveMaxPerDay:number('每日最多主动尝试次数','主动参与',0,100),
  proactiveStart:{type:'time',label:'主动消息开始时间（北京时间）',section:'主动参与'},
  proactiveEnd:{type:'time',label:'主动消息结束时间（北京时间）',section:'主动参与'},
  groupAmbientEnabled:bool('未 @ 时允许自主参与','群聊参与',['group']),
  groupAmbientDelaySeconds:{...number('群消息合并等待（秒）','群聊参与',1,10080),kinds:['group']},
  groupAmbientMinMinutes:{...number('自主参与判断最短间隔（分钟）','群聊参与',1,10080),kinds:['group']},
  groupMinReplyGapSeconds:{...number('两次发送最短间隔（秒，0 不限制）','群聊参与',0,10080),kinds:['group']},
  groupMaxRepliesPerHour:{...number('每小时最大发送次数（0 不限制）','群聊参与',0,10080),kinds:['group']},
  groupToolsEnabled:bool('群聊专用搜索、记忆与工作区工具','群聊参与',['group']),
  adminUsers:{type:'ids',label:'允许使用 QQ 控制命令的管理员（每行一个）',section:'控制与提醒'},
  remindersEnabled:bool('投递本聊天的 DSH 闹钟结果','控制与提醒'),
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
    proactiveEnabled:config[prefix+'Enabled'],proactiveMinMinutes:config[prefix+'MinMinutes'],proactiveMaxMinutes:config[prefix+'MaxMinutes'],proactiveMaxPerDay:config[prefix+'MaxPerDay'],
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
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('聊天设置必须是对象');
  const fields=fieldsFor(kind),out={};
  for(const [key,v] of Object.entries(value)){
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
    if(p.proactiveMaxMinutes<p.proactiveMinMinutes)throw Error('主动搭话最长间隔不能小于最短间隔');
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
    [group?'groupProactiveMinMinutes':'recallMinMinutes']:p.proactiveMinMinutes,
    [group?'groupProactiveMaxMinutes':'recallMaxMinutes']:p.proactiveMaxMinutes,
    [group?'groupProactiveMaxPerDay':'recallMaxPerDay']:p.proactiveMaxPerDay};
}
