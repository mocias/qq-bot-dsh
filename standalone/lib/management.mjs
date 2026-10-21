import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {MemoryStore} from './memory.mjs';
import {writeJson} from './config.mjs';
import {snapshotHistory} from './memory-history.mjs';
const hash=text=>createHash('sha256').update(text).digest('hex');
export class Management {
  constructor(runtime){this.runtime=runtime;}
  store(key,personaId){return new MemoryStore(this.runtime,key,personaId);}
  inspect(key,personaId){
    const store=this.store(key,personaId),file=store.safe('SOUL.md'),persona=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
    return {...store.inspect(),pages:store.pages().map(p=>({...p,revision:hash(p.text)})),emptyRevision:hash(''),persona,personaRevision:hash(persona)};
  }
  savePersona({key,personaId,text,revision}){
    if(typeof text!=='string'||text.length>20000)throw Error('人设最多 20000 字');
    const store=this.store(key,personaId),file=store.safe('SOUL.md'),old=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
    if(hash(old)!==revision)throw Error('人设已被修改，请重新加载');
    snapshotHistory(store);
    writeJson(store.safe('.runtime/persona-backups/'+randomUUID()+'.json'),{at:Date.now(),text:old});
    const temp=file+'.tmp';fs.writeFileSync(temp,text);fs.renameSync(temp,file);
    snapshotHistory(store);
    return this.inspect(key,personaId);
  }
  savePage({key,personaId,page,text,revision,forget=false}){
    const store=this.store(key,personaId),old=store.pages().find(x=>x.name===page)?.text??'';
    if(hash(old)!==revision)throw Error('记忆页已被修改，请重新加载');
    const id='panel-'+randomUUID();store.record({id,kind:'owner-memory-edit',at:Date.now(),page});
    store.commit([{action:forget?'forget':'write',page,text:text??'',reason:'本机管理面板修改',evidence:[id]}],{id,evidenceIds:[id],summary:forget?'管理者移除记忆页':'管理者修改记忆页'});
    return this.inspect(key,personaId);
  }
  pageRevision(text){return hash(text??'');}
  personaContext(key){const store=this.store(key),file=store.safe('SOUL.md');return fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';}
}
