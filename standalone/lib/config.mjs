import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const defaults = {
  dshUrl: 'http://127.0.0.1:3080', dshToken: '', dshLocalAuth: false,
  qqUrl: 'ws://127.0.0.1:3001', qqToken: '', botQQ: '',
  privateUsers: [], groups: [], privatePreset: '', groupPreset: '',
  voice: 'Microsoft Huihui Desktop', model: 'small',
  memoryEnabled: true, memoryIdleMinutes: 30, rotateAfterCompactions: 15,
  rotationEnabled: true, privateMessagePolicy: 'steer', groupMessagePolicy: 'queue',
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
  const out = { ...previous };
  for (const field of Object.keys(defaults)) {
    if (!(field in input)) continue;
    const value = input[field];
    if (field === 'privateUsers' || field === 'groups') {
      if (!Array.isArray(value) || value.length > 100 || value.some(x => typeof x !== 'string' || !/^\d{5,20}$/.test(x))) throw Error('QQ 号码请使用数字，每行一个');
      out[field] = [...new Set(value)];
    } else if (['memoryEnabled','rotationEnabled','dshLocalAuth'].includes(field)) {
      if(typeof value!=='boolean') throw Error('开关格式不正确'); out[field]=value;
    } else if (['memoryIdleMinutes','rotateAfterCompactions'].includes(field)) {
      if(!Number.isInteger(value)||value<1||value>10080) throw Error('空闲时间和压缩次数需要是正整数'); out[field]=value;
    } else {
      if (typeof value !== 'string' || value.length > 4096) throw Error('配置字段格式不正确');
      if (field.endsWith('Token') && value === '') continue;
      out[field] = value.trim();
    }
  }
  if (input.clearDshToken === true) out.dshToken = '';
  if (input.clearQqToken === true) out.qqToken = '';
  out.dshUrl = localUrl(out.dshUrl, ['http:', 'https:']);
  out.qqUrl = localUrl(out.qqUrl, ['ws:', 'wss:']);
  if(out.botQQ && !/^\d{5,20}$/.test(out.botQQ)) throw Error('机器人 QQ 号码格式不正确');
  if (!['base', 'small'].includes(out.model)) throw Error('请选择 base 或 small 模型');
  for(const field of ['privateMessagePolicy','groupMessagePolicy']) if(!['queue','steer'].includes(out[field])) throw Error('请选择排队或插话');
  if (!['Microsoft Huihui Desktop', 'Microsoft Zira Desktop'].includes(out.voice)) throw Error('请选择已支持的本地声音');
  for (const field of ['privatePreset', 'groupPreset']) if (out[field].length > 200) throw Error('预设名称过长');
  return out;
}
export function publicConfig(config) {
  const { dshToken, qqToken, ...rest } = config;
  return { ...rest, dshTokenConfigured: !!dshToken, qqTokenConfigured: !!qqToken };
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
