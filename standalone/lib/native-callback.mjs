import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {once} from 'node:events';

// One short-lived capability per DSH run, never exposed to the model.
export async function nativeCallback({sessionId,runId,allowed,execute,signal,continuous=false}){
  const token=randomBytes(32).toString('hex'), calls=new Map();
  let closed=false,tail=Promise.resolve(),count=0;
  const server=http.createServer(async(req,res)=>{
    const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    const supplied=Buffer.from(String(req.headers.authorization??'')),expected=Buffer.from('Bearer '+token);
    if(closed||signal?.aborted||req.method!=='POST'||req.url!=='/tool'||req.headers.origin||
      req.headers.host!==`127.0.0.1:${server.address().port}`||
      supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){send(403,{error:'无有效的本轮工具授权'});return;}
    try{
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>300000)throw Error('工具参数过大');chunks.push(chunk);}
      const value=JSON.parse(Buffer.concat(chunks).toString());
      if(value.sessionId!==sessionId||value.runId!==runId||typeof value.callId!=='string'||value.callId.length>200||!allowed.includes(value.tool))throw Error('工具不属于当前会话或本轮');
      const signature=JSON.stringify([value.tool,value.args]);
      let saved=calls.get(value.callId);
      if(saved&&saved.signature!==signature)throw Error('重复工具调用ID的参数不一致');
      if(!saved){
        if(++count>(continuous?128:32))throw Error('本轮原生工具调用次数超限');
        const promise=tail.then(async()=>{
          if(closed||signal?.aborted)throw Error('本轮已停止');
          return execute(value.tool,value.args,value.callId);
        }).catch(error=>({error:error.message}));
        tail=promise.then(()=>{});saved={signature,promise};calls.set(value.callId,saved);
      }
      send(200,await saved.promise);
    }catch(error){send(400,{error:error.message});}
  });
  server.requestTimeout=20000;server.headersTimeout=10000;
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {url:`http://127.0.0.1:${server.address().port}/tool`,token,
    async close(){closed=true;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await tail;}};
}
