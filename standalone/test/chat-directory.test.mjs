import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chatDirectory} from '../lib/chat-directory.mjs';
import {PersonaCards} from '../lib/persona-cards.mjs';
import {ModelProfiles} from '../lib/model-profiles.mjs';
import {validate,writeJson} from '../lib/config.mjs';
import {createApp} from '../server.mjs';
import {once} from 'node:events';
const key='100000001/private/100000002',group='100000001/group/100000003';
function temp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-directory-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('directory shows actual binding, model inheritance, current snapshot and per-type receive state without writes',t=>{
 const root=temp(t),cards=new PersonaCards(root),models=new ModelProfiles(root);
 const card=cards.create({key,name:'小夏',revision:0});cards.assign({key,personaId:card.id,revision:1});
 const linked=cards.reuse({key:group,sourceKey:key,sourcePersonaId:card.id,revision:2});cards.assign({key:group,personaId:linked.id,revision:3});
 models.save({settings:{provider:'p',model:'global',contextWindow:400000},revision:0});
 models.save({key,personaId:card.id,settings:{provider:'p',model:'private-model',contextWindow:200000},revision:1});
 const config=validate({botQQ:'100000001',privateUsers:['100000002'],groups:['100000003']});
 const bridge={status:{state:'running',channels:{private:true,group:false}},state:{sessions:{a:{route:{key},personaId:card.id,modelSettings:{provider:'p',model:'old',contextWindow:1000000}}}},jobs:new Map([[key,{}]])};
 const before=fs.readdirSync(root).map(n=>[n,fs.readFileSync(path.join(root,n),'utf8')]);
 const {rows}=chatDirectory(root,config,bridge);assert.equal(rows[0].personaName,'小夏');assert.equal(rows[0].configuredModel.model,'private-model');assert.equal(rows[0].currentModel.model,'old');assert.equal(rows[0].canAssign,false);assert.equal(rows[1].receiving,false);assert.equal(rows[1].canAssign,true);assert.equal(rows[1].shared,true);assert.equal(rows[1].configuredModel.model,'global');
 assert.deepEqual(fs.readdirSync(root).map(n=>[n,fs.readFileSync(path.join(root,n),'utf8')]),before);
 assert.equal(chatDirectory(root,{...config,botQQ:'900000001'},bridge).rows[0].personaName,'默认人格');
});
test('authenticated directory and binding save round trip keep original cards and models',async t=>{
 const runtime=temp(t);writeJson(path.join(runtime,'config.private.json'),validate({botQQ:'100000001',privateUsers:['100000002']}));
 const cards=new PersonaCards(runtime),card=cards.create({key,name:'研究员',revision:0});
 const app=createApp({runtime});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(async()=>{app.bridge.stop();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});
 const origin=new URL(app.loginUrl()).origin;assert.equal((await fetch(origin+'/api/chat-directory')).status,401);
 const login=await fetch(app.loginUrl(),{redirect:'manual'}),headers={Cookie:login.headers.get('set-cookie').split(';')[0],Origin:origin,'X-QQ-RSI':'panel','Content-Type':'application/json'};
 const get=async()=> (await fetch(origin+'/api/chat-directory',{headers})).json();let data=await get();assert.equal(data.rows[0].personaId,'default');
 const response=await fetch(origin+'/api/persona-cards/assign',{method:'POST',headers,body:JSON.stringify({key,personaId:card.id,revision:data.rows[0].revision})});assert.equal(response.status,200);
 data=await get();assert.equal(data.rows[0].personaName,'研究员');assert.equal(cards.view(key).cards.length,2);
 const html=await (await fetch(origin+'/',{headers})).text();assert.ok(html.includes('id="directory-rows"'));assert.match(html,/class="nav active" data-tab="directory"/);
});
