import {parseFrontmatter} from './legacy-memory/insights.js';
import {clampSummary,planIndex} from './legacy-memory/index-page.js';
import {setMetadata} from './memory-state.mjs';
import {attributionPattern} from './message-snapshot.mjs';
import {memoryPagePattern} from './memory-access.mjs';
import path from 'node:path';

export function editIndex(text,pages){
  if(typeof text!=='string'||!text.trim()||text.length>100000)throw Error('索引需为非空 Markdown（最多100000字符）');
  const seen=new Set();
  for(const m of text.matchAll(/\]\(([^\s)]+)\)/g)){
    const name=m[1].replace(/^\.\//,'');
    if(!pages.has(name)&&!['SOUL.md','MEMORY.md','BOOTSTRAP.md','log.md'].includes(name))throw Error('索引只能链接本库现有页面');
    if(seen.has(name))throw Error('索引每页只保留一条路由');seen.add(name);
  }
  // Sections/order/prose are author-controlled; route summaries remain compiled.
  return text;
}
export function backfillSummaries(store,pages){
  for(const line of planIndex(store.dir).lines){
    const text=pages.get(line.target);
    if(!text||parseFrontmatter(text).summary!==undefined||!text.startsWith('---'))continue;
    const summary=/\s+[—–-]\s+(.+?)(?:\s+`salience:[^`]*`)?\s*$/.exec(line.current)?.[1]?.trim();
    if(summary)pages.set(line.target,setMetadata(text,{summary:JSON.stringify(clampSummary(summary))}));
  }
}
const content=text=>text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,'').replace(attributionPattern,'').trim();
export function semanticBody(op,pages){
  if(!Array.isArray(op.claims)||!op.claims.length||op.claims.length>40)throw Error('语义整理需要1至40条有原文依据的陈述');
  const allowed=new Set([op.page,...(op.sources??[])]),used=new Set();
  const paragraphs=op.claims.map(claim=>{
    if(!claim||Object.keys(claim).some(k=>!['text','evidence'].includes(k))||typeof claim.text!=='string'||!claim.text.trim()||claim.text.length>4000||/qq-attribution|qq_memory_state|qq_merged_into|<!--/i.test(claim.text)||!Array.isArray(claim.evidence)||!claim.evidence.length||claim.evidence.length>20)throw Error('语义陈述和原文依据格式无效');
    const refs=claim.evidence.map(e=>{
      if(!e||Object.keys(e).some(k=>!['page','quote'].includes(k))||!memoryPagePattern.test(e.page??'')||!allowed.has(e.page)||typeof e.quote!=='string'||!e.quote.trim()||!content(pages.get(e.page)).includes(e.quote))throw Error('语义整理引用必须来自参与整理页面的完整原文');
      used.add(e.page);return '['+e.page+']('+path.posix.relative(path.posix.dirname(op.page),e.page)+')';
    });
    return claim.text.trim()+'\n\n原文依据：'+[...new Set(refs)].join('、');
  });
  if([...allowed].some(page=>!used.has(page)))throw Error('每个合并页面都必须纳入原文核对，不能无依据丢弃');
  const result=paragraphs.join('\n\n');if(result.length>20000)throw Error('单次语义整理正文过长，请分批');
  return result;
}
