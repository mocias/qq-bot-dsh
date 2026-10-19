import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {defaults,textReason,ownerSession,preferenceAllowed,writeMode,createTransport,wavInfo} from '../lib/core.mjs';
const day=new Date('2026-10-19T07:00:00Z'),night=new Date('2026-10-19T18:00:00Z');
test('auto voice respects technical content, quiet hours and explicit preferences',()=>{
 assert.equal(textReason('今天过得怎么样？',defaults,day),null);
 for(const text of ['文件在 D:\\work\\a.py','打开 https://example.com','```js\n1+1\n```','1. 第一步\n2. 第二步'])assert.equal(textReason(text,defaults,day),'technical_content');
 assert.equal(textReason('晚安',defaults,night),'quiet_hours');
 assert.equal(textReason('晚安',{...defaults,mode:'voice'},night),null);
 assert.equal(textReason('你好',{...defaults,mode:'text'},day),'text_preference');
 assert.equal(textReason('好'.repeat(181),defaults,day),'length');
});
test('voice permissions remain scoped to the owner and trusted local sessions',()=>{
 assert.equal(ownerSession('onebot-private-100000001'),true);
 assert.equal(ownerSession('onebot-private-100000001-2'),true);
 for(const id of ['','onebot-private-123456','onebot-group-100000003'])assert.equal(preferenceAllowed(id),false);
 assert.equal(preferenceAllowed('web-session'),true);
});
test('policy persists and transport prepares one record without sending QQ messages',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-voice-test-'));const file=path.join(directory,'policy.json');
 fs.writeFileSync(file,JSON.stringify(defaults));let calls=0;
 const transport=createTransport({policyFile:file,runtime:directory,now:()=>day,tts:async text=>{calls++;return {audio:Buffer.from('fake-audio'),info:{duration_seconds:2,bytes:10}}}});
 assert.equal((await transport.prepare('private:999999','你好')).reason,'unauthorized_target');assert.equal(calls,0);
 assert.equal((await transport.prepare('private:100000001','你好')).segments[0].type,'record');assert.equal(calls,1);
 writeMode(file,'text');assert.equal((await transport.prepare('private:100000001','你好')).reason,'text_preference');assert.equal(calls,1);
 assert.throws(()=>writeMode(file,'invalid'),/Invalid/);
 fs.unlinkSync(file);fs.rmdirSync(directory);
});
test('WAV validation rejects silent empty or invalid files',()=>{assert.throws(()=>wavInfo(Buffer.from('not a wav')),/WAV/)});
