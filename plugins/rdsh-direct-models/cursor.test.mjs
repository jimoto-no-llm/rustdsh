import test from 'node:test';
import assert from 'node:assert/strict';
import { createCursorBackend, cursorRequest } from './cursor.mjs';
import { decodeFields,pbText,pbBytes,pbString,pbFields,pbInt } from './protobuf.mjs';

test('Cursor native protobuf request contains schema-verified chat fields',()=>{
  const outer=decodeFields(cursorRequest({model:'composer-2.5',system:'system',sessionId:'session',messages:[{role:'user',content:[{type:'text',text:'hello'}]},{role:'assistant',content:[{type:'text',text:'world'}]}]}));
  const inner=decodeFields(outer.get(1)[0]);
  assert.equal(pbText(decodeFields(inner.get(3)[0]),1),'system');
  assert.equal(pbText(decodeFields(inner.get(5)[0]),1),'composer-2.5');
  const messages=inner.get(1).map(decodeFields);
  assert.equal(pbText(messages[0],1),'hello');
  assert.equal(messages[0].get(2)[0],1n);
  assert.equal(messages[1].get(2)[0],2n);
  assert.equal(inner.get(22)[0],1n);assert.equal(inner.get(27)[0],0n);
  assert.equal(inner.get(33)[0],1n);assert.equal(inner.get(46)[0],1n);assert.equal(inner.get(48)[0],1n);
});
test('images and invalid tool history fail explicitly before reading credentials',async()=>{
  const backend=createCursorBackend({credentials:async()=>{throw new Error('credentials must not be read');}});
  for(const options of [{messages:[{role:'tool',content:[]}]},{messages:[{role:'user',content:[{type:'image'}]}]},{messages:[{role:'assistant',content:[{type:'tool-call',name:'read_file'}]}]}]){
    await assert.rejects(backend.generate({model:'composer-2.5',messages:[],...options}),/unsupported|no matching|Invalid Cursor/);
  }
});
test('native gRPC response nested text is generated without CLI delegation',async()=>{
  const backend=createCursorBackend({credentials:async()=>({accessToken:'test-token'}),grpcImpl:async function*(url,body,options){
    assert.match(url,/StreamUnifiedChatWithTools$/);
    assert.equal(options.headers.authorization,'Bearer test-token');
    assert.ok(Buffer.isBuffer(body));
    yield pbBytes(2,pbString(1,'hello '));yield pbBytes(2,pbString(1,'world'));
  }});
  assert.deepEqual(await backend.generate({model:'composer-2.5',messages:[]}),{text:'hello world',toolCalls:[]});
});
test('gRPC errors and empty generation do not become successful model output',async()=>{
  for(const grpcImpl of [async function*(){throw new Error('Native gRPC failed (status 8)');},async function*(){}]){
    const backend=createCursorBackend({credentials:async()=>({accessToken:'test-token'}),grpcImpl});
    await assert.rejects(backend.generate({model:'composer-2.5',messages:[]}));
  }
});

const tool={name:'read_file',description:'Read a file',parameters:{type:'object',properties:{path:{type:'string'}}}};
function clientTool({id='call1',name='read_file',args='{"path":"README.md"}',index=2,modelCallId='model1',toolId=19}={}) {
  return pbBytes(1,pbFields(pbInt(1,toolId),pbString(3,id),pbString(9,name),pbString(10,args),pbInt(48,index),pbString(49,modelCallId)));
}
function streamedTool({args='{"path":"README.md"}',name='read_file'}={}) {
  return pbBytes(2,pbBytes(36,pbFields(pbInt(1,19),pbString(2,'call1'),pbString(8,name),pbString(10,args),pbInt(50,2),pbString(51,'model1'))));
}
test('MCP declarations enable only native MCP tools, with JSON schema and no server executor',()=>{
  const inner=decodeFields(decodeFields(cursorRequest({model:'model',messages:[],tools:[tool]})).get(1)[0]);
  assert.equal(inner.get(27)[0],1n);assert.equal(inner.get(48)[0],0n);
  assert.deepEqual(inner.get(29),[19n]);
  const definition=decodeFields(inner.get(34)[0]);
  assert.equal(pbText(definition,1),'read_file');assert.equal(pbText(definition,4),'rdsh');
  assert.deepEqual(JSON.parse(pbText(definition,3)),tool.parameters);
});
test('MCP generation and next-turn DSH tool result make a native request roundtrip',async()=>{
  const backend=createCursorBackend({credentials:async()=>({accessToken:'test-token'}),grpcImpl:async function*(){yield streamedTool({args:'{"path":'});yield clientTool();}});
  const result=await backend.generate({model:'model',messages:[],tools:[tool]});
  assert.deepEqual(result.toolCalls,[{id:'call1',name:'read_file',arguments:'{"path":"README.md"}'}]);
  assert.equal(result.replayState.toolCalls[0].toolIndex,2);
  const history=[{role:'assistant',id:'assistant1',content:result.toolCalls.map(call=>({type:'tool-call',...call})),source:{provider:'cursor-native',replayState:{response:result.replayState}}},{role:'tool',toolCallId:'call1',content:[{type:'text',text:'file contents'}]}];
  const inner=decodeFields(decodeFields(cursorRequest({model:'model',messages:history,tools:[tool]})).get(1)[0]);
  assert.equal(inner.get(1).length,1);
  const ai=decodeFields(inner.get(1)[0]);assert.equal(ai.get(2)[0],2n);
  const toolResult=decodeFields(ai.get(18)[0]);
  assert.equal(pbText(toolResult,1),'call1');assert.equal(pbText(toolResult,2),'read_file');
  assert.equal(toolResult.get(3)[0],2n);assert.equal(pbText(toolResult,5),'{"path":"README.md"}');
  assert.equal(pbText(toolResult,7),'file contents');assert.equal(pbText(toolResult,12),'model1');
  const nativeResult=decodeFields(toolResult.get(8)[0]);
  assert.equal(nativeResult.get(1)[0],19n);assert.equal(pbText(nativeResult,35),'call1');
  const mcpResult=decodeFields(nativeResult.get(28)[0]);
  assert.equal(pbText(mcpResult,1),'read_file');assert.equal(pbText(mcpResult,2),'file contents');
  assert.equal(pbText(decodeFields(toolResult.get(11)[0]),3),'call1');
});
test('streamed tool responses use complete final snapshots, never speculative delta concatenation',async()=>{
  const backend=createCursorBackend({credentials:async()=>({accessToken:'test-token'}),grpcImpl:async function*(){yield streamedTool({args:'{"path":'});yield streamedTool();}});
  const result=await backend.generate({model:'model',messages:[],tools:[tool]});
  assert.equal(result.toolCalls[0].arguments,'{"path":"README.md"}');
});
test('unknown or builtin tools, malformed arguments, name changes and conflicting finals fail closed',async()=>{
  const sequences=[[clientTool({name:'unknown'})],[clientTool({toolId:1})],[clientTool({args:'[]'})],[clientTool({args:'invalid'})],[streamedTool(),clientTool({name:'unknown'})],[clientTool(),clientTool({args:'{}'})]];
  for(const sequence of sequences){
    const backend=createCursorBackend({credentials:async()=>({accessToken:'test-token'}),grpcImpl:async function*(){yield* sequence;}});
    await assert.rejects(backend.generate({model:'model',messages:[],tools:[tool]}));
  }
});
