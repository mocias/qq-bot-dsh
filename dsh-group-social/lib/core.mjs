import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const BOT = '100000002';
export const OWNER = '100000001';
export const GROUP = '100000003';
export function targetAllowed(chat) { return chat === `group:${GROUP}` || chat === `private:${OWNER}`; }
export function callerAllowed(id = '') {
  return !id.startsWith('onebot-') || id === `onebot-private-${OWNER}` || id.startsWith(`onebot-private-${OWNER}-`);
}
export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n');
  renameSync(path + '.tmp', path);
}
export function loadJson(path, fallback) { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback; }
export function messageText(message) {
  return Array.isArray(message) ? message.map(s => s.type === 'text' ? String(s.data?.text ?? '')
    : s.type === 'at' ? `[@${s.data?.qq}]` : s.type === 'reply' ? `[回复:${s.data?.id}]` : `[${s.type}]`).join('')
    : String(message ?? '');
}
// Group images carry their OneBot file/url in the segment; keep them so the
// inbound path can fetch and attach a real image instead of a bare [image].
// Only http(s) URLs are kept here; anything else is not a fetchable address.
export function messageImages(message) {
  if (!Array.isArray(message)) return [];
  return message.filter(s => s?.type === 'image' && s.data && typeof s.data === 'object')
    .map(s => ({ file: typeof s.data.file === 'string' ? s.data.file : undefined,
      url: typeof s.data.url === 'string' && /^https?:\/\//i.test(s.data.url) ? s.data.url : undefined }))
    .filter(ref => ref.file || ref.url);
}
export function compactMessage(m,maxChars=1600) {
  const images=messageImages(m.message ?? m.raw_message);
  return { id: String(m.message_id ?? ''), time: Number(m.time ?? 0),
    sender: String(m.user_id ?? m.sender?.user_id ?? ''),
    name: String(m.sender?.card || m.sender?.nickname || '').slice(0, 40),
    text: messageText(m.message ?? m.raw_message).slice(0, maxChars),
    ...(images.length?{images}:{}) };
}
export function directlyAddressed(event) {
  return Array.isArray(event.message) && event.message.some(s => s.type === 'at' && String(s.data?.qq) === BOT);
}
export function groupEventAllowed(event) {
  return event.post_type==='message' && event.message_type==='group'
    && String(event.group_id)===GROUP && String(event.self_id)===BOT && String(event.user_id)!==BOT;
}
export function clock(now, zone = 'Asia/Shanghai') {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year:'numeric', month:'2-digit',
    day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).formatToParts(now).map(x => [x.type,x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour)*60+Number(p.minute) };
}
export function inHours(now, policy) {
  const minute = clock(now, policy.timeZone).minute;
  const mins = text => {const [h,m]=text.split(':').map(Number);return h*60+m;};
  const from=mins(policy.activeHours.start),to=mins(policy.activeHours.end);
  return from===to || (from<to ? minute>=from&&minute<to : minute>=from||minute<to);
}
export function readPolicy(path) {
  const p = {directDebounceMs:2500,ambientDebounceMs:30000,...loadJson(path, {})};
  if (typeof p.enabled !== 'boolean' || typeof p.proactiveEnabled !== 'boolean') throw Error('Invalid group enable flags');
  new Intl.DateTimeFormat('en',{timeZone:p.timeZone}).format();
  for (const key of ['minReplyGapSeconds','ambientCheckMinutes','maxRepliesPerHour','maxAmbientPerHour','maxProactivePerDay','proactiveMinMinutes','proactiveMaxMinutes','directDebounceMs','ambientDebounceMs']) {
    if(!Number.isFinite(p[key])||p[key]<0)throw Error(`Invalid group setting ${key}`);
  }
  if(p.proactiveMaxMinutes<p.proactiveMinMinutes)throw Error('Invalid group intervals');
  for(const k of ['start','end'])if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(p.activeHours?.[k]??''))throw Error('Invalid active hours');
  return p;
}
/** A zero output quota is unlimited; positive quotas retain their hard cap. */
export function replyLimitReached(count,limit) { return limit>0 && count>=limit; }
export function eventDelay(policy,direct) { return direct?policy.directDebounceMs:policy.ambientDebounceMs; }
export function parseDecision(raw) {
  const text = raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  const value = JSON.parse(text);
  if (!value || !['string','object'].includes(typeof value.reply) || (value.reply !== null && typeof value.reply !== 'string')) throw Error('Model decision has no valid reply');
  return { reply: (value.reply ?? '').trim().slice(0, 500),
    remember: typeof value.remember === 'string' ? value.remember.trim().slice(0, 2500) : '',
    search: typeof value.search === 'string' ? value.search.trim() : '',
    reason: typeof value.reason === 'string' ? value.reason.slice(0, 180) : '' };
}
export class OneBotApi {
  constructor(configPath, transport) {
    if(transport){this.transport=transport;return;}
    const c=loadJson(configPath,{}); this.url=c.url;
    const u=new URL(this.url);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1')throw Error('OneBot must use loopback HTTP');
    this.token=readFileSync(resolve(dirname(configPath),c.tokenFile),'utf8').trim();
  }
  async call(action, params={}, write=false) {
    if(this.transport){
      if(!write)await this.transport.whenConnected();
      try{return await this.transport.call(action,params);}
      catch(error){throw Error(write?'发送结果未知；禁止自动重发，请先读取消息历史核对。':error.message);}
    }
    let response;
    try { response=await fetch(new URL(action,this.url+'/'),{method:'POST',headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},body:JSON.stringify(params),signal:AbortSignal.timeout(20000)}); }
    catch(error){throw Error(write?'发送结果未知；禁止自动重发，请先读取消息历史核对。':`OneBot unavailable: ${error.message}`);}
    if(!response.ok)throw Error(`OneBot HTTP ${response.status}`);
    const r=await response.json();if(r.retcode!==0||r.status==='failed')throw Error(`OneBot ${r.retcode}: ${r.message||r.wording||'failed'}`);
    return r.data;
  }
  async sendText(chat,text) {
    if(!targetAllowed(chat))throw Error('Only the authorized owner and group are enabled');
    if(typeof text!=='string'||!text.trim()||text.length>4000)throw Error('Text must contain 1–4000 characters');
    const sent=await this.sendSegments(chat,[{type:'text',data:{text}}]);
    let verified=false;
    try { const read=await this.call('get_msg',{message_id:String(sent.message_id)});
      verified=messageText(read.message??read.raw_message)===text && String(read.user_id??read.sender?.user_id)===BOT;
    } catch {}
    return {sent:true,message_id:String(sent.message_id),chat_id:chat,verified};
  }
  /** Low-level send used by both text and image paths; never auto-retries. */
  async sendSegments(chat,segments) {
    if(!targetAllowed(chat))throw Error('Only the authorized owner and group are enabled');
    if(!Array.isArray(segments)||!segments.length)throw Error('Message must contain at least one segment');
    if(segments.length>10)throw Error('Message is limited to 10 segments');
    const login=await this.call('get_login_info');
    if(String(login.user_id)!==BOT)throw Error('QQ account changed; refusing to send as another account');
    const group=chat.startsWith('group:');
    return this.call(group?'send_group_msg':'send_private_msg',{
      [group?'group_id':'user_id']:chat.split(':')[1], message:segments,
    },true);
  }
}
