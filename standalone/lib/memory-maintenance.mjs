import fs from 'node:fs';
import {lintMemory} from './memory-lint.mjs';
import {editIndex,backfillSummaries,semanticBody} from './memory-edit.mjs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {memoryPagePattern,revisionOf} from './memory-access.mjs';
import {parseFrontmatter} from './legacy-memory/insights.js';
import {runCheckup} from './legacy-memory/checkup.js';
import {suggestLinks,buildMemoryGraph} from './legacy-memory/graph.js';
import {pageAttribution,attributionPattern} from './message-snapshot.mjs';
import {activePage,pageState,setMetadata} from './memory-state.mjs';
import {compileMemoryIndex} from './memory-index.mjs';
import {planIndex,clampSummary} from './legacy-memory/index-page.js';
import {repairMemoryMetadata} from './memory-format.mjs';

export const MAINTENANCE_GUIDE='记忆维护：先 qq_memory_diagnose 查版本、严格校验、冷页与重复候选，再 qq_memory_read inspect:true 阅读全文。qq_memory_maintain {operations:[{action:"downgrade|archive|restore|merge|consolidate|sync_index|sync_summaries|edit_index|repair_metadata",page:"页路径",reason:"判断依据"}],expectedRevision:"诊断版本",preview:true} 预览；正常回合 preview:false 保存，后台仅预览后用 qq_memory_digest.maintenance 一次提交。按原版由模型判断降级和归档：温记忆超过180天未访问建议降为冷，冷记忆超过90天建议归档，热记忆通常保留；这些是建议，不是代码时间门槛。downgrade 将1降到2、2降到3；archive 可归档过时或不再重要的活动页，须说明具体依据。代码仍保护聊天隔离、整库版本、人物归属和原文。归档原路径保留，可 includeArchived:true 查阅或 restore。merge 指定目标 page、sources；不传 claims 时无损拼接；传 claims:[{text:"精简后的陈述",evidence:[{page:"参与合并的页",quote:"逐字原文"}]} 可语义精简，consolidate 同格式整理单页。每页必须有引用，保留时间条件、否定、冲突与转述身份，不能把转述升级为本人确认或捏造新事实。原文匹配不能证明改写语义正确，模型须逐项核对。修订保留所有旧全文。edit_index 传 index 完整Markdown，可调整分区、顺序和移除失效路由；行摘要仍从页面派生，漏列页会补入新记忆分区。sync_summaries 从现有索引摘要回填缺失的 frontmatter summary，sync_index 同步路由。repair_metadata 只按已有完整短标题与系统推演时间修复 summary/date，正文、人物来源及经历不变；不确定项保留待办。最终 digest 即使 updates 为空也检查并修复这类格式，结果见 formatRepair。新增事实仍经 qq_memory_update 的当前消息来源校验。';
const readIndex=store=>fs.readFileSync(store.safe('index.md'),'utf8');
export function maintenanceRevision(store){
  return revisionOf(JSON.stringify([store.key,readIndex(store),store.pages().map(p=>[p.name,p.text])]));
}
function ageOf(text,now=Date.now()){
  const date=parseFrontmatter(text).last_access;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date??''))return null;
  const time=Date.parse(date+'T00:00:00Z');
  if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==date)return null;
  return Math.floor((Date.parse(new Date(now).toISOString().slice(0,10)+'T00:00:00Z')-time)/86400000);
}
const body=text=>text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,'').replace(attributionPattern,'').trim();
function owner(name,text){
  const q=name.startsWith('user/')?name.match(/^user\/(\d{5,20})(?:\.md|\/)/)?.[1]:null;
  const attrs=pageAttribution(text);
  if(name.startsWith('user/')&&(!q||!attrs.length||attrs.some(a=>a.qq!==q)))throw Error('人物页归属未经核实，不能合并');
  return JSON.stringify([q??null,[...new Set(attrs.map(a=>a.qq))].sort()]);
}
export function diagnoseMemory(store,args={}){
  if(Object.keys(args).some(k=>!['offset','limit'].includes(k)))throw Error('诊断参数无效');
  const offset=args.offset??0,limit=args.limit??20;
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('诊断分页无效');
  store.recover();store.validateTree();
  const pages=store.pages(),duplicates=new Map();
  const rows=pages.map(({name,text})=>{
    const fm=parseFrontmatter(text),days=ageOf(text),status=pageState(text);
    let signature;try{signature=owner(name,text);}catch{signature=null;}
    if(status.state==='active'&&signature){
      const hash=revisionOf(signature+'\n'+body(text));
      duplicates.set(hash,[...(duplicates.get(hash)??[]),name]);
    }
    return {page:name,revision:revisionOf(text),...status,title:fm.title??null,type:fm.type??null,summaryDeclared:!!fm.summary,salience:Number(fm.salience)||null,daysSinceAccess:days,totalChars:text.length,
      subjects:pageAttribution(text),downgrade:status.state==='active'&&Number(fm.salience)===2&&days!==null&&days>180,
      archive:status.state==='active'&&Number(fm.salience)===3&&days!==null&&days>90};
  });
  const checkup=runCheckup(store.dir);delete checkup.store;
  checkup.actions=checkup.actions.map(text=>text.replace(/`dsh-memory index --write`/g,'qq_memory_maintain 的 sync_index').replace(/`dsh-memory graph --suggest`/g,'本次 linkSuggestions').replace(/lint 会报/g,'诊断会报告'));
  checkup.integrity.checks=checkup.integrity.checks.map(c=>({...c,detail:c.detail.replace(/index --write/g,'sync_index')}));
  const strict=lintMemory(store);
  const indexPlan=planIndex(store.dir),indexDiagnostics={};
  for(const [name,list] of Object.entries({missingRoutes:indexPlan.missing,brokenRoutes:indexPlan.removed,drift:indexPlan.lines.filter(l=>l.changed).map(l=>({page:l.target,section:l.section,current:l.current,next:l.next}))})){
    indexDiagnostics[name]={items:list.slice(offset,offset+limit),total:list.length,nextOffset:offset+limit<list.length?offset+limit:null};
  }
  return {revision:maintenanceRevision(store),checkup,strict:{passed:strict.passed,total:strict.total,issues:strict.issues.slice(offset,offset+limit),nextOffset:offset+limit<strict.total?offset+limit:null},pages:rows.slice(offset,offset+limit),total:rows.length,
    indexDiagnostics,
    nextOffset:offset+limit<rows.length?offset+limit:null,
    exactDuplicateGroups:[...duplicates.values()].filter(group=>group.length>1).filter(group=>group.some(p=>rows.slice(offset,offset+limit).some(r=>r.page===p))),
    linkSuggestions:suggestLinks(buildMemoryGraph(store.dir)).filter(x=>rows.slice(offset,offset+limit).some(r=>r.page===x.page)),
    indexNeedsSync:compileMemoryIndex(readIndex(store),new Map(pages.map(p=>[p.name,p.text])))!==readIndex(store),
    states:{active:rows.filter(r=>r.state==='active').length,archived:rows.filter(r=>r.state==='archived').length,merged:rows.filter(r=>r.state==='merged').length},
    note:'只读诊断，不更新访问时间；strict 是严格校验，与原健康分数分开。downgrade/archive 是满足时间建议的候选，不是硬性执行门槛。原核心统计包含归档页。结构检查不能证明事实真实，重复候选需核对全文及人物归属。',untrusted:true};
}

