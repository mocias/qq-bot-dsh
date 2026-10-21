import fs from 'node:fs';
import {parseFrontmatter} from './legacy-memory/insights.js';
import {indexIssues} from './legacy-memory/index-page.js';

// Original CLI lint coverage, with the host's historical ISO log dates accepted.
export function lintMemory(store){
  const issues=indexIssues(store.dir,{includeNoSummary:false}).map(x=>({code:x.kind,page:x.target??'index.md',detail:x.detail}));
  const linked=[...fs.readFileSync(store.safe('index.md'),'utf8').matchAll(/\]\(([^)]+\.md)\)/g)].map(m=>m[1]).filter(p=>!p.startsWith('http'));
  for(const page of linked){
    let exists=false;try{exists=fs.existsSync(store.safe(page.replace(/^\.\//,'')));}catch{}
    if(!exists&&!issues.some(x=>x.code==='removed'&&x.page===page))issues.push({code:'removed',page,detail:'索引指向不存在或越界页面'});
  }
  const indexed=new Set(linked.map(p=>p.replace(/^\.\//,'')));
  for(const {name,text} of store.pages()){
    if(!indexed.has(name)&&!issues.some(x=>x.code==='missing'&&x.page===name))issues.push({code:'missing',page:name,detail:'页面未列入索引'});
    const fm=parseFrontmatter(text);
    for(const key of ['title','date','type','salience'])if(!(key in fm))issues.push({code:'missing-frontmatter',page:name,field:key,detail:'缺少 '+key});
    if(fm.salience&&!['1','2','3'].includes(fm.salience))issues.push({code:'invalid-salience',page:name,detail:'salience 必须为 1、2 或 3'});
  }
  fs.readFileSync(store.safe('log.md'),'utf8').split('\n').forEach((line,i)=>{
    if(line.startsWith('## ')&&!/^## \[\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}\.\d{3}Z)?\] /.test(line))issues.push({code:'malformed-log',page:'log.md',line:i+1,detail:line});
  });
  return {passed:issues.length===0,total:issues.length,issues};
}
