import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {readJson,writeJson} from '../standalone/lib/config.mjs';
const [deploymentArg,profileArg,appArg]=process.argv.slice(2);
if(!deploymentArg||!profileArg||!appArg)throw Error('用法：node install-native-plugin.mjs <部署根目录> <DSH profile目录> <DSH安装目录>');
const deployment=path.resolve(deploymentArg),profile=path.resolve(profileArg),app=path.resolve(appArg);
const manifest=readJson(path.join(deployment,'.runtime','native-release.private.json'),null);
if(!manifest)throw Error('请先选择完整的服务＋插件发布版本');
const asar=path.join(app,'resources','app.asar');
if(!fs.existsSync(asar)||!fs.existsSync(path.join(profile,'cordis.patch.yml')))throw Error('DSH安装或profile路径不存在');
const loaderDir=path.join(deployment,'native-dsh-loader'),loader=path.join(loaderDir,'index.mjs');
const packageName='dsh-qq-rsi-native',profileFile=path.join(profile,'package.json');
const profileText=fs.readFileSync(profileFile,'utf8'),profileManifest=JSON.parse(profileText);
const dependency='link:'+loaderDir.replaceAll('\\','/');
const existingDependency=profileManifest.dependencies?.[packageName];
if(existingDependency&&existingDependency!==dependency)throw Error('已有其他来源的同名插件，未覆盖');
const moduleLink=path.join(profile,'node_modules',packageName);
if(fs.existsSync(moduleLink)&&fs.realpathSync(moduleLink)!==fs.realpathSync(loaderDir))throw Error('已有同名插件目录，未覆盖');
const patch=path.join(profile,'cordis.patch.yml'),previous=fs.readFileSync(patch,'utf8');
const begin='# BEGIN QQ RSI NATIVE ADAPTER',end='# END QQ RSI NATIVE ADAPTER';
let next=previous;
if(previous.includes(begin)){
  const start=previous.indexOf(begin),finish=previous.indexOf(end,start);
  if(finish<0||previous.indexOf(begin,start+1)>=0)throw Error('插件配置标记不完整或重复，未覆盖profile');
  // The bundle now owns this row. Keeping the legacy insert would make the
  // settings switch ineffective (and could register the service twice).
  next=previous.slice(0,start)+previous.slice(finish+end.length).replace(/^\r?\n/,'');
}else if(!existingDependency&&/id:\s*qq-rsi-native\b/.test(previous))throw Error('已有同名插件配置，请核对归属');
const selected=profileManifest.dsh?.profile?.bundles??[];
const enabled=existingDependency?selected.includes(packageName):true;
const updated={...profileManifest,dependencies:{...profileManifest.dependencies,[packageName]:dependency},
  dsh:{...profileManifest.dsh,profile:{...profileManifest.dsh?.profile,
    bundles:enabled?[...new Set([...selected,packageName])]:selected}}};
const bundle=readJson(path.join(manifest.releaseRoot,'native-dsh-plugin','package.json'),null);
if(bundle?.name!==packageName||bundle.version!==manifest.version||!bundle.dsh?.bundle)throw Error('轻量插件包信息与发布版本不一致');
let source=fs.readFileSync(path.join(manifest.releaseRoot,'native-dsh-plugin','lib','index.mjs'),'utf8');
// Resolve host peers to the running Electron app's own modules. Never bundle
// another copy of Cordis or the host registries into the adapter.
for(const name of ['dsh-tools','dsh-typert-protocol']){
  const target=pathToFileURL(path.join(asar,'dsh','node_modules','@deepseek-ai',name,'lib','index.js')).href;
  source=source.replace(`'@deepseek-ai/${name}'`,JSON.stringify(target));
}
fs.mkdirSync(loaderDir,{recursive:true});
if(!fs.existsSync(loader)||fs.readFileSync(loader,'utf8')!==source){
  if(fs.existsSync(loader))fs.copyFileSync(loader,loader+'.previous');
  const tmp=loader+'.next';fs.writeFileSync(tmp,source);fs.renameSync(tmp,loader);
}
writeJson(path.join(loaderDir,'package.json'),{...bundle,main:'index.mjs',
  exports:{...bundle.exports,'.':'./index.mjs'},peerDependencies:undefined});
fs.cpSync(path.join(manifest.releaseRoot,'native-dsh-plugin','locale'),path.join(loaderDir,'locale'),{recursive:true});
fs.writeFileSync(path.join(loaderDir,'cordis.patch.yml'),[
  '- insert:','    - id: qq-rsi-native','      name: '+packageName,'      config:',
  '        releaseManifest: '+JSON.stringify(path.join(deployment,'.runtime','native-release.private.json').replaceAll('\\','/')),''
].join('\n'));
fs.mkdirSync(path.dirname(moduleLink),{recursive:true});
if(!fs.existsSync(moduleLink))fs.symlinkSync(loaderDir,moduleLink,process.platform==='win32'?'junction':'dir');
// Prepare the resolvable package first, then replace the legacy row and select
// the bundle. Backups retain unrelated profile fields and explicit row overrides.
if(next!==previous){
  fs.copyFileSync(patch,patch+'.before-qq-native-'+Date.now());
  const tmp=patch+'.qq-native.next';fs.writeFileSync(tmp,next);fs.renameSync(tmp,patch);
}
if(JSON.stringify(updated)!==JSON.stringify(profileManifest)){
  fs.copyFileSync(profileFile,profileFile+'.before-qq-native-'+Date.now());
  try{writeJson(profileFile,updated);}catch(error){
    if(next!==previous)fs.writeFileSync(patch,previous);
    throw error;
  }
}
writeJson(path.join(deployment,'.runtime','native-install.private.json'),{
  profile,app,loader,bundleRegistered:true,bootstrapHash:createHash('sha256').update(source).digest('hex')
});
console.log(JSON.stringify({installed:true,enabled,packageName,version:manifest.version,loader,profileReload:'DSH配置热加载；若插件未出现需重载DSH'}));
