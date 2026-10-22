import {parseFrontmatter} from './legacy-memory/insights.js';
import {INDEX_SUMMARY_MAX} from './legacy-memory/index-page.js';
import {activePage,setMetadata} from './memory-state.mjs';

function recordedDay(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))return null;
  const time=Date.parse(value);
  return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value.slice(0,10)?value.slice(0,10):null;
}
// A routing label is not a fact rewrite. Use the complete existing short title,
// never truncate a factual sentence or manufacture a historical date.
export function repairMemoryMetadata(page,text){
  const pending=[],fields={};
  if(!activePage(text)||!/^---\r?\n/.test(text))return {text,fields,pending};
  const fm=parseFrontmatter(text);
  if((fm.summary??'').length>INDEX_SUMMARY_MAX){
    const title=(fm.title??'').trim();
    if(title&&title.length<=INDEX_SUMMARY_MAX&&!/[\r\n]/.test(title))fields.summary=title;
    else pending.push({page,field:'summary',reason:'缺少可直接复用的完整短标题，需按原文人工或语义核对'});
  }
  if(!Object.hasOwn(fm,'date')){
    let day=null;
    if(fm.source==='role-simulation'){
      if(page==='concepts/character-state.md'){
        const marker=text.match(/<!-- role-state -->\s*([\s\S]*?)\s*<!-- \/role-state -->/);
        try{day=recordedDay(JSON.parse(marker?.[1]??'null')?.at);}catch{}
      }else if(page.startsWith('concepts/character-history/')){
        const stamps=[...text.matchAll(/^## (\S+)\r?$/gm)].map(m=>recordedDay(m[1])).filter(Boolean).sort();
        day=stamps[0]??null;
      }
    }
    if(day)fields.date=day;
    else pending.push({page,field:'date',reason:'无可核实的原始生成日期，未使用当前日期替代'});
  }
  return {text:Object.keys(fields).length?setMetadata(text,fields):text,fields,pending};
}
