import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {execFileSync} from 'node:child_process';
import {DshClient} from '../standalone/lib/dsh.mjs';
import {readJson,writeJson} from '../standalone/lib/config.mjs';
import {reloadNativePlugin} from './native-plugin-reload.mjs';
const [deploymentArg,releaseArg]=process.argv.slice(2);
if(!deploymentArg||!releaseArg)throw Error('用法：node activate-release.mjs <部署根目录> <完整发布目录>');
const deployment=path.resolve(deploymentArg),releaseRoot=path.resolve(releaseArg);
const release=readJson(path.join(releaseRoot,'release.json'),null);
if(!release||release.protocol!==1)throw Error('缺少完整发布清单');
if(!release.hashes||release.buildId!==createHash('sha256').update(JSON.stringify(release.hashes)).digest('hex'))throw Error('发布构建标识校验失败');
for(const name of ['standalone','native-dsh-plugin'])if(readJson(path.join(releaseRoot,name,'package.json'),{}).version!==release.version)throw Error('插件与服务必须属于同一版本');
for(const [name,hash] of Object.entries(release.hashes)){
  const file=path.resolve(releaseRoot,name);
  if(!file.startsWith(releaseRoot+path.sep)||createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==hash)throw Error('发布文件校验失败：'+name);
}
const runtime=path.join(deployment,'standalone','.runtime'),launch=readJson(path.join(runtime,'launch.private.json'),null);
const install=readJson(path.join(deployment,'.runtime','native-install.private.json'),null);
let nativeWasEnabled=false;
if(install){
  const dsh=new DshClient({...readJson(path.join(runtime,'config.private.json'),{}),dshNativeTools:false});
  try{
    const status=await dsh.nativeStatus();
    if(status.state==='disabled'){
      // A user-disabled bundle stays disabled during updates.
    }else{
      nativeWasEnabled=status.enabled===true;
      const state=await dsh.rpc('qqRsiNative/probe');
      if(state.active)throw Error('DSH插件仍有活动回合，未切换版本');
    }
  }catch(error){
    // A closed local listener cannot own an active adapter round. Authentication,
    // timeouts and all other failures remain blocking rather than guessing.
    if(error.cause?.cause?.code!=='ECONNREFUSED')throw error;
  }
  finally{dsh.close();}
}
// Only the authenticated panel can confirm the owned service is safe to stop.
if(launch?.url){
  let login;
  try{login=await fetch(launch.url,{redirect:'manual',signal:AbortSignal.timeout(1500)});}
  catch(error){if(!['ECONNREFUSED','UND_ERR_CONNECT_TIMEOUT'].includes(error.cause?.code))throw error;}
  if(login){
    const origin=new URL(launch.url).origin,cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
    await login.body?.cancel();
    if(!cookie)throw Error('运行服务鉴权失败；未切换发布');
    const response=await fetch(origin+'/api/status',{headers:{Cookie:cookie}}),status=await response.json();
    if(status.bridge?.state!=='stopped'||status.bridge?.active)throw Error('请先停止QQ连接并等待当前任务结束，再统一更新');
    const stop=await fetch(origin+'/api/service/shutdown',{method:'POST',headers:{Cookie:cookie,Origin:origin,'X-QQ-RSI':'panel','Content-Type':'application/json'},body:'{}'});
    if(!stop.ok)throw Error('旧服务不支持自动关闭，请先正常退出旧服务再更新');
    await stop.body?.cancel();
    let stopped=false;
    for(let i=0;i<30;i++){await delay(100);try{await fetch(origin+'/api/status',{signal:AbortSignal.timeout(300)});}catch{stopped=true;break;}}
    if(!stopped)throw Error('旧服务尚未退出；未切换发布');
  }
}
const manifestFile=path.join(deployment,'.runtime','native-release.private.json');
const previous=readJson(manifestFile,null);
if(previous)writeJson(manifestFile+'.previous',previous);
// Both startup and the DSH loader read this single atomic pointer.
writeJson(manifestFile,{releaseRoot,version:release.version,protocol:release.protocol,buildId:release.buildId});
try{
  if(install)execFileSync(process.execPath,[path.join(releaseRoot,'scripts','install-native-plugin.mjs'),deployment,install.profile,install.app],{stdio:'inherit'});
  const updated=readJson(path.join(deployment,'.runtime','native-install.private.json'),null);
  if(nativeWasEnabled&&install?.bootstrapHash!==updated?.bootstrapHash){
    const dsh=new DshClient(readJson(path.join(runtime,'config.private.json'),{}));
    try{
      const live=await reloadNativePlugin(dsh,{profileFile:path.join(install.profile,'package.json')});
      if(live.version!==release.version||live.buildId!==release.buildId)throw Error('DSH插件入口重载后构建不一致');
    }finally{dsh.close();}
  }
}catch(error){
  if(previous)writeJson(manifestFile,previous);
  throw error;
}
const configFile=path.join(runtime,'config.private.json');
if(fs.existsSync(configFile)){
  const config=readJson(configFile,{});
  if(!config.dshNativeTools){writeJson(configFile+'.before-native',config);writeJson(configFile,{...config,dshNativeTools:true});}
}
fs.mkdirSync(path.join(deployment,'scripts'),{recursive:true});
fs.copyFileSync(path.join(releaseRoot,'scripts','start-release.ps1'),path.join(deployment,'scripts','start-release.ps1'));
fs.writeFileSync(path.join(deployment,'start-latest.ps1'),"& (Join-Path $PSScriptRoot 'scripts/start-release.ps1') -Deployment $PSScriptRoot\n");
console.log(JSON.stringify({activated:release.version,pluginAndService:releaseRoot,qqState:'stopped',restart:'start-latest.ps1'}));
