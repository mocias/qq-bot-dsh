import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {validateChatPolicy} from './chat-policy.mjs';

export const defaults = {
  chatPolicy: {private:{},group:{},overrides:{}},
  dshUrl: 'http://127.0.0.1:3080', dshToken: '', dshLocalAuth: false,
  qqUrl: 'ws://127.0.0.1:3001', qqToken: '', botQQ: '',
  adminUsers: [], qqFiles: false, groupAmbientEnabled: false, groupAmbientDelaySeconds: 10, groupAmbientMinMinutes: 5, groupToolsEnabled: false, knowledgeEnabled: false, remindersEnabled: false,
  privateUsers: [], groups: [], privatePreset: '', groupPreset: '',
  voice: 'Microsoft Huihui Desktop', model: 'small',
  voiceProvider: 'local', mimoApiKey: '', mimoTtsMode: 'preset', mimoVoice: 'mimo_default',
  mimoReferenceId: '', mimoStyle: '', mimoAsrLanguage: 'auto',
  memoryEnabled: true, memoryIdleMinutes: 30, rotateAfterCompactions: 15,
  memoryAutoInject:true,memoryRegisterSkill:true,memoryActiveOnly:false,memoryBootMaxChars:6000,memoryPageMaxChars:10000,proactiveMaxPerSession:0,
  rotationEnabled: true, privateMessagePolicy: 'steer', groupMessagePolicy: 'queue',
  qqImages: true, qqForward: true, qqVoiceReceive: true, qqVoiceSend: true,
  qqMediaRoots: [], ffmpegPath: '', voiceReplyMode: 'auto', voiceQuietStart: 23, voiceQuietEnd: 8,
  recallEnabled: false, recallMinMinutes: 30, recallMaxMinutes: 120, recallMaxPerDay: 3,
  groupProactiveEnabled: false, groupProactiveMinMinutes: 30, groupProactiveMaxMinutes: 120, groupProactiveMaxPerDay: 3,
  groupMinReplyGapSeconds: 0, groupMaxRepliesPerHour: 0,
  proactiveStart: '09:00', proactiveEnd: '23:00',
  qqExecutable: '', napcatFrameworkDir: '',
};
export function localUrl(value, schemes) {
  const url = new URL(value);
  if (!schemes.includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw Error('连接地址必须是本机地址，不能包含路径、密码或参数');
  }
  return url.origin;
}
export function validate(input, previous = defaults) {
  const out = { ...defaults, ...previous };
  for (const field of Object.keys(defaults)) {
    if(field==='chatPolicy')continue;
    if (!(field in input)) continue;
    const value = input[field];
    if(field==='qqMediaRoots'){
      if(!Array.isArray(value)||value.length>10||value.some(x=>typeof x!=='string'||x.length>1000||!(/^[a-z]:[\\/]/i.test(x)||x.startsWith('/'))||x.startsWith('//')||x.startsWith('\\\\')))throw Error('QQ 媒体目录必须是本机绝对路径');
      out[field]=[...new Set(value)];
    } else if (field === 'privateUsers' || field === 'groups' || field === 'adminUsers') {
      if (!Array.isArray(value) || value.length > 100 || value.some(x => typeof x !== 'string' || !/^\d{5,20}$/.test(x))) throw Error('QQ 号码请使用数字，每行一个');
      out[field] = [...new Set(value)];
    } else if (['memoryAutoInject','memoryRegisterSkill','memoryActiveOnly','qqFiles','groupAmbientEnabled','groupToolsEnabled','knowledgeEnabled','remindersEnabled','memoryEnabled','rotationEnabled','dshLocalAuth','qqImages','qqForward','qqVoiceReceive','qqVoiceSend','recallEnabled','groupProactiveEnabled'].includes(field)) {
      if(typeof value!=='boolean') throw Error('开关格式不正确'); out[field]=value;
    } else if (['memoryBootMaxChars','memoryPageMaxChars','proactiveMaxPerSession'].includes(field)) {
      const budget=field!=='proactiveMaxPerSession';
      if(!Number.isInteger(value)||value<(budget?1000:0)||value>(budget?30000:100))throw Error('记忆容量或次数超出范围');
      out[field]=value;
    } else if (['groupAmbientDelaySeconds','groupAmbientMinMinutes','memoryIdleMinutes','rotateAfterCompactions','recallMinMinutes','recallMaxMinutes','recallMaxPerDay','groupProactiveMinMinutes','groupProactiveMaxMinutes','groupProactiveMaxPerDay','voiceQuietStart','voiceQuietEnd','groupMinReplyGapSeconds','groupMaxRepliesPerHour'].includes(field)) {
      const zero=field.endsWith('PerDay')||field.startsWith('voiceQuiet')||['groupMinReplyGapSeconds','groupMaxRepliesPerHour'].includes(field);
      const max=field.startsWith('voiceQuiet')?23:field.endsWith('PerDay')?100:10080;
      if(!Number.isInteger(value)||value<(zero?0:1)||value>max) throw Error('时间或次数设置超出范围'); out[field]=value;
    } else {
      if (typeof value !== 'string' || value.length > 4096) throw Error('配置字段格式不正确');
      if ((field.endsWith('Token') || field==='mimoApiKey') && value.trim() === '') continue;
      out[field] = value.trim();
    }
  }
  if (input.clearDshToken === true) out.dshToken = '';
  if (input.clearQqToken === true) out.qqToken = '';
  if (input.clearMimoApiKey === true) out.mimoApiKey = '';
  if(!['local','mimo'].includes(out.voiceProvider))throw Error('请选择本地模式或 MiMo API');
  if(!['preset','clone'].includes(out.mimoTtsMode))throw Error('请选择预置音色或参考录音');
  if(!['mimo_default','冰糖','茉莉','苏打','白桦','Mia','Chloe','Milo','Dean'].includes(out.mimoVoice))throw Error('请选择支持的 MiMo 音色');
  if(!['auto','zh','en'].includes(out.mimoAsrLanguage))throw Error('识别语言无效');
  if(out.mimoReferenceId&&!/^[0-9a-f-]{36}$/.test(out.mimoReferenceId))throw Error('参考录音编号无效');
  if(out.mimoStyle.length>500||/[\r\n]/.test(out.mimoApiKey))throw Error('MiMo 配置格式不正确');
  out.dshUrl = localUrl(out.dshUrl, ['http:', 'https:']);
  out.qqUrl = localUrl(out.qqUrl, ['ws:', 'wss:']);
  if(out.botQQ && !/^\d{5,20}$/.test(out.botQQ)) throw Error('机器人 QQ 号码格式不正确');
  if (!['base', 'small'].includes(out.model)) throw Error('请选择 base 或 small 模型');
  for(const field of ['privateMessagePolicy','groupMessagePolicy']) if(!['queue','steer'].includes(out[field])) throw Error('请选择排队或插话');
  if (!['Microsoft Huihui Desktop', 'Microsoft Zira Desktop'].includes(out.voice)) throw Error('请选择已支持的本地声音');
  if(!['auto','text','voice'].includes(out.voiceReplyMode))throw Error('语音回复模式无效');
  for(const f of ['proactiveStart','proactiveEnd'])if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(out[f]))throw Error('主动消息时段格式应为 HH:mm');
  if(out.recallMaxMinutes<out.recallMinMinutes||out.groupProactiveMaxMinutes<out.groupProactiveMinMinutes)throw Error('最长间隔不能小于最短间隔');
  for (const field of ['privatePreset', 'groupPreset']) if (out[field].length > 200) throw Error('预设名称过长');
  out.chatPolicy=validateChatPolicy(input.chatPolicy??out.chatPolicy,out);
  return out;
}
export function publicConfig(config) {
  const { dshToken, qqToken, mimoApiKey, ...rest } = config;
  return { ...rest, dshTokenConfigured: !!dshToken, qqTokenConfigured: !!qqToken, mimoApiKeyConfigured: !!mimoApiKey };
}
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
export function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}
