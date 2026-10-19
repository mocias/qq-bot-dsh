import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import WebSocket from 'ws';
import { DshClient } from './dsh.mjs';
import { readJson, writeJson } from './config.mjs';
import { MemoryStore, decodeReply, preparePrompt } from './memory.mjs';
import { initializeLife, noteArrival, observeCompaction, maintain, due } from './lifecycle.mjs';
import { verifyQQ } from './onebot.mjs';

export function routeMessage(event, config) {
  if(config.botQQ&&String(event.self_id)!==config.botQQ)return null;
  if (event.post_type !== 'message' || !event.message_id || !event.self_id || String(event.user_id) === String(event.self_id)) return null;
  const group = event.message_type === 'group';
  if (!group && event.message_type !== 'private') return null;
  const id = String(group ? event.group_id : event.user_id);
  if (!(group ? config.groups : config.privateUsers).includes(id)) return null;
  if (!Array.isArray(event.message)) return null;
  if (group && !event.message.some(x => x.type === 'at' && String(x.data?.qq) === String(event.self_id))) return null;
  const text = event.message.filter(x => x.type === 'text').map(x => x.data?.text || '').join('').trim();
  if (!text || text.length > 12000) return null;
  return { key: `${event.self_id}/${group ? 'group' : 'private'}/${id}`, id, group, text,
    sender: String(event.user_id), messageId: `${event.self_id}/${group ? 'group' : 'private'}/${id}/${event.message_id}` };
}
export class Bridge {
  constructor(runtime, { Dsh = DshClient, now = Date.now } = {}) {
    this.runtime = runtime; this.Dsh = Dsh;
    this.file = path.join(runtime, 'bridge.private.json');
    this.state = readJson(this.file, { sessions: {}, seen: [], deliveries: [] });
    this.status = { state: 'stopped', active: 0, lastError: '' };
    this.queues = new Map(); this.pending = new Map(); this.generation = 0;
    this.now=now;this.jobs=new Map();this.maintenance=new Map();this.memories=new Map();
    this.state.retired??=[];this.state.rotations??={};
    for(const session of Object.values(this.state.sessions)){
      if(!session.route)continue;
      const life=initializeLife(session,now());
      if(life.pending){
        const store=this.memory(session.route.key);
        if(store.hasReceipt(life.pending.id)){
          life.digestedIds=[...new Set([...life.digestedIds,...(life.pending.compactionIds??[])])];
          life.receipt=life.pending.id;life.digestVersion=life.pending.version;life.conversation=[];
        }else session.blocked=true;
        life.pending=null;this.persist();
      }
    }
  }
  memory(key){if(!this.memories.has(key))this.memories.set(key,new MemoryStore(this.runtime,key));return this.memories.get(key);}
  scope(route){const preset=route.group?this.config.groupPreset:this.config.privatePreset;return createHash('sha256').update(this.config.dshUrl+'|'+preset+'|'+route.key).digest('hex');}
  summary(){return Object.values(this.state.sessions).filter(s=>s.route).map(s=>({key:s.route.key,sessionId:s.id,blocked:s.blocked,
    compactions:s.life?.compactions.length??0,pendingCompactions:s.life?.compactions.filter(c=>!s.life.digestedIds.includes(c.id)).length??0,
    lastDigest:this.memory(s.route.key).state.lastDigest||null,maintenance:this.maintenance.has(s.route.key),lastActivity:s.life?.lastAt}));}
  persist() { this.state.seen = this.state.seen.slice(-10000); this.state.deliveries = this.state.deliveries.slice(-200); writeJson(this.file, this.state); }
  async start(config) {
    if (this.status.state !== 'stopped') throw Error('请先停止当前连接');
    if (config.privateUsers.length && !config.privatePreset) throw Error('请指定私聊使用的 DSH 预设');
    if (config.groups.length && !config.groupPreset) throw Error('请指定已限制工具权限的群聊 DSH 预设');
    if (!config.privateUsers.length && !config.groups.length) throw Error('请先设置允许接收的 QQ 号码或群号');
    this.config = structuredClone(config); this.dsh = new this.Dsh(config);
    const generation = ++this.generation; this.status = { state: 'connecting', active: this.status.active, lastError: '' };
    try {
      await this.dsh.probe();
      if (generation !== this.generation) throw Error('启动已取消');
      const socket = this.socket = new WebSocket(config.qqUrl, { headers: config.qqToken ? { Authorization: 'Bearer '+config.qqToken } : {}, handshakeTimeout: 10000, maxPayload: 1024*1024, followRedirects: false });
      await new Promise((resolve,reject) => {
        socket.once('open', resolve); socket.once('error', () => reject(Error('无法连接 QQ OneBot 服务')));
        socket.once('close', () => reject(Error('QQ 连接已关闭')));
      });
      if (generation !== this.generation) { socket.close(); throw Error('启动已取消'); }
      socket.on('message', bytes => { let event; try { event=JSON.parse(bytes.toString()); } catch { return; }
        if (event.echo && this.pending.has(event.echo)) { const pending=this.pending.get(event.echo); this.pending.delete(event.echo); pending(event); return; }
        try { this.receive(event, generation); }
        catch { this.stop(); this.status.lastError='保存消息状态失败，QQ 连接已停止'; }
      });
      socket.on('error', () => { this.status.lastError='QQ 连接发生错误'; });
      socket.on('close', () => { if (this.generation === generation) { this.stop(); this.status.lastError='QQ 连接断开，请手动重新启动'; } });
      const verified=await verifyQQ(socket,config);
      if(generation!==this.generation)throw Error('启动已取消');
      Object.assign(this.status,verified);
      this.status.state = 'running';
      this.timer=setInterval(()=>this.sweep().catch(error=>{this.status.lastError=error.message;}),30000);this.timer.unref?.();
    } catch (error) { if (this.generation === generation) { this.stop(); this.status.lastError=error.message; } throw error; }
  }
  stop() {
    clearInterval(this.timer);for(const job of this.maintenance.values())job.controller.abort();
    this.generation++; this.socket?.close(); this.dsh?.close();
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear(); this.status.state='stopped';
  }
  receive(event, generation) {
    if (generation !== this.generation || this.status.state !== 'running') return;
    const route = routeMessage(event, this.config); if (!route || this.state.seen.includes(route.messageId)) return;
    this.status.lastReceivedAt=new Date().toISOString();this.status.lastReceivedId=route.messageId;
    if (this.status.active >= 20) { this.status.lastError='待处理消息已满，本条消息未处理'; return; }
    const session=this.state.sessions[this.scope(route)];if(session)noteArrival(session,this.now());
    this.maintenance.get(route.key)?.controller.abort();
    if(this.config.memoryEnabled)this.memory(route.key).record({id:route.messageId,kind:'qq-input',at:this.now(),sender:route.sender,text:route.text});
    this.state.seen.push(route.messageId); this.persist(); this.status.active++;
    const job=this.jobs.get(route.key),policy=route.group?this.config.groupMessagePolicy:this.config.privateMessagePolicy;
    const operation=job&&policy==='steer'&&this.dsh.canSteer?.(job.session.id)
      ? this.insert(route,job,generation):this.enqueue(route,generation);
    operation.catch(error=>{this.status.lastError=error.message;}).finally(()=>{this.status.active=Math.max(0,this.status.active-1);});
  }
  async insert(route,job,generation){
    job.inputs.push(route);
    try{
      const accepted=await this.dsh.steer(job.session.id,preparePrompt(this.memory(route.key),route,this.config));
      if(!accepted){job.inputs=job.inputs.filter(x=>x!==route);return this.enqueue(route,generation);}
    }catch(error){job.session.blocked=true;this.persist();throw error;}
  }
  enqueue(route,generation){
    const prior = this.queues.get(route.key) || Promise.resolve();
    const task = prior.catch(() => {}).then(() => this.handle(route, generation)).finally(() => {
      if (this.queues.get(route.key) === task) this.queues.delete(route.key);
    });
    this.queues.set(route.key, task);return task;
  }
  async handle(route, generation) {
    if (generation !== this.generation) return;
    const preset = route.group ? this.config.groupPreset : this.config.privatePreset;
    const scope = this.scope(route);
    let session = this.state.sessions[scope];
    const dsh = this.dsh;
    if (!session || session.blocked) {
      const dir = path.join(this.runtime, 'workspaces', scope); fs.mkdirSync(dir, { recursive: true });
      if(session)this.state.retired.push({...session,reason:'interrupted',retiredAt:this.now()});
      session = { id: await dsh.createSession(dir, preset), blocked: false,route:{key:route.key,id:route.id,group:route.group},workspace:dir,preset };
      initializeLife(session,this.now());noteArrival(session,this.now());
      this.state.sessions[scope] = session; this.persist();
    }
    // Upgrade v1 sessions lazily, retaining their existing workspace and id.
    session.route??={key:route.key,id:route.id,group:route.group};session.workspace??=path.join(this.runtime,'workspaces',scope);session.preset??=preset;
    initializeLife(session,this.now());const store=this.memory(route.key);
    if (generation !== this.generation) return;
    const job={session,inputs:[route]};this.jobs.set(route.key,job);
    try {
      // A crash or cancellation must not reuse a possibly running DSH session.
      session.blocked=true; this.persist();
      const prompt = preparePrompt(store,route,this.config);
      const response = await dsh.prompt(session.id, prompt,{onEvent:event=>observeCompaction(session,event,store,()=>this.persist())});
      if (generation !== this.generation) return;
      const parsed=decodeReply(response);const reply=parsed.reply;
      const inputs=job.inputs.map(x=>({messageId:x.messageId,sender:x.sender,text:x.text}));
      if(this.config.memoryEnabled){
        const explicit=route.group||job.inputs.some(x=>/(记住|记下来|记一下|忘记|更新.{0,6}记忆|修正.{0,6}记忆|remember|forget)/i.test(x.text));
        if(parsed.memory.length&&!explicit)throw Error('普通聊天不能自行写入私聊长期记忆，请明确要求记住或等待空闲整理');
        if(parsed.memory.length)store.commit(parsed.memory,{id:'remember-'+route.messageId,evidenceIds:inputs.map(x=>x.messageId),summary:'用户请求或群聊稳定事实'});
        const record={id:'turn-'+session.id+'-'+route.messageId,inputs,reply,at:this.now()};store.record({kind:'conversation',...record});
        session.life.conversation.push(record);
      }
      session.life.lastAt=this.now();
      if (!reply) { session.blocked=false; this.persist(); return; }
      const delivery = { messageId: route.messageId, state: 'sending', at: new Date().toISOString() };
      this.state.deliveries.push(delivery); this.persist();
      const echo = randomUUID();
      const sendResponse = new Promise(resolve => {
        const timer = setTimeout(() => { this.pending.delete(echo); resolve(null); }, 15000);
        this.pending.set(echo, result => { clearTimeout(timer); resolve(result); });
      });
      this.socket.send(JSON.stringify({ action: route.group ? 'send_group_msg' : 'send_private_msg',
        params: { [route.group ? 'group_id' : 'user_id']: route.id, message: [{ type: 'text', data: { text: reply.slice(0,4000) } }] }, echo }));
      const result = await sendResponse;
      delivery.state = result?.status === 'ok' && result.retcode === 0 ? 'sent' : result ? 'failed' : 'unknown'; this.persist();
      if(delivery.state==='sent'){delivery.qqMessageId=String(result.data?.message_id??'');this.status.lastSentAt=new Date().toISOString();this.persist();}
      if (delivery.state !== 'sent') throw Error('QQ 发送失败或结果不确定；为避免重复发送，不会自动重试');
      session.blocked=false; this.persist();
    } catch (error) { session.blocked=true; this.persist(); throw error; }
    finally{if(this.jobs.get(route.key)===job)this.jobs.delete(route.key);}
  }
  async sweep(){
    if(this.sweeping||this.status.state!=='running')return;this.sweeping=true;
    const generation=this.generation;
    try{for(const [scope,session] of Object.entries(this.state.sessions)){
      const route=session.route;if(!route||generation!==this.generation)continue;
      if(!(route.group?this.config.groups:this.config.privateUsers).includes(route.id)||this.scope(route)!==scope||this.queues.has(route.key)||!due(session,this.config,this.now()))continue;
      const controller=new AbortController(),store=this.memory(route.key);
      const current=()=>generation===this.generation&&this.state.sessions[scope]===session;
      const job={controller};this.maintenance.set(route.key,job);
      const operation=maintain({session,config:this.config,store,dsh:this.dsh,persist:()=>this.persist(),now:this.now,isCurrent:current,signal:controller.signal,
        rotate:(receipt,version)=>this.rotate(scope,session,receipt,version,generation,controller.signal)})
        .catch(error=>{session.life.retryAt=this.now()+this.config.memoryIdleMinutes*60000;this.persist();this.status.lastError=error.message;})
        .finally(()=>{if(this.maintenance.get(route.key)===job)this.maintenance.delete(route.key);if(this.queues.get(route.key)===operation)this.queues.delete(route.key);});
      this.queues.set(route.key,operation);await operation;
    }}finally{this.sweeping=false;}
  }
  async rotate(scope,session,receipt,version,generation,signal){
    const safe=()=>!signal.aborted&&generation===this.generation&&this.state.sessions[scope]===session&&session.life.version===version&&!session.blocked;
    if(!safe()||!this.memory(session.route.key).hasReceipt(receipt))return;
    let journal=this.state.rotations[session.id];
    if(!journal){journal={oldId:session.id,workspace:session.workspace,receipt,status:'pending',at:this.now()};this.state.rotations[session.id]=journal;this.persist();}
    if(!journal.newId){journal.newId=await this.dsh.createSession(session.workspace,session.preset);this.persist();}
    if(!safe())return;
    const title='QQ 私聊｜'+new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'medium'}).format(this.now());
    await this.dsh.rename(journal.newId,title);
    if(!safe())return;
    const next={id:journal.newId,blocked:false,route:session.route,workspace:session.workspace,preset:session.preset};initializeLife(next,this.now());
    const retiredLength=this.state.retired.length;
    this.state.retired.push({...session,retiredAt:this.now(),reason:'rotation'});this.state.sessions[scope]=next;journal.status='complete';
    try{this.persist();}catch(error){this.state.sessions[scope]=session;this.state.retired.length=retiredLength;journal.status='pending';throw error;}
  }
  async newConversation(key){
    if(this.status.state!=='running')throw Error('请先启动 QQ 连接');
    const route={key,group:key.includes('/group/'),id:key.split('/').at(-1)},scope=this.scope(route),session=this.state.sessions[scope];
    if(!session||session.blocked||this.queues.has(key)||this.jobs.has(key)||this.maintenance.has(key))throw Error('会话不存在或仍在处理消息，请稍后重试');
    const generation=this.generation,version=session.life.version;
    const task=(async()=>{
      const id=await this.dsh.createSession(session.workspace,session.preset);
      const safe=()=>this.generation===generation&&this.state.sessions[scope]===session&&session.life.version===version&&!session.blocked;
      if(!safe())throw Error('有新消息到达或连接已停止，保留原会话');
      await this.dsh.rename(id,'QQ 新会话｜'+new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}));
      if(!safe())throw Error('有新消息到达或连接已停止，保留原会话');
      const next={id,blocked:false,route:session.route,workspace:session.workspace,preset:session.preset};initializeLife(next,this.now());
      const length=this.state.retired.length;this.state.retired.push({...session,retiredAt:this.now(),reason:'manual-new-conversation'});this.state.sessions[scope]=next;
      try{this.persist();}catch(error){this.state.sessions[scope]=session;this.state.retired.length=length;throw error;}
      return {oldId:session.id,newId:id,key,memoryPreserved:true};
    })();
    this.queues.set(key,task);
    try{return await task;}finally{if(this.queues.get(key)===task)this.queues.delete(key);}
  }
}
