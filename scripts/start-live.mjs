import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../standalone/server.mjs';
import {writeJson} from '../standalone/lib/config.mjs';
import {VERSION,BUILD_ID} from '../native-dsh-plugin/lib/schema.mjs';
const root=path.resolve(process.argv[2]??'.'),runtime=path.join(root,'standalone','.runtime');
const app=createApp({root,runtime});
app.server.listen(3199,'127.0.0.1',()=>{
  writeJson(path.join(runtime,'launch.private.json'),{pid:process.pid,url:app.loginUrl(),startedAt:new Date().toISOString(),version:VERSION,buildId:BUILD_ID,entry:import.meta.url});
  console.log('QQ RSI '+VERSION+' 已启动，QQ连接保持停止。');
});
app.server.on('error',error=>{console.error(error.code??error.message);process.exitCode=1;});
function stop(){app.bridge.stop();app.server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),2000).unref();}
process.once('SIGINT',stop);process.once('SIGTERM',stop);
