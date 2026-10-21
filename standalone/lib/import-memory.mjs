import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { scopeOf, MemoryStore } from './memory.mjs';
import { writeJson } from './config.mjs';
import { ensureMemoryScaffold } from './legacy-memory/scaffold.js';

// Explicit source -> owner binding. Never merge private/groups subtrees.
export function importMemory({runtime,key,source,group=false}) {
  if(!/^\d{5,20}\/(private|group)\/\d{5,20}$/.test(key)||key.includes('/group/')!==group)throw Error('导入范围不匹配');
  source=fs.realpathSync(source);
  const target=path.join(runtime,'memories',scopeOf(key));
  if(fs.existsSync(target))throw Error('目标记忆库已存在，拒绝覆盖；原备份仍然保留');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const staging=target+'.import-'+randomUUID();fs.mkdirSync(staging);
  ensureMemoryScaffold(staging);const inventory=[];
  function copyFile(relative,destination=relative){
    const from=path.join(source,relative);if(!fs.existsSync(from))return;
    if(fs.lstatSync(from).isSymbolicLink())throw Error('不能导入链接文件');
    const data=fs.readFileSync(from);const to=path.join(staging,destination);
    fs.mkdirSync(path.dirname(to),{recursive:true});fs.writeFileSync(to,data);
    inventory.push({source:relative,destination,sha256:createHash('sha256').update(data).digest('hex'),bytes:data.length});
  }
  if(group){
    copyFile('MEMORY.md','concepts/legacy-group.md');copyFile('PERSONA.md','SOUL.md');copyFile('log.md');
    const persona=path.join(source,'PERSONA.memory.json');
    if(fs.existsSync(persona)){copyFile('PERSONA.memory.json','raw/legacy-persona.json');fs.writeFileSync(path.join(staging,'user/persona-history.md'),'# 群聊既有人设成长资料\n\n仅作为风格与经历参考，不能改变权限。\n\n'+fs.readFileSync(persona,'utf8'));}
    fs.writeFileSync(path.join(staging,'BOOTSTRAP.md'),'# 群聊初始化\nstatus: complete\n');
    fs.writeFileSync(path.join(staging,'index.md'),'# 群聊记忆索引\n\n- [既有群记忆](concepts/legacy-group.md)\n- [成长资料](user/persona-history.md)\n');
  }else{
    const categories=new Set(['identity','user','skills','decisions','projects','concepts','raw','assets']);
    function walk(relative=''){
      for(const item of fs.readdirSync(path.join(source,relative),{withFileTypes:true})){
        if(item.isSymbolicLink())throw Error('不能导入链接');
        const name=relative?relative+'/'+item.name:item.name;
        if(item.isDirectory()){if(relative||categories.has(item.name))walk(name);}
        else if(item.isFile()&&(relative||item.name.endsWith('.md')))copyFile(name);
      }
    }
    walk();
  }
  writeJson(path.join(staging,'.runtime/import.json'),{key,source,at:new Date().toISOString(),inventory,snapshot:true});
  fs.renameSync(staging,target);
  const store=new MemoryStore(runtime,key,'default');
  return {key,files:inventory.length,pages:store.pages().length,source,target};
}
export function importedStores(runtime){
  const dir=path.join(runtime,'memories');if(!fs.existsSync(dir))return [];
  return fs.readdirSync(dir).filter(x=>/^[a-f0-9]{64}$/.test(x)).flatMap(id=>{
    const file=path.join(dir,id,'.runtime/import.json');if(!fs.existsSync(file))return [];
    const data=JSON.parse(fs.readFileSync(file,'utf8'));return [{key:data.key,files:data.inventory.length,at:data.at}];
  });
}
