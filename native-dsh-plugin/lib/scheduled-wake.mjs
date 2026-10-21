import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export function readWakeJson(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
export function writeWakeJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600,flag:'wx'});fs.renameSync(tmp,file);}
export const wakePaths=root=>({registry:path.join(root,'scheduled-wake-routes.private.json'),queue:path.join(root,'scheduled-wakes')});

// A recurring batch may be regrouped after a partial scheduler commit. Dedup
// each occurrence, rather than the entire batch or its changing message id.
function occurrences(text){
  const batch=text.match(/^reminders_json: (.+)$/m);
  if(text.startsWith('[SCHEDULE REMINDER BATCH]')&&batch){
    const rows=JSON.parse(batch[1]);
    if(!Array.isArray(rows)||!rows.length||rows.length>1000)throw Error('定时唤醒批次无效');
    return rows.map(row=>{
      if(typeof row.schedule_id!=='string'||typeof row.occurrence_at!=='string'||typeof row.reminder_prompt!=='string')throw Error('定时唤醒条目无效');
      return {identity:JSON.stringify([row.schedule_id,row.occurrence_at]),text:'[SCHEDULE REMINDER]\nschedule_id_json: '+JSON.stringify(row.schedule_id)+'\noccurrence_at: '+row.occurrence_at+'\nreminder_prompt_json: '+JSON.stringify(row.reminder_prompt)};
    });
  }
  const id=text.match(/^schedule_id_json: (.+)$/m),at=text.match(/^occurrence_at: (.+)$/m);
  return [{identity:id&&at?JSON.stringify([JSON.parse(id[1]),at[1]]):text,text}];
}

// DSH schedule calls resolveAgent(...), then synchronous followup(...). Persist
// the reminder before acknowledging it, so QQ can bind tools before generation.
// Only typed schedule events for registered QQ sessions are diverted.
export class ScheduleWakeRouter{
  constructor(ctx,root){
    this.ctx=ctx;this.root=root;this.hooks=new Map();if(!root)return;
    this.paths=wakePaths(root);const controller=ctx.sessionController;
    if(controller?.resolveAgent){
      const original=controller.resolveAgent,router=this;
      this.original=original;this.wrapped=async function(...args){const result=await original.apply(this,args);if(result?.agent)router.attach(result.agent);return result;};
      controller.resolveAgent=this.wrapped;
    }
    this.refresh();
  }
  registry(){return readWakeJson(this.paths.registry,{sessions:{}});}
  refresh(){if(!this.root)return;for(const id of Object.keys(this.registry().sessions))this.attach(this.ctx.agents.get(id));}
  attach(agent){
    if(!agent||!this.root||this.hooks.has(agent)||!this.registry().sessions[agent.session.id])return;
    const original=agent.followup,router=this;
    if(typeof original!=='function')throw Error('DSH定时唤醒缺少followup接口');
    const wrapped=function(message){
      if(message?.source?.kind!=='schedule'&&!(message?.source?.kind==='plugin'&&message.source.plugin==='schedule'))return original.call(this,message);
      const registry=router.registry(),route=registry.sessions[agent.session.id];
      // Keep old QQ sessions intercepted even after they have been retired.
      if(!route)return;
      const text=(message.content??[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');
      if(!text||text.length>120000)throw Error('定时唤醒内容无效');
      for(const occurrence of occurrences(text)){
        const id=createHash('sha256').update(agent.session.id+'\0'+occurrence.identity).digest('hex'),file=path.join(router.paths.queue,id+'.json');
        if(fs.existsSync(file))continue;
        writeWakeJson(file,{id,sessionId:agent.session.id,key:route.key,personaId:route.personaId,epoch:registry.epoch,text:occurrence.text,at:Date.now(),state:route.enabled?'pending':'skipped'});
      }
    };
    agent.followup=wrapped;this.hooks.set(agent,{original,wrapped});
  }
  dispose(){for(const [agent,{original,wrapped}]of this.hooks)if(agent.followup===wrapped)agent.followup=original;this.hooks.clear();if(this.wrapped&&this.ctx.sessionController?.resolveAgent===this.wrapped)this.ctx.sessionController.resolveAgent=this.original;}
}
