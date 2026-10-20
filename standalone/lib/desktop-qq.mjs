import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { probeQQ } from './onebot.mjs';
const run=promisify(execFile);
const shell=path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
export async function qqProcesses(){
  if(process.platform!=='win32')return [];
  const script="$ErrorActionPreference='Stop'; $items=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('QQ.exe','napimain.exe') } | ForEach-Object { @{id=$_.ProcessId; name=$_.Name; command=$_.CommandLine} }); ConvertTo-Json -InputObject $items -Compress";
  const {stdout}=await run(shell,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,maxBuffer:131072});
  return JSON.parse(stdout.trim()||'[]');
}
export function launchDecision(processes,online){
  if(online)return {action:'reuse',message:'QQ 接口已在线，复用当前登录，不启动第二个实例。'};
  if(processes.some(p=>['qq.exe','napimain.exe'].includes(p.name.toLowerCase())))return {action:'blocked',message:'检测到 QQ 或桌面加载器已运行，但机器人接口不可用。请先检查现有连接；如需重新加载，请从托盘退出 QQ 后再打开。不会强退或重复登录。'};
  return {action:'launch',message:'可以启动桌面 QQ 与机器人共用的登录实例。'};
}
export class DesktopQQ {
  constructor(runtime,{processes=qqProcesses,probe=probeQQ,launch,platform=process.platform}={}){
    this.runtime=runtime;this.processes=processes;this.probe=probe;this.platform=platform;this.launchImpl=launch??this.launchNative.bind(this);this.busy=false;
  }
  async inspect(config){
    if(this.platform!=='win32')return {action:'unsupported',message:'此启动入口只支持 Windows；请手动准备 OneBot 服务。'};
    const processes=await this.processes();let online;
    try{online=await this.probe(config);}catch{}
    return {...launchDecision(processes,!!online),online:!!online,account:online?.account??'',processCount:processes.length};
  }
  async start(config){
    if(this.busy)throw Error('桌面 QQ 正在启动，请稍候');
    this.busy=true;
    fs.mkdirSync(this.runtime,{recursive:true});const lock=path.join(this.runtime,'desktop-launch.lock');
    let fd;
    try{
      try{fd=fs.openSync(lock,'wx');}catch{throw Error('另一个启动操作尚未完成；若上次启动程序异常退出，请检查 QQ 进程后清理本地 desktop-launch.lock');}
      const state=await this.inspect(config);
      if(state.action==='reuse')return state;
      if(state.action!=='launch')throw Error(state.message);
      const qq=path.resolve(config.qqExecutable||''),dir=path.resolve(config.napcatFrameworkDir||'');
      if(!config.qqExecutable||!config.napcatFrameworkDir||path.basename(qq).toLowerCase()!=='qq.exe')throw Error('请先配置 QQ.exe 和官方 NapCat Framework 目录');
      const files=[qq,...['napimain.exe','napiloader.dll','nativeLoader.cjs'].map(n=>path.join(dir,n))];
      for(const file of files)if(!fs.existsSync(file)||!fs.statSync(file).isFile())throw Error('桌面 QQ 启动文件缺失，请检查路径');
      // Recheck after validation so concurrent ordinary QQ startup is not ignored.
      if((await this.processes()).length)throw Error('QQ 已在其他地方启动，本次不重复打开');
      await this.launchImpl({qq,dir});
      return {action:'launched',message:'桌面 QQ 已启动，请在 QQ 窗口完成登录，再检查机器人连接。'};
    }finally{if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(lock);}this.busy=false;}
  }
  async launchNative({qq,dir}){
    // Pass paths as environment values, never interpolate them as PowerShell code.
    const script="$ErrorActionPreference='Stop'; $args=@(('\"'+$env:QQ_DSH_EXE+'\"'),('\"'+$env:NAPCAT_INJECT_PATH+'\"'),('\"'+$env:NAPCAT_MAIN_PATH+'\"')); Start-Process -FilePath $env:QQ_DSH_LAUNCHER -WorkingDirectory $env:QQ_DSH_FRAMEWORK -ArgumentList $args -WindowStyle Hidden";
    for(const p of [qq,dir])if(/["\r\n]/.test(p))throw Error('启动路径格式错误');
    await run(shell,['-NoProfile','-NonInteractive','-Command',script],{
      windowsHide:true,timeout:15000,maxBuffer:16384,env:{...process.env,
        QQ_DSH_EXE:qq,QQ_DSH_FRAMEWORK:dir,QQ_DSH_LAUNCHER:path.join(dir,'napimain.exe'),
        NAPCAT_INJECT_PATH:path.join(dir,'napiloader.dll'),NAPCAT_MAIN_PATH:path.join(dir,'nativeLoader.cjs').replaceAll('\\','/')},
    });
  }
}
