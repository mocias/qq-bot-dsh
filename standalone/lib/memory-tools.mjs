import {readMemory,searchMemory,queryMemory} from './memory-access.mjs';
import {diagnoseMemory,maintainMemory} from './memory-maintenance.mjs';

const names=new Set(['qq_memory_read','qq_memory_search','qq_memory_query','qq_memory_diagnose','qq_memory_maintain']);
export const isMemoryQuery=name=>names.has(name);

// Share query semantics across native chat, legacy chat and internal digests.
// Admission and evidence-backed writes stay with the caller's turn. Background
// queries never warm pages, and maintenance can only preview before final digest.
export function runMemoryQuery(store,name,args,{background=false,id}={}) {
  switch(name) {
    case 'qq_memory_read': return readMemory(store,args,{trackAccess:!background});
    case 'qq_memory_search': return searchMemory(store,args,{trackAccess:!background});
    case 'qq_memory_query': return queryMemory(store,args);
    case 'qq_memory_diagnose': return diagnoseMemory(store,args);
    case 'qq_memory_maintain': return maintainMemory(store,args,{previewOnly:background,...(id?{id}:{})});
    default: throw Error('后台只开放记忆诊断、查询与维护预览');
  }
}
