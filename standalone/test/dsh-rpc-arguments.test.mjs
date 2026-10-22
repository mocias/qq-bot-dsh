import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {DshClient} from '../lib/dsh.mjs';

test('model catalog uses the parameterless DSH gateway contract; request methods keep their envelope',async t=>{
  const calls=[];
  const server=http.createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;
    const input=JSON.parse(text);calls.push(input);
    const valid=input.method!=='session/modelCatalog'||Object.keys(input.payload.args).length===0;
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({type:'server-response',rpcId:input.rpcId,result:valid?{ok:true,value:{groups:[{id:'fixture',models:[{id:'test'}]}]}}:{ok:false,error:'gateway/arguments-invalid: unexpected request'}}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const client=new DshClient({dshUrl:'http://127.0.0.1:'+server.address().port});client.authenticate=async()=>{};t.after(()=>client.close());
  assert.equal((await client.rpc('session/modelCatalog')).groups[0].id,'fixture');
  await client.rpc('session/create',{workspaceId:'fixture'});
  await client.rpc('session/list');
  assert.deepEqual(calls.map(x=>x.payload.args),[{}, {request:{workspaceId:'fixture'}},{_request:{}}]);
});
