import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {readJson,writeJson} from './config.mjs';
import {personaIdentity} from './persona-cards.mjs';
import {PROMPT_CATALOG} from '../../native-dsh-plugin/lib/prompt-catalog.mjs';
import {validatePromptRules} from '../../native-dsh-plugin/lib/prompt-text.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class PromptProfiles{
  constructor(runtime){this.runtime=runtime;this.file=path.join(runtime,'prompt-profiles.private.json');}
  read(){return readJson(this.file,{revision:0,global:{},personas:{}});}
  resolve(key,personaId){
    const state=this.read(),scope=key?personaIdentity(this.runtime,key,personaId).scope:null;
    const rules={...state.global,...(scope?state.personas[scope]??{}:{})};
    validatePromptRules(rules);return {promptRules:rules,promptProfileRevision:hash(rules)};
  }
  view(key,personaId){
    const state=this.read(),identity=key?personaIdentity(this.runtime,key,personaId):null;
    return {key:key??null,personaId:identity?.personaId??null,personaName:identity?.personaName??null,revision:state.revision,
      scope:identity?'persona':'global',catalog:PROMPT_CATALOG,overrides:identity?state.personas[identity.scope]??{}:state.global,
      inherited:Object.fromEntries(PROMPT_CATALOG.map(e=>[e.id,identity&&Object.hasOwn(state.global,e.id)?state.global[e.id]:e.text])),
      ...this.resolve(key,personaId)};
  }
  save({key,personaId,revision,overrides}){
    if(key&&!personaId)throw Error('请明确选择人格');
    const identity=key?personaIdentity(this.runtime,key,personaId):null,state=this.read();
    if(revision!==state.revision)throw Error('提示词已被修改，请重新加载后保存');
    validatePromptRules(overrides);
    // A full backup precedes each successful replacement, including reset.
    writeJson(path.join(this.runtime,'prompt-backups',randomUUID()+'.private.json'),state);
    if(identity){if(Object.keys(overrides).length)state.personas[identity.scope]={...overrides};else delete state.personas[identity.scope];}
    else state.global={...overrides};
    state.revision++;writeJson(this.file,state);return this.view(key,personaId);
  }
}
