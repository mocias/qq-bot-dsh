import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {memoryFiles} from './memory-access.mjs';
import {writeJson,readJson} from './config.mjs';

// A private, host-owned repository, separate from imported .git and source repos.
// Never stage raw messages, runtime metadata, revisions, audio, or credentials.
export function snapshotHistory(store){
  const status=store.safe('.runtime/history-status.json');
  try{
    const gitDir=store.safe('.runtime/history.git'),hooks=store.safe('.runtime/empty-hooks');
    fs.mkdirSync(hooks,{recursive:true});
    const emptyConfig=store.safe('.runtime/git-empty-config');fs.writeFileSync(emptyConfig,'');
    const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.toUpperCase().startsWith('GIT_')));
    Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:emptyConfig,GIT_TERMINAL_PROMPT:'0',
      GIT_AUTHOR_NAME:'QQ Memory',GIT_AUTHOR_EMAIL:'memory@localhost',GIT_COMMITTER_NAME:'QQ Memory',GIT_COMMITTER_EMAIL:'memory@localhost'});
    const git=args=>execFileSync('git',[...(args[0]==='init'?[]:['--git-dir='+gitDir,'--work-tree='+store.dir]),'-c','core.hooksPath='+hooks,
      '-c','core.fsmonitor=false','-c','commit.gpgSign=false','-c','core.autocrlf=false',...args],
      {cwd:store.dir,env,encoding:'utf8',windowsHide:true,timeout:10000,stdio:['pipe','pipe','pipe']});
    if(!fs.existsSync(gitDir))git(['init','--bare',gitDir]);
    const files=memoryFiles(store);
    if(!files.length)return {state:'empty'};
    // An empty index plus an explicit allowlist also removes deleted pages and
    // excludes any unrelated staged files. No git add -A, hooks, remotes or push.
    git(['read-tree','--empty']);
    for(let start=0;start<files.length;start+=40)git(['add','--',...files.slice(start,start+40)]);
    const tree=git(['write-tree']).trim();let head='';
    try{head=git(['rev-parse','--verify','HEAD']).trim();}catch{}
    if(!head||git(['rev-parse','HEAD^{tree}']).trim()!==tree){
      const commit=git(['commit-tree',tree,...(head?['-p',head]:[]),'-m','Memory snapshot']).trim();
      git(['update-ref','HEAD',commit]);head=commit;
    }
    const result={state:'ready',commit:head,at:Date.now()};writeJson(status,result);return result;
  }catch{
    // Failure must not turn an already durable memory update into a failed write.
    const result={state:'unavailable',message:'记忆和修订备份已保留，本地 Git 历史暂不可用；下次保存重试',at:Date.now()};
    try{writeJson(status,result);}catch{}return result;
  }
}
export const historyStatus=store=>readJson(store.safe('.runtime/history-status.json'),{state:'not_started'});
