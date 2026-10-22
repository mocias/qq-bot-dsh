import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {localSessionCookie} from './local-dsh-auth.mjs';

const run=promisify(execFile);
// The panel's own listener is never a DSH candidate.
const EXCLUDED_PORTS=new Set([3199]);

/** Ports owned by the DSH process itself, so unrelated local services are not poked. */
async function dshProcessPorts({timeoutMs=4000}={}){
  if(process.platform!=='win32')return [];
  try{
    const [{stdout:netstat},{stdout:tasklist}]=await Promise.all([
      run('netstat',['-ano','-p','TCP'],{timeout:timeoutMs,windowsHide:true,maxBuffer:4*1024*1024}),
      run('tasklist',['/FI','IMAGENAME eq DeepSeek Harness.exe','/FO','CSV','/NH'],{timeout:timeoutMs,windowsHide:true,maxBuffer:1024*1024})
    ]);
    const pids=new Set();
    for(const line of tasklist.split(/\r?\n/)){const m=line.match(/^"DeepSeek Harness\.exe","(\d+)"/i);if(m)pids.add(m[1]);}
    if(!pids.size)return [];
    const ports=new Set();
    for(const line of netstat.split(/\r?\n/)){
      const m=line.match(/^\s*TCP\s+(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\]):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
      if(m&&pids.has(m[2]))ports.add(Number(m[1]));
    }
    return [...ports].filter(port=>port>1024&&!EXCLUDED_PORTS.has(port));
  }catch{return [];}
}

/** List TCP ports listening on this machine, without assuming a fixed DSH port. */
export async function localListeningPorts({timeoutMs=4000}={}){
  const ports=new Set();
  try{
    if(process.platform==='win32'){
      const {stdout}=await run('netstat',['-ano','-p','TCP'],{timeout:timeoutMs,windowsHide:true,maxBuffer:4*1024*1024});
      for(const line of stdout.split(/\r?\n/)){
        const m=line.match(/^\s*TCP\s+(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\]):(\d+)\s+\S+\s+LISTENING\s+\d+/i);
        if(m)ports.add(Number(m[1]));
      }
    }else{
      const {stdout}=await run('ss',['-ltn'],{timeout:timeoutMs,maxBuffer:4*1024*1024});
      for(const line of stdout.split(/\n/)){
        const m=line.match(/^LISTEN\s+\d+\s+\d+\s+(?:127\.0\.0\.1|0\.0\.0\.0|\*|\[::1?\]|\[::\]):(\d+)/i);
        if(m)ports.add(Number(m[1]));
      }
    }
  }catch{}
  return [...ports].filter(port=>port>1024&&!EXCLUDED_PORTS.has(port));
}

/** One DSH handshake: only a real DSH answers this RPC with its own envelope. */
export async function probeDshUrl(url,{timeoutMs=1200,home}={}){
  let cookie;
  try{cookie=localSessionCookie(url,home?{home}:{}).cookie;}catch{return false;}
  const rpcId=randomUUID();
  try{
    const response=await fetch(new URL('/api/agentPresets/list',url),{method:'POST',redirect:'error',
      headers:{'Content-Type':'application/json',Cookie:cookie},
      body:JSON.stringify({type:'client-request',rpcId,method:'agentPresets/list',payload:{args:{}}}),
      signal:AbortSignal.timeout(timeoutMs)});
    if(!response.ok){await response.body?.cancel();return false;}
    const body=await response.json();
    return body?.type==='server-response'&&body.rpcId===rpcId&&body.result?.ok===true;
  }catch{return false;}
}

/**
 * Resolve the DSH base URL. The saved address wins while it still answers;
 * otherwise every local listener is probed for the DSH handshake.
 */
export async function discoverDshUrl({current='',timeoutMs=1200,concurrency=8,ports,home}={}){
  if(current&&await probeDshUrl(current,{timeoutMs,home}))return {url:current,reused:true};
  const all=Array.isArray(ports)?ports.filter(port=>port>1024&&!EXCLUDED_PORTS.has(port)):await localListeningPorts();
  // Try the DSH process's own listeners first, then any other local port.
  const owned=Array.isArray(ports)?[]:await dshProcessPorts();
  const candidates=[...new Set([...owned,...all])];
  for(let index=0;index<candidates.length;index+=concurrency){
    const batch=candidates.slice(index,index+concurrency);
    const hits=await Promise.all(batch.map(async port=>{
      const url='http://127.0.0.1:'+port;
      return (await probeDshUrl(url,{timeoutMs,home}))?url:null;
    }));
    const found=hits.find(Boolean);
    if(found)return {url:found,reused:false};
  }
  return null;
}

/**
 * Persist a discovered URL. The client mutates the shared config object before
 * notifying, so this must write unconditionally instead of comparing values.
 */
export function persistDiscoveredDshUrl(url,{config,configFile,bridge,systemLog,writeJson}){
  if(!url)return config;
  const next={...config,dshUrl:url};
  writeJson(configFile,next);
  if(bridge?.config)bridge.config=next;
  systemLog?.record('dsh.url.persisted',{component:'dsh',url});
  return next;
}
