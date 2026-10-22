import fs from 'node:fs';
import path from 'node:path';
import {personaIdentity} from './persona-cards.mjs';
import {memoryPagePattern} from './memory-access.mjs';
import {activePage} from './memory-state.mjs';
import {activeIndexProjection} from './memory-index.mjs';

// Pure inspection: do not construct MemoryStore (it scaffolds and recovers),
// touch access dates, create receipts or call the model.
export function memoryBudgetStats(runtime,key,personaId,{native=true}={}){
  const identity=personaIdentity(runtime,key,personaId),root=path.join(runtime,'memories',identity.memoryScope);
  const read=name=>{
    let file=runtime;
    for(const part of path.relative(runtime,path.join(root,name)).split(path.sep)){
      file=path.join(file,part);if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('记忆统计不支持链接路径');
    }
    return fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
  };
  const pages=[];
  const walk=relative=>{
    const dir=path.join(root,relative);if(!fs.existsSync(dir))return;
    if(fs.lstatSync(dir).isSymbolicLink())throw Error('记忆统计不支持链接路径');
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const name=relative+'/'+entry.name;if(entry.isSymbolicLink())throw Error('记忆统计不支持链接路径');
      if(entry.isDirectory())walk(name);else if(entry.isFile()&&memoryPagePattern.test(name))pages.push({name,text:read(name)});
    }
  };
  read('MEMORY.md'); // Check ancestors before enumerating pages.
  for(const dir of ['user','identity','skills','decisions','concepts','projects'])walk(dir);
  const active=pages.filter(p=>activePage(p.text));
  const bootFiles=(native?['MEMORY.md','index.md']:['SOUL.md','MEMORY.md','index.md']).map(name=>{
    const raw=read(name),text=name==='index.md'?activeIndexProjection(raw,pages):raw;return {name,chars:text.length};
  });
  return {key,personaId:identity.personaId,personaName:identity.personaName,exists:fs.existsSync(root),checkedAt:new Date().toISOString(),
    boot:{chars:bootFiles.reduce((n,f)=>n+f.chars,0),files:bootFiles,personaOutsideBudget:native?read('SOUL.md').length:0},
    pages:{chars:active.reduce((n,p)=>n+p.text.length,0),count:active.length,excluded:pages.length-active.length,
      candidateChars:active.reduce((n,p)=>n+Math.min(3000,p.text.length),0),perPageCap:3000},
    unit:'JavaScript string.length，与实际预算截取一致；不是 token 数'};
}
