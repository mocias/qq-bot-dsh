import fs from 'node:fs';
import path from 'node:path';

// Deliberately accept fixed event names and scalar counters, never message bodies,
// credentials, query strings or arbitrary upstream error text.
export class SystemLog {
  constructor(runtime){this.file=path.join(runtime,'logs','system.jsonl');}
  record(event,{level='info',component='system',operation='',count,durationMs,chat}={}){
    if(!/^[a-z][a-z0-9_.-]{0,79}$/.test(event))return;
    const entry={time:new Date().toISOString(),level:['info','warn','error'].includes(level)?level:'info',component:/^[a-z-]{1,30}$/.test(component)?component:'system',event};
    if(/^\/api\/[a-z/-]{1,80}$/.test(operation))entry.operation=operation;
    if(Number.isFinite(count))entry.count=count;
    if(Number.isFinite(durationMs))entry.durationMs=durationMs;
    if(typeof chat==='string'&&/^\d{5,20}\/(private|group)\/\d{5,20}$/.test(chat))entry.chat=chat;
    try{
      fs.mkdirSync(path.dirname(this.file),{recursive:true});
      if(fs.existsSync(this.file)&&fs.statSync(this.file).size>1024*1024){
        for(let i=3;i>=1;i--){const source=i===1?this.file:this.file+'.'+(i-1),target=this.file+'.'+i;if(fs.existsSync(source)){if(fs.existsSync(target))fs.unlinkSync(target);fs.renameSync(source,target);}}
      }
      fs.appendFileSync(this.file,JSON.stringify(entry)+'\n');
    }catch{this.failed=true;} // Logging must not break message handling.
  }
  read({level='',component='',limit=300}={}){
    const entries=[];
    for(const file of [3,2,1,0].map(i=>this.file+(i?'.'+i:''))){
      if(!fs.existsSync(file))continue;
      for(const line of fs.readFileSync(file,'utf8').split('\n'))try{const row=JSON.parse(line);if((!level||row.level===level)&&(!component||row.component===component))entries.push(row);}catch{}
    }
    return {entries:entries.slice(-Math.min(1000,Math.max(1,Number(limit)||300))),writeFailed:!!this.failed};
  }
}
