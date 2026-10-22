import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {randomBytes,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {probeQQ} from '../onebot.mjs';
import {probePacketQQ} from '../packet-status.mjs';
import {mergeNapcat} from '../napcat-sync.mjs';
import {assertOrdinary,inspectComponents,validateManifest,manifestId} from './components.mjs';
import {processSnapshot,processKey,isQQProcess,descendantProcesses,launchShell,terminateOwned} from './processes.mjs';
import {officialNodeManifest} from './catalog.mjs';
import {VersionStore,versionId,atomicPrivate} from './versions.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function account(config){if(!/^\d{5,20}$/.test(String(config.botQQ??'')))throw Error('请先填写有效的机器人 QQ 账号');return String(config.botQQ);}
function validConnection(saved){return saved?.schema===1&&/^\d{5,20}$/.test(saved.account)&&/^[a-f0-9]{64}$/.test(saved.manifestId)&&Number.isInteger(saved.onebotPort)&&Number.isInteger(saved.webuiPort)&&saved.onebotPort>0&&saved.onebotPort<=65535&&saved.webuiPort>0&&saved.webuiPort<=65535&&saved.onebotPort!==saved.webuiPort&&/^[a-f0-9]{64}$/.test(saved.onebotToken)&&/^[a-f0-9]{64}$/.test(saved.webuiToken)&&saved.onebotToken!==saved.webuiToken;}
function read(file){assertOrdinary(file);return JSON.parse(fs.readFileSync(file,'utf8'));}
function write(file,data){assertOrdinary(file);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(data,null,2),{flag:'wx',mode:0o600});fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}}
async function reservePort(){const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));return port;}
async function portFree(port){const server=net.createServer();try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});return true;}catch{return false;}finally{if(server.listening)await new Promise(resolve=>server.close(resolve));}}
function copyLegacyConfig(source,target,qq){
  assertOrdinary(source);let bytes=0,files=0;
  const visit=(src,dst)=>{fs.mkdirSync(dst,{recursive:true,mode:0o700});for(const item of fs.readdirSync(src,{withFileTypes:true})){const other=/^onebot11_(\d+)\.json$/.exec(item.name);if(other&&other[1]!==qq)continue;const from=assertOrdinary(path.join(src,item.name)),to=path.join(dst,item.name),stat=fs.lstatSync(from);if(stat.isDirectory())visit(from,to);else if(stat.isFile()){bytes+=stat.size;files++;if(stat.size>16*1024**2||bytes>64*1024**2||files>1000)throw Error('旧 QQ Shell 配置复制超过大小限制，原文件保留');fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);}else throw Error('旧 QQ Shell 配置包含特殊文件，原文件保留');}};
  visit(source,target);
}

