import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),workspace=path.dirname(root);
const own=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const output=path.join(workspace,'dsh-qq-deploy','releases',`${own.name}-${own.version}-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const parts=[['dsh-onebot-source','lib','lib'],['dsh-group-social','lib','lib/group'],['dsh-companion-voice','lib','lib/voice']];
const manifest={version:own.version,builtAt:new Date().toISOString(),sources:{},files:{}};
for(const [project,from,to]of parts){
  const source=path.join(workspace,project),pkg=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
  fs.cpSync(path.join(source,from),path.join(output,to),{recursive:true,filter:p=>!path.basename(p).includes('.bak-')});
  own.peerDependencies={...own.peerDependencies,...pkg.peerDependencies};manifest.sources[project]=pkg.version;
}
fs.cpSync(path.join(root,'lib'),path.join(output,'lib'),{recursive:true});
fs.copyFileSync(path.join(root,'cordis.patch.yml'),path.join(output,'cordis.patch.yml'));
if(fs.existsSync(path.join(root,'README.md')))fs.copyFileSync(path.join(root,'README.md'),path.join(output,'README.md'));
delete own.scripts;fs.writeFileSync(path.join(output,'package.json'),JSON.stringify(own,null,2)+'\n');
function scan(dir){for(const file of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,file.name);if(file.isDirectory())scan(p);else manifest.files[path.relative(output,p).replaceAll('\\','/')]=createHash('sha256').update(fs.readFileSync(p)).digest('hex')}}
scan(path.join(output,'lib'));fs.writeFileSync(path.join(output,'build-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
fs.writeFileSync(path.join(root,'.latest-build'),output+'\n');console.log(output);
