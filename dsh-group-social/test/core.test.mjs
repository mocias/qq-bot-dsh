import test from 'node:test';
import assert from 'node:assert/strict';
import { targetAllowed, callerAllowed, compactMessage, directlyAddressed, groupEventAllowed, parseDecision, inHours, BOT, OneBotApi } from '../lib/core.mjs';

test('only the selected group and owner are valid send targets',()=>{
  assert.equal(targetAllowed('group:100000003'),true);
  assert.equal(targetAllowed('private:100000001'),true);
  assert.equal(targetAllowed('group:754027509'),false);
  assert.equal(targetAllowed('private:99999'),false);
});
test('other QQ chats cannot use social management tools',()=>{
  assert.equal(callerAllowed('onebot-private-100000001'),true);
  assert.equal(callerAllowed('onebot-private-100000001-next'),true);
  assert.equal(callerAllowed('onebot-private-1000000010'),false);
  assert.equal(callerAllowed('onebot-group-100000003'),false);
  assert.equal(callerAllowed('local-user-session'),true);
});
test('self mentions are distinguished from mentions of other members',()=>{
  assert.equal(directlyAddressed({message:[{type:'at',data:{qq:BOT}}]}),true);
  assert.equal(directlyAddressed({message:[{type:'at',data:{qq:'12345'}}]}),false);
});
test('events from other groups, other accounts, and the bot itself are ignored',()=>{
  const event={post_type:'message',message_type:'group',group_id:'100000003',self_id:BOT,user_id:'12345'};
  assert.equal(groupEventAllowed(event),true);
  assert.equal(groupEventAllowed({...event,group_id:'99999'}),false);
  assert.equal(groupEventAllowed({...event,self_id:'99999'}),false);
  assert.equal(groupEventAllowed({...event,user_id:BOT}),false);
});
test('group messages retain actual text and identifiers',()=>{
  assert.deepEqual(compactMessage({message_id:4,time:5,user_id:6,sender:{nickname:'群友'},message:[{type:'text',data:{text:'你好'}},{type:'image',data:{url:'private'}}]}),
    {id:'4',time:5,sender:'6',name:'群友',text:'你好[image]'});
});
test('real image addresses survive compaction but junk refs are dropped',()=>{
  const withUrl=compactMessage({message_id:7,time:8,user_id:9,message:[{type:'text',data:{text:'看图'}},{type:'image',data:{url:'https://gchat.qpic.cn/a.jpg'}}]});
  assert.deepEqual(withUrl.images,[{file:undefined,url:'https://gchat.qpic.cn/a.jpg'}]);
  assert.equal(withUrl.text,'看图[image]');
  const withFile=compactMessage({message_id:10,time:11,user_id:12,message:[{type:'image',data:{file:'ABC.jpg'}}]});
  assert.deepEqual(withFile.images,[{file:'ABC.jpg',url:undefined}]);
  const junk=compactMessage({message_id:13,time:14,user_id:15,message:[{type:'image',data:{url:'private'}}]});
  assert.equal(junk.images,undefined);
  assert.equal(compactMessage({message_id:16,time:17,user_id:18,message:[{type:'text',data:{text:'hi'}}]}).images,undefined);
});
test('model silence is empty and malformed decisions fail closed',()=>{
  assert.equal(parseDecision('{"reply":"","reason":"与我无关"}').reply,'');
  assert.equal(parseDecision('```json\n{"reply":null}\n```').reply,'');
  assert.equal(parseDecision('{"reply":"你好","remember":"群内事实"}').reply,'你好');
  assert.throws(()=>parseDecision('收到'));assert.throws(()=>parseDecision('{"reply":{"text":"bad"}}'));
});
test('quiet hours follow Shanghai time',()=>{
  const p={timeZone:'Asia/Shanghai',activeHours:{start:'09:00',end:'23:00'}};
  assert.equal(inHours(new Date('2026-10-19T01:00:00Z'),p),true);
  assert.equal(inHours(new Date('2026-10-19T15:00:00Z'),p),false);
});
test('plain send uses a text segment and verifies the returned message',async()=>{
  const api=Object.create(OneBotApi.prototype),calls=[];
  api.call=async(action,params)=>{calls.push({action,params});if(action==='get_login_info')return {user_id:BOT};return action==='get_msg'
    ?{user_id:BOT,message:[{type:'text',data:{text:'大家好 [CQ:at,qq=all]'}}]}:{message_id:42};};
  const result=await api.sendText('group:100000003','大家好 [CQ:at,qq=all]');
  assert.equal(calls[0].action,'get_login_info');
  assert.equal(calls[1].action,'send_group_msg');
  assert.deepEqual(calls[1].params.message,[{type:'text',data:{text:'大家好 [CQ:at,qq=all]'}}]);
  assert.equal(calls[2].action,'get_msg');assert.equal(result.verified,true);
});
test('uncertain sending is never automatically retried',async()=>{
  const api=Object.create(OneBotApi.prototype);let count=0;
  api.call=async(action)=>{if(action==='get_login_info')return {user_id:BOT};count++;throw Error('发送结果未知');};
  await assert.rejects(api.sendText('group:100000003','你好'),/结果未知/);assert.equal(count,1);
  await assert.rejects(api.sendText('group:12345','你好'),/authorized/);assert.equal(count,1);
});
test('account switching prevents writes',async()=>{
  const api=Object.create(OneBotApi.prototype),actions=[];
  api.call=async action=>{actions.push(action);return {user_id:'99999'};};
  await assert.rejects(api.sendText('group:100000003','你好'),/account changed/);
  assert.deepEqual(actions,['get_login_info']);
});
