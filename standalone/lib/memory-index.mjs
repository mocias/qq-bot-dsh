import {parseFrontmatter} from './legacy-memory/insights.js';
import path from 'node:path';
import {renderIndexLine,declaredSummary,summaryBudget} from './legacy-memory/index-page.js';
import {activePage} from './memory-state.mjs';

// Preserve headings, prose, partitions and existing route order. Only the
// declared metadata for a known page is refreshed. New routes have an explicit
// stable placement; broken routes stay visible for diagnosis rather than vanish.
export function compileMemoryIndex(previous,pages){
  const seen=new Set();
  const lineFor=name=>{
    const text=pages.get(name),fm=parseFrontmatter(text),title=fm.title||path.posix.basename(name,'.md');
    const salience=[1,2,3].includes(Number(fm.salience))?Number(fm.salience):undefined;
    return renderIndexLine({target:name,title,salience,summary:declaredSummary(fm,summaryBudget(name,title))});
  };
  const lines=(previous||'# 长期记忆索引\n').split('\n').map(line=>{
    const m=line.match(/^(\s*[-*]\s+)\[[^\]]*\]\((?:\.\/)?([^\s)]+\.md)\)/);
    if(!m||!pages.has(m[2]))return line;
    seen.add(m[2]);return lineFor(m[2]).replace(/^[-*]\s+/,m[1]);
  });
  const added=[...pages.keys()].filter(name=>!seen.has(name)).sort();
  if(added.length){
    let section=lines.findIndex(line=>/^## 新记忆\s*$/.test(line));
    if(section<0){lines.push('','## 新记忆','');section=lines.length-1;}
    let end=section+1;
    while(end<lines.length&&!/^##\s/.test(lines[end]))end++;
    lines.splice(end,0,...added.map(lineFor),'');
  }
  return lines.join('\n');
}

export function activeIndexProjection(index,pages,{preserveOffsets=false}={}){
  const inactive=new Set(pages.filter(p=>!activePage(p.text)).map(p=>p.name));
  return index.split('\n').flatMap(line=>{
    const hidden=[...line.matchAll(/\]\((?:\.\/)?([^\s)]+\.md)\)/g)].some(m=>inactive.has(m[1]));
    return hidden?(preserveOffsets?[' '.repeat(line.length)]:[]):[line];
  }).join('\n');
}