export class NapcatShellRuntime {
  constructor({runtimeRoot,componentsRoot,manifest,catalog,sourceRoot,probe=probeQQ,processes=processSnapshot,launch=launchShell,terminate=terminateOwned,download,extract,packetProbe=probePacketQQ,allocatePort=reservePort,checkPort=portFree,platform=process.platform,arch=process.arch,settleMs=150,pointerCommit=atomicPrivate,beforeActivation}={}) {
    if(!runtimeRoot)throw Error('QQ Shell 需要私有运行目录');
    this.root=path.join(path.resolve(runtimeRoot),'qq-shell');this.legacy=path.join(this.root,'current');this.work=path.join(this.root,'work');this.store=new VersionStore(this.root,{commit:pointerCommit});
    this.componentsRoot=path.resolve(componentsRoot??path.join(runtimeRoot,'components','napcat-shell'));
    this.manifestInput=manifest;this.catalogInput=catalog;this.sourceRoot=sourceRoot;this.probe=probe;this.processes=processes;this.launch=launch;this.terminate=terminate;this.beforeActivation=beforeActivation;
    this.download=download;this.extract=extract;this.packetProbe=packetProbe;this.allocatePort=allocatePort;this.checkPort=checkPort;this.platform=platform;this.arch=arch;this.settleMs=settleMs;
    this.owner=randomUUID();this.owned=new Map();this.child=null;this.busy=false;this.lastError='';
  }
  defaultManifest(){if(this.manifestInput!==undefined)return this.manifestInput;const file=path.join(this.componentsRoot,'manifest.json');return fs.existsSync(file)?read(file):officialNodeManifest;}
  catalog(){const items=this.catalogInput??(this.defaultManifest()?[this.defaultManifest()]:[]);if(!Array.isArray(items)||items.length>20)throw Error('QQ Shell 固定版本目录无效');const seen=new Set();return items.map(input=>{const manifest=validateManifest(input),id=versionId(manifest);if(seen.has(id))throw Error('QQ Shell 固定版本目录重复');seen.add(id);return {id,manifest};});}
  selection(){const pointer=this.store.pointer();if(pointer)return this.store.selection(pointer.active);const manifest=this.defaultManifest();return {manifest,root:fs.existsSync(this.legacy)?this.legacy:manifest?this.store.components(versionId(manifest)):this.legacy,descriptor:null};}
  get current(){return this.selection().root;}
  manifest(){return this.selection().manifest;}
  privateFile(){const active=this.store.pointer()?.active;return active?path.join(this.workFor(active.account,active.versionId),'connection.private.json'):path.join(this.root,'connection.private.json');}
  processFile(){return path.join(this.root,'process.private.json');}
  workFor(qq,id=this.store.pointer()?.active.versionId??versionId(this.defaultManifest())){return path.join(this.work,id,account({botQQ:qq}));}
  resolveConfig(config) {
    account(config);const descriptor=this.store.pointer()?.active;if(!descriptor)throw Error('QQ Shell 尚未激活版本，请先准备组件');return this.connectionFor(config,descriptor);
  }
  connectionFor(config,descriptor,{workOverride}={}) {
    const {manifest,root}=this.store.selection(descriptor),work=assertOrdinary(workOverride??this.workFor(descriptor.account,descriptor.versionId)),saved=read(path.join(work,'connection.private.json'));
    if(!validConnection(saved)||saved.account!==String(config.botQQ)||saved.account!==descriptor.account||saved.manifestId!==manifestId(manifest))throw Error('QQ Shell 尚未为当前账号准备，或私有连接记录损坏');
    const complete=read(path.join(root,'.complete.json'));if(complete.manifestId!==saved.manifestId)throw Error('QQ Shell 组件准备未完成');
    if(!fs.statSync(work).isDirectory())throw Error('QQ Shell 账号工作目录不可用');
    const web=read(path.join(work,'config','webui.json')),onebot=read(path.join(work,'config',`onebot11_${saved.account}.json`));
    if(web.host!=='127.0.0.1'||web.port!==saved.webuiPort||web.token!==saved.webuiToken||web.disableWebUI===true||web.enable2FA===true)throw Error('QQ Shell 私有管理接口配置与连接记录不一致');
    const listener=onebot?.network?.websocketServers?.find(x=>x.name==='qq-rsi-local');
    if(!listener||listener.host!=='127.0.0.1'||listener.port!==saved.onebotPort||listener.token!==saved.onebotToken||listener.enable!==true)throw Error('QQ Shell 私有 OneBot 配置与连接记录不一致');
    return {...config,qqUrl:`ws://127.0.0.1:${saved.onebotPort}`,qqToken:saved.onebotToken,napcatFrameworkDir:work};
  }
  async exclusive(callback) {
    if(this.busy)throw Error('QQ Shell 管理操作正在进行');this.busy=true;
    let fd;const lock=path.join(this.root,'operation.lock');
    try{assertOrdinary(this.root);fs.mkdirSync(this.root,{recursive:true,mode:0o700});try{fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({owner:this.owner,pid:process.pid}));}catch{throw Error('另一个 QQ Shell 操作未确认结束，请检查后再恢复');}return await callback();}
    finally{if(fd!==undefined){fs.closeSync(fd);fs.rmSync(lock,{force:true});}this.busy=false;}
  }
  async inventory() {
    const snapshot=await this.processes();this.owned=descendantProcesses(snapshot,this.owned,p=>this.withinComponents(p));
    const saved=fs.existsSync(this.processFile())?read(this.processFile()):null;
    const managedExecutable=p=>{if(!p.executable||path.basename(p.executable).toLowerCase()!=='node.exe')return false;const relative=path.relative(this.root,path.resolve(p.executable));return relative&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);};
    const alive=[...this.owned.values()].filter(p=>snapshot.some(x=>processKey(x)===processKey(p))),external=snapshot.filter(p=>isQQProcess(p)||managedExecutable(p)||(saved?.pid&&p.pid===saved.pid)).filter(p=>!this.owned.has(processKey(p)));
    // Persistent records help diagnose an interrupted service; they never confer
    // permission to adopt or stop a live process after service restart.
    const previousAlive=saved?.processes?.filter(p=>snapshot.some(x=>processKey(x)===processKey(p)))??[];
    return {snapshot,alive,external,previousAlive,saved};
  }
  withinComponents(item){if(!item.executable)return false;const relative=path.relative(this.current,path.resolve(item.executable));return relative!==''&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);}
  async status(config) {
    let component;try{component=inspectComponents(this.current,this.manifest());}catch{component={state:'invalid',version:'',message:'QQ Shell 组件清单读取失败'};}
    const result={backend:'shell',state:component.state==='verified'?'prepared':component.state,component,validation:{components:component.state==='verified'?'verified':'unverified',launch:'unverified',realQQ:'unverified'},connection:{state:'missing'},process:{state:'stopped',owned:false},interface:{online:false,account:'',accountMatches:false},capabilities:{packet:{state:'unknown',message:'高级消息能力尚未验证'}},message:component.message};
    try{result.versions=await this.inspect(config);}catch{result.versions={catalog:[],activeId:'',previousId:'',canRollback:false,legacy:{state:fs.existsSync(this.legacy)?'detected':'absent'},error:'QQ Shell 版本记录无效，保留现场'};result.state='invalid';}
    try{this.resolveConfig(config);result.connection.state='prepared';}catch{let hasConnection=false;try{hasConnection=fs.existsSync(this.privateFile());}catch{}if(hasConnection){result.connection.state='invalid';if(component.state==='verified'){result.state='invalid';result.message='组件摘要已校验，但当前账号私有连接记录无效；真实 QQ 启动尚未验证';}}}
    if(component.state==='verified'&&!result.versions?.activeId){result.state=fs.existsSync(this.legacy)?'migration_required':'installed';result.message=fs.existsSync(this.legacy)?'检测到旧 QQ Shell 目录；原路径保留，请准备组件完成受管迁移':'QQ Shell 组件已安装，尚未激活';}
    let inv;try{inv=await this.inventory();}catch{result.state='blocked';result.process.state='unknown';result.message='无法核实 QQ 进程，保持停止';return result;}
    if(inv.alive.length){result.process={state:'running',owned:true,pid:this.child?.pid??inv.alive[0].pid};result.validation.launch='process_observed';result.state='starting';result.message='受管 QQ Shell 正在运行，等待账号与在线接口校验';}
    else if(inv.previousAlive.length||inv.external.length){result.process={state:'orphaned',owned:false};result.state='blocked';result.message='发现已有或归属未确认的 QQ 进程，请先检查现有登录，不会启动或停止它';}
    else if(inv.saved?.state==='exit_unconfirmed'){result.process.state='exit_unconfirmed';result.state='exit_unconfirmed';result.message='上次 QQ Shell 退出未确认，请检查后再尝试停止';}
    else if(component.state==='verified'&&result.connection.state==='prepared')result.message='QQ Shell 组件与连接已准备，真实 QQ 启动尚未验证';
    try {
      const resolved=this.resolveConfig(config),online=await this.probe(resolved);
      // An injected probe has the same contract as probeQQ; independently check
      // its result so mere socket connectivity can never report ready.
      if(online?.online!==true||String(online.account)!==String(config.botQQ))throw Error('identity');
      result.interface={online:true,account:String(online.account),accountMatches:true};result.validation.realQQ='account_online_verified';
      if(result.process.owned){result.state='online';result.message='QQ Shell 在线，账号与面板一致';}
      else {result.state='blocked';result.message='QQ 接口在线，但进程归属未确认，不会接管或重启';}
      if(this.packetProbe){try{result.capabilities.packet=await this.packetProbe(resolved);}catch{result.capabilities.packet={state:'unknown',message:'高级消息能力探测未完成'};}}
    }catch{}
    // Account connectivity cannot override a failed immutable-program check.
    // Keep the independently observed process/account fields for diagnosis.
    if(component.state==='invalid'){result.state='invalid';result.message=component.message;}
    return result;
  }
  async inspect(config) {
    const pointer=this.store.pointer(),entries=this.catalog(),known=new Map(entries.map(x=>[x.id,x]));
    for(const descriptor of [pointer?.active,pointer?.previous].filter(Boolean))if(!known.has(descriptor.versionId))known.set(descriptor.versionId,{id:descriptor.versionId,manifest:this.store.selection(descriptor).manifest});
    const catalog=[...known.values()].map(({id,manifest})=>{const component=this.store.inspect(id);return {id,version:manifest.version,qqVersion:manifest.qqVersion,installed:component.state==='verified',active:pointer?.active.versionId===id,previous:pointer?.previous?.versionId===id,componentState:component.state,validation:'components_only',available:entries.some(x=>x.id===id)};});
    let canRollback=!!pointer?.previous&&pointer.previous.account===String(config.botQQ)&&pointer.active.account===String(config.botQQ)&&this.store.inspect(pointer.previous.versionId).state==='verified';
    if(canRollback)try{this.connectionFor(config,pointer.previous);}catch{canRollback=false;}
    return {catalog,activeId:pointer?.active.versionId??'',previousId:pointer?.previous?.versionId??'',revision:pointer?.generation??0,canRollback,legacy:{state:fs.existsSync(this.legacy)?pointer?'preserved':'detected':'absent'}};
  }
  async assertStopped(){const inv=await this.inventory();if(inv.alive.length||inv.previousAlive.length||inv.external.length||inv.saved?.state==='exit_unconfirmed')throw Error('QQ 进程仍在运行或归属未确认，不能准备或更换组件');return inv;}
  async installSelected(id) {
    const entry=this.catalog().find(x=>x.id===id);if(!entry)throw Error('只能安装固定目录内已核实的 QQ Shell 版本');const {manifest}=entry;
    if(this.platform!=='win32'||manifest.arch!==this.arch)throw Error('QQ Shell 组件与当前 Windows 架构不符');
    const legacy=fs.existsSync(this.legacy)&&inspectComponents(this.legacy,manifest).state==='verified';
    const installed=await this.store.install(manifest,{sourceRoot:legacy?this.legacy:this.sourceRoot,installedSource:legacy,download:this.download,extract:this.extract});
    return {...installed,migratedLegacy:legacy};
  }
  async installVersion(config,{versionId:id}={}) {return this.exclusive(async()=>{account(config);const installed=await this.installSelected(id);return {...await this.inspect(config),installedId:installed.id,reused:installed.reused,activated:false};});}
  async ensureConnection(config,descriptor) {
    const qq=account(config),work=assertOrdinary(this.workFor(qq,descriptor.versionId)),{manifest,root}=this.store.selection(descriptor);
    if(fs.existsSync(work)){try{this.connectionFor(config,descriptor);}catch(error){throw Error('QQ Shell 私有连接记录损坏或配置无效，已保留现场，不会覆盖：'+error.message);}return;}
    const parent=assertOrdinary(path.dirname(work));fs.mkdirSync(parent,{recursive:true,mode:0o700});const stage=path.join(parent,'.prepare-work-'+randomUUID());fs.mkdirSync(stage,{mode:0o700});
    try {
      let saved;const legacyFile=path.join(this.root,'connection.private.json');
      if(!this.store.pointer()&&fs.existsSync(this.legacy)&&inspectComponents(this.legacy,manifest).state==='verified'&&fs.existsSync(legacyFile)) {
        const old=read(legacyFile);if(!validConnection(old))throw Error('旧 QQ Shell 私有连接记录损坏，保留现场');
        if(old.account===qq&&old.manifestId===descriptor.manifestId){saved=old;const legacyConfig=path.join(this.work,qq,'config');if(fs.existsSync(legacyConfig))copyLegacyConfig(legacyConfig,path.join(stage,'config'),qq);}
      }
      if(!saved){const onebotPort=await this.allocatePort();let webuiPort=await this.allocatePort();for(let attempt=0;webuiPort===onebotPort&&attempt<10;attempt++)webuiPort=await this.allocatePort();if(onebotPort===webuiPort)throw Error('无法分配两个独立本机端口');saved={schema:1,account:qq,manifestId:descriptor.manifestId,onebotPort,webuiPort,onebotToken:randomBytes(32).toString('hex'),webuiToken:randomBytes(32).toString('hex')};}
      const dir=path.join(stage,'config');fs.mkdirSync(dir,{recursive:true,mode:0o700});
      if(!fs.existsSync(path.join(dir,'webui.json')))write(path.join(dir,'webui.json'),{host:'127.0.0.1',port:saved.webuiPort,token:saved.webuiToken,enable2FA:false,disableWebUI:false,disableNonLANLogin:false});
      if(!fs.existsSync(path.join(dir,`onebot11_${qq}.json`)))write(path.join(dir,`onebot11_${qq}.json`),mergeNapcat({}, {qqUrl:`ws://127.0.0.1:${saved.onebotPort}`,qqToken:saved.onebotToken}));
      write(path.join(stage,'connection.private.json'),saved);this.connectionFor(config,descriptor,{workOverride:stage});fs.renameSync(stage,work);
      if(manifest.preset==='native-shell'){const main=path.join(root,...manifest.entry.main.split('/'));fs.writeFileSync(assertOrdinary(path.join(root,'loadNapCat.js')),`(async () => { await import(${JSON.stringify(pathToFileURL(main).href)}); })();\n`,{mode:0o600});}
      this.connectionFor(config,descriptor);
    }finally{fs.rmSync(stage,{recursive:true,force:true});}
  }
  async activateSelected(config,id,{expectedActiveId,expectedRevision}={}) {
    const qq=account(config);await this.assertStopped();const manifest=this.store.manifest(id),descriptor={versionId:id,manifestId:manifestId(manifest),account:qq};
    if(this.platform!=='win32'||manifest.arch!==this.arch)throw Error('QQ Shell 版本与当前 Windows 架构不符');
    if(this.store.inspect(id).state!=='verified')throw Error('目标 QQ Shell 版本组件未通过校验');
    const prior=this.store.pointer();if(expectedActiveId!==undefined&&expectedActiveId!==(prior?.active.versionId??''))throw Error('活动 QQ Shell 版本已变化，请刷新后重试');
    if(expectedRevision!==undefined&&(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision!==(prior?.generation??0)))throw Error('QQ Shell 活动账号或版本修订已变化，请刷新后重试');
    await this.ensureConnection(config,descriptor);await this.beforeActivation?.({versionId:id});await this.assertStopped();this.connectionFor(config,descriptor);
    const saved=read(path.join(this.workFor(qq,id),'connection.private.json'));if(!await this.checkPort(saved.onebotPort)||!await this.checkPort(saved.webuiPort))throw Error('目标 QQ Shell 本机端口被占用，保留当前活动版本');
    const result=this.store.activate(descriptor,{expectedActiveId,expectedRevision});return {...await this.status(config),activated:true,reused:result.reused};
  }
  async activateVersion(config,{versionId:id,expectedActiveId,expectedRevision}={}) {return this.exclusive(()=>this.activateSelected(config,id,{expectedActiveId,expectedRevision}));}
  async rollback(config,{expectedActiveId,expectedRevision}={}) {return this.exclusive(async()=>{const pointer=this.store.pointer();if(!pointer?.previous)throw Error('尚无可回退的已激活版本');if(pointer.active.account!==account(config)||pointer.previous.account!==String(config.botQQ))throw Error('回退版本属于其他账号，不会自动导入或切换账号');return this.activateSelected(config,pointer.previous.versionId,{expectedActiveId,expectedRevision});});}
  async prepare(config) {return this.exclusive(async()=>{
    account(config);await this.assertStopped();const manifest=validateManifest(this.defaultManifest()),id=versionId(manifest),installed=await this.installSelected(id),pointer=this.store.pointer();
    if(pointer&&pointer.active.versionId!==id)return {...await this.status(config),prepared:true,installedId:id,activationRequired:true,reused:installed.reused};
    return {...await this.activateSelected(config,id,{expectedActiveId:pointer?.active.versionId??'',expectedRevision:pointer?.generation??0}),prepared:true,reused:installed.reused};
  });}
  async start(config) {return this.exclusive(async()=>{
    account(config);if(this.platform!=='win32')throw Error('QQ Shell 仅支持 Windows');
    if(validateManifest(this.manifest()).arch!==this.arch)throw Error('QQ Shell 版本与当前 Windows 架构不符');
    const component=inspectComponents(this.current,this.manifest());if(component.state!=='verified')throw Error(component.message);
    const resolved=this.resolveConfig(config),inv=await this.inventory();
    if(inv.alive.length)return this.status(config);
    if(inv.previousAlive.length||inv.external.length||inv.saved?.state==='exit_unconfirmed')throw Error('已有 QQ 或上次退出未确认，不会重复启动');
    const saved=read(this.privateFile());if(!await this.checkPort(saved.onebotPort)||!await this.checkPort(saved.webuiPort))throw Error('QQ Shell 本机端口被占用，不会覆盖其他服务');
    // A second inventory closes the ordinary-QQ-start race during validation.
    const finalInventory=await this.inventory();if(finalInventory.external.length||finalInventory.previousAlive.length)throw Error('QQ 已在其他地方启动，不会重复打开');
    const manifest=validateManifest(this.manifest());this.owned.clear();
    const child=this.launch({root:this.current,entry:manifest.entry,preset:manifest.preset,workDir:this.workFor(config.botQQ),config:resolved});this.child=child;
    let spawnError;child.once('error',()=>{spawnError=true;});
    write(this.processFile(),{schema:1,state:'starting',owner:this.owner,pid:child.pid??null,processes:[]});
    await wait(this.settleMs);
    const executable=manifest.preset==='official-node'?manifest.entry.executable:manifest.entry.launcher;
    const snapshot=await this.processes(),root=snapshot.find(p=>p.pid===child.pid&&p.startedAt&&p.executable&&path.resolve(p.executable).toLowerCase()===path.resolve(this.current,executable).toLowerCase());
    if(root){this.owned.set(processKey(root),root);this.owned=descendantProcesses(snapshot,this.owned,p=>this.withinComponents(p));}
    if(spawnError||!root){write(this.processFile(),{schema:1,state:'exit_unconfirmed',owner:this.owner,pid:child.pid??null,processes:[]});throw Error('QQ Shell 启动或进程归属未确认，请检查现有进程；不会自动重启');}
    write(this.processFile(),{schema:1,state:'running',owner:this.owner,processes:[...this.owned.values()]});return this.status(config);
  });}
  async stop(config) {return this.exclusive(async()=>{
    const inv=await this.inventory();
    if(inv.previousAlive.some(p=>!this.owned.has(processKey(p)))||(!inv.alive.length&&inv.external.length))throw Error('QQ 进程不属于本次服务，不能停止');
    let failed=false;
    for(const p of [...inv.alive].reverse())try{await this.terminate(p);}catch{failed=true;}
    await wait(this.settleMs);
    const after=await this.inventory();
    if(failed||after.alive.length||after.external.some(p=>inv.snapshot.some(x=>this.owned.has(processKey(x))&&x.pid===p.parentPid))){write(this.processFile(),{schema:1,state:'exit_unconfirmed',owner:this.owner,processes:[...this.owned.values()]});throw Error('QQ Shell 退出未确认，不会自动强退、重启或替换实例');}
    this.child=null;this.owned.clear();write(this.processFile(),{schema:1,state:'stopped',owner:this.owner,processes:[]});return this.status(config);
  });}
}

export {inspectComponents,prepareComponents,validateManifest} from './components.mjs';
