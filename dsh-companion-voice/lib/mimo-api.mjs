import fs from 'node:fs';

export const MIMO_ENDPOINT='https://api.xiaomimimo.com/v1/chat/completions';
export const apiDefaults={ttsProvider:'windows',asrEnabled:false,mimoVoice:'mimo_default',mimoStyle:'',timeoutMs:60000};
export function readApiConfig(file){
  return {...apiDefaults,...(fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{})};
}
export function publicApiConfig(config){
  const {ttsProvider,asrEnabled,mimoVoice,mimoStyle,timeoutMs}={...apiDefaults,...config};
  return {ttsProvider,asrEnabled,mimoVoice,mimoStyle,timeoutMs,apiKeyConfigured:!!(config.apiKey||process.env.MIMO_API_KEY)};
}
async function complete(body,config,{fetchImpl=fetch,signal}={}){
  const key=config.apiKey||process.env.MIMO_API_KEY;
  if(typeof key!=='string'||!key.trim())throw Error('MiMo API key is not configured');
  const timeout=config.timeoutMs??60000;
  if(!Number.isInteger(timeout)||timeout<1000||timeout>120000)throw Error('Invalid MiMo timeout');
  const timed=AbortSignal.timeout(timeout),combined=signal?AbortSignal.any([signal,timed]):timed;
  let response;
  try{response=await fetchImpl(MIMO_ENDPOINT,{method:'POST',redirect:'error',signal:combined,
    headers:{'Content-Type':'application/json','api-key':key.trim()},body:JSON.stringify({...body,stream:false})});}
  catch{throw Error(combined.aborted?'MiMo request cancelled or timed out':'MiMo connection failed');}
  if(!response.ok){await response.body?.cancel();throw Error(`MiMo API returned HTTP ${response.status}`);}
  const reader=response.body?.getReader();if(!reader)throw Error('MiMo returned an empty response');
  const chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;
    if(size>16*1024*1024){await reader.cancel();throw Error('response limit');}chunks.push(value);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch{throw Error(combined.aborted?'MiMo request cancelled or timed out':'MiMo response invalid or too large');}
  finally{reader.releaseLock();}
}
export async function mimoSpeech(text,config,options={}){
  if(typeof text!=='string'||!text.trim()||text.length>300)throw Error('Invalid speech text length');
  const messages=[];
  if(config.mimoStyle)messages.push({role:'user',content:config.mimoStyle});
  messages.push({role:'assistant',content:text});
  const data=await complete({model:'mimo-v2.5-tts',messages,audio:{format:'wav',voice:config.mimoVoice||'mimo_default'}},config,options);
  const encoded=data.choices?.[0]?.message?.audio?.data;
  if(typeof encoded!=='string'||!encoded.length||encoded.length>12*1024*1024||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw Error('MiMo returned invalid audio');
  const audio=Buffer.from(encoded,'base64');
  if(audio.length>8*1024*1024)throw Error('MiMo audio exceeds size limit');
  return audio;
}
export async function mimoTranscribe(audio,config,options={}){
  if(!Buffer.isBuffer(audio)||audio.length<44||audio.length>8*1024*1024||audio.toString('ascii',0,4)!=='RIFF'||audio.toString('ascii',8,12)!=='WAVE')throw Error('MiMo ASR requires a WAV file under 8 MiB');
  const data=await complete({model:'mimo-v2.5-asr',messages:[{role:'user',content:[{type:'input_audio',input_audio:{data:`data:audio/wav;base64,${audio.toString('base64')}`}}]}],asr_options:{language:'zh'}},config,options);
  const text=data.choices?.[0]?.message?.content;
  if(typeof text!=='string'||text.length>30000)throw Error('MiMo returned invalid transcript');
  return text.trim();
}
