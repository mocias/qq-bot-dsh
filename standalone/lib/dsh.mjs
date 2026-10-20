import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { localSessionCookie } from './local-dsh-auth.mjs';

export function presetIds(result){
  const rows=Array.isArray(result)?result:result?.presets;
  if(!Array.isArray(rows))throw Error('DSH 预设列表格式不兼容，无法确认对话预设');
  return [...new Set(rows.map(row=>typeof row==='string'?row:row?.id??row?.name).filter(id=>typeof id==='string'&&id.length>0))];
}

// DSH Web API protocol checked against qq-bridge a56164e7, src/dsh-client.js.
// Launch token or explicitly enabled local browser-session grant.
export class DshClient {
  constructor(config) { this.config = config; this.cookie = ''; this.sockets = new Set(); this.runs = new Map(); }
  close() { for (const socket of this.sockets) socket.close(); this.sockets.clear(); }
  async authenticate() {
    if(this.config.dshLocalAuth){
      if(!this.cookie||Date.now()>(this.cookieExpiresAt??0)-300000){
        let auth;try{auth=localSessionCookie(this.config.dshUrl);}catch{throw Error('无法读取本机 DSH 登录状态，请检查 DSH 是否在此用户下运行');}
        this.cookie=auth.cookie;this.cookieExpiresAt=auth.expiresAt;
      }
      return;
    }
    if (this.cookie) return;
    if (!this.config.dshToken) throw Error('请填写 DSH 启动链接中的 token');
    const url = new URL(this.config.dshUrl); url.searchParams.set('token', this.config.dshToken);
    let response;
    try { response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) }); }
    catch { throw Error('无法连接 DSH，请确认它已启动'); }
    const cookies = response.headers.getSetCookie().map(x => x.split(';')[0]).filter(x => x.startsWith('dsh-auth-'));
    await response.body?.cancel();
    if (!cookies.length) throw Error('DSH 登录失败，请更新当前启动链接中的 token');
    this.cookie = cookies.join('; ');
  }
  async rpc(method, request = {}, rpcId = randomUUID()) {
    await this.authenticate();
    const args = method === 'agentPresets/list' ? {} : { [method === 'session/list' ? '_request' : 'request']: request };
    let response;
    try {
      response = await fetch(new URL('/api/'+method, this.config.dshUrl), { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Cookie: this.cookie },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }), signal: AbortSignal.timeout(15000) });
    } catch { throw Error('DSH 请求失败或超时'); }
    if (!response.ok) { await response.body?.cancel(); this.cookie = ''; throw Error('DSH 返回 HTTP '+response.status); }
    const body = await response.json();
    if (body.type !== 'server-response' || body.rpcId !== rpcId || !body.result?.ok) throw Error('DSH 未接受 '+method+' 请求，请在 DSH 中检查预设和会话');
    return body.result.value;
  }
  async probe() { return this.rpc('agentPresets/list'); }
  async createSession(workspacePath, preset) {
    const workspace = await this.rpc('workspace/create', { path: workspacePath });
    if (!workspace?.workspace?.workspaceId) throw Error('DSH 工作区响应格式不兼容');
    const session = await this.rpc('session/create', { workspaceId: workspace.workspace.workspaceId, agentPreset: preset });
    if (!session?.sessionId) throw Error('DSH 会话响应格式不兼容');
    return session.sessionId;
  }
  canSteer(sessionId) { return this.runs.get(sessionId)?.accepting === true; }
  async steer(sessionId,text) {
    const run=this.runs.get(sessionId);if(!run?.accepting)return false;
    await run.submit(text,'steer');return true;
  }
  async cancel(sessionId) { return this.rpc('session/cancel',{sessionId}); }
  async rename(sessionId,title) { return this.rpc('session/rename',{sessionId,title}); }
  watch(sessionId,onEvent,onError){
    let socket,timer,closed=false,ready=false;
    const close=()=>{closed=true;clearTimeout(timer);if(socket){this.sockets.delete(socket);socket.close();}};
    (async()=>{
      await this.authenticate();if(closed)return;
      const url=new URL('/api/remote.mux',this.config.dshUrl);url.protocol=url.protocol==='https:'?'wss:':'ws:';
      socket=new WebSocket(url,{headers:{Cookie:this.cookie},maxPayload:8*1024*1024,handshakeTimeout:10000,followRedirects:false});this.sockets.add(socket);
      const streamId=randomUUID();
      const fail=()=>{if(!closed){close();onError(Error('闹钟订阅断开，下一次巡检重新订阅；断线期间不补发'));}};
      timer=setTimeout(fail,15000);timer.unref?.();
      socket.on('error',fail);socket.on('close',fail);
      socket.on('open',()=>socket.send(JSON.stringify({type:'open',streamId,endpoint:'session/follow',payload:{args:{request:{address:{kind:'session',sessionId},maxMessages:20}}}})));
      socket.on('message',bytes=>{try{const f=JSON.parse(bytes);if(f.streamId!==streamId||closed)return;if(f.type==='end'||f.type==='error'){fail();return;}if(f.type!=='item')return;if(f.value?.type==='snapshot'){ready=true;clearTimeout(timer);return;}if(ready&&f.value?.type==='event')onEvent(f.value.event);}catch{fail();}});
    })().catch(error=>{if(!closed){close();onError(error);}});
    return close;
  }
  async prompt(sessionId, text, options = {}) {
    if(this.runs.has(sessionId))throw Error('同一 DSH 会话已有运行任务');
    await this.authenticate();
    if(options.signal?.aborted)throw Object.assign(Error('后台整理已让路'),{cancelled:true,acknowledged:true});
    const url = new URL('/api/remote.mux', this.config.dshUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, { headers: { Cookie: this.cookie }, maxPayload: 8*1024*1024, handshakeTimeout: 10000, followRedirects: false });
    this.sockets.add(socket);
    const streamId = randomUUID();
    let readyResolve, readyReject, finishResolve, finishReject, submitted = false, currentTurn, settled=false, abortRequested=false;
    const inputs=new Map(), turns=new Map(),seenEvents=new Set(); let pendingRPC=0,answerEpoch=0,messageOrder=0;
    const ready = new Promise((resolve,reject) => { readyResolve=resolve; readyReject=reject; });
    const finished = new Promise((resolve,reject) => { finishResolve=resolve; finishReject=reject; });
    // Both promises can reject before the sequential awaits begin.
    ready.catch(() => {}); finished.catch(() => {});
    const reject=error=>{settled=true;run.accepting=false;readyReject(error);finishReject(error);};
    const fail = () => reject(Error('DSH 回合中断，请检查 DSH；本次消息不会自动重发'));
    const complete=()=>{
      if(settled||!submitted||pendingRPC||!inputs.size)return;
      const ids=[...inputs.values()];if(ids.some(id=>id===null||!turns.get(id)?.ended))return;
      const affected=[...new Set(ids)].map(id=>turns.get(id));
      const bad=affected.find(t=>t.reason!=='completed');
      if(abortRequested||bad){reject(Object.assign(Error(abortRequested?'后台整理已让路':'DSH 回合未正常完成'),{cancelled:abortRequested,acknowledged:abortRequested&&affected.every(t=>t.ended)}));return;}
      const messages=affected.flatMap(t=>t.messages).filter(m=>m.epoch===answerEpoch).sort((a,b)=>a.order-b.order).map(m=>m.text.trim()).filter(Boolean);
      settled=true;run.accepting=false;finishResolve(options.collectMessages?messages:messages.at(-1)||'');
    };
    const run={accepting:false,submit:async(content,mode)=>{
      if(settled)throw Error('当前回合已结束');
      const id=randomUUID();inputs.set(id,null);pendingRPC++;
      try{
        const result=await this.rpc('session/prompt',{sessionId,mode,requestId:id,clientTimeZone:'Asia/Shanghai',content:[{type:'text',text:`[QQ_INPUT:${id}]\n${content}`},...(mode==='queue'?(options.images??[]):[])]},id);
        if(result?.command)throw Error('桥接内容不应触发 DSH 命令');
        if(abortRequested)await this.cancel(sessionId);
      }catch(error){reject(error);throw error;}finally{pendingRPC--;complete();}
    }};
    this.runs.set(sessionId,run);
    const readyTimer = setTimeout(() => reject(Error('DSH 会话快照超时')), 15000);
    const turnTimer = setTimeout(() => reject(Error('DSH 回复超时；如需工具审批，请在 DSH 中处理')), options.timeoutMs??180000);
    const abort=()=>{
      abortRequested=true;run.accepting=false;
      if(!submitted){reject(Object.assign(Error('后台整理已让路'),{cancelled:true,acknowledged:true}));return;}
      this.cancel(sessionId).catch(()=>reject(Object.assign(Error('后台整理取消状态不确定'),{cancelled:true})));
    };
    options.signal?.addEventListener('abort',abort,{once:true});
    socket.on('error', fail); socket.on('close', fail);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 20 } } } })));
    socket.on('message', bytes => {
      let frame; try { frame = JSON.parse(bytes.toString()); } catch { return; }
      if (frame.streamId !== streamId) return;
      if (frame.type === 'error' || frame.type === 'end') { fail(); return; }
      if (frame.type !== 'item') return;
      if (frame.value?.type === 'snapshot') { clearTimeout(readyTimer); readyResolve(); return; }
      if (!submitted || frame.value?.type !== 'event') return;
      const event = frame.value.event, data = event?.data;
      try {
        if(Number.isSafeInteger(event?.seq)){if(seenEvents.has(event.seq))return;seenEvents.add(event.seq);}
        options.onEvent?.(event);
        if(event?.type==='turn/start'){currentTurn=data.turn;if(!turns.has(currentTurn))turns.set(currentTurn,{messages:[],ended:false});}
        if(event?.type==='user/message'){
          const message=data.message??data;
          const body=(message.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
          const id=message.source?.rpcId??body.match(/\[QQ_INPUT:([a-f0-9-]+)\]/)?.[1];
          if(inputs.has(id)&&inputs.get(id)===null&&currentTurn!==undefined){inputs.set(id,currentTurn);answerEpoch++;}
        }
        const turn=turns.get(data?.turn);
        if(event?.type==='assistant/message'&&turn){
          const value=(data.message?.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('');
          if(value.length>100000)throw Error('DSH 回复过长');
          if(value){
            const id=data.message?.id??(Number.isSafeInteger(event.seq)?'event:'+event.seq:null);
            const previous=id===null?null:turn.messages.find(m=>m.id===id);
            if(previous)previous.text=value;
            else turn.messages.push({id,text:value,epoch:answerEpoch,order:messageOrder++});
            const messages=[...turns.values()].flatMap(t=>t.messages);
            if(messages.length>100||messages.reduce((sum,m)=>sum+m.text.length,0)>100000)throw Error('DSH 多段回复过长');
          }
        }
        if(event?.type==='turn/end'&&turn){turn.ended=true;turn.reason=typeof data.reason==='string'?data.reason:data.reason?.kind;complete();}
      } catch(error){reject(error);}
    });
    try {
      await ready;if(options.signal?.aborted)throw Object.assign(Error('后台整理已让路'),{cancelled:true,acknowledged:true});submitted = true;run.accepting=true;
      await run.submit(text,'queue');
      return await finished;
    } finally { run.accepting=false;this.runs.delete(sessionId);options.signal?.removeEventListener('abort',abort);clearTimeout(readyTimer); clearTimeout(turnTimer); this.sockets.delete(socket); socket.close(); }
  }
}
