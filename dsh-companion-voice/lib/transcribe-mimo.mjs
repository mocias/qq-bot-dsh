import fs from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {readApiConfig,mimoTranscribe} from './mimo-api.mjs';

try{
  const {values}=parseArgs({options:{file:{type:'string'},out:{type:'string'},config:{type:'string'}}});
  if(!values.file||!values.out||!values.config)throw Error('Required arguments: --file --out --config');
  const config=readApiConfig(values.config);
  if(!config.asrEnabled)throw Error('MiMo ASR is disabled');
  const size=(await fs.stat(values.file)).size;if(size>8*1024*1024)throw Error('Audio exceeds 8 MiB');
  const text=await mimoTranscribe(await fs.readFile(values.file),config);
  await fs.writeFile(values.out+'.txt',text,'utf8');
  console.log(JSON.stringify({ok:true,engine:'mimo-v2.5-asr',characters:text.length}));
}catch(error){console.error(error.message);process.exitCode=1;}
