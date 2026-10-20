// Old saved values are minutes. Convert their duration, never reinterpret 5 as 5s.
export const minuteFields=['memoryIdle','groupAmbientMin','recallMin','recallMax','groupProactiveMin','groupProactiveMax','proactiveMin','proactiveMax'];
export function migrateIntervals(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const result={...value};
  for(const prefix of minuteFields){
    const old=prefix+'Minutes',next=prefix+'Seconds';
    if(!Object.hasOwn(result,old))continue;
    if(!Number.isInteger(result[old])||result[old]<1||result[old]>10080)throw Error('旧版分钟间隔格式不正确');
    if(!Object.hasOwn(result,next))result[next]=result[old]*60;
    delete result[old];
  }
  return result;
}
export function wakeSeconds(input){
  if(input.seconds!==undefined)return input.seconds;
  if(input.minutes!==undefined){
    if(!Number.isInteger(input.minutes)||input.minutes<1||input.minutes>1440)throw Error('旧版潜水时长无效');
    return input.minutes*60;
  }
  return 1800;
}
