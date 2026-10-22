import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {readJson,writeJson} from './config.mjs';
import {personaIdentity} from './persona-cards.mjs';
import {PROMPT_CATALOG} from '../../native-dsh-plugin/lib/prompt-catalog.mjs';
import {validatePromptRules,promptText} from '../../native-dsh-plugin/lib/prompt-text.mjs';
import {SCENE_VERSION,SCENE_DEFAULTS,COMMON_SCENE_DEFAULTS} from '../../native-dsh-plugin/lib/chat-scene.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function applies(id,scene){
  if(scene==='private')return id!=='proactive.1'&&id!=='chat.input.8'&&!id.startsWith('tool.qq_group_')&&!id.startsWith('tool.qq_slang_')&&id!=='tool.qq_send_message.atUserId';
  return scene!=='group'||id!=='proactive.private';
}
function sceneOf(key,kind){
  if(kind!==undefined&&!['private','group'].includes(kind))throw Error('提示词聊天类型无效');
  const scene=key?key.split('/')[1]:kind;
  if(key&&kind&&scene!==kind)throw Error('聊天对象与提示词类型不一致');
  return scene;
}
export class PromptProfiles{
  constructor(runtime){this.runtime=runtime;this.file=path.join(runtime,'prompt-profiles.private.json');}
  read(){return readJson(this.file,{revision:0,global:{},personas:{}});}
  resolve(key,personaId,kind){
    const scene=sceneOf(key,kind),state=this.read(),scope=key?personaIdentity(this.runtime,key,personaId).scope:null;
    const rules={...COMMON_SCENE_DEFAULTS,...SCENE_DEFAULTS[scene],...state.global,...state.scenes?.[scene],...(scope?state.personas[scope]??{}:{})};
    validatePromptRules(rules);return {promptScene:scene,promptRules:rules,promptProfileRevision:hash([SCENE_VERSION,scene,rules])};
  }
  view(key,personaId,kind){
    const scene=sceneOf(key,kind),state=this.read(),identity=key?personaIdentity(this.runtime,key,personaId):null;
    const parents={...(scene||identity?state.global:{}),...(identity?state.scenes?.[scene]:{})};
    return {key:key??null,personaId:identity?.personaId??null,personaName:identity?.personaName??null,revision:state.revision,
      kind:scene??null,scope:identity?'persona':scene?'scene':'global',catalog:PROMPT_CATALOG.filter(e=>applies(e.id,scene)).map(e=>({...e,text:promptText({promptScene:scene},e.id),source:SCENE_DEFAULTS[scene]?.[e.id]!==undefined||COMMON_SCENE_DEFAULTS[e.id]!==undefined?'本项目场景规则（参考 qq-bridge）':e.source})),overrides:identity?state.personas[identity.scope]??{}:scene?state.scenes?.[scene]??{}:state.global,
      inherited:Object.fromEntries(PROMPT_CATALOG.map(e=>[e.id,promptText({promptScene:scene,promptRules:parents},e.id)])),
      ...this.resolve(key,personaId,kind)};
  }
  save({key,personaId,kind,revision,overrides}){
    const scene=sceneOf(key,kind);
    if(personaId&&!key)throw Error('人格提示词需要聊天对象');
    if(key&&!personaId)throw Error('请明确选择人格');
    const identity=key?personaIdentity(this.runtime,key,personaId):null,state=this.read();
    if(revision!==state.revision)throw Error('提示词已被修改，请重新加载后保存');
    validatePromptRules(overrides);
    // A full backup precedes each successful replacement, including reset.
    writeJson(path.join(this.runtime,'prompt-backups',randomUUID()+'.private.json'),state);
    if(identity){if(Object.keys(overrides).length)state.personas[identity.scope]={...overrides};else delete state.personas[identity.scope];}
    else if(scene){state.scenes??={};state.scenes[scene]={...overrides};}
    else state.global={...overrides};
    state.revision++;writeJson(this.file,state);return this.view(key,personaId,kind);
  }
}
