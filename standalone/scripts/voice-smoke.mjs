import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LocalVoice } from '../lib/voice.mjs';
import { defaults, writeJson } from '../lib/config.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=process.argv[2] || path.resolve(here,'../..');
const runtime=path.resolve(here,'../.runtime/voice-smoke');
const voice=new LocalVoice(root,runtime);
const text='你好，这是本地语音测试。今天我们开始搭建独立的聊天助手。';
const started=Date.now(),audio=await voice.synthesize(text,defaults);
const report={text,ttsMs:Date.now()-started,audio:path.join(voice.dir,audio.id+'.wav'),results:[]};
for(const model of ['base','small']){
  const start=Date.now();const result=await voice.transcribe(voice.audio(audio.id),{...defaults,model});
  if(!result.text.trim())throw Error(model+' returned empty transcript');
  report.results.push({...result,elapsedMs:Date.now()-start});
}
writeJson(path.join(runtime,'report.json'),report);console.log(JSON.stringify(report,null,2));
