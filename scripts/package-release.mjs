import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {VERSION,PROTOCOL} from '../native-dsh-plugin/lib/schema.mjs';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const destination=path.resolve(process.argv[2]??'');
if(!process.argv[2]||fs.existsSync(destination))throw Error('请指定不存在的发布目录；不覆盖现有版本');
for(const name of ['standalone','native-dsh-plugin']){
  const pkg=JSON.parse(fs.readFileSync(path.join(source,name,'package.json')));
  if(pkg.version!==VERSION)throw Error('服务与插件版本号不同');
}
const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:source,encoding:'utf8'}).split('\0').filter(Boolean);
fs.mkdirSync(destination,{recursive:true});
for(const name of files){
  if(name.split(/[\\/]/).some(p=>['.git','.runtime','node_modules'].includes(p))||name.includes('.private.'))throw Error('发布文件中发现私有或运行目录');
  const from=path.join(source,name);if(!fs.existsSync(from)||!fs.statSync(from).isFile())continue;
  const to=path.join(destination,name);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);
}
fs.cpSync(path.join(source,'standalone','node_modules'),path.join(destination,'standalone','node_modules'),{recursive:true,dereference:true});
const hashes={};
for(const dir of ['native-dsh-plugin','standalone/lib','standalone/public','scripts']){
  for(const file of fs.readdirSync(path.join(destination,dir),{recursive:true})){
    const name=dir+'/'+file.replaceAll('\\','/'),full=path.join(destination,name);
    if(fs.statSync(full).isFile())hashes[name]=createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  }
}
for(const name of ['native-dsh-plugin/package.json','standalone/package.json','standalone/package-lock.json','standalone/server.mjs']){
  hashes[name]=createHash('sha256').update(fs.readFileSync(path.join(destination,name))).digest('hex');
}
const buildId=createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
fs.writeFileSync(path.join(destination,'release.json'),JSON.stringify({version:VERSION,protocol:PROTOCOL,buildId,builtAt:new Date().toISOString(),hashes},null,2));
console.log(JSON.stringify({version:VERSION,releaseRoot:destination,files:files.length}));
