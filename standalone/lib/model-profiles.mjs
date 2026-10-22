import path from 'node:path';
import {readJson,writeJson} from './config.mjs';
import {personaIdentity} from './persona-cards.mjs';
export function validateModelSettings(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['provider','model','contextWindow'].includes(k)))throw Error('模型配置无效');
  const {provider='',model='',contextWindow=0}=value;
  if(typeof provider!=='string'||typeof model!=='string'||provider.length>200||model.length>200||!!provider!==!!model||/[\r\n\0]/.test(provider+model))throw Error('请同时选择模型服务与模型');
  if(!Number.isSafeInteger(contextWindow)||contextWindow<0||contextWindow>10000000)throw Error('上下文窗口须为 0–10000000 的整数，0 沿用模型默认');
  return {provider:provider.trim(),model:model.trim(),contextWindow};
}
export class ModelProfiles{
  constructor(runtime){this.runtime=runtime;this.file=path.join(runtime,'model-profiles.private.json');}
  read(){return readJson(this.file,{revision:0,defaults:{provider:'',model:'',contextWindow:0},scenes:{},overrides:{}});}
  view(key,personaId,kind){
    const state=this.read(),scene=key?key.split('/')[1]:kind;
    if(scene&&!['private','group'].includes(scene))throw Error('聊天类型无效');
    const scope=key?personaIdentity(this.runtime,key,personaId).scope:null;
    const inherited=key?state.scenes[scene]??state.defaults:state.defaults;
    const override=scope?state.overrides[scope]:scene?state.scenes[scene]:state.defaults;
    return {revision:state.revision,inherited,override:override??null,effective:override??inherited};
  }
  save({key,personaId,kind,revision,settings}){
    this.view(key,personaId,kind);const state=this.read();if(revision!==state.revision)throw Error('模型配置已变化，请刷新');
    const value=settings===null?null:validateModelSettings(settings);
    if(key){const scope=personaIdentity(this.runtime,key,personaId).scope;if(value)state.overrides[scope]=value;else delete state.overrides[scope];}
    else if(kind){if(value)state.scenes[kind]=value;else delete state.scenes[kind];}
    else state.defaults=value??{provider:'',model:'',contextWindow:0};
    state.revision++;writeJson(this.file,state);return this.view(key,personaId,kind);
  }
}
