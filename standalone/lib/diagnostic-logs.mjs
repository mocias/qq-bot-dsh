import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function redactLog(text,secrets=[]){
  let value=String(text).replace(/\x1b\[[0-9;]*[a-zA-Z]/g,'');
  for(const secret of secrets.filter(x=>typeof x==='string'&&x.length>=4).sort((a,b)=>b.length-a.length))value=value.split(secret).join('[已隐藏]');
  return value
    .replace(/https?:\/\/[^\s"'<>]+(?:token|key|auth|signature|credential)=[^\s"'<>]*/gi,'[含凭据的链接已隐藏]')
    .replace(/((?:authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/gi,'$1[已隐藏]')
    .replace(/(["']?(?:[\w-]*(?:token|password|secret|credential)|api[_-]?key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,'$1[已隐藏]')
    .replace(/\bBearer\s+\S+/gi,'Bearer [已隐藏]')
    .replace(/\bsk-[a-zA-Z0-9_-]{10,}\b/g,'[已隐藏]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'');
}
function files(dir,match){
  try{
    if(fs.lstatSync(dir).isSymbolicLink())return [];
    return fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isFile()&&!e.isSymbolicLink()&&match.test(e.name)).map(e=>{
      const file=path.join(dir,e.name),stat=fs.statSync(file);return {file,name:e.name,mtime:stat.mtimeMs,size:stat.size};
    }).sort((a,b)=>b.mtime-a.mtime).slice(0,4);
  }catch{return [];}
}
function tail(file,secrets){
  let fd;
  try{
    if(fs.lstatSync(file.file).isSymbolicLink())throw Error();
    fd=fs.openSync(file.file,'r');const size=fs.fstatSync(fd).size,start=Math.max(0,size-65536),buffer=Buffer.alloc(Math.min(size,65536));
    fs.readSync(fd,buffer,0,buffer.length,start);let text=buffer.toString('utf8');
    if(start)text=text.includes('\n')?text.slice(text.indexOf('\n')+1):'';
    // Sanitize before truncating; never return a partial credential field.
    return {name:file.name,updatedAt:new Date(file.mtime).toISOString(),text:redactLog(text,secrets).split('\n').slice(-150).join('\n'),truncated:start>0};
  }catch{return {name:file.name,error:'日志暂时无法读取'};}finally{if(fd!==undefined)fs.closeSync(fd);}
}
export class DiagnosticLogs {
  constructor(runtime,control,{home=process.env.DSH_HOME||path.join(os.homedir(),'.dsh'),appData=process.env.APPDATA,now=Date.now}={}){
    this.runtime=runtime;this.control=control;this.home=home;this.appData=appData;this.now=now;this.live=[];this.state='尚未订阅';this.retryAt=0;
  }
  secrets(config){
    const values=[];
    const walk=o=>{for(const [k,v]of Object.entries(o??{})){if(/token|key|secret|password|credential/i.test(k)&&typeof v==='string')values.push(v);else if(v&&typeof v==='object')walk(v);}};
    walk(config);
    try{walk(JSON.parse(fs.readFileSync(path.join(config.napcatFrameworkDir,'config','webui.json'),'utf8')));}catch{}
    return values;
  }
  touch(config){
    const identity=JSON.stringify([config.napcatFrameworkDir,config.botQQ]);
    if(this.identity!==identity){this.close();this.live=[];this.identity=identity;this.retryAt=0;}
    clearTimeout(this.idle);this.idle=setTimeout(()=>this.close(),20000);this.idle.unref?.();
    if(this.controller||this.now()<this.retryAt||!config.napcatFrameworkDir||!this.control.followLogs)return;
    const controller=this.controller=new AbortController(),secrets=this.secrets(config);this.state='正在连接实时日志';
    this.control.followLogs(config,{signal:controller.signal,onReady:()=>{if(this.controller===controller)this.state='已订阅实时日志';},onLine:text=>{
      if(this.controller!==controller)return;
      this.live.push({time:new Date(this.now()).toISOString(),text:redactLog(text,secrets).slice(0,8000)});this.live=this.live.slice(-200);
    }}).catch(()=>{if(this.controller===controller)this.state='实时日志未连接；15 秒后重试。检查 NapCat 管理接口。';}).finally(()=>{
      if(this.controller===controller){this.controller=null;this.retryAt=this.now()+15000;}
    });
  }
  close(){clearTimeout(this.idle);this.controller?.abort();this.controller=null;this.state='实时订阅已暂停';}
  read(config){
    this.touch(config);const secrets=this.secrets(config);
    const processFiles=files(this.runtime,/^(?:server(?:-[\w-]+)?|panel)\.(?:out|err)\.log$/);
    const napcatFiles=config.napcatFrameworkDir?[...files(path.join(config.napcatFrameworkDir,'logs'),/\.log$/),...files(config.napcatFrameworkDir,/^boot\.(out|err)\.log$/)]:[];
    const dshFiles=[...files(path.join(this.home,'logs'),/\.log$/),...(this.appData?files(path.join(this.appData,'@deepseek-ai','dsh-desktop','logs'),/\.log$/):[])];
    return {napcat:{state:this.state,entries:this.live,files:napcatFiles.map(f=>tail(f,secrets))},dsh:{files:dshFiles.map(f=>tail(f,secrets))},process:{files:processFiles.map(f=>tail(f,secrets))}};
  }
}