// Pure plan: no writes until the caller journals the entire result. The token
// covers every page and the index, including backlinks outside the chosen pages.
export function planMaintenance(store,request,pages=new Map(store.pages().map(p=>[p.name,p.text]))){
  if(!request||Object.keys(request).some(k=>!['operations','expectedRevision'].includes(k))||!Array.isArray(request.operations)||!request.operations.length||request.operations.length>12)throw Error('维护操作格式无效');
  if(request.expectedRevision!==maintenanceRevision(store))throw Error('记忆库版本已改变，请重新诊断和预览');
  const original=new Map(pages),changes=[],touched=new Set();
  let index=readIndex(store);
  const requirePage=name=>{if(typeof name!=='string'||!memoryPagePattern.test(name)||!pages.has(name))throw Error('维护页面不在当前记忆库');return pages.get(name);};
  for(const op of request.operations){
    if(!op||Object.keys(op).some(k=>!['action','page','sources','reason','claims','index'].includes(k))||!['downgrade','archive','restore','merge','consolidate','sync_index','sync_summaries','edit_index','repair_metadata'].includes(op.action)||typeof op.reason!=='string'||!op.reason.trim()||op.reason.length>400)throw Error('维护操作需要有效类型及依据');
    if(op.claims!==undefined&&!['merge','consolidate'].includes(op.action))throw Error('只有语义整理接受 claims');
    if(op.index!==undefined&&op.action!=='edit_index')throw Error('只有编辑索引接受 index');
    if(['sync_index','sync_summaries','edit_index'].includes(op.action)){
      if(op.page!==undefined||op.sources!==undefined)throw Error('同步索引不接受页面参数');
      if(op.action==='edit_index')index=editIndex(op.index,pages);
      if(op.action==='sync_summaries')backfillSummaries(store,pages);
      changes.push({...op});continue;
    }
    if(op.action!=='merge'&&op.sources!==undefined)throw Error('仅合并接受 sources');
    let text=requirePage(op.page);const status=pageState(text),days=ageOf(text),fm=parseFrontmatter(text);
    if(touched.has(op.page))throw Error('同一批维护不能重复操作同一页');
    touched.add(op.page);
    if(store.key.includes('/group/')&&op.page.startsWith('identity/'))throw Error('群聊不能修改基础身份');
    if(op.action==='restore'){
      if(status.state==='active')throw Error('该页未归档或合并');
      pages.set(op.page,setMetadata(text,{qq_memory_state:null,qq_merged_into:null}));
    }else{
      if(status.state!=='active')throw Error('请先恢复已归档或合并页面');
      if(op.action==='repair_metadata'){
        const repaired=repairMemoryMetadata(op.page,text);
        pages.set(op.page,repaired.text);
        changes.push({...op,fields:Object.keys(repaired.fields),pending:repaired.pending});continue;
      }else if(op.action==='downgrade'){
        if(![1,2].includes(Number(fm.salience)))throw Error('仅可将热记忆降为温、温记忆降为冷');
        pages.set(op.page,setMetadata(text,{salience:Number(fm.salience)+1}));
      }else if(op.action==='archive'){
        pages.set(op.page,setMetadata(text,{qq_memory_state:'archived'}));
      }else if(['merge','consolidate'].includes(op.action)){
        const semantic=op.claims!==undefined?semanticBody(op,pages):null;
        if(op.action==='consolidate'&&!semantic)throw Error('单页语义整理必须提供 claims');
        const sources=op.sources??[];
        if(!Array.isArray(sources)||(op.action==='merge'&&!sources.length)||sources.length>10||new Set(sources).size!==sources.length)throw Error('合并需要不重复的来源页面');
        const signature=owner(op.page,text),attrs=[...pageAttribution(text)],metadata=[fm];
        let combined=text.replace(attributionPattern,'').trimEnd();const bodies=new Set([body(text)]);
        for(const source of sources){
          const content=requirePage(source);
          if(touched.has(source)||!activePage(content)||store.key.includes('/group/')&&source.startsWith('identity/'))throw Error('合并来源不可重复或使用已归档页面');
          if(owner(source,content)!==signature)throw Error('不能合并不同人物QQ或不同人物归属的记忆');
          touched.add(source);
          // Lossless fallback; evidence-backed semantic text is applied below.
          if(!bodies.has(body(content))){
            const rebased=body(content).replace(/(\[[^\]\n]*\]\()([^\s)]+\.md)(#[^\s)]*)?(\))/g,(all,start,link,hash='',end)=>{
              if(/^(?:[a-z]+:|\/)/i.test(link))return all;
              const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(source),link));
              return start+path.posix.relative(path.posix.dirname(op.page),resolved)+hash+end;
            });
            combined+='\n\n## 合并来源：'+source+'\n\n'+rebased;bodies.add(body(content));
          }
          metadata.push(parseFrontmatter(content));
          attrs.push(...pageAttribution(content));
          pages.set(source,setMetadata(content,{qq_memory_state:'merged',qq_merged_into:op.page}));
        }
        if(semantic){const header=text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0]??'';combined=header+'\n'+semantic;}
        if(attrs.length)combined+='\n\n<!-- qq-attribution-v2 -->\n人物归属与来源（宿主核验，保留合并前来源）：\n'+JSON.stringify([...new Map(attrs.map(a=>[JSON.stringify(a),a])).values()])+'\n<!-- /qq-attribution-v2 -->';
        const priorities=metadata.map(m=>Number(m.salience)).filter(n=>[1,2,3].includes(n));
        const tags=[...new Set(metadata.flatMap(m=>(m.tags??'').replace(/^\[|\]$/g,'').split(',').map(s=>s.trim()).filter(Boolean)))];
        const dates=metadata.map(m=>m.last_access).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d??'')).sort();
        pages.set(op.page,setMetadata(combined+'\n',{
          ...(semantic?{summary:JSON.stringify(clampSummary(op.claims.map(c=>c.text).join('；')))}:{}),
          ...(priorities.length?{salience:Math.min(...priorities)}:{}),
          ...(tags.length?{tags:'['+tags.join(', ')+']'}:{}),...(dates.length?{last_access:dates.at(-1)}:{})
        }));
        // Preserve archived originals byte-for-byte except their host metadata.
        // Rewrite live backlinks only; archived paths remain valid readable pages.
        for(const [name,value] of pages){
          if(!activePage(value)||(semantic&&name===op.page))continue;
          const rewritten=value.replace(/(\[[^\]\n]*\]\()([^\s)]+\.md)(#[^\s)]*)?(\))/g,(all,start,link,hash='',end)=>{
            const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(name),link));
            if(!sources.includes(resolved))return all;
            return start+path.posix.relative(path.posix.dirname(name),op.page)+hash+end;
          });
          if(rewritten!==value&&store.key.includes('/group/')&&name.startsWith('identity/'))throw Error('合并将修改受保护身份页的链接');
          pages.set(name,rewritten);
        }
      }
    }
    changes.push({...op});
  }
  const files=[...pages].filter(([name,text])=>original.get(name)!==text).map(([name,text])=>({name,text}));
  if(store.key.includes('/group/')&&files.some(f=>f.name.startsWith('identity/')))throw Error('群聊不能修改基础身份');
  return {pages,index,files,changes,before:files.map(f=>({page:f.name,text:original.get(f.name)}))};
}
export function maintainMemory(store,args={},{id='memory-maintain-'+randomUUID(),previewOnly=false}={}){
  if(Object.keys(args).some(k=>!['operations','expectedRevision','preview'].includes(k))||args.preview!==undefined&&typeof args.preview!=='boolean')throw Error('维护参数无效');
  if(previewOnly&&args.preview===false)throw Error('后台维护只可预览；请在最终 digest 中提交');
  store.recover();
  const request={operations:args.operations,expectedRevision:args.expectedRevision},plan=planMaintenance(store,request);
  const oldIndex=readIndex(store),newIndex=compileMemoryIndex(plan.index,plan.pages);
  const result={preview:args.preview!==false,revision:args.expectedRevision,changes:plan.changes,
    index:{changed:oldIndex!==newIndex,beforeRevision:revisionOf(oldIndex),afterRevision:revisionOf(newIndex)},
    files:plan.files.map(f=>({page:f.name,beforeRevision:revisionOf(plan.before.find(b=>b.page===f.name).text),afterRevision:revisionOf(f.text),totalChars:f.text.length}))};
  if(args.preview===false){store.commit([],{id,evidenceIds:[],summary:'受控记忆维护',maintenance:request});result.saved=true;result.revision=maintenanceRevision(store);}
  return result;
}
