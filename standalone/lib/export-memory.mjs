import fs from 'node:fs';
import path from 'node:path';
import {personaIdentity} from './persona-cards.mjs';
import {workspacePersonaName} from './workspace.mjs';

const crc=bytes=>{let n=0xffffffff;for(const b of bytes){n^=b;for(let j=0;j<8;j++)n=(n>>>1)^((n&1)?0xedb88320:0);}return (n^0xffffffff)>>>0;};
// Standard uncompressed ZIP: portable UTF-8 filenames, no shell, no ZIP64.
export function zipFiles(entries){
  const local=[],directory=[];let offset=0;
  for(const [name,bytes]of entries){
    const filename=Buffer.from(name),checksum=crc(bytes),header=Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(33,12);
    header.writeUInt32LE(checksum,14);header.writeUInt32LE(bytes.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(filename.length,26);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(33,14);
    central.writeUInt32LE(checksum,16);central.writeUInt32LE(bytes.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(filename.length,28);central.writeUInt32LE(offset,42);
    local.push(header,filename,bytes);directory.push(central,filename);offset+=header.length+filename.length+bytes.length;
  }
  const catalog=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(catalog.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,catalog,end]);
}
export function exportMemory(runtime,key,personaId){
  if(!personaId)throw Error('请明确选择要导出的人格');
  const identity=personaIdentity(runtime,key,personaId),root=path.join(runtime,'memories',identity.scope),entries=[];let total=0;
  for(const dir of [path.join(runtime,'memories'),root,path.join(root,'.runtime')])if(fs.existsSync(dir)&&fs.lstatSync(dir).isSymbolicLink())throw Error('不能导出符号链接目录');
  const add=(name,bytes)=>{total+=bytes.length;if(total>64*1024*1024||entries.length>=16000)throw Error('导出内容超过64MiB或16000个文件，请分批备份');entries.push([name,bytes]);};
  function walk(dir,relative=''){
    if(!fs.existsSync(dir))return;if(fs.lstatSync(dir).isSymbolicLink())throw Error('不能导出符号链接目录');
    for(const e of fs.readdirSync(dir,{withFileTypes:true})){
      if(e.name.startsWith('.'))continue;if(e.isSymbolicLink())throw Error('不能导出符号链接');
      const rel=relative+e.name,file=path.join(dir,e.name);
      if(e.isDirectory())walk(file,rel+'/');else if(e.isFile()&&e.name.endsWith('.md')){if(total+fs.statSync(file).size>64*1024*1024)throw Error('导出内容超过64MiB');add('memory/'+rel,fs.readFileSync(file));}
    }
  }
  walk(root);
  const handoffs=path.join(root,'.runtime','handoffs');
  if(fs.existsSync(handoffs)){
    if(fs.lstatSync(handoffs).isSymbolicLink())throw Error('不能导出符号链接');
    for(const session of fs.readdirSync(handoffs,{withFileTypes:true}))if(session.isDirectory()&&!session.isSymbolicLink()){
      for(const name of fs.readdirSync(path.join(handoffs,session.name)).filter(n=>/^handoff-[a-zA-Z0-9_-]+\.json$/.test(n))){
        const file=path.join(handoffs,session.name,name);if(fs.lstatSync(file).isSymbolicLink())throw Error('不能导出符号链接');
        const r=JSON.parse(fs.readFileSync(file,'utf8'));if(r.status==='ready')add('handoffs/'+name,Buffer.from(JSON.stringify({id:r.id,at:r.at,reason:r.reason,summary:r.summary,unfinished:r.unfinished},null,2)));
      }
    }
  }
  const [,kind,id]=key.split('/'),manifest={format:'qq-persona-memory',version:1,exportedAt:new Date().toISOString(),key,personaId,personaName:identity.personaName,files:entries.map(([name])=>name)};
  add('manifest.json',Buffer.from(JSON.stringify(manifest,null,2)));
  add('说明.txt',Buffer.from('此包仅包含所选聊天和人格的人设、记忆Markdown及交接摘要。未包含密钥、运行配置、其他人格、原始工具日志或完整DSH会话；导出不改变原资料。'));
  return {filename:`${kind==='group'?'群聊':'私聊'}-${id}-${workspacePersonaName(identity.personaName)}-记忆.zip`,bytes:zipFiles(entries)};
}
