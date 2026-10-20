import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopQQ } from '../lib/desktop-qq.mjs';
import { readJson,defaults,validate } from '../lib/config.mjs';
const runtime=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.runtime');
try{
  const config=validate(readJson(path.join(runtime,'config.private.json'),defaults));
  const result=await new DesktopQQ(runtime).start(config);console.log(result.message);
}catch(error){console.error(error.message);process.exitCode=1;}
