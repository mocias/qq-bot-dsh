import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Media,publicAddress,publicDownload,fencedRead } from '../lib/media.mjs';
import { Proactive,groupRateAllowed } from '../lib/proactive.mjs';
import { DesktopQQ,launchDecision } from '../lib/desktop-qq.mjs';
import { defaults,validate } from '../lib/config.mjs';
import { Bridge } from '../lib/bridge.mjs';
import { initializeLife } from '../lib/lifecycle.mjs';
import { MemoryStore } from '../lib/memory.mjs';
const key='123456/private/234567',route={key,id:'234567',sender:'234567',group:false,messageId:'m1',text:'你好'};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfWQAAAAASUVORK5CYII=','base64');
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-migration-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function wav(){
  const b=Buffer.alloc(364);b.write('RIFF');b.writeUInt32LE(356,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(320,40);return b;
}
test('image and forwarded-image bytes become real model attachments; records use resolved trusted files',async t=>{
  const runtime=temp(t),audio=path.join(runtime,'record.wav');fs.writeFileSync(audio,wav());const calls=[];
  const media=new Media(runtime,{download:async()=>png,call:async(action,params)=>{
    calls.push([action,params]);
    if(action==='get_image')return {url:'https://images.example.org/x.png'};
    if(action==='get_record')return {file:audio};
    if(action==='get_forward_msg')return {messages:[{type:'node',data:{nickname:'引用者',message:[{type:'text',data:{text:'转发正文'}},{type:'image',data:{file:'embedded'}}]}}]};
  },voice:{transcribeRecord:async file=>{assert.ok(fs.existsSync(file));return {text:'识别后的语音'};}}});
  const result=await media.incoming({...route,segments:[{type:'image',data:{file:'direct'}},{type:'forward',data:{id:'forward'}},{type:'record',data:{file:'opaque'}}]},{...defaults,qqMediaRoots:[runtime]});
  assert.equal(result.images.length,2);assert.equal(result.images[0].data,png.toString('base64'));
  assert.match(result.text,/引用者[\s\S]*转发正文/);assert.match(result.text,/识别后的语音/);
  assert.deepEqual(calls.find(x=>x[0]==='get_forward_msg')[1],{id:'forward',message_id:'forward'});
  assert.equal(result.mediaFailures.length,0);
});
test('media security rejects private DNS, local paths from sender and cross-chat output paths',async t=>{
  for(const ip of ['127.0.0.1','10.1.2.3','169.254.1.2','::1','::ffff:127.0.0.1','fc00::1'])assert.equal(publicAddress(ip),false);
  await assert.rejects(publicDownload('https://images.example.org/a',{lookup:async()=>[{address:'127.0.0.1',family:4}]}),/内网/);
  const root=temp(t),other=path.join(root,'private');fs.mkdirSync(other);const file=path.join(other,'private.png');fs.writeFileSync(file,png);
  assert.throws(()=>fencedRead(file,[path.join(root,'workspace')]),/允许/);
  const media=new Media(root,{call:async()=>({file}),voice:{}});
  const result=await media.incoming({...route,segments:[{type:'image',data:{file:'opaque',url:file}}]},defaults);
  assert.equal(result.images.length,0);assert.match(result.text,/读取失败/);
  await assert.rejects(media.outgoing({reply:'',qq:{images:[file]}},route,{workspace:path.join(root,'workspace')},defaults),/允许/);
});
test('NapCat converted recording bytes work without granting QQ cache directory access',async t=>{
  const root=temp(t),media=new Media(root,{call:async()=>({file:'untrusted-cache-path',base64:wav().toString('base64')}),voice:{transcribeRecord:async file=>{assert.deepEqual(fs.readFileSync(file),wav());return {text:'转换成功'};}}});
  const result=await media.incoming({...route,segments:[{type:'record',data:{file:'opaque'}}]},defaults);
  assert.match(result.text,/转换成功/);assert.deepEqual(result.mediaFailures,[]);
});
test('sender paths and URL-shaped file IDs cannot ask OneBot to read arbitrary media',async t=>{
  let calls=0;const media=new Media(temp(t),{call:async()=>{calls++;return {base64:png.toString('base64')};},voice:{}});
  const result=await media.incoming({...route,segments:[{type:'image',data:{file:'C:/private/photo.png'}},{type:'record',data:{file:'http://127.0.0.1/private.wav'}}]},defaults);
  assert.equal(calls,0);assert.equal(result.images.length,0);assert.deepEqual(result.mediaFailures,['image','record']);
});
test('outgoing image, merged-forward and voice follow original envelopes and fallback only before send',async t=>{
  const root=temp(t),media=new Media(root,{now:()=>Date.parse('2026-10-20T04:00:00Z'),call:async()=>{},download:async()=>png,voice:{synthesize:async()=>({id:'audio'}),audio:()=>wav()}});
  const session={workspace:root};
  const image=await media.outgoing({reply:'图',qq:{images:['https://images.example.org/a']}},route,session,defaults);
  assert.equal(image.action,'send_private_msg');assert.equal(image.params.user_id,route.id);assert.match(image.params.message[1].data.file,/^base64:\/\//);
  const forward=await media.outgoing({reply:'',qq:{forward:[{name:'助手',content:'正文'}]}},route,session,defaults);
  assert.equal(forward.action,'send_private_forward_msg');assert.equal(forward.params.messages[0].data.uin,'123456');
  const voice=await media.outgoing({reply:'',qq:{voice:'你好'}},route,session,{...defaults,voiceReplyMode:'voice'});
  assert.equal(voice.params.message.length,1);assert.equal(voice.params.message[0].type,'record');
  media.voice.synthesize=async()=>{throw Error('offline');};
  const fallback=await media.outgoing({reply:'',qq:{voice:'你好'}},route,session,{...defaults,voiceReplyMode:'voice'});
  assert.equal(fallback.params.message[0].data.text,'你好');
  const quiet=await media.outgoing({reply:'[[qq_voice]]你好[[/qq_voice]]'},route,session,{...defaults,voiceReplyMode:'text'});
  assert.equal(quiet.params.message[0].data.text,'你好');
  await assert.rejects(media.outgoing({reply:'',qq:{images:[],user_id:'another'}},route,session,defaults),/格式/);
});
test('quiet modes support all-day silence, unrestricted hours and overnight scheduled silence',async t=>{
 const root=temp(t);let now=Date.parse('2026-10-20T16:00:00Z'),calls=0;
 const media=new Media(root,{now:()=>now,voice:{synthesize:async()=>{calls++;return {id:'audio'};},audio:()=>wav()}});
 const send=mode=>media.outgoing({reply:'',qq:{voice:'你好'}},route,{workspace:root},{...defaults,voiceReplyMode:'voice',voiceQuietMode:mode});
 assert.equal((await send('scheduled')).params.message[0].type,'text');
 assert.equal((await send('never')).params.message[0].type,'record');
 assert.equal((await send('always')).params.message[0].type,'text');
 now=Date.parse('2026-10-20T04:00:00Z');assert.equal((await send('scheduled')).params.message[0].type,'record');assert.equal(calls,2);
 assert.throws(()=>validate({voiceQuietMode:'bad'}));
 const cfg=validate({chatPolicy:{group:{voiceQuietMode:'always'},overrides:{'123456/group/234567':{voiceQuietMode:'never'}}}});assert.equal(cfg.chatPolicy.group.voiceQuietMode,'always');
});
test('original recall scheduler persists reservations, caps daily attempts and waits for real activity',async t=>{
  const root=temp(t);let now=Date.parse('2026-10-20T02:00:00Z');
  const store=new MemoryStore(root,key);
  store.commit([{action:'write',page:'user/tea.md',text:'# 茶\n喜欢红茶',reason:'用户要求',evidence:['m']}],{id:'m',evidenceIds:['m'],summary:'喜欢红茶'});
  const session={id:'s',route,lastUserAt:now,blocked:false};initializeLife(session,now);
  const config={...defaults,recallEnabled:true,recallMinSeconds:60,recallMaxSeconds:60,recallMaxPerDay:1};
  const scheduler=new Proactive(root,{now:()=>now,random:()=>0});
  const opts={activeKey:key,call:async()=>{}};
  assert.equal(await scheduler.candidate(session,config,store,opts),null);
  now+=60001;const candidate=await scheduler.candidate(session,config,store,opts);assert.match(candidate.route.text,/主动搭话/);
  candidate.reserve();now+=60001;
  assert.equal(await new Proactive(root,{now:()=>now}).candidate(session,config,store,opts),null);
  session.lastUserAt=0;assert.equal(await scheduler.candidate(session,config,store,opts),null);
});
test('group scheduled contact needs recent genuine group activity and silence when stale',async t=>{
  const root=temp(t);let now=Date.parse('2026-10-20T02:00:00Z');
  const group={...route,key:'123456/group/345678',group:true,id:'345678'},session={id:'g',route:group,lastUserAt:now,blocked:false};initializeLife(session,now);
  const config={...defaults,groupProactiveEnabled:true,groupProactiveMinSeconds:60,groupProactiveMaxSeconds:60};
  const p=new Proactive(root,{now:()=>now}),store=new MemoryStore(root,group.key);
  let age=100;const opts={call:async()=>({messages:[{user_id:234567,time:now/1000-age,message:[{type:'text',data:{text:'真实话题'}}]}]})};
  assert.equal(await p.candidate(session,config,store,opts),null);now+=60001;
  age=6000;assert.equal(await p.candidate(session,config,store,opts),null);
  age=100;assert.match((await p.candidate(session,config,store,opts)).route.text,/真实话题/);
});
test('desktop launcher reuses live login, blocks existing QQ and never starts a Shell login',async t=>{
  assert.equal(launchDecision([{name:'QQ.exe'}],false).action,'blocked');
  assert.equal(launchDecision([],true).action,'reuse');
  const root=temp(t);let launched=0;
  const service=new DesktopQQ(root,{platform:'win32',processes:async()=>[{name:'QQ.exe'}],probe:async()=>{throw Error('offline');},launch:async()=>launched++});
  await assert.rejects(service.start(defaults),/不会强退或重复登录/);assert.equal(launched,0);
  service.probe=async()=>({account:'123456'});assert.equal((await service.start(defaults)).action,'reuse');assert.equal(launched,0);
  service.processes=async()=>[];service.probe=async()=>{throw Error('offline');};
  for(const file of ['QQ.exe','napimain.exe','napiloader.dll','nativeLoader.cjs'])fs.writeFileSync(path.join(root,file),'mock');
  assert.equal((await service.start({...defaults,qqExecutable:path.join(root,'QQ.exe'),napcatFrameworkDir:root})).action,'launched');assert.equal(launched,1);
});
test('migration configuration validates policy and preserves blank private credentials',()=>{
  assert.throws(()=>validate({recallMinSeconds:3600,recallMaxSeconds:600}),/最长/);
  assert.throws(()=>validate({proactiveStart:'25:00'}),/HH:mm/);
  assert.throws(()=>validate({qqMediaRoots:['relative']}),/绝对/);
  assert.equal(validate({qqImages:true,recallEnabled:true}).recallEnabled,true);
});
test('group cadence preserves zero-as-unlimited and enforces hourly quota and quiet gap',()=>{
  const now=10000000;
  assert.equal(groupRateAllowed([now-1],defaults,now),true);
  assert.equal(groupRateAllowed([now-1000],{...defaults,groupMinReplyGapSeconds:30},now),false);
  assert.equal(groupRateAllowed([now-1000],{...defaults,groupMaxRepliesPerHour:1},now),false);
  assert.equal(groupRateAllowed([now-3600001],{...defaults,groupMaxRepliesPerHour:1},now),true);
});
test('real bridge media path attaches pixels and sends image exactly once even on unknown delivery',async t=>{
  const root=temp(t);let prompts=0,sends=0;
  const b=new Bridge(root,{media:new Media(root,{call:async()=>({url:'https://images.example.org/a'}),download:async()=>png,voice:{}})});
  b.config={...defaults,privatePreset:'chat',privateUsers:['234567']};b.status.state='running';
  b.dsh={rename:async()=>{},createSession:async()=> 's',prompt:async(_id,text,options)=>{
    prompts++;assert.equal(options.images[0].mediaType,'image/png');assert.match(text,/图片已附加/);
    return JSON.stringify({reply:'这张图',memory:[],qq:{images:['https://images.example.org/a']}});
  }};
  b.socket={send(bytes){sends++;const frame=JSON.parse(bytes);assert.equal(frame.action,'send_private_msg');assert.equal(frame.params.message[1].type,'image');queueMicrotask(()=>{b.pending.get(frame.echo)?.(null);b.pending.delete(frame.echo);});}};
  await assert.rejects(b.handle({...route,hasMedia:true,segments:[{type:'image',data:{file:'opaque'}}]},b.generation),/不确定/);
  assert.equal(prompts,1);assert.equal(sends,1);assert.equal(b.state.deliveries[0].state,'unknown');
});
test('new user input cancels proactive work, preserves memory and suppresses the proactive reply',async t=>{
  const root=temp(t);let began,finished=false,reserved=0,sent=[];
  const ready=new Promise(r=>began=r);
  const b=new Bridge(root,{proactive:{candidate:async session=>({route:{...route,trigger:'recall',messageId:'scheduled',expectedVersion:session.life.version},reserve:()=>reserved++})}});
  b.config={...defaults,privatePreset:'chat',privateUsers:['234567']};b.status.state='running';b.state.lastActiveKey=key;
  const session={id:'s',route,workspace:root,preset:'chat',blocked:false,lastUserAt:Date.now()};initializeLife(session);b.state.sessions[b.scope(route)]=session;
  b.dsh={
    createSession:async()=> 'new',rename:async()=>{},
    canSteer:()=>true,
    prompt:async(_id,text,opts)=>{
      if(text.includes('这轮由主动搭话调度触发'))return new Promise((_resolve,reject)=>{
        opts.signal.addEventListener('abort',()=>reject(Object.assign(Error('cancelled'),{cancelled:true,acknowledged:true})),{once:true});began();
      });
      finished=true;return JSON.stringify({reply:'真实消息回复',memory:[]});
    },
  };
  b.socket={send(bytes){const frame=JSON.parse(bytes);sent.push(frame);queueMicrotask(()=>{b.pending.get(frame.echo)?.({status:'ok',retcode:0,data:{message_id:1}});b.pending.delete(frame.echo);});}};
  const tick=b.tick();await ready;
  b.receive({post_type:'message',message_type:'private',self_id:123456,user_id:234567,message_id:7,message:[{type:'text',data:{text:'你好，新消息'}}]},b.generation);
  await tick;
  for(let i=0;i<100&&b.status.active;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(reserved,1);assert.equal(finished,true);assert.equal(sent.length,1);
  assert.equal(session.proactiveAttempts,1);
  assert.equal(new Bridge(root).state.sessions[b.scope(route)].proactiveAttempts,1);
  assert.equal(sent[0].params.message[0].data.text,'真实消息回复');assert.equal(session.blocked,false);
});
test('ordinary private chat can remember grounded preferences while proactive turns cannot write',async t=>{
  const root=temp(t),sent=[],b=new Bridge(root);
  b.config={...defaults,privatePreset:'chat'};b.status.state='running';
  b.dsh={rename:async()=>{},createSession:async()=> 's',prompt:async()=>JSON.stringify({reply:'你好呀',memory:[{action:'write',page:'user/preference.md',text:'# 偏好\n喜欢茶',reason:'用户明确陈述偏好',evidence:[route.messageId]}]})};
  b.socket={send(bytes){const frame=JSON.parse(bytes);sent.push(frame);queueMicrotask(()=>{b.pending.get(frame.echo)?.({status:'ok',retcode:0,data:{message_id:sent.length}});b.pending.delete(frame.echo);});}};
  await b.handle({...route,text:'我一直很喜欢喝茶'},b.generation);
  const session=b.state.sessions[b.scope(route)];
  assert.equal(b.memory(key).pages().some(p=>p.text.includes('喜欢茶')),true);
  b.dsh.prompt=async()=>JSON.stringify({reply:'你好呀',memory:[{action:'write',page:'user/proactive.md',text:'# 不应保存',reason:'主动猜测',evidence:['scheduled']}]});
  await b.handle({...route,messageId:'scheduled',trigger:'recall',expectedVersion:session.life.version},b.generation);
  assert.equal(sent.length,2);assert.equal(sent[0].params.message[0].data.text,'你好呀');
  assert.equal(b.memory(key).pages().some(p=>p.text.includes('不应保存')),false);assert.equal(session.blocked,false);
});
