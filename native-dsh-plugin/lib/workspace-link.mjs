import fs from 'node:fs';
import path from 'node:path';
import {VERSION,PROTOCOL,BUILD_ID} from './schema.mjs';

// Restore registry membership only; no agent creation, preset, title, pin or
// archive changes. The saved Session header remains the cwd authority.
export async function repairWorkspaceMembership(ctx,root,request){
  const {sessionId,workspacePath,version,protocol,buildId}=request??{};
  if(version!==VERSION||protocol!==PROTOCOL||buildId!==BUILD_ID)throw Error('工作区恢复版本不一致');
  if(!path.isAbsolute(root??'')||typeof sessionId!=='string'||!sessionId||!path.isAbsolute(workspacePath??''))throw Error('工作区恢复参数无效');
  const managed=path.resolve(root,'workspaces'),target=path.resolve(workspacePath),relative=path.relative(managed,target);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('只允许恢复当前QQ部署的受管工作区');
  // Refuse junctions as well as lexical escapes, before touching the registry.
  for(let current=target;;current=path.dirname(current)){
    const stat=fs.lstatSync(current);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('工作区路径不是普通目录');
    if(path.relative(root,current)==='')break;
  }
  const live=ctx.sessions?.get(sessionId);
  const header=live?.header??(await ctx.sessionPersistence.list()).find(s=>s.header.id===sessionId)?.header;
  if(!header?.cwd||path.relative(fs.realpathSync(header.cwd),fs.realpathSync(target))!=='')throw Error('原会话的工作目录与请求不符或会话不存在');
  const workspace=await ctx.workspaceRegistry.create(target);
  await workspace.attachSession(sessionId);
  if(!workspace.sessionIds.includes(sessionId))throw Error('DSH未确认原会话的工作区归属');
  return {workspaceId:workspace.id,sessionId,path:workspace.path};
}
