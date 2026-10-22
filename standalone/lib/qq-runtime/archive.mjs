import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createInflateRaw} from 'node:zlib';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const officialHosts = new Set(['github.com','api.github.com','objects.githubusercontent.com','release-assets.githubusercontent.com','github-releases.githubusercontent.com','dldir1.qq.com','dldir1v6.qq.com']);
export function officialUrl(value,{artifact=true}={}) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !officialHosts.has(url.hostname) || url.username || url.password || url.hash || (url.port && url.port !== '443') || /(?:^|\/)latest(?:\/|$)/i.test(url.pathname)) throw Error('组件下载必须使用固定版本的官方 HTTPS 地址');
  if(artifact&&url.hostname==='github.com'&&!/^\/NapNeko\/NapCatQQ\/releases\/download\/v\d+\.\d+\.\d+\/[^/]+\.zip$/i.test(url.pathname))throw Error('组件归档必须指向 NapCat 官方固定版本发布路径');
  if(artifact&&url.hostname==='api.github.com'&&!/^\/repos\/NapNeko\/NapCatQQ\/releases\/assets\/\d+$/.test(url.pathname))throw Error('组件归档必须指向 NapCat 官方固定发布资产');
  return url.href;
}
export function relativeFile(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || /[:\x00-\x1f]/.test(value)) throw Error('组件归档路径不安全');
  const parts=value.split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p))) throw Error('组件归档路径不安全');
  return parts.join('/');
}
export function sha256(file) {const hash=createHash('sha256'),fd=fs.openSync(file,'r');try{const chunk=Buffer.allocUnsafe(1024*1024);let count;while((count=fs.readSync(fd,chunk,0,chunk.length,null)))hash.update(chunk.subarray(0,count));return hash.digest('hex');}finally{fs.closeSync(fd);}}
export async function downloadArchive(artifact,file,{fetch:request=globalThis.fetch,timeoutMs=120000}={}) {
  let url=officialUrl(artifact.url),response;
  const signal=AbortSignal.timeout(timeoutMs);
  for(let redirects=0;redirects<=5;redirects++) {
    response=await request(url,{redirect:'manual',signal,headers:{Accept:'application/octet-stream'}});
    if([301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel();
      if(redirects===5||!response.headers.get('location'))throw Error('组件下载重定向过多');
      url=officialUrl(new URL(response.headers.get('location'),url).href,{artifact:false});continue;
    }
    break;
  }
  if(!response?.ok||!response.body)throw Error('组件下载失败');
  const declared=Number(response.headers.get('content-length'));
  if(declared>artifact.maxBytes){await response.body.cancel();throw Error('组件下载超过大小限制');}
  const hash=createHash('sha256');let size=0;
  const count=new Transform({transform(chunk,encoding,done){size+=chunk.length;if(size>artifact.maxBytes)return done(Error('组件下载超过大小限制'));hash.update(chunk);done(null,chunk);}});
  try {
    await pipeline(response.body,count,fs.createWriteStream(file,{flags:'wx',mode:0o600}));
    if(hash.digest('hex')!==artifact.sha256)throw Error('组件归档 SHA256 不匹配');
  }catch(error){fs.rmSync(file,{force:true});throw error;}
}

// ZIP central-directory validation precedes every write. ZIP64, encrypted archives,
// links, ambiguous Windows names and overlapping duplicate names are rejected.
export async function extractZip(archive,destination,{maxEntries=30000,maxExpandedBytes=4*1024**3,maxFileBytes=1024**3}={}) {
  const fd=fs.openSync(archive,'r'),size=fs.fstatSync(fd).size;
  const read=(offset,length)=>{if(offset<0||length<0||offset+length>size)throw Error('组件 ZIP 结构无效');const buffer=Buffer.alloc(length);if(fs.readSync(fd,buffer,0,length,offset)!==length)throw Error('组件 ZIP 结构无效');return buffer;};
  let entries=[];
  try {
    const tail=read(Math.max(0,size-65557),Math.min(size,65557));let eocd=-1;
    for(let n=tail.length-22;n>=0;n--)if(tail.readUInt32LE(n)===0x06054b50&&n+22+tail.readUInt16LE(n+20)===tail.length){eocd=n;break;}
    if(eocd<0)throw Error('组件 ZIP 目录缺失');
    const count=tail.readUInt16LE(eocd+10),centralBytes=tail.readUInt32LE(eocd+12),centralOffset=tail.readUInt32LE(eocd+16);
    if(tail.readUInt16LE(eocd+4)||tail.readUInt16LE(eocd+6)||tail.readUInt16LE(eocd+8)!==count||count===65535||count>maxEntries||centralBytes===0xffffffff||centralOffset+centralBytes>size-tail.length+eocd)throw Error('组件 ZIP 格式或文件数不受支持');
    let offset=centralOffset,total=0;const seen=new Set();
    for(let n=0;n<count;n++) {
      const h=read(offset,46);if(h.readUInt32LE(0)!==0x02014b50)throw Error('组件 ZIP 目录损坏');
      const flags=h.readUInt16LE(8),method=h.readUInt16LE(10),compressed=h.readUInt32LE(20),expanded=h.readUInt32LE(24),nameBytes=h.readUInt16LE(28),extra=h.readUInt16LE(30),comment=h.readUInt16LE(32),attrs=h.readUInt32LE(38),localOffset=h.readUInt32LE(42);
      const name=read(offset+46,nameBytes).toString('utf8');offset+=46+nameBytes+extra+comment;
      const directory=name.endsWith('/'),relative=relativeFile(directory?name.slice(0,-1):name),mode=(attrs>>>16)&0xf000;
      if(flags&1||![0,8].includes(method)||[0xa000,0x6000,0x2000,0x1000,0xc000].includes(mode)||(![0,0x8000,0x4000].includes(mode))||(attrs&0x400)||seen.has(relative.toLowerCase())||compressed===0xffffffff||expanded===0xffffffff||expanded>maxFileBytes)throw Error('组件 ZIP 含有链接、重复路径或不支持的条目');
      seen.add(relative.toLowerCase());total+=expanded;if(total>maxExpandedBytes)throw Error('组件 ZIP 解压超过大小限制');
      const local=read(localOffset,30);if(local.readUInt32LE(0)!==0x04034b50||local.readUInt16LE(8)!==method||local.readUInt16LE(6)!==flags)throw Error('组件 ZIP 本地目录损坏');
      const localNameLength=local.readUInt16LE(26),dataOffset=localOffset+30+localNameLength+local.readUInt16LE(28);
      if(read(localOffset+30,localNameLength).toString('utf8')!==name||dataOffset+compressed>centralOffset)throw Error('组件 ZIP 条目边界无效');
      entries.push({relative,directory,method,compressed,expanded,dataOffset});
    }
    if(offset!==centralOffset+centralBytes)throw Error('组件 ZIP 目录长度无效');
  }finally{fs.closeSync(fd);}
  fs.mkdirSync(destination,{recursive:true});
  for(const entry of entries) {
    const target=path.join(destination,...entry.relative.split('/'));
    if(entry.directory){fs.mkdirSync(target,{recursive:true});continue;}
    fs.mkdirSync(path.dirname(target),{recursive:true});let written=0;
    const counter=new Transform({transform(chunk,encoding,done){written+=chunk.length;if(written>entry.expanded||written>maxFileBytes)return done(Error('组件 ZIP 解压超过声明长度'));done(null,chunk);}});
    const output=fs.createWriteStream(target,{flags:'wx',mode:0o600});
    if(entry.compressed===0){output.end();await new Promise((resolve,reject)=>{output.once('finish',resolve);output.once('error',reject);});}
    else {
      const input=fs.createReadStream(archive,{start:entry.dataOffset,end:entry.dataOffset+entry.compressed-1});
      await pipeline(...(entry.method===8?[input,createInflateRaw(),counter,output]:[input,counter,output]));
    }
    if(written!==entry.expanded)throw Error('组件 ZIP 解压长度不匹配');
  }
}
