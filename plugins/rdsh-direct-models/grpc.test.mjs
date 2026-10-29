import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { grpcFrame, grpcStream } from './grpc.mjs';

const URL = 'https://api2.cursor.sh/aiserver.v1.ChatService/StreamUnifiedChatWithTools';
async function collect(stream) { const result=[]; for await(const chunk of stream) result.push(chunk); return result; }
function transport({ chunks=[], status='0', http=200, type='application/grpc+proto', hang=false, responseStatus=false, extraTrailers={} }={}) {
  const state={};
  state.connectImpl=origin=>{
    state.origin=origin;
    const session=new EventEmitter(); session.destroy=()=>{state.destroyed=true;};
    session.request=headers=>{
      state.headers=headers;
      const request=new PassThrough();
      request.end=body=>{
        state.body=body;
        process.nextTick(()=>{
          request.emit('response',{':status':http,'content-type':type,...(responseStatus?{'grpc-status':status}:{})});
          for(const chunk of chunks)request.write(chunk);
          if(!hang){if(status!==undefined&&!responseStatus)request.emit('trailers',{'grpc-status':status,...extraTrailers});request.push(null);}
        });
      };
      return request;
    };
    return session;
  };
  return state;
}
test('gRPC sends HTTP2 protobuf framing and accepts fragmented frames with successful trailers',async()=>{
  const frame=grpcFrame(Buffer.from('reply'));
  const state=transport({chunks:[frame.subarray(0,2),frame.subarray(2,7),frame.subarray(7)]});
  const values=await collect(grpcStream(URL,Buffer.from('request'),{connectImpl:state.connectImpl}));
  assert.equal(values[0].toString(),'reply');
  assert.equal(state.headers['content-type'],'application/grpc+proto');
  assert.equal(state.headers.te,'trailers');
  assert.equal(state.headers[':path'],'/aiserver.v1.ChatService/StreamUnifiedChatWithTools');
  assert.deepEqual(state.body,grpcFrame(Buffer.from('request')));
  assert.equal(state.destroyed,true);
});
test('HTTP200 with grpcstatus8 and empty body is an error',async()=>{
  const state=transport({status:'8'});
  await assert.rejects(collect(grpcStream(URL,Buffer.alloc(0),{connectImpl:state.connectImpl})),/status 8/);
});
test('mandatory terminal status supports trailers-only headers and rejects missing or invalid status',async()=>{
  const good=transport({responseStatus:true});
  assert.deepEqual(await collect(grpcStream(URL,Buffer.alloc(0),{connectImpl:good.connectImpl})),[]);
  for(const status of [undefined,'invalid']){
    const state=transport({status});
    // Explicit undefined needs removal because object-destructuring applies the default.
    if(status===undefined){state.connectImpl=()=>{const s=new EventEmitter();s.destroy=()=>{};s.request=()=>{const r=new PassThrough();r.end=()=>process.nextTick(()=>{r.emit('response',{':status':200,'content-type':'application/grpc+proto'});r.push(null);});return r;};return s;};}
    await assert.rejects(collect(grpcStream(URL,Buffer.alloc(0),{connectImpl:state.connectImpl})),/terminal status/);
  }
});
test('frame limits, compression, truncation and invalid HTTP metadata fail closed',async()=>{
  const huge=Buffer.alloc(5);huge.writeUInt32BE(4*1024*1024+1,1);
  const compressed=grpcFrame(Buffer.from('x'));compressed[0]=1;
  for(const options of [{chunks:[huge]},{chunks:[compressed]},{chunks:[Buffer.from([0,0,0])]},{http:401},{type:'text/html'}]){
    const state=transport(options);
    await assert.rejects(collect(grpcStream(URL,Buffer.alloc(0),{connectImpl:state.connectImpl})));
  }
});
test('timeout and caller abort destroy the request and session',async()=>{
  const state=transport({hang:true});
  // Keep this unit test alive while the transport's production deadline is unref'ed.
  const keepAlive=setTimeout(()=>{},1000);
  try{await assert.rejects(collect(grpcStream(URL,Buffer.alloc(0),{connectImpl:state.connectImpl,timeoutMs:10})),/timed out/);}finally{clearTimeout(keepAlive);}
  assert.equal(state.destroyed,true);
  const controller=new AbortController(), aborted=transport({hang:true});
  const pending=collect(grpcStream(URL,Buffer.alloc(0),{connectImpl:aborted.connectImpl,signal:controller.signal}));
  process.nextTick(()=>controller.abort());
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(aborted.destroyed,true);
});
test('unsupported hosts and raw network failures cannot leak their diagnostics',async()=>{
  await assert.rejects(collect(grpcStream('https://evil.example/rpc',Buffer.alloc(0))),/Unsupported/);
  await assert.rejects(collect(grpcStream(URL,Buffer.alloc(0),{connectImpl:()=>{throw new Error('secret-token');}})),error=>!error.message.includes('secret-token'));
});
function terminal(value={}){const frame=grpcFrame(Buffer.from(JSON.stringify(value)));frame[0]=2;return frame;}
test('Connect protobuf over HTTP2 yields only data and requires a JSON terminal frame',async()=>{
  const state=transport({type:'application/connect+proto',chunks:[grpcFrame(Buffer.from('reply')),terminal()]});
  const result=await collect(grpcStream(URL,Buffer.from('request'),{transport:'connect',connectImpl:state.connectImpl}));
  assert.equal(result[0].toString(),'reply');assert.equal(result.length,1);
  assert.equal(state.headers['content-type'],'application/connect+proto');
  assert.equal(state.headers['connect-protocol-version'],'1');
  assert.equal(state.headers['connect-accept-encoding'],'identity');
  for(const chunks of [[],[grpcFrame(Buffer.from('reply'))],[terminal(),grpcFrame(Buffer.from('later'))],[terminal(),terminal()],[Buffer.from([2,0,0,0,1,120])]]){
    const invalid=transport({type:'application/connect+proto',chunks});
    await assert.rejects(collect(grpcStream(URL,Buffer.alloc(0),{transport:'connect',connectImpl:invalid.connectImpl})));
  }
});
test('Connect terminal errors preserve safe code while redacting credential headers and explicit secrets',async()=>{
  const state=transport({type:'application/connect+proto',chunks:[terminal({error:{code:'permission_denied',message:'failed Bearer top-secret-token other-secret sk-abcdefghijklmnop'}})]});
  await assert.rejects(collect(grpcStream(URL,Buffer.alloc(0),{transport:'connect',connectImpl:state.connectImpl,headers:{authorization:'Bearer top-secret-token'},secrets:['other-secret']})),error=>{
    assert.equal(error.code,'permission_denied');
    assert.match(error.message,/REDACTED/);
    assert.doesNotMatch(error.message,/top-secret-token|other-secret|sk-abcdefghijklmnop/);
    return true;
  });
  const unknown=transport({type:'application/connect+proto',chunks:[terminal({error:{code:'top-secret-token',message:'denied'}})]});
  await assert.rejects(collect(grpcStream(URL,Buffer.alloc(0),{transport:'connect',connectImpl:unknown.connectImpl})),error=>error.code==='unknown'&&!error.message.includes('top-secret-token'));
});
test('gRPC diagnostics decode safe message and report binary detail length without exposing contents',async()=>{
  const details=Buffer.from('binary-secret').toString('base64');
  const state=transport({status:'8',extraTrailers:{'grpc-message':encodeURIComponent('rate limit: top-secret-token\ntry later'),'grpc-status-details-bin':details}});
  await assert.rejects(collect(grpcStream(URL,Buffer.alloc(0),{connectImpl:state.connectImpl,headers:{authorization:'Bearer top-secret-token'}})),error=>{
    assert.match(error.message,/rate limit/);assert.match(error.message,new RegExp(`status details: ${details.length} bytes`));
    assert.doesNotMatch(error.message,/top-secret-token|binary-secret/);assert.ok(!error.message.includes(details));
    return true;
  });
});
