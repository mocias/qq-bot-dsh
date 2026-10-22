import WebSocket from 'ws';
import {localUrl} from './config.mjs';
import {callOneBot,verifyQQ} from './onebot.mjs';

const result=(state,reasonCode,message,observedAt)=>({state,probe:'nc_get_packet_status',reasonCode,message,observedAt});

function classify(error){
 if(error?.code==='ONEBOT_TIMEOUT'||/超时|timed? out/i.test(String(error?.message??'')))return ['timeout','probe_timeout','PacketBackend 状态检查超时'];
 if(error?.code==='ONEBOT_DISCONNECTED')return ['unavailable','onebot_disconnected','OneBot 连接已断开'];
 if(['ONEBOT_INVALID_ACCOUNT','ONEBOT_ACCOUNT_MISMATCH','ONEBOT_OFFLINE'].includes(error?.code))return ['unavailable','onebot_not_verified','OneBot 账号或在线状态未通过核验'];
 const response=String(error?.responseMessage??error?.message??''),lower=response.toLowerCase();
 if(/packetbackend.{0,50}(不可用|未就绪|unavailable)|(?:不可用|unavailable).{0,50}packetbackend/i.test(response))
  return ['unavailable','packet_backend_unavailable','NapCat 报告 PacketBackend 不可用'];
 if(/(?:api|action|接口|动作).{0,40}(?:not found|unsupported|unknown|不存在|不支持|未注册)|(?:not found|unsupported|unknown|不存在|不支持).{0,40}(?:api|action|接口|动作)/i.test(response))
  return ['unsupported','probe_action_unsupported','NapCat 不支持只读 PacketBackend 检查接口'];
 if(error?.code==='ONEBOT_REJECTED'&&error?.retcode===1400&&lower.includes('packet'))
  return ['unavailable','packet_backend_unavailable','NapCat 报告 PacketBackend 不可用'];
 return ['unknown','probe_failed','PacketBackend 状态检查失败'];
}

/**
 * Read-only PacketBackend probe. `call` is injected by the runtime so the
 * capability check shares its authenticated OneBot connection and can be
 * fixture-tested without launching QQ or sending a message.
 */
export async function probePacketBackend(call,{now=Date.now}={}){
 if(typeof call!=='function')throw new TypeError('PacketBackend 检查需要 OneBot 调用函数');
 const observedAt=new Date(now()).toISOString();
 try{
  const data=await call('nc_get_packet_status',{});
  // NapCat 4.18.41 declares a null return schema; a successful null response
  // means the backend status check passed, not that a poke was delivered.
  if(data===null)return result('ready','packet_backend_check_passed','PacketBackend 检查通过；拍一拍实际投递仍未验证',observedAt);
  return result('unknown','unexpected_probe_response','PacketBackend 检查返回了未识别的数据，不能确认状态',observedAt);
 }catch(error){
  const [state,reasonCode,message]=classify(error);
  return result(state,reasonCode,message,observedAt);
 }
}

/** Open and verify a read-only OneBot connection for runtime status screens. */
export async function probePacketQQ(config,{now=Date.now,socketFactory=(url,options)=>new WebSocket(url,options)}={}){
 const observedAt=new Date(now()).toISOString();let socket;
 try{
  const url=localUrl(config.qqUrl,['ws:','wss:']);
  socket=socketFactory(url,{headers:config.qqToken?{Authorization:'Bearer '+config.qqToken}:{},handshakeTimeout:8000,followRedirects:false,maxPayload:1024*1024});
  await new Promise((resolve,reject)=>{
   socket.once('open',resolve);
   socket.once('error',()=>reject(Object.assign(Error('无法连接QQ OneBot接口'),{code:'ONEBOT_DISCONNECTED'})));
   socket.once('close',()=>reject(Object.assign(Error('QQ OneBot接口已断开'),{code:'ONEBOT_DISCONNECTED'})));
  });
  await verifyQQ(socket,config);
  const checked=await probePacketBackend((action,params)=>callOneBot(socket,action,params),{now});
  return {...checked,observedAt};
 }catch(error){
  const [state,reasonCode,message]=classify(error);
  return result(state,reasonCode,message,observedAt);
 }finally{
  try{socket?.close();}catch{}
 }
}
