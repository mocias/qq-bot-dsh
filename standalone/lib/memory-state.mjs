import {parseFrontmatter} from './legacy-memory/insights.js';

// Reserved host metadata. Archive keeps the original path and full body so
// existing links, attribution and source records remain recoverable.
export function pageState(text){
  const fm=parseFrontmatter(text);
  return {state:['archived','merged'].includes(fm.qq_memory_state)?fm.qq_memory_state:'active',mergedInto:fm.qq_merged_into??null};
}
export const activePage=text=>pageState(text).state==='active';
export function setMetadata(text,values){
  const match=text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  let lines=match?match[1].split(/\r?\n/):[];
  for(const [key,value] of Object.entries(values)){
    lines=lines.filter(line=>!line.startsWith(key+':'));
    if(value!==null)lines.push(key+': '+value);
  }
  return '---\n'+lines.join('\n')+'\n---\n'+(match?text.slice(match[0].length):'\n'+text);
}
