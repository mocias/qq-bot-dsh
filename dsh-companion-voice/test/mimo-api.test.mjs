import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mimoSpeech,mimoTranscribe,publicApiConfig,MIMO_ENDPOINT} from '../lib/mimo-api.mjs';
import {createTransport,defaults,wavInfo} from '../lib/core.mjs';

function wav(){const b=Buffer.alloc(46);b.write('RIFF');b.writeUInt32LE(38,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(2,40);return b;}
const config={apiKey:'test-secret',timeoutMs:1000,mimoVoice:'冰糖',mimoStyle:'自然平静'};
test('TTS uses official Chat API message roles and decodes audio',async()=>{
  let request;const audio=await mimoSpeech('你好',config,{fetchImpl:async(url,init)=>{request={url,...init};return Response.json({choices:[{message:{audio:{data:wav().toString('base64')}}}]});}});
  assert.equal(request.url,MIMO_ENDPOINT);assert.equal(request.headers['api-key'],'test-secret');assert.equal(request.redirect,'error');
  const body=JSON.parse(request.body);assert.deepEqual(body.messages,[{role:'user',content:'自然平静'},{role:'assistant',content:'你好'}]);assert.equal(body.model,'mimo-v2.5-tts');assert.equal(body.audio.format,'wav');assert.equal(body.stream,false);assert.ok(wavInfo(audio).bytes>0);
});
test('ASR sends WAV data URL and returns trimmed text',async()=>{
  const text=await mimoTranscribe(wav(),config,{fetchImpl:async(url,init)=>{const body=JSON.parse(init.body);assert.equal(body.model,'mimo-v2.5-asr');assert.equal(body.asr_options.language,'zh');assert.match(body.messages[0].content[0].input_audio.data,/^data:audio\/wav;base64,/);return Response.json({choices:[{message:{content:' 你好 '}}]});}});assert.equal(text,'你好');
});
test('provider errors do not leak its body or credentials and are not retried',async()=>{
  let calls=0;await assert.rejects(mimoSpeech('你好',config,{fetchImpl:async()=>{calls++;return new Response('test-secret private text',{status:401});}}),error=>error.message==='MiMo API returned HTTP 401');assert.equal(calls,1);
  assert.ok(!JSON.stringify(publicApiConfig(config)).includes('test-secret'));
});
test('malformed audio, invalid transcript and bad inputs fail before delivery',async()=>{
  await assert.rejects(mimoSpeech('你好',config,{fetchImpl:async()=>Response.json({choices:[{message:{audio:{data:'???'}}}]})}),/invalid audio/);
  await assert.rejects(mimoTranscribe(wav(),config,{fetchImpl:async()=>Response.json({choices:[{message:{content:null}}]})}),/invalid transcript/);
  await assert.rejects(mimoTranscribe(Buffer.from('bad'),config),/WAV/);
  await assert.rejects(mimoSpeech('好'.repeat(301),config),/length/);
});
test('caller cancellation produces a bounded error without exposing request data',async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(mimoSpeech('private-text',config,{signal:controller.signal,fetchImpl:async(_url,init)=>{assert.equal(init.signal.aborted,true);throw Error('test-secret private-text');}}),e=>e.message==='MiMo request cancelled or timed out');
});
test('ASR command writes the text file expected by the existing OneBot custom engine',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-mimo-cli-'));t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('qq-mimo-cli-'));fs.rmSync(dir,{recursive:true,force:true});});
 const audio=path.join(dir,'audio.wav'),conf=path.join(dir,'api.json'),out=path.join(dir,'out'),stub=path.join(dir,'mock.mjs');
 fs.writeFileSync(audio,wav());fs.writeFileSync(conf,JSON.stringify({...config,asrEnabled:true}));
 fs.writeFileSync(stub,"globalThis.fetch=async()=>Response.json({choices:[{message:{content:'识别测试'}}]});");
 const cli=fileURLToPath(new URL('../lib/transcribe-mimo.mjs',import.meta.url));
 const stdout=execFileSync(process.execPath,['--import',pathToFileURL(stub).href,cli,'--file',audio,'--out',out,'--config',conf],{encoding:'utf8',windowsHide:true});
 assert.equal(fs.readFileSync(out+'.txt','utf8'),'识别测试');assert.ok(!stdout.includes('test-secret'));assert.ok(!stdout.includes('识别测试'));
});
test('transport routes selected API with privacy gate and preserves text mode',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-mimo-test-'));t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('qq-mimo-test-'));fs.rmSync(dir,{recursive:true,force:true});});
  const policyFile=path.join(dir,'voice.json'),apiConfigFile=path.join(dir,'api.json');
  fs.writeFileSync(policyFile,JSON.stringify({...defaults,mode:'voice'}));fs.writeFileSync(apiConfigFile,JSON.stringify({...config,ttsProvider:'mimo'}));
  const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({choices:[{message:{audio:{data:wav().toString('base64')}}}]});};t.after(()=>{globalThis.fetch=old;});
  const transport=createTransport({policyFile,apiConfigFile,runtime:dir});
  assert.equal((await transport.prepare('private:other','你好')).reason,'unauthorized_target');assert.equal(calls,0);
  assert.equal((await transport.prepare('private:100000001','你好')).segments[0].type,'record');assert.equal(calls,1);
  fs.writeFileSync(policyFile,JSON.stringify({...defaults,mode:'text'}));assert.equal((await transport.prepare('private:100000001','你好')).reason,'text_preference');assert.equal(calls,1);
});
