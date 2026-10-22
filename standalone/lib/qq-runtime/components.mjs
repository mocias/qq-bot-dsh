import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {downloadArchive,extractZip,officialUrl,relativeFile,sha256} from './archive.mjs';

function integrityError(reasonCode,message){return Object.assign(Error(message),{reasonCode});}

export function assertOrdinary(target) {
  const resolved=path.resolve(target),parsed=path.parse(resolved);let cursor=parsed.root;
  for(const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor=path.join(cursor,part);
    let stat;try{stat=fs.lstatSync(cursor);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(stat?.isSymbolicLink())throw integrityError('path_invalid','受管 QQ 路径不能包含链接或目录联接');
  }
  return resolved;
}
export function validateManifest(input) {
  if(!input||input.schema!==1||input.platform!=='win32'||!['x64','arm64'].includes(input.arch)||!/^\d+\.\d+\.\d+(?:[.-][\w.-]+)?$/.test(input.version)||typeof input.qqVersion!=='string'||!input.qqVersion||input.localUseApproved!==true)throw Error('尚未提供经核实的固定版本 QQ / NapCat 组件清单');
  if(input.files!==undefined&&(!Array.isArray(input.files)||input.files.length>30000))throw Error('组件清单文件列表无效');
  const files=(input.files??[]).map(x=>({path:relativeFile(x.path),sha256:String(x.sha256??'').toLowerCase()})),seen=new Set();
  for(const file of files){if(!/^[a-f0-9]{64}$/.test(file.sha256)||seen.has(file.path.toLowerCase())||/^(?:config|logs|cache)(?:\/|$)/i.test(file.path)||['.complete.json','loadNapCat.js'].includes(file.path))throw Error('组件文件摘要、路径或去重校验失败');seen.add(file.path.toLowerCase());}
  if(input.criticalFiles!==undefined&&(!Array.isArray(input.criticalFiles)||input.criticalFiles.length>100))throw Error('关键组件摘要清单无效');
  const criticalFiles=(input.criticalFiles??[]).map(x=>({path:relativeFile(x.path),sha256:String(x.sha256??'').toLowerCase()}));
  for(const f of criticalFiles)if(!/^[a-f0-9]{64}$/.test(f.sha256))throw Error('关键组件摘要无效');
  const preset=input.preset??'native-shell',entry={},keys=preset==='official-node'?['executable','script','main']:['launcher','qq','hook','main'];
  if(!['official-node','native-shell'].includes(preset))throw Error('不支持的官方 QQ Shell 启动模式');
  for(const key of keys){entry[key]=relativeFile(input.entry?.[key]);if(files.length&&!files.some(f=>f.path===entry[key]))throw Error('组件启动入口不在校验清单');}
  if(preset==='official-node') {if(path.basename(entry.executable)!=='node.exe'||path.basename(entry.script)!=='index.js'||path.basename(entry.main)!=='napcat.mjs')throw Error('组件不是受支持的官方 Node Shell 入口');}
  else if(path.basename(entry.launcher)!=='NapCatWinBootMain.exe'||path.basename(entry.qq)!=='QQ.exe'||path.basename(entry.hook)!=='NapCatWinBootHook.dll'||path.basename(entry.main)!=='napcat.mjs')throw Error('组件不是受支持的官方 Windows Shell 入口');
  if(input.artifacts!==undefined&&(!Array.isArray(input.artifacts)||input.artifacts.length>4))throw Error('组件归档数量超出限制');
  const artifacts=(input.artifacts??[]).map(x=>({url:officialUrl(x.url),sha256:String(x.sha256??'').toLowerCase(),maxBytes:x.maxBytes,destination:x.destination?relativeFile(x.destination):''}));
  for(const a of artifacts)if(!/^[a-f0-9]{64}$/.test(a.sha256)||!Number.isSafeInteger(a.maxBytes)||a.maxBytes<1||a.maxBytes>2*1024**3)throw Error('组件归档必须有 SHA256 和下载大小上限');
  if(artifacts.reduce((total,a)=>total+a.maxBytes,0)>2*1024**3)throw Error('组件下载总量超出限制');
  if(!artifacts.length&&input.localSource!==true)throw Error('组件清单缺少固定官方归档');
  if(!files.length&&!artifacts.length)throw Error('无归档摘要时必须固定所有本地文件摘要');
  return {schema:1,platform:input.platform,arch:input.arch,version:input.version,qqVersion:input.qqVersion,localUseApproved:true,redistribution:input.redistribution??'unreviewed',preset,files,criticalFiles,entry,artifacts,localSource:input.localSource===true};
}
export function manifestId(manifest){return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');}
function tree(root,relative='') {
  const result=[];for(const item of fs.readdirSync(path.join(root,relative),{withFileTypes:true})) {
    const name=relative?relative+'/'+item.name:item.name,full=path.join(root,name);
    if(fs.lstatSync(full).isSymbolicLink()||(!item.isFile()&&!item.isDirectory()))throw integrityError('path_invalid','组件目录包含链接或特殊文件');
    if(relative&&runtimeDataFiles.includes(item.name))throw integrityError('unexpected_file','组件目录包含嵌套的运行数据路径；仅允许指定根目录普通文件');
    if(item.isDirectory())result.push(...tree(root,name));else result.push(name);
  }return result;
}
function mutableFile(name,manifest){return manifest.preset==='native-shell'&&name==='loadNapCat.js';}
// These exact root files were observed after starting/logging in with the pinned
// official Node package. They are runtime data, never trusted program inventory.
const runtimeDataFiles=['beacon_report.log','guild1.db','guild1.db-shm','guild1.db-wal'];
function runtimeFile(name,manifest){return manifest.preset==='official-node'&&runtimeDataFiles.includes(name);}
function checkRuntimeData(root,manifest,allow){
  for(const name of runtimeDataFiles){
    const file=path.join(root,name);let stat;try{stat=fs.lstatSync(file);}catch(error){if(error.code!=='ENOENT')throw error;continue;}
    if(!allow||manifest.preset!=='official-node'||stat.isSymbolicLink()||!stat.isFile())throw integrityError('runtime_data_invalid','仅允许运行后生成的指定根目录普通运行数据文件，不能作为安装组件或链接');
  }
}
export function verifyFiles(root,manifest,{mutable=false,inventory,runtime=false}={}) {
  assertOrdinary(root);checkRuntimeData(root,manifest,runtime);const names=tree(root),files=manifest.files.length?manifest.files:inventory;
  if(!Array.isArray(files)||!files.length)throw integrityError('inventory_invalid','组件完整性清单缺失');
  const allowed=new Set();for(const f of files){relativeFile(f.path);if(!/^[a-f0-9]{64}$/.test(f.sha256)||allowed.has(f.path)||runtimeFile(f.path,manifest))throw integrityError('inventory_invalid','组件完整性清单损坏，运行数据不能进入程序清单');allowed.add(f.path);}
  for(const name of names)if(!allowed.has(name)&&!(mutable&&(name==='.complete.json'||mutableFile(name,manifest)))&&!(runtime&&runtimeFile(name,manifest)))throw integrityError('unexpected_file','组件目录包含未知清单外文件；保留现场，请检查组件目录');
  for(const file of files){if(mutable&&mutableFile(file.path,manifest))continue;const full=path.join(root,...file.path.split('/'));assertOrdinary(full);if(!fs.existsSync(full)||!fs.statSync(full).isFile()||sha256(full)!==file.sha256)throw integrityError('file_integrity','QQ / NapCat 程序文件缺失或 SHA256 摘要不匹配；保留现场，请核对组件完整性');}
  for(const file of manifest.criticalFiles){const full=path.join(root,...file.path.split('/'));assertOrdinary(full);if(!allowed.has(file.path)||!fs.statSync(full).isFile()||sha256(full)!==file.sha256)throw integrityError('file_integrity','关键 QQ / NapCat 入口 SHA256 不匹配');}
  for(const name of Object.values(manifest.entry))if(!allowed.has(name)||!fs.statSync(path.join(root,name)).isFile())throw integrityError('entry_invalid','官方启动入口缺失');
}
export function inspectComponents(root,input) {
  if(!input)return {state:'missing',version:'',message:'此安装尚无已核实的官方 QQ / NapCat 组件清单，无法准备 Shell'};
  let manifest;try{manifest=validateManifest(input);}catch{return {state:'invalid',version:'',reasonCode:'manifest_invalid',message:'QQ / NapCat 固定版本组件清单未通过校验'};}
  if(!fs.existsSync(root))return {state:'missing',version:manifest.version,message:'QQ Shell 组件尚未准备'};
  let complete;
  try{assertOrdinary(root);assertOrdinary(path.join(root,'.complete.json'));complete=JSON.parse(fs.readFileSync(path.join(root,'.complete.json'),'utf8'));if(complete.manifestId!==manifestId(manifest)||JSON.stringify(complete.artifactDigests)!==JSON.stringify(manifest.artifacts.map(a=>a.sha256)))throw Error();}
  catch(error){return {state:'invalid',version:manifest.version,reasonCode:error.reasonCode??'metadata_invalid',message:error.reasonCode==='path_invalid'?error.message:'QQ Shell 安装记录缺失、损坏或与固定版本不一致；保留现场，请检查安装记录'};}
  try{verifyFiles(root,manifest,{mutable:true,inventory:complete.inventory,runtime:true});return {state:'verified',version:manifest.version,qqVersion:manifest.qqVersion,message:'QQ Shell 本地组件摘要已核实，登录和功能需另行校验'};}
  catch(error){return {state:'invalid',version:manifest.version,reasonCode:error.reasonCode??'inventory_invalid',message:error.reasonCode?error.message:'QQ Shell 组件完整性检查无法完成；保留现场，请检查清单和文件访问权限'};}
}
export async function prepareComponents({targetRoot,sourceRoot,manifest:input,download=downloadArchive,extract=extractZip,installedSource=false}) {
  const manifest=validateManifest(input),target=assertOrdinary(targetRoot);
  if(inspectComponents(target,manifest).state==='verified')return {manifest,reused:true};
  if(fs.existsSync(target))throw Error('现有 QQ Shell 组件校验失败；保留现场，不覆盖或删除');
  const parent=assertOrdinary(path.dirname(target));fs.mkdirSync(parent,{recursive:true});
  const stage=path.join(parent,'.prepare-'+randomUUID());fs.mkdirSync(stage,{mode:0o700});
  try {
    if(sourceRoot) {
      let files=manifest.files;
      if(installedSource){if(inspectComponents(sourceRoot,manifest).state!=='verified')throw Error('旧 QQ Shell 目录摘要未通过校验，不迁移');const complete=JSON.parse(fs.readFileSync(path.join(sourceRoot,'.complete.json'),'utf8'));files=manifest.files.length?manifest.files:complete.inventory;}
      else {if(!manifest.localSource)throw Error('此组件清单不允许本地来源');verifyFiles(sourceRoot,manifest);}
      for(const file of files){const dst=path.join(stage,file.path);fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(path.join(sourceRoot,file.path),dst,fs.constants.COPYFILE_EXCL);}
    } else {
      if(!manifest.artifacts.length)throw Error('尚未配置经核实的官方组件下载地址');
      for(const artifact of manifest.artifacts) {
        const archive=path.join(parent,'.archive-'+randomUUID()+'.zip');
        try{await download(artifact,archive);if(sha256(archive)!==artifact.sha256)throw Error('组件归档 SHA256 不匹配');await extract(archive,path.join(stage,artifact.destination));}finally{fs.rmSync(archive,{force:true});}
      }
    }
    checkRuntimeData(stage,manifest,false);const allFiles=tree(stage);if(allFiles.length>30000)throw Error('组件文件总数超出限制');
    const inventory=allFiles.filter(name=>!mutableFile(name,manifest)).map(name=>({path:name,sha256:sha256(path.join(stage,name))}));
    if(tree(stage).some(name=>name==='.complete.json'))throw Error('组件归档不能提供完成标记');
    verifyFiles(stage,manifest,{mutable:true,inventory});
    fs.writeFileSync(path.join(stage,'.complete.json'),JSON.stringify({schema:1,manifestId:manifestId(manifest),version:manifest.version,artifactDigests:manifest.artifacts.map(a=>a.sha256),inventory,preparedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});
    fs.renameSync(stage,target);
    return {manifest,reused:false};
  } finally {fs.rmSync(stage,{recursive:true,force:true});}
}
