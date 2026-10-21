import {promptText} from '../../native-dsh-plugin/lib/prompt-text.mjs';
// One relative clock per chat; reminders are host context, never QQ messages.
export const WORLD_SIMULATION_INTERVAL_MS=60_000;
export function worldSimulationPrompt(now=Date.now(),task=null,config={}){
  const time=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'medium'}).format(new Date(now));
  return `当前时间为${time}（Asia/Shanghai）。`+promptText(config,'simulation.body')+(task?promptText(config,'simulation.next.1')+JSON.stringify(task):promptText(config,'simulation.next.2'));
}
export class WorldSimulationClock{
  constructor(session,{now=Date.now,persist=()=>{},roleState=null,config={}}={}){this.session=session;this.now=now;this.persist=persist;this.roleState=roleState;this.config=config;}
  remaining(){return Math.max(0,(this.session.worldSimulationInputAt??this.now())+WORLD_SIMULATION_INTERVAL_MS-this.now());}
  delivered(requestUpdate=false){this.session.worldSimulationInputAt=this.now();this.persist();return worldSimulationPrompt(this.session.worldSimulationInputAt,requestUpdate?this.roleState?.begin():this.roleState?.task(),this.config);}
}
