import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {listPagePaths,listPagesWithMeta,touchPages,today} from './legacy-memory/pages.js';
import {pageAttribution} from './message-snapshot.mjs';
import {activePage,pageState} from './memory-state.mjs';
import {activeIndexProjection} from './memory-index.mjs';

export const memoryPagePattern=/^(?:user|identity|skills|decisions|concepts|projects\/(?:active|archive))\/(?:[a-zA-Z0-9_\-\u3400-\u9fff]+\/)*[a-zA-Z0-9_\-\u3400-\u9fff]+\.md$/;
export const memoryDocuments=['SOUL.md','MEMORY.md','BOOTSTRAP.md','index.md','log.md'];
export const revisionOf=text=>createHash('sha256').update(text).digest('hex');
const integer=(value,fallback,min,max)=>{const n=value??fallback;if(!Number.isSafeInteger(n)||n<min||n>max)throw Error('记忆分页参数无效');return n;};
export function memoryFiles(store){
  store.validateTree();
  return [...memoryDocuments.filter(name=>fs.existsSync(store.safe(name))),...listPagePaths(store.dir).filter(name=>memoryPagePattern.test(name))].sort();
}
function read(store,page){
  if(typeof page!=='string'||!memoryDocuments.includes(page)&&!memoryPagePattern.test(page))throw Error('只允许读取当前聊天的记忆页面');
  const file=store.safe(page);return fs.existsSync(file)?fs.readFileSync(file,'utf8'):null;
}
export function readMemory(store,args={},{trackAccess=true}={}){
  if(Object.keys(args).some(k=>!['page','offset','limit','revision','inspect'].includes(k))||args.inspect!==undefined&&typeof args.inspect!=='boolean')throw Error('记忆读取参数无效');
  const page=args.page??'index.md',offset=integer(args.offset,0,0,Number.MAX_SAFE_INTEGER),limit=integer(args.limit,4000,1,12000);
  let text=read(store,page);const revision=revisionOf(text??'');
  if(args.revision!==undefined&&args.revision!==revision)throw Error('记忆页已改变，请从头重新读取');
  if(text===null)return {page,exists:false,revision,text:'',totalChars:0,nextOffset:null};
  if(trackAccess&&!args.inspect&&activePage(text))touchPages(store.dir,[page]);text=read(store,page);
  const end=Math.min(text.length,offset+limit);
  const result={page,exists:true,revision,text:text.slice(offset,end),offset,totalChars:text.length,nextOffset:end<text.length?end:null,
    ...pageState(text),subjects:pageAttribution(text),attributionStatus:pageAttribution(text).length?'source_recorded':'legacy_unverified',untrusted:true};
  // Bookkeeping follows the original core; revision describes what was read.
  result.revision=revisionOf(read(store,page));
  return result;
}
export function searchMemory(store,args={},{trackAccess=true}={}){
  if(Object.keys(args).some(k=>!['query','offset','limit','includeArchived'].includes(k))||typeof args.query!=='string'||!args.query.trim()||args.query.length>200)throw Error('请输入1至200字符的记忆关键词');
  if(args.includeArchived!==undefined&&typeof args.includeArchived!=='boolean')throw Error('归档筛选参数无效');
  const offset=integer(args.offset,0,0,Number.MAX_SAFE_INTEGER),limit=integer(args.limit,10,1,30),query=args.query.trim().toLowerCase();
  const results=[];
  for(const page of memoryFiles(store)){
    const original=read(store,page),text=page==='index.md'&&!args.includeArchived?activeIndexProjection(original,store.pages(),{preserveOffsets:true}):original,at=text.toLowerCase().indexOf(query);
    if(!args.includeArchived&&!activePage(text))continue;
    if(at<0)continue;
    results.push({page,...pageState(text),matchOffset:at,excerpt:text.slice(Math.max(0,at-100),at+300),totalChars:text.length,revision:revisionOf(original)});
  }
  // Search scans the full page, not the startup excerpt. Only returned hits count as accessed.
  const hits=results.slice(offset,offset+limit);if(trackAccess)touchPages(store.dir,hits.filter(x=>x.state==='active').map(x=>x.page));
  for(const hit of hits)hit.revision=revisionOf(read(store,hit.page));
  return {query:args.query,results:hits,total:results.length,nextOffset:offset+limit<results.length?offset+limit:null,untrusted:true};
}

// Original memory query semantics, scoped to one chat. Query does not touch
// last_access: paging a stale list must not remove earlier hits from that list.
export function queryMemory(store,args={}){
  if(Object.keys(args).some(k=>!['query','tags','type','salience','hot','stale','offset','limit','includeArchived'].includes(k)))throw Error('记忆筛选参数无效');
  if(args.query!==undefined&&(typeof args.query!=='string'||args.query.length>200))throw Error('查询文本最多200字符');
  if(args.tags!==undefined&&(!Array.isArray(args.tags)||args.tags.length>20||args.tags.some(t=>typeof t!=='string'||!t.replace(/^#/,'').trim()||t.length>100)))throw Error('记忆标签格式无效');
  if(args.type!==undefined&&(typeof args.type!=='string'||!args.type.trim()||args.type.length>100))throw Error('记忆类型无效');
  if(args.salience!==undefined&&![1,2,3].includes(args.salience))throw Error('重要程度只能为1、2、3');
  for(const k of ['hot','stale','includeArchived'])if(args[k]!==undefined&&typeof args[k]!=='boolean')throw Error('记忆筛选开关无效');
  const offset=integer(args.offset,0,0,Number.MAX_SAFE_INTEGER),limit=integer(args.limit,10,1,30);
  const tags=(args.tags??[]).map(t=>t.replace(/^#/,'').trim()),query=(args.query??'').trim().toLowerCase();
  store.validateTree();
  const results=[],now=Date.parse(today()+'T00:00:00Z');
  for(const meta of listPagesWithMeta(store.dir).filter(p=>memoryPagePattern.test(p.path)).sort((a,b)=>a.path.localeCompare(b.path))){
    // The original metadata reader has lastAccess but not daysSinceAccess.
    const stamp=/^\d{4}-\d{2}-\d{2}$/.test(meta.lastAccess??'')?Date.parse(meta.lastAccess+'T00:00:00Z'):NaN;
    const daysSinceAccess=Number.isFinite(stamp)?Math.floor((now-stamp)/86400000):null;
    if(!tags.every(t=>meta.tags.includes(t))||args.type!==undefined&&args.type!==meta.type||args.salience!==undefined&&args.salience!==meta.salience||args.hot&&meta.salience!==1||args.stale&&daysSinceAccess!==null&&daysSinceAccess<=90)continue;
    const text=read(store,meta.path),base={...meta,page:meta.path,...pageState(text),daysSinceAccess,revision:revisionOf(text),totalChars:text.length};
    if(!args.includeArchived&&!activePage(text))continue;
    if(!query){results.push(base);continue;}
    let at=0;
    for(const [index,line] of text.split('\n').entries()){
      const match=line.toLowerCase().indexOf(query);
      if(match>=0)results.push({...base,line:index+1,matchOffset:at+match,excerpt:line.slice(Math.max(0,match-100),match+300)});
      at+=line.length+1;
    }
  }
  return {results:results.slice(offset,offset+limit),total:results.length,nextOffset:offset+limit<results.length?offset+limit:null,untrusted:true};
}
