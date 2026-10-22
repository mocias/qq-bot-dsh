import {PROMPT_CATALOG} from './prompt-catalog.mjs';
import {SCENE_DEFAULTS,COMMON_SCENE_DEFAULTS} from './chat-scene.mjs';
const entries=new Map(PROMPT_CATALOG.map(x=>[x.id,x]));
export function promptText(config,id){
  if(!entries.has(id))throw Error('未知提示词：'+id);
  return Object.hasOwn(config?.promptRules??{},id)?config.promptRules[id]:SCENE_DEFAULTS[config?.promptScene]?.[id]??COMMON_SCENE_DEFAULTS[id]??entries.get(id).text;
}
export function validatePromptRules(rules={}){
  if(!rules||typeof rules!=='object'||Array.isArray(rules)||Object.getPrototypeOf(rules)!==Object.prototype)throw Error('提示词配置格式无效');
  if(JSON.stringify(rules).length>600000)throw Error('提示词配置总长度不能超过600000字符');
  for(const [id,value] of Object.entries(rules))if(!entries.has(id)||typeof value!=='string'||value.length>40000)throw Error('提示词条目无效或超过40000字符：'+id);
  return rules;
}
export function promptTool(definition,config){
  const key='tool.'+definition.name;
  if(!entries.has(key))return definition;
  return {...definition,description:promptText(config,key),parameters:Object.fromEntries(Object.entries(definition.parameters??{}).map(([name,spec])=>
    [name,entries.has(key+'.'+name)?{...spec,description:promptText(config,key+'.'+name)}:spec]))};
}
