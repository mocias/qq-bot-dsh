import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { QQSettingsStore } from '../lib/settings-core.mjs';

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-unified-settings-')),priv=path.join(root,'private'),group=path.join(root,'group');
  for(const p of [priv,group])fs.mkdirSync(path.join(p,'.memory'),{recursive:true});
  fs.mkdirSync(path.join(group,'.runtime'));
  const save=(p,name,value)=>fs.writeFileSync(path.join(p,'.memory',name),typeof value==='string'?value:JSON.stringify(value));
  save(priv,'SOUL.md','私人原有人设');save(group,'PERSONA.md','群原有人设');
  save(priv,'voice.json',{enabled:true,mode:'text',maxCharacters:180,quietHours:{start:23,end:8},voice:'Windows Voice',timeZone:'Asia/Shanghai'});
  save(priv,'proactive.json',{enabled:true,activeHours:{start:'09:00',end:'23:00'},intervalMinMinutes:60,intervalMaxMinutes:180,maxPerDay:4,autonomousActions:true,desktopIdleSeconds:120,customKeep:'preserved'});
  save(group,'policy.json',{enabled:true,proactiveEnabled:false,timeZone:'Asia/Shanghai',activeHours:{start:'00:00',end:'00:00'},minReplyGapSeconds:0,ambientCheckMinutes:0,maxRepliesPerHour:0,maxAmbientPerHour:0,maxProactivePerDay:1,proactiveMinMinutes:120,proactiveMaxMinutes:360,directDebounceMs:250,ambientDebounceMs:500,note:'keep'});
  const entries=[{options:{id:'dsh-onebot',config:{workspacePath:priv,accessToken:'SECRET-NOT-FOR-UI',botQQ:'100000002',url:'ws://127.0.0.1:3001',directSteerPrivateUsers:['100000001'],splitShortTextBubbles:true,groupPolicy:'disabled',sttArgs:['existing-asr'],compactionRotationEnabled:true}}},{options:{id:'companion-group-social',config:{workspacePath:group,modelProvider:'qoder-cn',modelId:'DeepSeek-Flash',sharedTransport:true}}},{options:{id:'dsh-memory',config:{digestNudgeEnabled:true,digestNudgeMode:'compaction-idle',digestIdleMinutes:30,digestRotateAfterCompactions:15,sessionPrefixes:['onebot-private-100000001']}}}];
  const editor={entries:()=>entries,async edit(e,change){e.options.config=change(e.options.config,{})}};
  const store=new QQSettingsStore({editor,hub:{snapshot:()=>({connected:true,connectionCount:1,subscribers:1})}});
  return {root,priv,group,entries,store,read:(p,name)=>JSON.parse(fs.readFileSync(path.join(p,'.memory',name),'utf8'))};
}
test('snapshot masks tokens and retains distinct workspaces',()=>{const h=fixture(),s=h.store.snapshot();assert.equal(s.connection.tokenConfigured,true);assert.ok(!JSON.stringify(s).includes('SECRET-NOT-FOR-UI'));assert.notEqual(s.workspaces.private,s.workspaces.group);assert.equal(s.status.transport.connectionCount,1)});
test('one group policy edit preserves private policies, group notes and limits',async()=>{const h=fixture(),s=h.store.snapshot(),voice=fs.readFileSync(path.join(h.priv,'.memory','voice.json'),'utf8');await h.store.update('group',{activeStart:'09:00',activeEnd:'23:00'},s.revision);const p=h.read(h.group,'policy.json');assert.equal(p.enabled,true);assert.equal(p.note,'keep');assert.equal(p.maxRepliesPerHour,0);assert.equal(fs.readFileSync(path.join(h.priv,'.memory','voice.json'),'utf8'),voice)});
test('private settings merge without losing ASR, group fence or steering',async()=>{const h=fixture();await h.store.update('private',{queueNoticeEnabled:false},h.store.snapshot().revision);const c=h.entries[0].options.config;assert.deepEqual(c.sttArgs,['existing-asr']);assert.equal(c.groupPolicy,'disabled');assert.deepEqual(c.directSteerPrivateUsers,['100000001']);assert.equal(c.splitShortTextBubbles,true);assert.equal(c.compactionRotationEnabled,true)});
test('memory edits preserve the scope allowlist',async()=>{const h=fixture();await h.store.update('memory',{digestIdleMinutes:45},h.store.snapshot().revision);assert.deepEqual(h.entries[2].options.config.sessionPrefixes,['onebot-private-100000001']);assert.equal(h.entries[2].options.config.digestRotateAfterCompactions,15)});
test('rejects stale revisions including direct file changes',async()=>{const h=fixture(),s=h.store.snapshot();const p=h.read(h.group,'policy.json');p.enabled=false;fs.writeFileSync(path.join(h.group,'.memory','policy.json'),JSON.stringify(p));await assert.rejects(h.store.update('group',{activeEnd:'22:00'},s.revision),/配置已被/);assert.equal(h.read(h.group,'policy.json').enabled,false)});
test('invalid policy has no partial write',async()=>{const h=fixture(),file=path.join(h.group,'.memory','policy.json'),before=fs.readFileSync(file,'utf8');await assert.rejects(h.store.update('group',{activeStart:'25:00'},h.store.snapshot().revision));await assert.rejects(h.store.update('group',{proactiveMinMinutes:1000},h.store.snapshot().revision));assert.equal(fs.readFileSync(file,'utf8'),before)});
test('UI cannot reassign workspaces or expand group permissions',async()=>{const h=fixture();for(const [section,patch]of [['private',{groupPolicy:'open'}],['groupModel',{workspacePath:h.priv}],['group',{shell:true}]])await assert.rejects(h.store.update(section,patch,h.store.snapshot().revision),/不能修改字段/)});
test('personas write to their own fixed file only',async()=>{const h=fixture();await h.store.update('groupPersona',{content:'群新人设'},h.store.snapshot().revision);assert.equal(fs.readFileSync(path.join(h.priv,'.memory','SOUL.md'),'utf8'),'私人原有人设');assert.equal(fs.readFileSync(path.join(h.group,'.memory','PERSONA.md'),'utf8'),'群新人设')});
test('blank connection token preserves the existing secret',async()=>{const h=fixture();await h.store.update('connection',{accessToken:''},h.store.snapshot().revision);assert.equal(h.entries[0].options.config.accessToken,'SECRET-NOT-FOR-UI')});
test('two stale concurrent saves cannot overwrite each other',async()=>{const h=fixture(),revision=h.store.snapshot().revision;const results=await Promise.allSettled([h.store.update('private',{queueNoticeEnabled:false},revision),h.store.update('private',{ownerSteer:false},revision)]);assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.deepEqual(h.entries[0].options.config.directSteerPrivateUsers,['100000001'])});

