import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readJson,writeJson} from './config.mjs';
import {PersonaCards,personaScope} from './persona-cards.mjs';

function location(runtime,relative){
  const root=path.resolve(runtime),target=path.resolve(root,relative);
  if(!target.startsWith(root+path.sep))throw Error('备份路径无效');
  let current=root;
  for(const part of path.relative(root,target).split(path.sep)){current=path.join(current,part);if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('重置目录不能包含链接');}
  return target;
}
// A crash during reset is rolled back before Bridge loads its persistent state.
export function recoverMemoryReset(runtime){
  const journal=path.join(runtime,'memory-reset.pending.json'),data=readJson(journal,null);
  if(!data)return;
  if(data.phase!=='complete'){
    for(const move of [...data.moves].reverse()){
      const source=location(runtime,move.source),backup=location(runtime,move.backup);
      if(fs.existsSync(backup)){
        if(fs.existsSync(source))throw Error('记忆重置恢复存在冲突，请保留备份并检查');
        fs.mkdirSync(path.dirname(source),{recursive:true});fs.renameSync(backup,source);
      }
    }
    writeJson(path.join(runtime,'bridge.private.json'),data.before);
  }
  fs.unlinkSync(journal);
}
export function resetMemories(runtime,bridge,keys){
  if(bridge.status.state!=='stopped'||bridge.status.active||bridge.jobs.size||bridge.queues.size||bridge.maintenance.size||bridge.startup?.jobs.size)throw Error('请先停止 QQ 接收并等待全部任务结束');
  if(!keys.length||keys.some(key=>!/^\d{5,20}\/(?:private|group)\/\d{5,20}$/.test(key)))throw Error('请选择要重置的聊天');
  const cards=new PersonaCards(runtime);
  for(const key of keys)for(const card of cards.view(key).cards){
    const owner=cards.owner(key,card.id),scope=personaScope(owner.key,owner.personaId);
    for(const other of Object.keys(cards.read().chats))for(const c of cards.view(other).cards){
      const o=cards.owner(other,c.id);if(personaScope(o.key,o.personaId)===scope&&!keys.includes(other))throw Error('该人格记忆被其他聊天共用，请使用全账号重置或保留共享资料');
    }
    if(!keys.includes(owner.key))throw Error('共享人格的来源聊天未包含在重置范围内');
  }
  const id=randomUUID(),base='memory-reset-backups/'+id,selected=new Set(keys),before=structuredClone(bridge.state),moves=[];
  for(const key of keys)for(const card of new PersonaCards(runtime).view(key).cards)for(const scope of [personaScope(key,card.id)])for(const relative of ['memories/'+scope,'knowledge/'+scope+'.json','chat-inbox/'+scope+'.json','chat-context/'+scope]){
    const source=location(runtime,relative);if(fs.existsSync(source))moves.push({source:relative,backup:base+'/'+relative});
  }
  for(const move of moves)location(runtime,move.backup);
  const journal=path.join(runtime,'memory-reset.pending.json');
  writeJson(location(runtime,base+'/manifest.json'),{id,at:new Date().toISOString(),keys,before,moves});
  writeJson(journal,{phase:'pending',before,moves});
  try{
    for(const move of moves){const target=location(runtime,move.backup);fs.mkdirSync(path.dirname(target),{recursive:true});fs.renameSync(location(runtime,move.source),target);}
    bridge.state.memoryEpochs??={};
    for(const key of keys){bridge.state.memoryEpochs[key]=id;bridge.memories.delete(key);bridge.chatWindows?.delete(key);delete bridge.state.startups?.[key];delete bridge.state.maintenanceInbox?.[key];}
    for(const [scope,session]of Object.entries(bridge.state.sessions))if(selected.has(session.route?.key))delete bridge.state.sessions[scope];
    // Old DSH sessions/workspaces remain on disk but must not rejoin reminders or
    // supply old context. A new epoch gives the next conversation a fresh workspace.
    bridge.state.retired=bridge.state.retired.filter(s=>!selected.has(s.route?.key));
    bridge.persist();
    writeJson(journal,{phase:'complete',before,moves});
    try{fs.unlinkSync(journal);}catch{} // Committed; recovery only removes this marker.
    return {count:keys.length,backupId:id};
  }catch(error){recoverMemoryReset(runtime);bridge.state=before;throw error;}
}
