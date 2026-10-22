// Updating the stable entry adds Remote methods and service dependencies. A
// runtime-only manifest switch cannot refresh the already loaded entry class.
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
export function restorePluginProfileOrder(profileFile,beforeText){
  const currentText=fs.readFileSync(profileFile,'utf8');
  const normalized=text=>{const doc=JSON.parse(text);if(Array.isArray(doc.dsh?.profile?.bundles))doc.dsh.profile.bundles.sort();return canonical(doc);};
  if(normalized(currentText)!==normalized(beforeText))throw Error('DSH配置在重载期间发生其他变化，未覆盖配置');
  if(currentText!==beforeText){const temp=profileFile+'.qq-order-'+randomUUID();fs.writeFileSync(temp,beforeText);fs.renameSync(temp,profileFile);}
}
export async function reloadNativePlugin(dsh,{profileFile}={}){
  const status=await dsh.nativeStatus();
  if(status.enabled===false)return {disabled:true};
  const before=await dsh.rpc('qqRsiNative/probe');
  if(before.active)throw Error('DSH插件仍有活动回合，不能重新加载入口');
  const profileBefore=profileFile?fs.readFileSync(profileFile,'utf8'):null;
  const select=async enabled=>{
    const result=await dsh.rpc('pluginManager/setBundleEnabled',{name:'dsh-qq-rsi-native',enabled});
    if(result.application!=='applied')throw Error('DSH插件入口未完成热加载：'+result.application);
  };
  try{await select(false);}finally{
    try{await select(true);}finally{if(profileFile)restorePluginProfileOrder(profileFile,profileBefore);}
  }
  return dsh.rpc('qqRsiNative/probe');
}
