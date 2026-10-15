import test from 'node:test';
import assert from 'node:assert/strict';
import { access,readdir } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { executeCursorSdk } from './cursor-sdk-runner.mjs';
import { createCursorSdkBackend,createCursorSdkRunner } from './cursor-sdk.mjs';
const json=JSON.stringify({version:1,text:'OK',toolCalls:[]});
function sdkMock(events=[]){const state={};state.sdk={JsonlLocalAgentStore:class{constructor(root){state.store=root;}},Cursor:{models:{list:async options=>{state.auth=options;return [{model:{id:'real-model'},name:'Real'}];}}},Agent:{create:async options=>{state.options=options;return {send:async(prompt,sendOptions)=>{state.prompt=prompt;state.sendOptions=sendOptions;return {stream:async function*(){yield* events;},wait:async()=>({status:'finished',result:json}),cancel:async()=>{state.canceled=true;}};},close:()=>{state.closed=true;}};}}};return state;}
test('official SDK creates a fresh empty workspace, explicit store and disables every action capability',async()=>{
 const state=sdkMock();
 assert.deepEqual(await executeCursorSdk({action:'generate',model:'model',prompt:'prompt'},{sdk:state.sdk,env:{CURSOR_API_KEY:'sdk-api-key',CURSOR_ACCESS_TOKEN:'oauth-not-used'}}),{text:json});
 assert.deepEqual(state.options.tools,[]);assert.deepEqual(state.options.disallowedTools,['mcp','task']);assert.deepEqual(state.options.mcpServers,{});assert.deepEqual(state.options.agents,{});
 assert.deepEqual(state.options.local.settingSources,[]);assert.deepEqual(state.options.local.customTools,{});assert.equal(state.options.local.enableAgentRetries,false);assert.equal(state.options.apiKey,'sdk-api-key');assert.ok(state.store.endsWith('/store'));assert.ok(state.closed);
 await assert.rejects(access(state.options.local.cwd));
});
test('SDK model discovery returns official catalog with only SDK API key or default credential store',async()=>{
 const state=sdkMock();assert.deepEqual(await executeCursorSdk({action:'models'},{sdk:state.sdk,env:{CURSOR_ACCESS_TOKEN:'not-sdk-key'}}),{models:[{id:'real-model',name:'Real'}]});assert.deepEqual(state.auth,{});
});
test('any SDK tool or task event fails closed and cancels run',async()=>{
 for(const event of [{type:'tool_call',name:'shell'},{type:'task'},{type:'assistant',message:{content:[{type:'tool_use',name:'read'}]}},{type:'system',tools:['shell']}]){
  const state=sdkMock([event]);await assert.rejects(executeCursorSdk({action:'generate',model:'model',prompt:'prompt'},{sdk:state.sdk,env:{}}),error=>error.code==='SDK_TOOL_DETECTED');assert.equal(state.canceled,true);assert.equal(state.closed,true);
 }
});
test('JSON turns include DSH history and allow at most one repair, with tool proposals returned to DSH',async()=>{
 const calls=[],tool={name:'read_file',parameters:{type:'object',required:['path'],properties:{path:{type:'string'}}}};
 const backend=createCursorSdkBackend({runner:async payload=>{calls.push(payload);return {text:calls.length===1?'invalid':JSON.stringify({version:1,text:'',toolCalls:[{id:'c',name:'read_file',arguments:{path:'README.md'}}]})};}});
 const result=await backend.generate({model:'model',messages:[{role:'tool',toolCallId:'old',content:[{type:'text',text:'previous result'}]}],tools:[tool]});
 assert.equal(calls.length,2);assert.match(calls[0].prompt,/previous result/);assert.match(calls[1].prompt,/failed validation/);assert.deepEqual(result.toolCalls,[{id:'c',name:'read_file',arguments:'{"path":"README.md"}'}]);
 let count=0;await assert.rejects(createCursorSdkBackend({runner:async()=>{count++;return {text:'invalid'};}}).generate({model:'model'}));assert.equal(count,2);
});
function spawnFixture(handler){const state={};state.spawnImpl=(file,args,options)=>{state.options=options;state.args=args;state.file=file;const child=new EventEmitter();child.pid=98765;child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>process.nextTick(()=>child.emit('close',null));state.child=child;process.nextTick(()=>handler(child));return child;};state.killImpl=(pid,signal)=>{state.killed={pid,signal};process.nextTick(()=>state.child.emit('close',null));};return state;}
test('isolated runner argv is literal Node module and environment cannot import CLI OAuth or secret tokens',async()=>{
 const state=spawnFixture(child=>{child.stdout.write(JSON.stringify({text:json}));child.emit('close',0);});
 const result=await createCursorSdkRunner({...state,env:{HOME:'/home',CURSOR_API_KEY:'sdk-key',CURSOR_ACCESS_TOKEN:'oauth',OTHER_TOKEN:'private',NODE_OPTIONS:'inject-code'}})({action:'generate',prompt:'literal $(danger)'});
 assert.equal(result.text,json);assert.equal(state.file,process.execPath);assert.equal(state.options.shell,false);assert.match(state.args[0],/cursor-sdk-runner.mjs$/);assert.deepEqual(state.options.env,{HOME:'/home',CURSOR_API_KEY:'sdk-key'});
});
test('runner enforces timeout/cancel/output bound and does not expose diagnostics',async()=>{
 const timed=spawnFixture(()=>{}),keepAlive=setTimeout(()=>{},1000);
 try{await assert.rejects(createCursorSdkRunner({...timed,timeoutMs:10})({action:'models'}),/timed out/);}finally{clearTimeout(keepAlive);}
 assert.equal(timed.killed.signal,'SIGKILL');
 const controller=new AbortController(),aborted=spawnFixture(()=>controller.abort());await assert.rejects(createCursorSdkRunner(aborted)({action:'models'},{signal:controller.signal}),/aborted/);assert.equal(aborted.killed.signal,'SIGKILL');
 const noisy=spawnFixture(child=>{child.stderr.write('secret-token');child.stdout.write(JSON.stringify({error:'secret-token'}));child.emit('close',1);});await assert.rejects(createCursorSdkRunner(noisy)({action:'models'}),error=>!error.message.includes('secret-token'));
 const huge=spawnFixture(child=>child.stdout.write(Buffer.alloc(8*1024*1024+1)));await assert.rejects(createCursorSdkRunner(huge)({action:'models'}),/output exceeds/);
});
