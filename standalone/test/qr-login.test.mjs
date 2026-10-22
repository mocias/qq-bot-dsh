import test from 'node:test';
import assert from 'node:assert/strict';
import {qrLoginWatcher} from '../public/qr-login.js';
import {QQControl} from '../lib/qq-control.mjs';
test('QR watcher updates rotating codes, follows confirmation and stops on login',async()=>{
 const results=[{state:'waiting',image:'a'},{state:'waiting',image:'b'},{state:'confirming'},{state:'logged-in'}],seen=[];let next,logged=0;
 const watcher=qrLoginWatcher({load:async()=>results.shift(),render:r=>seen.push(r),onLogin:async()=>logged++,isVisible:()=>true,setTimer:fn=>(next=fn,1),clearTimer:()=>{next=null;}});
 await watcher.start();for(let i=0;i<3;i++){const fn=next;next=null;await fn();}
 assert.deepEqual(seen.map(x=>x.image),['a','b',undefined,undefined]);assert.equal(logged,1);assert.equal(next,null);
});
test('stopped or superseded QR requests cannot redraw old codes; failure clears stale image and retries',async()=>{
 let resolve,next;const seen=[];
 const watcher=qrLoginWatcher({load:()=>new Promise(r=>resolve=r),render:r=>seen.push(r),onLogin(){},isVisible:()=>true,setTimer:fn=>(next=fn,1),clearTimer:()=>{next=null;}});
 const pending=watcher.start();watcher.stop();resolve({image:'stale'});await pending;assert.equal(seen.length,0);assert.equal(next,undefined);
 const failing=qrLoginWatcher({load:async()=>{throw Error('offline');},render:r=>seen.push(r),onLogin(){},isVisible:()=>true,setTimer:fn=>(next=fn,1),clearTimer(){}});
 await failing.start();assert.equal(seen[0].state,'error');assert.equal(seen[0].image,undefined);assert.equal(typeof next,'function');failing.stop();
});
test('watch reads current NapCat QR without refresh or login side effects',async()=>{
 let state={},code='a';const calls=[],control=new QQControl({qr:async x=>'image:'+x});
 control.admin=async()=>async method=>{calls.push(method);return method.endsWith('CheckLoginStatus')?state:{qrcode:code};};
 const config={botQQ:'100000001'};
 assert.equal((await control.qrcode(config,{watch:true})).image,'image:a');code='b';assert.equal((await control.qrcode(config,{watch:true})).image,'image:b');
 state={qrLoginAccepted:true};assert.equal((await control.qrcode(config,{watch:true})).state,'confirming');
 state={isLogin:true};assert.equal((await control.qrcode(config,{watch:true})).state,'logged-in');
 assert.ok(calls.every(x=>['/QQLogin/CheckLoginStatus','/QQLogin/GetQQLoginQrcode'].includes(x)));
});
