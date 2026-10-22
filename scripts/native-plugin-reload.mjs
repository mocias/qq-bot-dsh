// Updating the stable entry adds Remote methods and service dependencies. A
// runtime-only manifest switch cannot refresh the already loaded entry class.
export async function reloadNativePlugin(dsh){
  const status=await dsh.nativeStatus();
  if(status.enabled===false)return {disabled:true};
  const before=await dsh.rpc('qqRsiNative/probe');
  if(before.active)throw Error('DSH插件仍有活动回合，不能重新加载入口');
  const select=async enabled=>{
    const result=await dsh.rpc('pluginManager/setBundleEnabled',{name:'dsh-qq-rsi-native',enabled});
    if(result.application!=='applied')throw Error('DSH插件入口未完成热加载：'+result.application);
  };
  try{await select(false);}finally{await select(true);}
  return dsh.rpc('qqRsiNative/probe');
}