test('MiMo credentials are write-only and blank updates preserve them',async()=>{
 const h=fixture();await h.store.update('voiceApi',{ttsProvider:'mimo',apiKey:'mimo-test-secret'},h.store.snapshot().revision);
 const s=h.store.snapshot();assert.equal(s.voiceApi.apiKeyConfigured,true);assert.equal(s.voiceApi.apiKey,'');assert.ok(!JSON.stringify(s).includes('mimo-test-secret'));
 await h.store.update('voiceApi',{apiKey:'',mimoVoice:'冰糖'},s.revision);
 assert.equal(JSON.parse(fs.readFileSync(path.join(h.priv,'.runtime','voice-api.private.json'),'utf8')).apiKey,'mimo-test-secret');
 assert.deepEqual(h.read(h.group,'policy.json').activeHours,{start:'00:00',end:'00:00'});
});
test('MiMo ASR installs custom adapter and restores prior STT without changing other settings',async()=>{
 const h=fixture(),before=structuredClone(h.entries[0].options.config);
 await h.store.update('voiceApi',{asrEnabled:true,apiKey:'test-key'},h.store.snapshot().revision);
 let c=h.entries[0].options.config;assert.equal(c.sttEngine,'custom');assert.equal(c.sttCommand,process.execPath);assert.ok(c.sttArgs[0].endsWith('transcribe-mimo.mjs'));assert.ok(!c.sttArgs.includes('test-key'));
 assert.deepEqual(c.directSteerPrivateUsers,before.directSteerPrivateUsers);
 await h.store.update('voiceApi',{asrEnabled:false},h.store.snapshot().revision);
 assert.deepEqual(h.entries[0].options.config,before);
});
test('failed host edit rolls back API config and preserves prior STT',async()=>{
 const h=fixture(),before=structuredClone(h.entries[0].options.config);h.store.editor.edit=async()=>{throw Error('host failed');};
 await assert.rejects(h.store.update('voiceApi',{asrEnabled:true,apiKey:'test-key'},h.store.snapshot().revision),/保存失败/);
 assert.deepEqual(h.entries[0].options.config,before);assert.equal(h.store.snapshot().voiceApi.asrEnabled,false);assert.equal(h.store.snapshot().voiceApi.apiKeyConfigured,!!process.env.MIMO_API_KEY);
});
test('external ASR changes are not overwritten on disable',async()=>{
 const h=fixture();await h.store.update('voiceApi',{asrEnabled:true,apiKey:'test-key'},h.store.snapshot().revision);
 h.entries[0].options.config.sttArgs=['external'];await assert.rejects(h.store.update('voiceApi',{asrEnabled:false},h.store.snapshot().revision),/其他位置改变/);
 assert.deepEqual(h.entries[0].options.config.sttArgs,['external']);assert.equal(h.store.snapshot().voiceApi.asrEnabled,true);
});
