import {promptText} from '../../native-dsh-plugin/lib/prompt-text.mjs';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {revisionOf} from './memory-access.mjs';
import {activePage} from './memory-state.mjs';

export const ROLE_STATE_PAGE='concepts/character-state.md';
const fields=['activity','mood','attention','progress','nextIntent'];
const labels={activity:'正在做什么',mood:'情绪',attention:'注意力',progress:'事情进展',nextIntent:'下一步打算'};
const read=(store,page)=>fs.existsSync(store.safe(page))?fs.readFileSync(store.safe(page),'utf8'):'';
export function currentRoleState(store){
  const file=store.safe('.runtime/role-state.json');
  return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
}
export class RoleState {
  constructor(store,session,{now=Date.now,persist=()=>{},config={}}={}){Object.assign(this,{store,session,now,persist,config});}
  task(){
    const current=currentRoleState(this.store);
    if(current&&this.session.roleSimulation?.id===current.simulationId){delete this.session.roleSimulation;this.persist();}
    return this.session.roleSimulation?{...this.session.roleSimulation,previous:current}:null;
  }
  begin(){
    if(!this.task()){this.session.roleSimulation={id:randomUUID(),at:new Date(this.now()).toISOString()};this.persist();}
    return this.task();
  }
  required(){const task=this.task();return task?{reason:'role-state-required',messages:[],simulation:task,
    instruction:promptText(this.config,'simulation.required.1')}:null;}
  update(args){
    if(!args||Object.keys(args).some(k=>!['simulationId',...fields].includes(k))||typeof args.simulationId!=='string'||fields.some(k=>typeof args[k]!=='string'||!args[k].trim()||args[k].length>600))throw Error('请提供本次推演编号和五项非空角色状态，每项不超过600字');
    const current=currentRoleState(this.store);
    if(current?.simulationId===args.simulationId){
      if(fields.some(k=>current[k]!==args[k].trim()))throw Error('已保存的推演不能用同一编号改写');
      return {saved:true,duplicate:true,state:current,page:ROLE_STATE_PAGE};
    }
    const task=this.task();if(!task||task.id!==args.simulationId)throw Error('推演编号已失效或不属于当前人格');
    const state={simulationId:task.id,at:task.at,savedAt:new Date(this.now()).toISOString(),source:'role-simulation',personaId:this.store.personaId,
      ...Object.fromEntries(fields.map(k=>[k,args[k].trim()]))};
    let journal=current?.journal??`concepts/character-history/${task.at.slice(0,10)}-${task.id}.md`;
    const entry=`\n## ${task.at}\n\n来源：角色推演；作为本人格正式经历。编号：${task.id}\n\n`+fields.map(k=>`- ${labels[k]}：${state[k]}`).join('\n')+'\n';
    let oldJournal=read(this.store,journal);
    if(oldJournal.length+entry.length>17000||!journal.includes(task.at.slice(0,10))||oldJournal&&!activePage(oldJournal)){journal=`concepts/character-history/${task.at.slice(0,10)}-${task.id}.md`;oldJournal='';}
    state.journal=journal;
    const text=`---\ntitle: 当前人格状态\ntype: concepts\nsummary: 当前人格正式经历与状态，每次角色推演更新\nsalience: 1\nsource: role-simulation\n---\n\n# 当前人格状态\n\n以下为本人格的正式角色经历与状态，来源为角色推演；不证明群友经历或现实工具动作。\n${entry}\n<!-- role-state -->\n${JSON.stringify(state)}\n<!-- /role-state -->\n`;
    this.store.commit([{page:ROLE_STATE_PAGE,action:'write',text,reason:'保存本次人格状态',evidence:[task.id],expectedRevision:revisionOf(read(this.store,ROLE_STATE_PAGE))},
      {page:journal,action:'write',text:(oldJournal||`---\ntitle: 人格经历 ${task.at.slice(0,10)}\ntype: concepts\nsummary: 角色推演形成的本人格正式经历，按时间追加\nsalience: 2\nsource: role-simulation\n---\n\n# 人格经历\n`)+entry,reason:'追加本次人格经历',evidence:[task.id],expectedRevision:revisionOf(oldJournal)}],
      {id:'role-simulation-'+task.id,evidenceIds:[task.id],roleStateRecord:state,summary:'角色推演：更新人格状态与正式经历'});
    delete this.session.roleSimulation;this.persist();
    return {saved:true,state,page:ROLE_STATE_PAGE,journal};
  }
}
