import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {VoiceService,audioFormat} from '../lib/voice-service.mjs';
import {defaults,validate,publicConfig} from '../lib/config.mjs';
import {Media} from '../lib/media.mjs';
import {createApp} from '../server.mjs';

function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-mimo-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function wav(){
  const b=Buffer.alloc(364);b.write('RIFF');b.writeUInt32LE(356,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);
  b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(320,40);return b;
}
const config=validate({voiceProvider:'mimo',mimoApiKey:'test-only-secret'});
function response(message,extra={}){return Response.json({choices:[{finish_reason:'stop',message}],...extra});}
function service(t,fetcher,options={}){const root=temp(t);return new VoiceService(root,root,{fetch:fetcher,...options});}
test('voice config upgrades old files, preserves blank keys and never exposes them',()=>{
  assert.equal(validate({model:'base'}).voiceProvider,'local');
  assert.equal(validate({mimoApiKey:''},config).mimoApiKey,config.mimoApiKey);
  assert.equal(validate({clearMimoApiKey:true},config).mimoApiKey,'');
  assert.equal(publicConfig(config).mimoApiKeyConfigured,true);
  assert.ok(!JSON.stringify(publicConfig(config)).includes(config.mimoApiKey));
  for(const input of [{voiceProvider:'other'},{mimoVoice:'other'},{mimoTtsMode:'other'},{mimoReferenceId:'../../private'},{mimoAsrLanguage:'other'},{mimoApiKey:'a\nb'}])assert.throws(()=>validate(input));
});
test('preset synthesis uses official model, assistant text, api-key header and validated WAV',async t=>{
  let request;
  const voice=service(t,async(url,options)=>{request={url,...options};return response({audio:{data:wav().toString('base64')}});});
  const result=await voice.synthesize('你好',{...config,mimoVoice:'茉莉',mimoStyle:'温柔'});
  assert.equal(request.url,'https://api.xiaomimimo.com/v1/chat/completions');
  assert.equal(request.headers['api-key'],config.mimoApiKey);assert.equal(request.redirect,'error');
  assert.deepEqual(JSON.parse(request.body),{model:'mimo-v2.5-tts',messages:[{role:'user',content:'温柔'},{role:'assistant',content:'你好'}],audio:{format:'wav',voice:'茉莉'},stream:false});
  assert.deepEqual(voice.audio(result.id),wav());assert.equal(voice.busy,false);
});
test('voice design requires text instructions and omits audio.voice even with a stale reference',async t=>{
 let payload,calls=0;
 const voice=service(t,async(url,options)=>{calls++;payload=JSON.parse(options.body);return response({audio:{data:wav().toString('base64')}});});
 const design={...config,mimoTtsMode:'design',mimoDesign:'温暖清亮的年轻女声，语速舒缓',mimoStyle:'自然地讲述',mimoReferenceId:'00000000-0000-0000-0000-000000000000'};
 assert.equal(voice.status(design).ttsReady,true);
 const result=await voice.synthesize('你好',design);
 assert.equal(result.model,'mimo-v2.5-tts-voicedesign');
 assert.equal(payload.model,result.model);assert.equal(Object.hasOwn(payload.audio,'voice'),false);
 assert.equal(payload.audio.optimize_text_preview,false);
 assert.deepEqual(payload.messages,[{role:'user',content:design.mimoDesign+'\n'+design.mimoStyle},{role:'assistant',content:'你好'}]);
 await assert.rejects(voice.synthesize('你好',{...design,mimoDesign:''}),/音色设计描述/);
 assert.equal(calls,1);assert.equal(voice.status({...design,mimoDesign:''}).ttsReady,false);
});
test('reference upload is local, persistent, bounded and used in every clone request',async t=>{
  const requests=[];const voice=service(t,async(url,options)=>{requests.push(JSON.parse(options.body));return response({audio:{data:wav().toString('base64')}});});
  const ref=voice.uploadReference(wav(),'我的声音');
  assert.equal(requests.length,0);assert.equal(voice.listReferences()[0].name,'我的声音');
  const restored=new VoiceService(voice.root,path.dirname(voice.dir));assert.equal(restored.reference(ref.id).meta.id,ref.id);
  for(let i=0;i<2;i++)await voice.synthesize('你好',{...config,mimoTtsMode:'clone',mimoReferenceId:ref.id});
  for(const req of requests){assert.equal(req.model,'mimo-v2.5-tts-voiceclone');assert.equal(req.audio.voice,'data:audio/wav;base64,'+wav().toString('base64'));}
  assert.throws(()=>voice.uploadReference(Buffer.alloc(7*1024*1024+1),'large'),/7 MiB/);
  assert.throws(()=>voice.uploadReference(Buffer.from('not audio'),'bad'));
  assert.throws(()=>voice.reference('../../secret'));
  const file=path.join(voice.references,ref.id+'.wav');fs.unlinkSync(file);fs.linkSync(path.join(voice.dir,fs.readdirSync(voice.dir)[0]),file);
  assert.throws(()=>voice.reference(ref.id),/损坏/);
});
test('WAV and MP3 recognition use MiMo ASR payload and return text',async t=>{
  const requests=[],voice=service(t,async(url,options)=>{requests.push(JSON.parse(options.body));return response({content:'识别成功'},{usage:{seconds:2}});});
  const mp3=Buffer.concat([Buffer.from('ID3'),Buffer.alloc(20)]);
  for(const bytes of [wav(),mp3]){
    const result=await voice.transcribe(bytes,{...config,mimoAsrLanguage:'zh'});assert.equal(result.text,'识别成功');
  }
  assert.equal(requests[0].model,'mimo-v2.5-asr');assert.deepEqual(requests[0].asr_options,{language:'zh'});
  assert.deepEqual(requests[0].messages[0].content[0],{type:'input_audio',input_audio:{format:'wav',data:'data:audio/wav;base64,'+wav().toString('base64')}});
  assert.equal(requests[1].messages[0].content[0].input_audio.format,'mp3');
  const file=path.join(voice.root,'record.mp3');fs.writeFileSync(file,mp3);await voice.transcribeRecord(file,config);assert.equal(requests.length,3);
});
test('missing credentials, missing clone reference and overlapping work fail before network',async t=>{
  let calls=0;const voice=service(t,async()=>{calls++;throw Error('unreachable');});
  await assert.rejects(voice.synthesize('你好',{...config,mimoApiKey:''}),/API Key/);
  await assert.rejects(voice.transcribe(wav(),{...config,mimoApiKey:''}),/API Key/);
  await assert.rejects(voice.synthesize('你好',{...config,mimoTtsMode:'clone'}),/参考录音/);
  voice.busy=true;await assert.rejects(voice.synthesize('你好',config),/正在运行/);voice.busy=false;
  assert.equal(calls,0);
  assert.equal(voice.status(config).credentialVerified,false);
});
test('API failures are bounded and sanitized; failed jobs release busy state',async t=>{
  for(const status of [401,403,429,500]){
    const voice=service(t,async()=>new Response('remote-private-'+config.mimoApiKey,{status}));
    await assert.rejects(voice.synthesize('你好',config),error=>{assert.ok(!error.message.includes(config.mimoApiKey));return /MiMo/.test(error.message);});
    assert.equal(voice.busy,false);
  }
  const timeout=service(t,async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error(config.mimoApiKey)))),{timeoutMs:10});
  await assert.rejects(timeout.synthesize('你好',config),/超时/);assert.equal(timeout.busy,false);
  const oversized=service(t,async()=>new Response(new Uint8Array(12*1024*1024+1)));
  await assert.rejects(oversized.synthesize('你好',config),/大小限制/);
});
test('incomplete, malformed and non-WAV TTS outputs are not saved',async t=>{
  for(const data of [
    {choices:[{finish_reason:'length',message:{audio:{data:wav().toString('base64')}}}]},
    {choices:[{finish_reason:'content_filter',message:{}}]},
    {choices:[{finish_reason:'stop',message:{audio:{data:'aGVsbG8='}}}]},
    {choices:[{finish_reason:'stop',message:{audio:{data:'!!bad!!'}}}]}
  ]){
    const voice=service(t,async()=>Response.json(data));await assert.rejects(voice.synthesize('你好',config));assert.deepEqual(fs.readdirSync(voice.dir),[]);
  }
  assert.throws(()=>audioFormat(Buffer.alloc(44)));
  const truncated=wav().subarray(0,100);assert.throws(()=>audioFormat(truncated));
});
test('local mode keeps local validation and never calls MiMo',async t=>{
  const voice=service(t,async()=>assert.fail('cloud must not be contacted'));
  await assert.rejects(voice.transcribe(Buffer.from('bad'),defaults),/WAV/);
  voice.busy=true;await assert.rejects(voice.synthesize('你好',defaults),/正在运行/);
  assert.equal(voice.status(defaults).provider,'local');
});
test('QQ incoming/outgoing media uses selected MiMo service and preserves text fallback',async t=>{
  const requests=[],voice=service(t,async(url,options)=>{const payload=JSON.parse(options.body);requests.push(payload);return payload.model.endsWith('asr')?response({content:'QQ 语音识别'}):response({audio:{data:wav().toString('base64')}});});
  const media=new Media(voice.root,{voice,call:async()=>({base64:wav().toString('base64')}),now:()=>new Date(2026,0,1,12).getTime()});
  const route={key:'123456/private/234567',id:'234567',sender:'234567',group:false,messageId:'m1',text:'',segments:[{type:'record',data:{file:'opaque'}}]};
  const incoming=await media.incoming(route,config);assert.match(incoming.text,/QQ 语音识别/);assert.deepEqual(incoming.mediaFailures,[]);
  const result=await media.outgoing({reply:'',qq:{voice:'你好'}},route,{workspace:voice.root},{...config,voiceReplyMode:'voice'});
  assert.equal(result.params.message[0].type,'record');assert.equal(requests.length,2);
  voice.fetch=async()=>new Response('failure',{status:401});
  const fallback=await media.outgoing({reply:'',qq:{voice:'你好'}},route,{workspace:voice.root},{...config,voiceReplyMode:'voice'});
  assert.equal(fallback.params.message[0].data.text,'你好');
});
test('panel voice routes require authentication, redact keys, preserve other config and reject busy changes',async t=>{
  const runtime=temp(t),voice=new VoiceService(runtime,runtime,{fetch:()=>assert.fail('configuration must not call cloud')});
  const app=createApp({runtime,voice});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{app.bridge.stop();app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));});
  const origin=new URL(app.loginUrl()).origin,login=await fetch(app.loginUrl(),{redirect:'manual'}),cookie=login.headers.get('set-cookie').split(';')[0];
  const headers={cookie,Origin:origin,'Content-Type':'application/json','X-QQ-RSI':'panel'};
  const post=(url,body,extra={})=>fetch(origin+url,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
  assert.equal((await fetch(origin+'/api/voice/references')).status,401);
  assert.equal((await post('/api/voice/config',{}, {Origin:'https://example.com'})).status,403);
  assert.equal((await post('/api/voice/config',{voiceProvider:'mimo'})).status,400);
  const ref=await (await post('/api/voice/references',{name:'测试声音',audio:wav().toString('base64')})).json();
  const saved=await (await post('/api/voice/config',{...config,mimoTtsMode:'clone',mimoReferenceId:ref.reference.id,privateUsers:['999999']})).json();
  assert.equal(saved.config.mimoApiKeyConfigured,true);assert.deepEqual(saved.config.privateUsers,[]);assert.ok(!JSON.stringify(saved).includes(config.mimoApiKey));
  const list=await (await fetch(origin+'/api/voice/references',{headers:{cookie}})).json();assert.equal(list.references.length,1);
  const preview=await fetch(origin+'/api/voice/reference/'+ref.reference.id,{headers:{cookie}});assert.equal(preview.headers.get('content-type'),'audio/wav');
  voice.busy=true;assert.equal((await post('/api/voice/config',{voiceProvider:'local'})).status,400);voice.busy=false;
  const cleared=await (await post('/api/voice/config',{voiceProvider:'local',clearMimoApiKey:true})).json();assert.equal(cleared.config.mimoApiKeyConfigured,false);
  const status=await (await fetch(origin+'/api/status',{headers:{cookie}})).json();assert.equal(status.voice.provider,'local');
});


test('per-message voice emotion reaches MiMo separately from speech and does not mutate persona settings',async t=>{
  let payload;const voice=service(t,async(url,options)=>{payload=JSON.parse(options.body);return response({audio:{data:wav().toString('base64')}});});
  const root=path.dirname(voice.dir),media=new Media(root,{voice}),settings={...config,qqVoiceSend:true,voiceReplyMode:'voice',voiceQuietMode:'never',mimoStyle:'平时温柔'};
  const out=await media.outgoing({reply:'',qq:{voice:'我有点想你了。',voiceStyle:'轻声，略带犹豫，句末停顿'}},{key:'100000001/private/100000002',id:'100000002',group:false},{workspace:root},settings);
  assert.equal(out.params.message[0].type,'record');assert.equal(payload.messages[0].content,'平时温柔\n轻声，略带犹豫，句末停顿');assert.equal(payload.messages[1].content,'我有点想你了。');assert.equal(settings.mimoStyle,'平时温柔');
});
