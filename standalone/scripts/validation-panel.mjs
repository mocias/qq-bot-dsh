// Isolated source-panel entry. It never imports deployment configuration or
// starts QQ components automatically. Default mode simulates QQ and DSH.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {createApp} from '../server.mjs';
import {validate,writeJson} from '../lib/config.mjs';

export async function createValidationPanel({mode='mock',runtime,botQQ='',privatePeer='',resume=false}={}){
 if(!['mock','components'].includes(mode))throw Error('请选择 mock 或 components 验收模式');
 let config=validate({qqBackend:'shell',botQQ,privateUsers:privatePeer?[privatePeer]:[],groups:[]});
 if(privatePeer&&!botQQ)throw Error('指定验收私聊对象时，必须同时指定机器人账号');
 runtime=runtime?path.resolve(runtime):fs.mkdtempSync(path.join(os.tmpdir(),'qq-rsi-validation-'));
 let marker={schema:1,purpose:'qq-rsi-isolated-validation',mode,botQQ,privatePeer,createdAt:new Date().toISOString()};
 if(resume){
  if(mode!=='components'||!path.basename(runtime).startsWith('qq-rsi-validation-'))throw Error('只能恢复本入口创建的独立组件验收目录');
  const saved=JSON.parse(fs.readFileSync(path.join(runtime,'validation.private.json'),'utf8')),savedConfig=validate(JSON.parse(fs.readFileSync(path.join(runtime,'config.private.json'),'utf8')));
  if(saved.schema!==1||saved.purpose!==marker.purpose||saved.mode!==mode||saved.botQQ!==botQQ||saved.privatePeer!==privatePeer||savedConfig.qqBackend!=='shell'||savedConfig.botQQ!==botQQ||savedConfig.groups.length||JSON.stringify(savedConfig.privateUsers)!==JSON.stringify(config.privateUsers))throw Error('验收标记或账号范围不符，不恢复此目录');
  const launchFile=path.join(runtime,'validation-launch.private.json');if(fs.existsSync(launchFile)){const launch=JSON.parse(fs.readFileSync(launchFile,'utf8'));if(Number.isSafeInteger(launch.pid)&&launch.pid>0){let alive=false;try{process.kill(launch.pid,0);alive=true;}catch(error){if(error.code!=='ESRCH')throw Error('无法确认旧验收面板退出');}if(alive)throw Error('旧验收面板仍在运行或进程尚未确认退出，不重复打开');}}
  marker=saved;config=savedConfig;
 }else if(fs.existsSync(runtime)&&fs.readdirSync(runtime).length)throw Error('验收入口只使用全新空目录，不覆盖已有资料');
 fs.mkdirSync(runtime,{recursive:true});
 const dsh=http.createServer((req,res)=>{res.writeHead(503);res.end('Isolated DSH mock: no model is connected.');});
 dsh.on('upgrade',(req,socket)=>socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'));
 dsh.listen(0,'127.0.0.1');await once(dsh,'listening');config.dshUrl='http://127.0.0.1:'+dsh.address().port;
 writeJson(path.join(runtime,'config.private.json'),config);writeJson(path.join(runtime,'validation.private.json'),marker);
 let app,wss,prepared=false,running=false,online=false,activeId='',previousId='',currentAccount='',revision=0;
 const installed=new Set(),secret=randomBytes(32).toString('hex');
 const catalog=[{id:'mock-a',version:'模拟版本 A',qqVersion:'模拟账号组件'},{id:'mock-b',version:'模拟版本 B',qqVersion:'模拟账号组件'}];
 const versions=()=>({catalog:catalog.map(item=>({...item,installed:installed.has(item.id),active:activeId===item.id,previous:previousId===item.id,componentState:installed.has(item.id)?'verified':'missing'})),activeId,previousId,revision,canRollback:!!previousId,legacy:{state:'absent'}});
 const check=({versionId,expectedActiveId,expectedRevision},switching=false)=>{if(switching&&running)throw Error('请先停止模拟 QQ 登录进程');if(versionId&&!catalog.some(item=>item.id===versionId))throw Error('该模拟版本不在受控列表');if(switching&&(expectedActiveId!==activeId||expectedRevision!==revision))throw Error('当前版本已变化，请刷新后重试');};
 let overrides={};
 if(mode==='mock'){
  wss=new WebSocketServer({host:'127.0.0.1',port:0});await once(wss,'listening');
  wss.on('connection',(socket,req)=>{if(req.headers.authorization!=='Bearer '+secret){socket.close();return;}socket.on('message',bytes=>{const frame=JSON.parse(bytes);let data;if(frame.action==='get_login_info')data={user_id:currentAccount,nickname:'模拟账号'};else if(frame.action==='get_status')data={online,good:true};else{socket.send(JSON.stringify({status:'failed',retcode:1404,echo:frame.echo}));return;}socket.send(JSON.stringify({status:'ok',retcode:0,echo:frame.echo,data}));});});
  const qqRuntime={
   resolveConfig:c=>{if(!prepared||!activeId)throw Error('请先准备并使用模拟组件');return {...c,qqUrl:'ws://127.0.0.1:'+wss.address().port,qqToken:secret,napcatFrameworkDir:path.join(runtime,'mock-only')};},
   status:async()=>({state:prepared?'prepared':'missing',component:{state:prepared?'verified':'missing',message:'隔离模拟组件，不代表真实 QQ 安装或登录'},process:{state:running?'running':'stopped',owned:running},capabilities:{packet:{state:'unsupported'}},versions:versions(),message:prepared?'模拟组件已准备':'模拟组件尚未准备'}),
   prepare:async()=>{installed.add('mock-a');if(!activeId){activeId='mock-a';revision++;}prepared=true;return {message:'模拟组件已准备'};},
   start:async c=>{if(!activeId)throw Error('请先准备并使用模拟组件');running=true;currentAccount=c.botQQ;return {message:'模拟登录进程已启动，不会启动真实 QQ'};},
   stop:async()=>{running=false;online=false;return {message:'模拟登录进程已停止'};},
   installVersion:async(c,input)=>{check(input);installed.add(input.versionId);return {message:'模拟版本已准备，当前使用版本未改变'};},
   activateVersion:async(c,input)=>{check(input,true);if(!installed.has(input.versionId))throw Error('请先准备所选模拟版本');if(activeId!==input.versionId){previousId=activeId;activeId=input.versionId;revision++;}prepared=true;return {message:'模拟版本已切换，接收保持停止'};},
   rollback:async(c,input)=>{check(input,true);if(!previousId)throw Error('尚无可回退版本');[activeId,previousId]=[previousId,activeId];revision++;return {message:'模拟版本已回退，接收保持停止'};},
  };
  const qqControl={status:async c=>({expectedAccount:c.botQQ,account:online?currentAccount:'',online,accountMatches:online&&currentAccount===c.botQQ,interfaceOnline:online,napcatReady:running,message:online?'模拟账号核验通过':'等待模拟扫码登录'}),qrcode:async()=>{if(!running)throw Error('请先启动模拟登录进程');online=true;return {image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5uQAAAAASUVORK5CYII=',message:'这是模拟二维码，不会连接 QQ；刷新状态可查看模拟核验结果。'};},contacts:async c=>{if(!online||currentAccount!==c.botQQ)throw Error('请先完成模拟账号核验');return {account:currentAccount,items:[{id:privatePeer||'100000002',name:'隔离模拟好友'}]};}};
  const bridge={status:{state:'stopped',active:0,channels:{private:false,group:false}},summary:()=>[],start:async(c,kind)=>{bridge.status={state:'running',active:0,account:c.botQQ,channels:{private:kind!=='group',group:kind!=='private'}};},stop:()=>{bridge.status={state:'stopped',active:0,channels:{private:false,group:false}};}};
  overrides={qqRuntime,qqControl,bridge,voice:{status:()=>({provider:'local',ttsReady:false,asrReady:false}),listReferences:()=>[]}};
 }
 const validationMessage=mode==='mock'?'隔离模拟验收：QQ 登录、版本、联系人与接收均为模拟；DSH 未连接真实模型。':'独立组件验收：使用全新资料，QQ 组件不会自动启动；DSH 仅模拟，群聊名单为空。';
 app=createApp({runtime,...overrides,validationMessage});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 let closed=false;const close=async()=>{if(closed)return;closed=true;app.bridge.stop();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));if(wss){for(const socket of wss.clients)socket.terminate();await new Promise(r=>wss.close(r));}dsh.closeAllConnections();await new Promise(r=>dsh.close(r));};
 return {app,runtime,mode,close};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),known=['--components','--bot-qq=','--private-peer=','--resume-runtime='];
 if(args.some(arg=>!known.some(item=>item.endsWith('=')?arg.startsWith(item):arg===item)))throw Error('可用参数：--components --bot-qq=<账号> --private-peer=<唯一私聊对象>');
 const value=name=>args.find(arg=>arg.startsWith(name+'='))?.slice(name.length+1)||'';
 const panel=await createValidationPanel({mode:args.includes('--components')?'components':'mock',botQQ:value('--bot-qq'),privatePeer:value('--private-peer'),...(value('--resume-runtime')?{runtime:value('--resume-runtime'),resume:true}:{})});
 const loginUrl=panel.app.loginUrl();writeJson(path.join(panel.runtime,'validation-launch.private.json'),{url:loginUrl,pid:process.pid,mode:panel.mode});
 fs.writeFileSync(path.join(panel.runtime,'open-panel.private.url'),'[InternetShortcut]\r\nURL='+loginUrl+'\r\n',{mode:0o600});
 console.log((panel.mode==='mock'?'隔离模拟验收面板':'独立组件验收面板')+'已启动；QQ 接收保持停止。\n资料目录：'+panel.runtime+'\n面板地址：'+new URL(loginUrl).origin+'\n打开入口：'+path.join(panel.runtime,'open-panel.private.url'));
 let closing=false;const stop=async()=>{if(closing)return;closing=true;await panel.close();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
