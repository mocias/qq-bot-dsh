import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {localUrl,readJson,writeJson} from './config.mjs';

const listenerName='qq-rsi-local';
export function mergeNapcat(previous,config){
  const url=new URL(localUrl(config.qqUrl,['ws:','wss:']));
  if(url.protocol!=='ws:')throw Error('NapCat 自动同步仅支持本机 ws: 接口');
  const host=url.hostname==='localhost'?'127.0.0.1':url.hostname.replace(/^\[|\]$/g,''),port=Number(url.port||80);
  const next=structuredClone(previous);
  next.network??={};
  if(typeof next.network!=='object'||Array.isArray(next.network))throw Error('NapCat 网络配置格式错误');
  const servers=next.network.websocketServers??[];
  if(!Array.isArray(servers))throw Error('NapCat WebSocket 配置格式错误');
  next.network.websocketServers=servers.filter(s=>s.name!==listenerName&&!(Number(s.port)===port&&[host,url.hostname,'localhost'].includes(s.host)));
  next.network.websocketServers.push({name:listenerName,enable:true,host,port,token:config.qqToken||'',messagePostFormat:'array',reportSelfMessage:false,enableForcePushEvent:false,heartInterval:30000,debug:false});
  return next;
}
function ordinary(file){if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('NapCat 配置路径不能是链接');}
export async function syncNapcat(config,runtime,{fetch:request=globalThis.fetch}={}){
  if(!config.napcatFrameworkDir)return {state:'unmanaged',changed:false,message:'未设置 NapCat 目录，请自行配置 OneBot 服务。'};
  if(!/^\d{5,20}$/.test(config.botQQ))throw Error('请先在面板填写机器人账号');
  const root=path.resolve(config.napcatFrameworkDir),dir=path.join(root,'config'),file=path.join(dir,`onebot11_${config.botQQ}.json`),webFile=path.join(dir,'webui.json');
  for(const p of [root,dir,file,webFile])ordinary(p);
  if(!fs.existsSync(path.join(root,'nativeLoader.cjs')))throw Error('NapCat 桌面目录不正确');
  let previous=readJson(file,{}),api,reason='接口配置已保存；请启动带 NapCat 的桌面 QQ 并登录面板指定账号。';
  // Validate the endpoint before contacting any management service.
  mergeNapcat(previous,config);
  const web=readJson(webFile,null);
  if(web?.token&&!web.enable2FA&&!web.disableWebUI){
    try{
      if(!Number.isInteger(web.port)||web.port<1||web.port>65535)throw Error('invalid management port');
      if(web.host&&!['127.0.0.1','localhost','::1','0.0.0.0','::'].includes(web.host))throw Error('unsupported management host');
      const origin=`http://${web.host==='::1'?'[::1]':'127.0.0.1'}:${web.port}`;
      let credential='';
      const call=async(route,body={})=>{
        const response=await request(origin+'/api'+route,{method:'POST',redirect:'error',signal:AbortSignal.timeout(4000),headers:{'Content-Type':'application/json',...(credential?{Authorization:'Bearer '+credential}:{})},body:JSON.stringify(body)});
        if(!response.ok)throw Error('management request failed');
        const data=await response.json();if(data.code!==0)throw Error('management request rejected');return data.data;
      };
      const auth=await call('/auth/login',{hash:createHash('sha256').update(web.token+'.napcat').digest('hex')});
      if(!auth?.Credential||auth.require2FA)throw Error('management login requires user');
      credential=auth.Credential;
      const account=await call('/QQLogin/GetQQLoginInfo');
      if(String(account?.uin)===config.botQQ){previous=await call('/OB11Config/GetConfig');api=call;}
      else reason='面板账号的接口配置已保存；请在桌面 QQ 登录面板指定账号，当前账号尚不匹配或未登录。';
    }catch{reason='接口配置已保存；暂时无法通过 NapCat 管理接口应用。登录后可重试同步，或从托盘退出 QQ 后通过面板重开。';}
  }
  const next=mergeNapcat(previous,config),changed=JSON.stringify(previous)!==JSON.stringify(next);
  if(changed){
    if(fs.existsSync(file)){
      const backup=path.join(runtime,'napcat-backups',`${config.botQQ}-${Date.now()}-${randomUUID()}.json`);
      fs.mkdirSync(path.dirname(backup),{recursive:true});fs.copyFileSync(file,backup);
    }
    if(api){
      try{await api('/OB11Config/SetConfig',{config:JSON.stringify(next)});}
      catch{throw Error('NapCat 在线应用结果未确认，请检查接口后重试；面板设置已保留。');}
    }else writeJson(file,next);
  }
  return {state:api?'applied':'pending',changed,message:api?'NapCat 接口已按面板设置对齐。':reason};
}
