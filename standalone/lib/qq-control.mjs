// NapCat Framework 4.18.38 management routes + OneBot v11 read operations.
// No arbitrary RPC forwarding, account switching, message sending or process killing.
import path from 'node:path';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import WebSocket from 'ws';
import QRCode from 'qrcode';
import {readJson,localUrl} from './config.mjs';
import {verifyQQ,callOneBot} from './onebot.mjs';
export class QQControl{
  constructor({fetch:request=globalThis.fetch,connect,qr=QRCode.toDataURL}={}){this.fetch=request;this.connect=connect??this.onebot.bind(this);this.qr=qr;}
  async admin(config){
    if(!config.napcatFrameworkDir)throw Error('请先在连接页保存 NapCat Framework 目录');
    const file=path.join(config.napcatFrameworkDir,'config','webui.json');
    if(!fs.existsSync(file)||fs.lstatSync(file).isSymbolicLink())throw Error('未找到 NapCat 管理配置，请先打开桌面 QQ');
    const web=readJson(file,null);
    if(!web?.token||web.disableWebUI||web.enable2FA)throw Error('NapCat 管理接口不可用或需要双重认证，请在桌面 QQ 完成登录');
    if(!Number.isInteger(web.port)||web.port<1||web.port>65535||web.host&&!['127.0.0.1','localhost','::1','0.0.0.0','::'].includes(web.host))throw Error('只支持本机 NapCat 管理接口');
    const origin=`http://${web.host==='::1'?'[::1]':'127.0.0.1'}:${web.port}`;let credential='';
    const call=async(route,body={})=>{
      try{
        const response=await this.fetch(origin+'/api'+route,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'Content-Type':'application/json',...(credential?{Authorization:'Bearer '+credential}:{})},body:JSON.stringify(body)});
        if(!response.ok)throw Error();
        const result=await response.json();if(result.code!==0)throw Error();return result.data;
      }catch{throw Error('NapCat 管理请求未成功，请检查桌面 QQ 是否启动、登录是否完成');}
    };
    const auth=await call('/auth/login',{hash:createHash('sha256').update(web.token+'.napcat').digest('hex')});
    if(!auth?.Credential||auth.require2FA)throw Error('NapCat 管理登录需要人工处理');
    credential=auth.Credential;
    call.logStream=async signal=>{
      const response=await this.fetch(origin+'/api/Log/GetLogRealTime',{redirect:'error',signal,headers:{Authorization:'Bearer '+credential}});
      if(!response.ok||!response.headers.get('content-type')?.includes('text/event-stream')){await response.body?.cancel();throw Error('NapCat 实时日志接口不可用');}
      return response.body;
    };
    return call;
  }
  async followLogs(config,{signal,onLine,onReady}){
    const call=await this.admin(config);if(signal.aborted)return;
    const stream=await call.logStream(signal);onReady();
    const decoder=new TextDecoder();let pending='';
    for await(const chunk of stream){
      pending+=decoder.decode(chunk,{stream:true});
      // Drop an oversized partial record, rather than exposing a cut-off secret.
      if(pending.length>262144)throw Error('NapCat 日志记录过大');
      let end;
      let separator;
      while((separator=/\r?\n\r?\n/.exec(pending))){
        end=separator.index;
        const frame=pending.slice(0,end);pending=pending.slice(end+separator[0].length);
        let data=frame.split(/\r?\n/).filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');
        if(data){
          try{const item=JSON.parse(data);if(typeof item.message==='string')data=(['info','warn','error','debug'].includes(item.level)?'['+item.level+'] ':'')+item.message;}catch{}
          onLine(data);
        }
      }
    }
    if(!signal.aborted)throw Error('NapCat 实时日志连接已结束');
  }
  async status(config){
    const result={expectedAccount:config.botQQ,account:'',online:false,napcatReady:false,phase:'unknown',message:''};
    try{
      const call=await this.admin(config);result.napcatReady=true;
      const status=await call('/QQLogin/CheckLoginStatus'),info=await call('/QQLogin/GetQQLoginInfo');
      result.phase=String(status?.loginPhase??'unknown');result.account=String(info?.uin??'');
      result.online=status?.isLogin===true;result.accountMatches=!!config.botQQ&&result.account===config.botQQ;
      result.message=result.online?(result.accountMatches?'QQ 已登录，账号与面板一致':config.qqBackend==='shell'?'当前 QQ 账号不符，接收保持关闭；请停止 QQ 登录进程后重新登录预期账号':'QQ 已登录其他账号，请在桌面 QQ 切换为面板指定账号'):'等待 QQ 登录或扫描登录二维码';
    }catch(error){result.message=error.message;}
    try{const data=await this.connect(config);result.interfaceOnline=true;result.account=data.account;result.online=true;result.accountMatches=!!config.botQQ&&data.account===config.botQQ;result.message=result.accountMatches?'QQ 接口在线，登录账号与面板一致':'请先保存预期机器人账号并核验登录身份';}
    catch{result.interfaceOnline=false;}
    return result;
  }
  async qrcode(config,{watch=false}={}){
    if(!/^\d{5,20}$/.test(config.botQQ))throw Error('请先保存机器人 QQ 账号，再显示登录二维码');
    const call=await this.admin(config),state=await call('/QQLogin/CheckLoginStatus');
    if(state?.isLogin||state?.qrLoginAccepted){
      if(watch)return {state:state.isLogin?'logged-in':'confirming',message:state.isLogin?'QQ 已登录，正在核对账号。':'扫码已接受，等待 QQ 完成登录…'};
      throw Error('QQ 已登录或正在完成登录，请刷新状态；不会替换现有登录');
    }
    const data=await call('/QQLogin/GetQQLoginQrcode');
    if(typeof data?.qrcode!=='string'||!data.qrcode||data.qrcode.length>4096)throw Error('登录二维码尚未生成，请稍后重试');
    return {state:'waiting',image:await this.qr(data.qrcode,{width:256,margin:2}),message:'二维码状态每 3 秒自动更新。请用面板指定账号扫码；不会自动启动回复。'};
  }
  async contacts(config,kind){
    if(!['private','group'].includes(kind))throw Error('请选择好友或群');
    if(!/^\d{5,20}$/.test(config.botQQ))throw Error('请先保存机器人 QQ 账号，再读取列表');
    const data=await this.connect(config,kind==='private'?'get_friend_list':'get_group_list');
    if(!Array.isArray(data.items))throw Error('QQ 未返回有效列表');
    return {account:data.account,kind,items:data.items.slice(0,1000).map(x=>({id:String(kind==='private'?x.user_id:x.group_id),name:String(kind==='private'?(x.remark||x.nickname||''):x.group_name||'').slice(0,100)})).filter(x=>/^\d{5,20}$/.test(x.id))};
  }
  async onebot(config,action){
    const socket=new WebSocket(localUrl(config.qqUrl,['ws:','wss:']),{headers:config.qqToken?{Authorization:'Bearer '+config.qqToken}:{},handshakeTimeout:5000,followRedirects:false,maxPayload:4*1024*1024});
    try{
      await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',()=>reject(Error('OneBot 接口未连接，请先同步接口并完成 QQ 登录')));socket.once('close',()=>reject(Error('OneBot 接口已断开')));});
      const login=await verifyQQ(socket,config);
      return {...login,...(action?{items:await callOneBot(socket,action)}:{})};
    }finally{socket.close();}
  }
}
