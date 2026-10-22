import fs from 'node:fs';
import path from 'node:path';
import {VERSION,PROTOCOL,BUILD_ID} from './schema.mjs';

// Read-only inspection. A missing registration is a user deletion, not a
// request to resurrect or reattach a historical workspace/session.
export async function repairWorkspaceMembership(ctx,root,request){
  const {sessionId,workspacePath,workspaceId,version,protocol,buildId}=request??{};
  if(version!==VERSION||protocol!==PROTOCOL||buildId!==BUILD_ID)throw Error('工作区恢复版本不一致');
  if(!path.isAbsolute(root??'')||typeof sessionId!=='string'||!sessionId||!path.isAbsolute(workspacePath??''))throw Error('工作区恢复参数无效');
  const managed=path.resolve(root,'workspaces'),target=path.resolve(workspacePath),relative=path.relative(managed,target);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('只允许恢复当前QQ部署的受管工作区');
  // Refuse junctions as well as lexical escapes, before touching the registry.
  for(let current=target;;current=path.dirname(current)){
    let stat;try{stat=fs.lstatSync(current);}catch(error){if(error.code==='ENOENT')return {sessionId,path:target,status:'directory-missing'};throw error;}
    if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('工作区路径不是普通目录');
    if(path.relative(root,current)==='')break;
  }
  const live=ctx.sessions?.get(sessionId);
  const header=live?.header??(await ctx.sessionPersistence.list()).find(s=>s.header.id===sessionId)?.header;
  if(!header)return {sessionId,path:target,status:'session-missing'};
  if(!header.cwd||path.relative(fs.realpathSync(header.cwd),fs.realpathSync(target))!=='')throw Error('原会话的工作目录与请求不符');
  const canonical=fs.realpathSync(target);
  const workspace=ctx.workspaceRegistry.list().find(w=>path.relative(w.path,canonical)==='');
  if(!workspace||workspaceId&&workspace.id!==workspaceId)return {sessionId,path:target,status:'registration-missing'};
  if(!workspace.sessionIds.includes(sessionId))return {sessionId,path:target,status:'membership-missing'};
  return {workspaceId:workspace.id,sessionId,path:workspace.path,status:'ready'};
}
