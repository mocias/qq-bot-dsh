import path from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
const powershell=path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
export async function processSnapshot() {
  if(process.platform!=='win32')return [];
  const script="$ErrorActionPreference='Stop'; $items=@(Get-CimInstance Win32_Process | ForEach-Object { @{pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; name=$_.Name; executable=$_.ExecutablePath; startedAt=if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{''}} }); ConvertTo-Json -InputObject $items -Compress";
  const {stdout}=await run(powershell,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,maxBuffer:4*1024*1024});
  return JSON.parse(stdout.trim()||'[]');
}
export function processKey(item){return `${item.pid}:${item.startedAt}:${String(item.executable??'').toLowerCase()}`;}
export function isQQProcess(item){return /^(?:QQ|napimain|NapCatWinBootMain|NapCatBoot)\.exe$/i.test(item.name??'');}
export function descendantProcesses(snapshot,owned,allow=()=>true) {
  const result=new Map(owned),pending=new Set([...owned.values()].filter(p=>snapshot.some(x=>processKey(x)===processKey(p))).map(p=>p.pid));
  let changed=true;while(changed){changed=false;for(const p of snapshot)if(pending.has(p.parentPid)&&!pending.has(p.pid)&&p.startedAt&&p.executable){pending.add(p.pid);if(allow(p))result.set(processKey(p),p);changed=true;}}
  return result;
}
export function launchShell({root,entry,preset='native-shell',workDir}) {
  const file=name=>path.join(root,...entry[name].split('/'));
  const env={...process.env};for(const key of Object.keys(env))if(/^NAPCAT_/i.test(key)||/^NODE_(?:OPTIONS|PATH)$/i.test(key))delete env[key];
  // NAPCAT_WORKDIR is supported by the inspected official PathWrapper. QQ's
  // native account storage is separately selected by its own wrapper.
  env.NAPCAT_WORKDIR=workDir;
  if(preset==='official-node')return spawn(file('executable'),[file('script')],{cwd:root,windowsHide:true,shell:false,detached:false,stdio:'ignore',env});
  return spawn(file('launcher'),[file('qq'),file('hook')],{
    cwd:root,windowsHide:true,shell:false,detached:false,stdio:'ignore',
    env:{...env,NAPCAT_MAIN_PATH:file('main').replaceAll('\\','/'),NAPCAT_LOAD_PATH:path.join(root,'loadNapCat.js'),NAPCAT_INJECT_PATH:file('hook'),NAPCAT_LAUNCHER_PATH:file('launcher'),NAPCAT_PATCH_PACKAGE:path.join(root,'qqnt.json')},
  });
}
// An old PID alone never grants authority to stop a process. Verify both the
// creation timestamp and executable path immediately before the native stop.
export async function terminateOwned(identity) {
  if(!identity.startedAt||!identity.executable||!Number.isSafeInteger(identity.pid)||identity.pid<1)throw Error('QQ 进程归属缺少可靠指纹，无法停止');
  if(process.platform!=='win32')throw Error('只支持 Windows 受管 QQ 进程');
  const script="$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:QQ_RSI_STOP_PID); if(!$p){exit 0}; if($p.CreationDate.ToUniversalTime().ToString('o') -cne $env:QQ_RSI_STOP_START -or $p.ExecutablePath -ine $env:QQ_RSI_STOP_EXE){throw 'process identity changed'}; Stop-Process -Id ([int]$p.ProcessId) -ErrorAction Stop";
  await run(powershell,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,maxBuffer:16384,env:{...process.env,QQ_RSI_STOP_PID:String(identity.pid),QQ_RSI_STOP_START:identity.startedAt,QQ_RSI_STOP_EXE:identity.executable}});
}
