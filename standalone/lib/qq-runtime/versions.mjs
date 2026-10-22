import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {assertOrdinary,validateManifest,manifestId,inspectComponents,prepareComponents} from './components.mjs';

export function readPrivate(file){assertOrdinary(file);return JSON.parse(fs.readFileSync(file,'utf8'));}
export function atomicPrivate(file,data){
  assertOrdinary(file);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temporary=file+'.'+randomUUID()+'.tmp';
  try{fs.writeFileSync(temporary,JSON.stringify(data,null,2),{flag:'wx',mode:0o600});fs.renameSync(temporary,file);}finally{fs.rmSync(temporary,{force:true});}
}
export function versionId(input){const manifest=validateManifest(input);return `${manifest.version}-${manifestId(manifest).slice(0,16)}`;}
export function validVersionId(id){return typeof id==='string'&&/^\d+\.\d+\.\d+(?:[.-][\w.-]+)?-[a-f0-9]{16}$/.test(id)&&!id.includes('..');}
export class VersionStore {
  constructor(root,{commit=atomicPrivate}={}){this.root=root;this.directory=path.join(root,'versions');this.pointerFile=path.join(root,'active.private.json');this.commit=commit;}
  versionRoot(id){if(!validVersionId(id))throw Error('QQ Shell 版本标识无效');return assertOrdinary(path.join(this.directory,id));}
  components(id){return path.join(this.versionRoot(id),'components');}
  manifest(id){const saved=readPrivate(path.join(this.versionRoot(id),'version.json')),manifest=validateManifest(saved.manifest);if(saved.schema!==1||saved.id!==id||versionId(manifest)!==id||saved.manifestId!==manifestId(manifest))throw Error('已安装 QQ Shell 版本记录损坏');return manifest;}
  pointer(){
    assertOrdinary(this.pointerFile);if(!fs.existsSync(this.pointerFile))return null;const saved=readPrivate(this.pointerFile);
    const valid=d=>d&&validVersionId(d.versionId)&&/^[a-f0-9]{64}$/.test(d.manifestId)&&/^\d{5,20}$/.test(d.account);
    if(saved.schema!==1||!Number.isSafeInteger(saved.generation)||saved.generation<1||!valid(saved.active)||(saved.previous!==null&&!valid(saved.previous)))throw Error('QQ Shell 活动版本记录损坏；保留现场，不自动替换');
    return saved;
  }
  selection(descriptor){const manifest=this.manifest(descriptor.versionId);if(manifestId(manifest)!==descriptor.manifestId)throw Error('QQ Shell 活动版本与已安装记录不一致');return {manifest,root:this.components(descriptor.versionId),descriptor};}
  inspect(id){try{const manifest=this.manifest(id);return inspectComponents(this.components(id),manifest);}catch{return {state:fs.existsSync(this.versionRoot(id))?'invalid':'missing',version:'',message:'QQ Shell 版本尚未安装或安装记录无效'};}}
  async install(input,{sourceRoot,download,extract,installedSource=false}={}) {
    const manifest=validateManifest(input),id=versionId(manifest),target=this.versionRoot(id);
    if(fs.existsSync(target)){if(this.inspect(id).state!=='verified'||manifestId(this.manifest(id))!==manifestId(manifest))throw Error('已安装版本校验失败，保留现场，不覆盖');return {id,manifest,reused:true};}
    fs.mkdirSync(assertOrdinary(this.directory),{recursive:true,mode:0o700});const stage=path.join(this.directory,'.install-'+randomUUID());fs.mkdirSync(stage,{mode:0o700});
    try {
      await prepareComponents({targetRoot:path.join(stage,'components'),sourceRoot,manifest,download,extract,installedSource});
      atomicPrivate(path.join(stage,'version.json'),{schema:1,id,manifestId:manifestId(manifest),manifest,installedAt:new Date().toISOString()});
      fs.renameSync(stage,target);return {id,manifest,reused:false};
    }finally{fs.rmSync(stage,{recursive:true,force:true});}
  }
  activate(descriptor,{expectedActiveId,expectedRevision,beforeCommit}={}) {
    const prior=this.pointer(),activeId=prior?.active.versionId??'';
    if(expectedActiveId!==undefined&&expectedActiveId!==activeId)throw Error('活动 QQ Shell 版本已变化，请刷新后重试');
    if(expectedRevision!==undefined&&(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision!==(prior?.generation??0)))throw Error('QQ Shell 活动账号或版本修订已变化，请刷新后重试');
    this.selection(descriptor);if(this.inspect(descriptor.versionId).state!=='verified')throw Error('目标 QQ Shell 版本组件校验失败');
    if(prior?.active.versionId===descriptor.versionId&&prior.active.account===descriptor.account)return {reused:true,pointer:prior};
    beforeCommit?.();const next={schema:1,generation:(prior?.generation??0)+1,active:descriptor,previous:prior?.active??null,changedAt:new Date().toISOString()};
    this.commit(this.pointerFile,next);return {reused:false,pointer:next};
  }
}
