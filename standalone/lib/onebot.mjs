import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { localUrl } from './config.mjs';

export function callOneBot(socket,action,params={},timeoutMs=8000){
 return new Promise((resolve,reject)=>{
  const echo=randomUUID();
  const finish=(error,value)=>{clearTimeout(timer);socket.off('message',message);socket.off('close',closed);socket.off('error',closed);error?reject(error):resolve(value);};
  const closed=()=>finish(Error('QQ 接口在验证完成前断开'));
  const message=bytes=>{let v;try{v=JSON.parse(bytes.toString());}catch{return;}
   if(v.echo!==echo)return;
   if(v.status!=='ok'||v.retcode!==0)return finish(Error('QQ 接口拒绝请求：'+action));
   finish(null,v.data);
  };
  const timer=setTimeout(()=>finish(Error('QQ 接口验证超时：'+action)),timeoutMs);
  socket.on('message',message);socket.once('close',closed);socket.once('error',closed);
  try{socket.send(JSON.stringify({action,params,echo}));}catch{closed();}
 });
}
export async function verifyQQ(socket,config){
 const login=await callOneBot(socket,'get_login_info');
 const account=String(login?.user_id??'');
 if(!/^\d{5,20}$/.test(account))throw Error('QQ 接口没有返回有效登录账号');
 if(config.botQQ&&account!==config.botQQ)throw Error(`QQ 登录账号不匹配：当前 ${account}，预期 ${config.botQQ}`);
 const status=await callOneBot(socket,'get_status');
 if(status?.online!==true||status?.good===false)throw Error('QQ 尚未登录或当前离线');
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
