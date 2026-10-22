import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { localUrl } from './config.mjs';

export function callOneBot(socket,action,params={},timeoutMs=8000){
 return new Promise((resolve,reject)=>{
  const echo=randomUUID(),fail=(code,message,details={})=>Object.assign(Error(message),{code,action,...details});
  const finish=(error,value)=>{clearTimeout(timer);socket.off('message',message);socket.off('close',closed);socket.off('error',closed);error?reject(error):resolve(value);};
  const closed=()=>finish(fail('ONEBOT_DISCONNECTED','QQ 接口在验证完成前断开'));
  const message=bytes=>{let v;try{v=JSON.parse(bytes.toString());}catch{return;}
   if(v.echo!==echo)return;
   if(v.status!=='ok'||v.retcode!==0)return finish(fail('ONEBOT_REJECTED','QQ 接口拒绝请求：'+action,{retcode:v.retcode,responseStatus:v.status,
    responseMessage:String(v.wording??v.message??'').slice(0,300)}));
   finish(null,v.data);
  };
  const timer=setTimeout(()=>finish(fail('ONEBOT_TIMEOUT','QQ 接口验证超时：'+action)),timeoutMs);
  socket.on('message',message);socket.once('close',closed);socket.once('error',closed);
  try{socket.send(JSON.stringify({action,params,echo}));}catch{closed();}
 });
}
export async function verifyQQ(socket,config){
 const login=await callOneBot(socket,'get_login_info');
 const account=String(login?.user_id??'');
 if(!/^\d{5,20}$/.test(account))throw Object.assign(Error('QQ 接口没有返回有效登录账号'),{code:'ONEBOT_INVALID_ACCOUNT'});
 if(config.botQQ&&account!==config.botQQ)throw Object.assign(Error(`QQ 登录账号不匹配：当前 ${account}，预期 ${config.botQQ}`),{code:'ONEBOT_ACCOUNT_MISMATCH'});
 const status=await callOneBot(socket,'get_status');
 // `good` is part of the OneBot status response, but NapCat currently reports
 // it as a fixed value. It can reject an explicit false result; it cannot be
 // used to infer support for optional actions or media extensions.
 if(status?.online!==true||status?.good===false)throw Object.assign(Error('QQ 尚未登录或当前离线'),{code:'ONEBOT_OFFLINE'});
 return {account,nickname:String(login.nickname??''),online:true,verifiedAt:new Date().toISOString()};
}
export async function probeQQ(config){
 const url=localUrl(config.qqUrl,['ws:','wss:']);
 const socket=new WebSocket(url,{headers:config.qqToken?{Authorization:'Bearer '+config.qqToken}:{},handshakeTimeout:8000,followRedirects:false,maxPayload:1024*1024});
 try{
  await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',()=>reject(Error('无法连接 QQ 接口，请先启动 NapCat')));socket.once('close',()=>reject(Error('QQ 接口已断开')));});
  return await verifyQQ(socket,config);
 }finally{socket.close();}
}
