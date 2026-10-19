import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import YAML from 'js-yaml';
import { localUrl } from './config.mjs';

// Compatible with DSH's persisted browser-session grant. Explicit local opt-in;
// never sends the grant itself and never writes it into the bridge config.
export function localSessionCookie(baseUrl, {home=process.env.DSH_HOME||path.join(os.homedir(),'.dsh'), now=Date.now()}={}) {
  localUrl(baseUrl,['http:','https:']);
  const doc=YAML.load(fs.readFileSync(path.join(home,'.credentials.yaml'),'utf8'));
  const record=doc?.records?.['client-connection/browser-session'];
  if(record?.kind!=='grant'||record.payload?.version!==1)throw Error('本机 DSH 会话凭据不兼容，请使用启动令牌');
  const secret=Buffer.from(record.payload.secret??'','base64url');
  if(secret.length!==32)throw Error('本机 DSH 会话凭据不兼容');
  const authority=new URL(baseUrl).host, expiresAt=now+3600000;
  const body=Buffer.from(JSON.stringify({version:1,authority,issuedAt:now,expiresAt})).toString('base64url');
  const name='dsh-auth-'+createHash('sha256').update(authority).digest('base64url');
  return {cookie:`${name}=v1.${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`,expiresAt};
}
