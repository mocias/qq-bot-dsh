import fs from 'node:fs';
import path from 'node:path';
import {personaIdentity} from './persona-cards.mjs';

export function workspacePersonaName(name){
  return Array.from(String(name).normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'_')).slice(0,40).join('').replace(/[. ]+$/g,'').trim()||'未命名人格';
}

export const beijingDate=now=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);

// A saved DSH binding survives deletion of its directory. Recreate only our
// managed directories, at the same path; never restore user-deleted contents.
export function ensureWorkspaceDirectory(runtime,workspace){
  try{
    if(typeof workspace!=='string'||!path.isAbsolute(workspace))throw Error('工作区路径无效');
    const root=path.resolve(runtime,'workspaces'),target=path.resolve(workspace),relative=path.relative(root,target);
    const managed=relative!== '..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);
    if(!managed){
      // Keep existing external bindings compatible, but do not recreate them.
      if(!fs.statSync(target).isDirectory())throw Error('工作区路径不是目录');
      return workspace;
    }
    const check=()=>{
      for(let current=target;;current=path.dirname(current)){
        let stat;
        try{stat=fs.lstatSync(current);}catch(error){if(error.code!=='ENOENT')throw error;}
        if(stat&&(!stat.isDirectory()||stat.isSymbolicLink()))throw Error('工作区路径被文件或链接占用');
        if(path.relative(path.resolve(runtime),current)==='')break;
      }
    };
    check();
    fs.mkdirSync(target,{recursive:true});
    check();
    return workspace;
  }catch(cause){
    throw Object.assign(new Error('工作区不可用，未提交模型：'+cause.message,{cause}),{notSubmitted:true});
  }
}

export function workspaceFor(runtime,state,route,scope,now,persist){
  if(!/^\d{5,20}\/(?:private|group)\/\d{5,20}$/.test(route.key))throw Error('工作区聊天范围无效');
  const mappings=state.workspaces??={};
  const existing=state.sessions[scope]?.workspace??mappings[scope];
  if(existing)return ensureWorkspaceDirectory(runtime,existing);
  // Preserve legacy directories and their DSH references in place.
  const legacy=path.join(runtime,'workspaces',scope);
  if(fs.existsSync(legacy)){ensureWorkspaceDirectory(runtime,legacy);mappings[scope]=legacy;persist();return legacy;}
  const [bot,kind,id]=route.key.split('/');
  const {personaName}=personaIdentity(runtime,route.key,route.personaId);
  const mode=kind==='group'?'群聊':'私聊';
  const parent=path.join(runtime,'workspaces',bot,mode),name=[beijingDate(now),mode,id,workspacePersonaName(personaName)].join('-');
  let dir=path.join(parent,name),number=1;
  const used=new Set(Object.values(mappings).map(x=>path.resolve(x).toLowerCase()));
  while(fs.existsSync(dir)||used.has(path.resolve(dir).toLowerCase()))dir=path.join(parent,'重建-'+(++number),name);
  ensureWorkspaceDirectory(runtime,dir);
  mappings[scope]=dir;persist();return dir;
}
