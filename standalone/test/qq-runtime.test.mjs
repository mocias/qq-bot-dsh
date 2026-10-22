import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {NapcatShellRuntime} from '../lib/qq-runtime/index.mjs';
import {prepareComponents,inspectComponents,validateManifest,manifestId} from '../lib/qq-runtime/components.mjs';
import {versionId,atomicPrivate} from '../lib/qq-runtime/versions.mjs';
import {downloadArchive,extractZip,relativeFile} from '../lib/qq-runtime/archive.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
function zip(items) {
  const locals=[],central=[];let offset=0;
  for(const item of items){const name=Buffer.from(item.name),plain=Buffer.from(item.data??''),data=item.deflate?deflateRawSync(plain):plain,local=Buffer.alloc(30),c=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(item.deflate?8:0,8);local.writeUInt32LE(data.length,18);local.writeUInt32LE(plain.length,22);local.writeUInt16LE(name.length,26);
    c.writeUInt32LE(0x02014b50);c.writeUInt16LE(item.deflate?8:0,10);c.writeUInt32LE(data.length,20);c.writeUInt32LE(plain.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(item.attrs??0,38);c.writeUInt32LE(offset,42);
    locals.push(local,name,data);central.push(c,name);offset+=local.length+name.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(items.length,8);end.writeUInt16LE(items.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,directory,end]);
}
function fixture(t) {
  // Windows AppContainer's redirected Temp rejects directory rename (EPERM).
  // Keep this isolated fixture within the writable checkout to exercise the
  // real atomic directory promotion rather than weakening production behavior.
  const root=fs.mkdtempSync(path.join(process.cwd(),'.tmp-qq-shell-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'source');fs.mkdirSync(source);const entry={launcher:'NapCatWinBootMain.exe',qq:'QQ/QQ.exe',hook:'NapCatWinBootHook.dll',main:'napcat.mjs'};
  const files=Object.values(entry).map(name=>{const value='fixture '+name;fs.mkdirSync(path.dirname(path.join(source,name)),{recursive:true});fs.writeFileSync(path.join(source,name),value);return {path:name,sha256:hash(value)};});
  const manifest={schema:1,platform:'win32',arch:'x64',version:'4.18.41',qqVersion:'fixture-only',localUseApproved:true,redistribution:'unreviewed',localSource:true,entry,files};
  let snapshot=[],pid=400;const killed=[];
  const runtime=new NapcatShellRuntime({runtimeRoot:path.join(root,'private'),sourceRoot:source,manifest,platform:'win32',arch:'x64',settleMs:0,packetProbe:async()=>({state:'unknown'}),processes:async()=>structuredClone(snapshot),probe:async()=>{throw Error('offline');},checkPort:async()=>true,
    launch:({root,entry})=>{const child=new EventEmitter();child.pid=pid++;snapshot.push({pid:child.pid,parentPid:process.pid,name:'NapCatWinBootMain.exe',executable:path.join(root,entry.launcher),startedAt:'2026-10-22T01:00:00Z'});return child;},
    terminate:async p=>{killed.push(p.pid);snapshot=snapshot.filter(x=>x.pid!==p.pid);},
  });
  return {root,source,manifest,runtime,config:{botQQ:'100000001'},killed,setSnapshot:value=>{snapshot=value;},getSnapshot:()=>snapshot};
}
test('Shell prepare verifies all payload files, creates local secrets, and never reports socket alone ready',async t=>{
  const {runtime,config}=fixture(t);assert.equal((await runtime.status(config)).component.state,'missing');
  const prepared=await runtime.prepare(config);assert.equal(prepared.component.state,'verified');assert.equal(prepared.process.state,'stopped');assert.equal(prepared.interface.online,false);
  const resolved=runtime.resolveConfig(config),saved=JSON.parse(fs.readFileSync(runtime.privateFile()));
  assert.match(resolved.qqUrl,/^ws:\/\/127\.0\.0\.1:\d+$/);assert.equal(resolved.qqToken.length,64);assert.notEqual(saved.webuiToken,resolved.qqToken);assert.notEqual(saved.onebotPort,saved.webuiPort);
  assert.ok(!JSON.stringify(prepared).includes(resolved.qqToken));assert.ok(!JSON.stringify(prepared).includes(saved.webuiToken));
  const web=JSON.parse(fs.readFileSync(path.join(runtime.workFor(config.botQQ),'config','webui.json')));assert.equal(web.host,'127.0.0.1');assert.equal(web.enable2FA,false);assert.equal(web.disableWebUI,false);
  assert.equal((await runtime.prepare(config)).reused,true);assert.equal(runtime.resolveConfig(config).qqToken,resolved.qqToken);
  await runtime.start(config);runtime.probe=async()=>({account:config.botQQ,online:false});assert.equal((await runtime.status(config)).state,'starting');
  runtime.probe=async()=>({account:'100000002',online:true});assert.equal((await runtime.status(config)).interface.online,false);
  runtime.probe=async()=>({account:config.botQQ,online:true});runtime.packetProbe=async()=>({state:'unavailable'});
  const online=await runtime.status(config);assert.equal(online.state,'online');assert.equal(online.capabilities.packet.state,'unavailable');
});
test('controlled stop only kills captured launcher descendants, never ordinary QQ or PID reuse',async t=>{
  const {runtime,config,getSnapshot,setSnapshot,killed}=fixture(t);await runtime.prepare(config);await runtime.start(config);
  const root=getSnapshot()[0],child={pid:888,parentPid:root.pid,name:'QQ.exe',executable:path.join(runtime.current,'QQ/QQ.exe'),startedAt:'2026-10-22T01:00:01Z'};
  const browser={pid:889,parentPid:root.pid,name:'browser.exe',executable:'C:\\unrelated\\browser.exe',startedAt:'fixture browser'};
  setSnapshot([root,child,browser]);await runtime.status(config);assert.equal((await runtime.stop(config)).process.state,'stopped');assert.deepEqual(killed,[888,root.pid]);assert.ok(getSnapshot().some(p=>p.pid===browser.pid));
  await runtime.start(config);const reused={...getSnapshot()[0],name:'QQ.exe',executable:'C:\\other\\QQ.exe',startedAt:'2026-10-22T02:00:00Z'};setSnapshot([reused]);
  assert.equal((await runtime.status(config)).process.state,'orphaned');await assert.rejects(runtime.stop(config),/不属于/);assert.equal(killed.length,2);
});
test('service restart never adopts live process records and cannot change account while running',async t=>{
  const {runtime,config,getSnapshot,manifest,root}=fixture(t);await runtime.prepare(config);await runtime.start(config);
  await assert.rejects(runtime.prepare({...config,botQQ:'100000002'}),/仍在运行/);
  const restarted=new NapcatShellRuntime({runtimeRoot:path.join(root,'private'),manifest,platform:'win32',arch:'x64',processes:async()=>getSnapshot(),probe:async()=>{throw Error();}});
  assert.equal((await restarted.status(config)).process.state,'orphaned');await assert.rejects(restarted.start(config),/不会重复启动/);await assert.rejects(restarted.stop(config),/不属于/);
});
test('missing manifest, tampered file, occupied port, existing QQ, and uncertain launch fail closed',async t=>{
  const f=fixture(t),{runtime,config,manifest}=f;
  const noManifest=new NapcatShellRuntime({runtimeRoot:path.join(f.root,'unconfigured'),manifest:null,processes:async()=>[]});assert.equal((await noManifest.status(config)).component.state,'missing');await assert.rejects(noManifest.prepare(config),/组件清单/);
  await runtime.prepare(config);runtime.checkPort=async()=>false;await assert.rejects(runtime.start(config),/端口被占用/);runtime.checkPort=async()=>true;
  f.setSnapshot([{pid:900,name:'QQ.exe',executable:'C:\\QQ.exe',startedAt:'existing'}]);await assert.rejects(runtime.start(config),/不会重复启动/);f.setSnapshot([]);
  fs.writeFileSync(path.join(runtime.current,manifest.entry.hook),'tampered');assert.equal((await runtime.status(config)).component.state,'invalid');await assert.rejects(runtime.start(config),/摘要/);
  fs.writeFileSync(path.join(runtime.current,manifest.entry.hook),'fixture '+manifest.entry.hook);
  runtime.launch=()=>{const child=new EventEmitter();child.pid=99;return child;};await assert.rejects(runtime.start(config),/归属未确认/);assert.equal((await runtime.status(config)).process.state,'exit_unconfirmed');await assert.rejects(runtime.start(config),/不会重复启动/);
});
test('stop failure retains exit-unconfirmed and serialization lock never silently clears another operation',async t=>{
  const {runtime,config}=fixture(t);await runtime.prepare(config);await runtime.start(config);runtime.terminate=async()=>{throw Error('fixture');};await assert.rejects(runtime.stop(config),/退出未确认/);await assert.rejects(runtime.prepare(config),/仍在运行/);
  fs.writeFileSync(path.join(runtime.root,'operation.lock'),'interrupted');await assert.rejects(runtime.stop(config),/另一个/);assert.equal(fs.readFileSync(path.join(runtime.root,'operation.lock'),'utf8'),'interrupted');
});
test('damaged private connection fails explicitly without overwriting tokens or reporting prepared',async t=>{
  const {runtime,config}=fixture(t);await runtime.prepare(config);const saved=JSON.parse(fs.readFileSync(runtime.privateFile()));saved.onebotPort=saved.webuiPort;fs.writeFileSync(runtime.privateFile(),JSON.stringify(saved));
  const before=fs.readFileSync(runtime.privateFile(),'utf8');assert.equal((await runtime.status(config)).connection.state,'invalid');assert.equal((await runtime.status(config)).state,'invalid');await assert.rejects(runtime.prepare(config),/损坏.*保留现场/);assert.equal(fs.readFileSync(runtime.privateFile(),'utf8'),before);
});
test('official download validates every redirect, stream size and complete SHA256',async t=>{
  const {root}=fixture(t),body=Buffer.from('official-fixture'),artifact={url:'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.41/test.zip',maxBytes:100,sha256:hash(body)};let count=0;
  await downloadArchive(artifact,path.join(root,'download.zip'),{fetch:async()=>++count===1?new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/pinned-artifact'}}):new Response(body)});assert.equal(count,2);
  await assert.rejects(downloadArchive(artifact,path.join(root,'redirect.zip'),{fetch:async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}})}),/官方 HTTPS/);
  await assert.rejects(downloadArchive({...artifact,maxBytes:2},path.join(root,'limit.zip'),{fetch:async()=>new Response(body)}),/大小限制/);assert.equal(fs.existsSync(path.join(root,'limit.zip')),false);
  await assert.rejects(downloadArchive({...artifact,sha256:'0'.repeat(64)},path.join(root,'wrong.zip'),{fetch:async()=>new Response(body)}),/SHA256/);assert.equal(fs.existsSync(path.join(root,'wrong.zip')),false);
});
test('ZIP extractor rejects traversal, absolute paths, ADS, Windows names, duplicates, symlink and expansion bombs',async t=>{
  const {root}=fixture(t);
  for(const [index,name] of ['../evil','/absolute','C:/drive','safe/../evil','safe:stream','NUL.txt','safe./file','a\\b'].entries()) {
    const archive=path.join(root,`bad-${index}.zip`);fs.writeFileSync(archive,zip([{name,data:'bad'}]));await assert.rejects(extractZip(archive,path.join(root,'out-'+index)),/不安全/);
  }
  for(const [index,items] of [[{name:'File',data:'a'},{name:'file',data:'b'}],[{name:'link',data:'target',attrs:0xa1ff0000}]].entries()){
    const archive=path.join(root,`special-${index}.zip`);fs.writeFileSync(archive,zip(items));await assert.rejects(extractZip(archive,path.join(root,'special-out-'+index)),/链接、重复/);
  }
  const bomb=path.join(root,'bomb.zip');fs.writeFileSync(bomb,zip([{name:'large',data:'x'.repeat(200),deflate:true}]));await assert.rejects(extractZip(bomb,path.join(root,'bomb-out'),{maxExpandedBytes:10}),/大小限制/);
  const valid=path.join(root,'valid.zip');fs.writeFileSync(valid,zip([{name:'nested/value',data:'payload',deflate:true},{name:'empty',data:''}]));await extractZip(valid,path.join(root,'valid-out'));assert.equal(fs.readFileSync(path.join(root,'valid-out/nested/value'),'utf8'),'payload');
});
test('automatic component pipeline is atomic, cleans failures, verifies extracted hashes and supports retry',async t=>{
  const {root,manifest,source}=fixture(t),bytes=zip(manifest.files.map(f=>({name:f.path,data:fs.readFileSync(path.join(source,f.path)),deflate:true}))),targetRoot=path.join(root,'installed');
  const remote={...manifest,localSource:false,artifacts:[{url:'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.41/fixture.zip',sha256:hash(bytes),maxBytes:bytes.length+1}]};
  const download=async(a,file)=>fs.writeFileSync(file,bytes);
  await assert.rejects(prepareComponents({targetRoot,manifest:remote,download,extract:async()=>{throw Error('fixture extraction failure');}}),/fixture/);
  assert.equal(fs.existsSync(targetRoot),false);assert.ok(!fs.readdirSync(root).some(n=>n.startsWith('.prepare-')||n.startsWith('.archive-')));
  await assert.rejects(prepareComponents({targetRoot,manifest:{...remote,files:remote.files.map((f,i)=>i?f:{...f,sha256:'0'.repeat(64)})},download}),/SHA256/);assert.equal(fs.existsSync(targetRoot),false);
  await prepareComponents({targetRoot,manifest:remote,download});assert.equal(inspectComponents(targetRoot,remote).state,'verified');assert.ok(fs.existsSync(path.join(targetRoot,'.complete.json')));
  assert.equal((await prepareComponents({targetRoot,manifest:remote,download:()=>{throw Error('must reuse');}})).reused,true);
});
test('manifests reject mutable payload, unpinned sources and case ambiguity',t=>{
  const {manifest}=fixture(t);assert.throws(()=>validateManifest({...manifest,localUseApproved:false}),/经核实/);
  assert.throws(()=>validateManifest({...manifest,artifacts:[{url:'https://github.com/x/releases/latest/test.zip',sha256:'0'.repeat(64),maxBytes:100}]}),/固定版本/);
  assert.throws(()=>validateManifest({...manifest,files:[...manifest.files,{...manifest.files[0],path:manifest.files[0].path.toUpperCase()}]}),/去重/);
  assert.throws(()=>relativeFile('x/COM1.dat'),/不安全/);
});
test('official Node preset prepares an unmodified pinned archive and verifies generated inventory plus critical hashes',async t=>{
  const {root}=fixture(t),items=[{name:'node.exe',data:'fixture executable'},{name:'index.js',data:'fixture entry'},{name:'QQNT.dll',data:'fixture native'},{name:'wrapper.node',data:'fixture wrapper'},{name:'napcat/napcat.mjs',data:'fixture NapCat'},{name:'napcat/config/default.json',data:'{}'}],bytes=zip(items);
  const manifest={schema:1,platform:'win32',arch:'x64',preset:'official-node',version:'4.18.41',qqVersion:'9.9.31-49738',localUseApproved:true,entry:{executable:'node.exe',script:'index.js',main:'napcat/napcat.mjs'},criticalFiles:[{path:'node.exe',sha256:hash('fixture executable')}],artifacts:[{url:'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.41/fixture.zip',sha256:hash(bytes),maxBytes:bytes.length+1}]};
  let snapshot=[],launchArgs;const runtime=new NapcatShellRuntime({runtimeRoot:path.join(root,'node-private'),manifest,platform:'win32',arch:'x64',settleMs:0,download:async(a,file)=>fs.writeFileSync(file,bytes),processes:async()=>snapshot,probe:async()=>{throw Error('fixture offline');},checkPort:async()=>true,launch:args=>{launchArgs=args;const child=new EventEmitter();child.pid=765;snapshot=[{pid:765,parentPid:process.pid,name:'node.exe',executable:path.join(args.root,args.entry.executable),startedAt:'fixture start'}];return child;},terminate:async()=>{snapshot=[];}});
  const config={botQQ:'100000001'};assert.equal((await runtime.prepare(config)).component.state,'verified');assert.equal(runtime.resolveConfig(config).napcatFrameworkDir,runtime.workFor(config.botQQ));assert.equal(fs.existsSync(path.join(runtime.current,'loadNapCat.js')),false);
  fs.mkdirSync(path.join(runtime.workFor(config.botQQ),'data'),{recursive:true});fs.writeFileSync(path.join(runtime.workFor(config.botQQ),'data/login.private'),'fixture private data');
  assert.equal((await runtime.status(config)).component.state,'verified');await runtime.start(config);assert.equal(launchArgs.preset,'official-node');assert.equal(launchArgs.workDir,runtime.workFor(config.botQQ));assert.equal((await runtime.status(config)).process.owned,true);
  const restarted=new NapcatShellRuntime({runtimeRoot:path.join(root,'node-private'),manifest,platform:'win32',arch:'x64',processes:async()=>snapshot,probe:async()=>{throw Error('fixture');}});assert.equal((await restarted.status(config)).process.state,'orphaned');await assert.rejects(restarted.prepare(config),/归属未确认/);
  await runtime.stop(config);fs.writeFileSync(path.join(runtime.current,'napcat/config/default.json'),'modified original package default');assert.equal((await runtime.status(config)).component.state,'invalid');fs.writeFileSync(path.join(runtime.current,'napcat/config/default.json'),'{}');fs.writeFileSync(path.join(runtime.current,'QQNT.dll'),'modified native');assert.equal((await runtime.status(config)).component.state,'invalid');await assert.rejects(runtime.start(config),/摘要/);
});
test('account work directories preserve old private configuration without activating it for a new account',async t=>{
  const {runtime,config}=fixture(t);await runtime.prepare(config);const previous=path.join(runtime.workFor(config.botQQ),'config',`onebot11_${config.botQQ}.json`),before=fs.readFileSync(previous,'utf8');
  const next={botQQ:'100000002'};await runtime.prepare(next);assert.equal(fs.readFileSync(previous,'utf8'),before);const nextRoot=runtime.resolveConfig(next).napcatFrameworkDir;assert.notEqual(nextRoot,runtime.workFor(config.botQQ));assert.equal(fs.existsSync(path.join(nextRoot,'config',`onebot11_${config.botQQ}.json`)),false);assert.equal(fs.existsSync(path.join(nextRoot,'config',`onebot11_${next.botQQ}.json`)),true);
});
test('resolveConfig and start refuse a substituted account work junction',async t=>{
  const {runtime,config}=fixture(t);await runtime.prepare(config);const work=runtime.workFor(config.botQQ),preserved=work+'-preserved';fs.renameSync(work,preserved);
  try{fs.symlinkSync(preserved,work,'junction');}catch(error){fs.renameSync(preserved,work);if(['EPERM','EACCES'].includes(error.code)){t.skip('Windows junction creation unavailable');return;}throw error;}
  try{assert.throws(()=>runtime.resolveConfig(config),/链接|联接/);assert.equal((await runtime.status(config)).connection.state,'invalid');await assert.rejects(runtime.start(config),/链接|联接/);}finally{fs.unlinkSync(work);fs.renameSync(preserved,work);}
});
function twoVersions(f){const a=f.manifest,b={...f.manifest,version:'4.18.40'};f.runtime.catalogInput=[a,b];return {a,b,idA:versionId(a),idB:versionId(b)};}
test('version installation is separate from activation and rollback restores each version private configuration',async t=>{
  const f=fixture(t),{runtime,config}=f,{idA,idB}=twoVersions(f);await runtime.prepare(config);
  const aConnection=runtime.resolveConfig(config),pointerBefore=fs.readFileSync(runtime.store.pointerFile,'utf8'),aChoice=path.join(aConnection.napcatFrameworkDir,'config/user-choice.json');fs.writeFileSync(aChoice,'{"choice":"A"}');
  const installation=await runtime.installVersion(config,{versionId:idB});assert.equal(installation.activated,false);assert.equal(installation.activeId,idA);assert.equal(fs.readFileSync(runtime.store.pointerFile,'utf8'),pointerBefore);assert.equal(fs.existsSync(runtime.workFor(config.botQQ,idB)),false);
  const activated=await runtime.activateVersion(config,{versionId:idB,expectedActiveId:idA});assert.equal(activated.versions.activeId,idB);assert.equal(activated.versions.previousId,idA);assert.equal(activated.versions.canRollback,true);
  const bConnection=runtime.resolveConfig(config);assert.notEqual(bConnection.qqToken,aConnection.qqToken);assert.equal(fs.existsSync(path.join(bConnection.napcatFrameworkDir,'config/user-choice.json')),false);fs.writeFileSync(path.join(bConnection.napcatFrameworkDir,'config/user-choice.json'),'{"choice":"B"}');
  await runtime.rollback(config,{expectedActiveId:idB});assert.equal(runtime.resolveConfig(config).qqToken,aConnection.qqToken);assert.equal(fs.readFileSync(aChoice,'utf8'),'{"choice":"A"}');assert.equal(fs.readFileSync(path.join(bConnection.napcatFrameworkDir,'config/user-choice.json'),'utf8'),'{"choice":"B"}');assert.equal((await runtime.inspect(config)).previousId,idB);
  const firstMarker=fs.readFileSync(runtime.privateFile(),'utf8'),pointer=fs.readFileSync(runtime.store.pointerFile,'utf8');await runtime.prepare(config);assert.equal(fs.readFileSync(runtime.privateFile(),'utf8'),firstMarker);assert.equal(fs.readFileSync(runtime.store.pointerFile,'utf8'),pointer);
  assert.ok(!JSON.stringify(await runtime.status(config)).includes(aConnection.qqToken));assert.ok(!JSON.stringify(await runtime.inspect(config)).includes(bConnection.qqToken));
});
test('install alone has no active account and stale activation cannot modify existing active connection',async t=>{
  const f=fixture(t),{runtime,config}=f,{idA,idB}=twoVersions(f);const installed=await runtime.installVersion(config,{versionId:idA});assert.equal(installed.activeId,'');assert.equal((await runtime.status(config)).state,'installed');assert.throws(()=>runtime.resolveConfig(config),/尚未激活/);
  await runtime.activateVersion(config,{versionId:idA,expectedActiveId:''});await runtime.installVersion(config,{versionId:idB});const old=fs.readFileSync(runtime.store.pointerFile,'utf8');await assert.rejects(runtime.activateVersion(config,{versionId:idB,expectedActiveId:''}),/已变化/);assert.equal(fs.readFileSync(runtime.store.pointerFile,'utf8'),old);assert.equal(fs.existsSync(runtime.workFor(config.botQQ,idB)),false);
  await assert.rejects(runtime.installVersion(config,{versionId:'4.18.99-0000000000000000'}),/固定目录/);
});
test('failed install, configuration allocation and pointer commit retain active version and manual stopped state',async t=>{
  const f=fixture(t),{runtime,config}=f,{idA,idB,b}=twoVersions(f);await runtime.prepare(config);fs.writeFileSync(runtime.processFile(),JSON.stringify({schema:1,state:'stopped',reason:'user-selected-stop',processes:[]}));
  const oldPointer=fs.readFileSync(runtime.store.pointerFile,'utf8'),oldConnection=fs.readFileSync(runtime.privateFile(),'utf8'),oldProcess=fs.readFileSync(runtime.processFile(),'utf8');
  runtime.catalogInput=[f.manifest,{...b,files:b.files.map((file,n)=>n?file:{...file,sha256:'0'.repeat(64)})}];const invalidId=versionId(runtime.catalogInput[1]);await assert.rejects(runtime.installVersion(config,{versionId:invalidId}),/SHA256/);assert.equal(fs.existsSync(runtime.store.versionRoot(invalidId)),false);runtime.catalogInput=[f.manifest,b];
  await runtime.installVersion(config,{versionId:idB});const allocate=runtime.allocatePort;runtime.allocatePort=async()=>{throw Error('fixture port allocation failed');};await assert.rejects(runtime.activateVersion(config,{versionId:idB,expectedActiveId:idA}),/allocation failed/);assert.equal(fs.existsSync(runtime.workFor(config.botQQ,idB)),false);runtime.allocatePort=allocate;
  runtime.checkPort=async()=>false;await assert.rejects(runtime.activateVersion(config,{versionId:idB,expectedActiveId:idA}),/端口被占用/);assert.equal(fs.readFileSync(runtime.store.pointerFile,'utf8'),oldPointer);runtime.checkPort=async()=>true;
  runtime.store.commit=()=>{throw Error('fixture commit denied');};await assert.rejects(runtime.activateVersion(config,{versionId:idB,expectedActiveId:idA}),/commit denied/);
  assert.equal(fs.readFileSync(runtime.store.pointerFile,'utf8'),oldPointer);assert.equal(fs.readFileSync(runtime.privateFile(),'utf8'),oldConnection);assert.equal(fs.readFileSync(runtime.processFile(),'utf8'),oldProcess);
  const candidateFile=path.join(runtime.workFor(config.botQQ,idB),'connection.private.json'),candidate=fs.readFileSync(candidateFile,'utf8');runtime.store.commit=atomicPrivate;await runtime.activateVersion(config,{versionId:idB,expectedActiveId:idA});assert.equal(fs.readFileSync(candidateFile,'utf8'),candidate);assert.equal(fs.readFileSync(runtime.processFile(),'utf8'),oldProcess);
});
test('interrupted install and pointer temporary files never replace the last committed active descriptor',async t=>{
  const f=fixture(t),{runtime,config,root,manifest,source}=f,{idA,idB,b}=twoVersions(f);await runtime.prepare(config);const old=fs.readFileSync(runtime.store.pointerFile,'utf8');
  fs.mkdirSync(path.join(runtime.store.directory,'.install-crash/components'),{recursive:true});fs.writeFileSync(path.join(runtime.store.directory,'.install-crash/components/partial'),'partial artifact');fs.writeFileSync(runtime.store.pointerFile+'.interrupted.tmp','{"schema":1,"active":"incomplete"}');
  const restart=new NapcatShellRuntime({runtimeRoot:path.join(root,'private'),manifest,catalog:[manifest,b],sourceRoot:source,platform:'win32',arch:'x64',processes:async()=>[],probe:async()=>{throw Error('fixture offline');}});
  assert.equal((await restart.inspect(config)).activeId,idA);assert.equal(fs.readFileSync(restart.store.pointerFile,'utf8'),old);await restart.installVersion(config,{versionId:idB});await restart.activateVersion(config,{versionId:idB,expectedActiveId:idA});
  const restartedAgain=new NapcatShellRuntime({runtimeRoot:path.join(root,'private'),manifest,catalog:[manifest,b],platform:'win32',arch:'x64',processes:async()=>[],probe:async()=>{throw Error('fixture');}});assert.equal((await restartedAgain.inspect(config)).activeId,idB);assert.equal((await restartedAgain.inspect(config)).previousId,idA);await restartedAgain.rollback(config,{expectedActiveId:idB});assert.equal((await restartedAgain.inspect(config)).activeId,idA);
});
test('legacy current migration validates and copies the same artifact and selected account while preserving original paths',async t=>{
  const {runtime,config,source,manifest}=fixture(t);await prepareComponents({targetRoot:runtime.legacy,sourceRoot:source,manifest});
  const legacyWork=path.join(runtime.work,config.botQQ),saved={schema:1,account:config.botQQ,manifestId:manifestId(validateManifest(manifest)),onebotPort:31001,webuiPort:31002,onebotToken:'a'.repeat(64),webuiToken:'b'.repeat(64)};
  fs.mkdirSync(path.join(legacyWork,'config'),{recursive:true});fs.writeFileSync(path.join(runtime.root,'connection.private.json'),JSON.stringify(saved));fs.writeFileSync(path.join(legacyWork,'config/webui.json'),JSON.stringify({host:'127.0.0.1',port:saved.webuiPort,token:saved.webuiToken,disableWebUI:false,enable2FA:false}));fs.writeFileSync(path.join(legacyWork,`config/onebot11_${config.botQQ}.json`),JSON.stringify({network:{websocketServers:[{name:'qq-rsi-local',host:'127.0.0.1',port:saved.onebotPort,token:saved.onebotToken,enable:true}]}}));
  const originalMarker=fs.readFileSync(path.join(runtime.legacy,'.complete.json'),'utf8'),originalPrivate=fs.readFileSync(path.join(runtime.root,'connection.private.json'),'utf8');assert.equal((await runtime.status(config)).state,'migration_required');
  await runtime.prepare(config);assert.notEqual(runtime.current,runtime.legacy);assert.equal(runtime.resolveConfig(config).qqToken,saved.onebotToken);assert.equal(fs.readFileSync(path.join(runtime.legacy,'.complete.json'),'utf8'),originalMarker);assert.equal(fs.readFileSync(path.join(runtime.root,'connection.private.json'),'utf8'),originalPrivate);assert.equal((await runtime.inspect(config)).legacy.state,'preserved');assert.equal(fs.existsSync(path.join(legacyWork,`config/onebot11_${config.botQQ}.json`)),true);
});
test('activation and rollback never import another account or mutate a running Shell',async t=>{
  const f=fixture(t),{runtime,config}=f,{idA,idB}=twoVersions(f);await runtime.prepare(config);await runtime.start(config);const installed=await runtime.installVersion(config,{versionId:idB});assert.equal(installed.activeId,idA);assert.equal((await runtime.status(config)).process.owned,true);await assert.rejects(runtime.activateVersion(config,{versionId:idB,expectedActiveId:idA}),/仍在运行/);await runtime.stop(config);
  const previousToken=runtime.resolveConfig(config).qqToken,next={botQQ:'100000002'};await runtime.activateVersion(next,{versionId:idB,expectedActiveId:idA});assert.equal((await runtime.inspect(next)).canRollback,false);await assert.rejects(runtime.rollback(next,{expectedActiveId:idB}),/其他账号/);assert.throws(()=>runtime.resolveConfig(config),/当前账号/);assert.equal(JSON.parse(fs.readFileSync(path.join(runtime.workFor(config.botQQ,idA),'connection.private.json'))).onebotToken,previousToken);
});
test('a QQ process appearing while target configuration is prepared aborts activation without changing the active pointer',async t=>{
  const f=fixture(t),{runtime,config}=f,{idA,idB}=twoVersions(f);await runtime.prepare(config);await runtime.installVersion(config,{versionId:idB});const before=fs.readFileSync(runtime.store.pointerFile,'utf8');
  runtime.beforeActivation=()=>f.setSnapshot([{pid:404,parentPid:process.pid,name:'QQ.exe',executable:'C:\\other\\QQ.exe',startedAt:'fixture concurrent start'}]);
  await assert.rejects(runtime.activateVersion(config,{versionId:idB,expectedActiveId:idA}),/仍在运行/);assert.equal(fs.readFileSync(runtime.store.pointerFile,'utf8'),before);assert.equal((await runtime.inspect(config)).activeId,idA);
});
test('revision CAS rejects a stale same-version account switch even when active version ID is unchanged',async t=>{
  const f=fixture(t),{runtime,config}=f,{idA}=twoVersions(f);await runtime.prepare(config);const before=await runtime.inspect(config),next={botQQ:'100000002'};
  await runtime.activateVersion(next,{versionId:idA,expectedActiveId:idA,expectedRevision:before.revision});const pointer=fs.readFileSync(runtime.store.pointerFile,'utf8');
  await assert.rejects(runtime.activateVersion(config,{versionId:idA,expectedActiveId:idA,expectedRevision:before.revision}),/修订已变化/);assert.equal(fs.readFileSync(runtime.store.pointerFile,'utf8'),pointer);assert.equal((await runtime.inspect(next)).revision,before.revision+1);
});
async function runtimeLogFixture(t){
  const {root}=fixture(t),items=[{name:'node.exe',data:'fixture node'},{name:'index.js',data:'fixture entry'},{name:'napcat/napcat.mjs',data:'fixture main'}],bytes=zip(items),manifest={schema:1,platform:'win32',arch:'x64',preset:'official-node',version:'4.18.41',qqVersion:'fixture-native-runtime',localUseApproved:true,entry:{executable:'node.exe',script:'index.js',main:'napcat/napcat.mjs'},artifacts:[{url:'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.41/fixture.zip',sha256:hash(bytes),maxBytes:bytes.length+1}]},target=path.join(root,'node-components'),download=async(a,file)=>fs.writeFileSync(file,bytes);
  await prepareComponents({targetRoot:target,manifest,download});return {root,target,manifest,download};
}
test('only the observed root ordinary beacon log is tolerated and original inventory remains immutable',async t=>{
  const {root,target,manifest}=await runtimeLogFixture(t),marker=path.join(target,'.complete.json'),before=fs.readFileSync(marker,'utf8'),log=path.join(target,'beacon_report.log');
  fs.writeFileSync(log,'native runtime report');assert.equal(inspectComponents(target,manifest).state,'verified');fs.appendFileSync(log,'\nlater native report');assert.equal(inspectComponents(target,manifest).state,'verified');assert.equal(fs.readFileSync(marker,'utf8'),before);assert.equal(JSON.parse(before).inventory.some(f=>f.path==='beacon_report.log'),false);
  fs.writeFileSync(path.join(target,'unrelated.log'),'unexpected');assert.equal(inspectComponents(target,manifest).state,'invalid');fs.rmSync(path.join(target,'unrelated.log'));
  fs.writeFileSync(path.join(target,'index.js'),'modified original');assert.equal(inspectComponents(target,manifest).state,'invalid');fs.writeFileSync(path.join(target,'index.js'),'fixture entry');
  fs.rmSync(log);fs.mkdirSync(log);assert.equal(inspectComponents(target,manifest).state,'invalid');fs.rmSync(log,{recursive:true});fs.writeFileSync(log,'native runtime report');
  const forged=JSON.parse(before);forged.inventory.push({path:'beacon_report.log',sha256:hash('native runtime report')});fs.writeFileSync(marker,JSON.stringify(forged));assert.equal(inspectComponents(target,manifest).state,'invalid');fs.writeFileSync(marker,before);
  const copied=path.join(root,'migrated-components');await prepareComponents({targetRoot:copied,sourceRoot:target,manifest,installedSource:true});assert.equal(inspectComponents(copied,manifest).state,'verified');assert.equal(fs.existsSync(path.join(copied,'beacon_report.log')),false);assert.equal(fs.readFileSync(marker,'utf8'),before);
});
test('a beacon-report link is rejected rather than followed as a runtime log',async t=>{
  const {root,target,manifest}=await runtimeLogFixture(t),outsideDir=path.join(root,'other-directory'),outside=path.join(outsideDir,'other-file');fs.mkdirSync(outsideDir);fs.writeFileSync(outside,'outside log target');
  try{fs.symlinkSync(outside,path.join(target,'beacon_report.log'),'file');}catch(error){if(!['EPERM','EACCES'].includes(error.code))throw error;try{fs.symlinkSync(outsideDir,path.join(target,'beacon_report.log'),'junction');}catch(fallback){if(['EPERM','EACCES'].includes(fallback.code)){t.skip('Windows link creation unavailable');return;}throw fallback;}}
  assert.equal(inspectComponents(target,manifest).state,'invalid');assert.equal(fs.readFileSync(outside,'utf8'),'outside log target');
});
test('installation refuses a runtime beacon log instead of laundering it into a new inventory',async t=>{
  const {root,manifest,download}=await runtimeLogFixture(t),targetRoot=path.join(root,'contaminated-install');
  await assert.rejects(prepareComponents({targetRoot,manifest,download,extract:async(archive,dir)=>{await extractZip(archive,dir);fs.writeFileSync(path.join(dir,'beacon_report.log'),'not part of the verified archive');}}),/不能作为安装组件/);
  assert.equal(fs.existsSync(targetRoot),false);assert.ok(!fs.readdirSync(root).some(name=>name.startsWith('.prepare-')));
});

const guildRuntimeFiles=['guild1.db','guild1.db-shm','guild1.db-wal'];
test('observed official Node guild runtime files stay outside immutable inventory and migration',async t=>{
  const {root,target,manifest}=await runtimeLogFixture(t),marker=path.join(target,'.complete.json'),before=fs.readFileSync(marker,'utf8');
  for(const name of guildRuntimeFiles)fs.writeFileSync(path.join(target,name),'fixture runtime database');
  assert.equal(inspectComponents(target,manifest).state,'verified');
  for(const name of guildRuntimeFiles)fs.appendFileSync(path.join(target,name),' later runtime write');
  assert.equal(inspectComponents(target,manifest).state,'verified');assert.equal(fs.readFileSync(marker,'utf8'),before);
  const migrated=path.join(root,'migrated');await prepareComponents({targetRoot:migrated,sourceRoot:target,manifest,installedSource:true});
  assert.equal(inspectComponents(migrated,manifest).state,'verified');for(const name of guildRuntimeFiles)assert.equal(fs.existsSync(path.join(migrated,name)),false);
  fs.writeFileSync(path.join(target,'unexpected.db'),'fixture');assert.equal(inspectComponents(target,manifest).reasonCode,'unexpected_file');fs.rmSync(path.join(target,'unexpected.db'));
  fs.mkdirSync(path.join(target,'nested'));fs.writeFileSync(path.join(target,'nested','guild1.db'),'fixture');assert.equal(inspectComponents(target,manifest).reasonCode,'unexpected_file');fs.rmSync(path.join(target,'nested'),{recursive:true});
  fs.mkdirSync(path.join(target,'nested','guild1.db'),{recursive:true});assert.equal(inspectComponents(target,manifest).reasonCode,'unexpected_file');fs.rmSync(path.join(target,'nested'),{recursive:true});
  fs.writeFileSync(path.join(target,'index.js'),'changed program');assert.equal(inspectComponents(target,manifest).reasonCode,'file_integrity');
});
test('guild runtime file directories and forged inventory are rejected',async t=>{
  const {target,manifest}=await runtimeLogFixture(t),marker=path.join(target,'.complete.json'),before=fs.readFileSync(marker,'utf8');
  for(const name of guildRuntimeFiles){fs.mkdirSync(path.join(target,name));assert.equal(inspectComponents(target,manifest).reasonCode,'runtime_data_invalid');fs.rmdirSync(path.join(target,name));}
  const forged=JSON.parse(before);forged.inventory.push({path:'guild1.db',sha256:hash('fixture')});fs.writeFileSync(path.join(target,'guild1.db'),'fixture');fs.writeFileSync(marker,JSON.stringify(forged));assert.equal(inspectComponents(target,manifest).reasonCode,'inventory_invalid');
});
test('installation rejects each observed guild runtime file as archive pollution',async t=>{
  const {root,manifest,download}=await runtimeLogFixture(t);
  for(const name of guildRuntimeFiles){const targetRoot=path.join(root,'contaminated-'+name);await assert.rejects(prepareComponents({targetRoot,manifest,download,extract:async(archive,dir)=>{await extractZip(archive,dir);fs.writeFileSync(path.join(dir,name),'fixture runtime');}}),/不能作为安装组件/);assert.equal(fs.existsSync(targetRoot),false);}
});
test('guild runtime links never follow or modify their targets',async t=>{
  const {root,target,manifest}=await runtimeLogFixture(t),outside=path.join(root,'outside');fs.mkdirSync(outside);
  for(const name of guildRuntimeFiles){try{fs.symlinkSync(outside,path.join(target,name),'junction');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Windows link creation unavailable');return;}throw error;}assert.equal(inspectComponents(target,manifest).reasonCode,'runtime_data_invalid');fs.unlinkSync(path.join(target,name));}assert.equal(fs.statSync(outside).isDirectory(),true);
});
test('component failure stays authoritative while online account and owned process remain visible',async t=>{
  const {runtime,config}=fixture(t);await runtime.prepare(config);await runtime.start(config);runtime.probe=async()=>({account:config.botQQ,online:true});fs.writeFileSync(path.join(runtime.current,'unexpected.db'),'fixture');
  const status=await runtime.status(config);assert.equal(status.state,'invalid');assert.equal(status.component.reasonCode,'unexpected_file');assert.equal(status.message,status.component.message);assert.equal(status.interface.online,true);assert.equal(status.interface.accountMatches,true);assert.equal(status.process.state,'running');assert.equal(status.process.owned,true);
});
