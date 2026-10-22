import {PersonaCards,personaIdentity} from './persona-cards.mjs';
import {ModelProfiles} from './model-profiles.mjs';
import {policyView} from './chat-policy.mjs';

// Read-only projection. Browsing the directory never creates a memory store or session.
export function chatDirectory(runtime,config,bridge){
  const cards=new PersonaCards(runtime),models=new ModelProfiles(runtime),rows=[];
  if(!config.botQQ)return {rows};
  for(const kind of ['private','group'])for(const id of config[kind==='private'?'privateUsers':'groups']??[]){
    const key=config.botQQ+'/'+kind+'/'+id,view=cards.view(key),identity=personaIdentity(runtime,key,view.activeId);
    const configured=models.view(key,view.activeId).effective;
    const sessions=Object.values(bridge.state.sessions??{}).filter(s=>s.route?.key===key&&(s.personaId??'default')===view.activeId);
    const current=sessions.at(-1);
    const receiving=bridge.status.state==='running'&&bridge.status.channels?.[kind]!==false&&(!Array.isArray(bridge.status.chatKeys)||bridge.status.chatKeys.includes(key));
    const busy=['jobs','queues','maintenance','backgrounds','outbox','deferredDrains'].some(n=>bridge[n]?.has(key))||bridge.startup?.jobs?.has(key)||bridge.awaitingExit?.(key);
    rows.push({key,id,kind,personaId:view.activeId,personaName:identity.personaName,shared:identity.memoryKey!==key||identity.memoryPersonaId!==view.activeId,
      cards:view.cards,revision:view.revision,configuredModel:configured,currentModel:current?.modelSettings??null,
      modelWarnings:current?.modelWarnings??[],preset:policyView(config,key).effective.preset,
      receiving,state:bridge.status.state==='connecting'?'connecting':receiving?'receiving':'stopped',busy:!!busy,
      canAssign:!receiving&&bridge.status.state!=='connecting'&&!busy});
  }
  return {rows};
}
