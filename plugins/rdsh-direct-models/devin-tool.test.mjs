import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { registerDevinTool, inject } from './devin-tool.mjs';

function fixture(options={}) {
  const state={};
  const ctx={on(event,listener){assert.equal(event,'tools/pre-execute');state.policy=listener;return ()=>{state.policyRemoved=true;};},tools:{register(definition){state.definition=definition;return ()=>{state.toolRemoved=true;};}}};
  state.dispose=registerDevinTool(ctx,options);
  return state;
}
async function workspace(t){const root=await mkdtemp(path.join(tmpdir(),'rdsh-devin-tool-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
function execution(root,signal=new AbortController().signal){return {name:'devin_cli',arguments:{prompt:'hello'},agent:{session:{header:{cwd:root}}},signal};}
function childFixture(handler){
  const state={};
  state.spawnImpl=(file,args,options)=>{
    state.file=file;state.args=args;state.options=options;
    const child=new EventEmitter();child.pid=12345;child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>process.nextTick(()=>child.emit('close',null,'SIGKILL'));state.child=child;
    process.nextTick(()=>handler?.(child));return child;
  };
  state.killImpl=(pid,signal)=>{state.killed={pid,signal};process.nextTick(()=>state.child.emit('close',null,signal));};
  return state;
}
test('registry installs an exclusive tool and DSH approval gate; unrelated tools and denials are preserved',async t=>{
  const root=await workspace(t),state=fixture();
  assert.deepEqual(inject,['tools']);assert.equal(state.definition.name,'devin_cli');assert.equal(state.definition.isConcurrencySafe(),false);
  assert.deepEqual(await state.policy(execution(root),async()=>({kind:'allow'})),{kind:'ask',reason:'Delegate this prompt to Devin CLI in the current session workspace. Devin may read files, edit files, run commands, and use its account.'});
  assert.deepEqual(await state.policy(execution(root),async()=>({kind:'deny',reason:'blocked'})),{kind:'deny',reason:'blocked'});
  assert.deepEqual(await state.policy({name:'other'},async()=>({kind:'allow'})),{kind:'allow'});
  state.dispose();assert.ok(state.policyRemoved&&state.toolRemoved);
});
test('spawn passes literal prompt argv, fixed executable, clean environment and no permission or trust bypass',async t=>{
  const root=await workspace(t),child=childFixture(process=>{process.stdout.write('OK secret-value');process.stderr.write('warning');process.emit('close',0,null);});
  const state=fixture({...child,env:{HOME:'/fake/home',PATH:'/usr/bin',API_TOKEN:'secret-value',DEVIN_PERMISSION_MODE:'dangerous'},executable:'/fixed/devin'});
  const prompt='say hello; $(touch dangerous) `echo do-not-run`';
  const result=await state.definition.execute({prompt},execution(root));
  assert.equal(child.file,'/fixed/devin');assert.deepEqual(child.args,['-p',prompt]);assert.equal(child.options.shell,false);
  assert.equal(child.options.cwd,await import('node:fs/promises').then(fs=>fs.realpath(root)));
  assert.deepEqual(child.options.env,{HOME:'/fake/home',PATH:'/usr/bin'});assert.equal(child.options.stdio[0],'ignore');
  assert.equal(result.exitCode,0);assert.equal(result.stdout,'OK [REDACTED]');assert.equal(result.stderr,'warning');
});
test('workspace boundary rejects traversal, sibling paths, symlink escapes and unidentified sessions',async t=>{
  const root=await workspace(t),outside=await workspace(t),child=childFixture(),state=fixture(child);
  await symlink(outside,path.join(root,'escape'));
  for(const cwd of ['..',outside,'escape'])await assert.rejects(state.definition.execute({prompt:'hello',cwd},execution(root)),/inside/);
  await assert.rejects(state.definition.execute({prompt:'hello'},{signal:new AbortController().signal}),/identified/);
  assert.equal(child.file,undefined);
  await mkdir(path.join(root,'nested'));
  const decision=await state.policy({...execution(root),arguments:{prompt:'hello',cwd:'nested'}},async()=>({kind:'allow'}));assert.equal(decision.kind,'ask');
});
test('invalid args deny before spawn, and output schema uses supported DSH oneOf',async t=>{
  const root=await workspace(t),child=childFixture(),state=fixture(child);
  for(const args of [{prompt:''},{prompt:'x'.repeat(32001)},{prompt:'hello',timeout:0},{prompt:'hello',timeout:301},{prompt:'hello',permission_mode:'dangerous'}]){
    assert.equal((await state.policy({...execution(root),arguments:args},async()=>({kind:'allow'}))).kind,'deny');
    await assert.rejects(state.definition.execute(args,execution(root)));
  }
  assert.equal(child.file,undefined);assert.ok(state.definition.output.schema.properties.exitCode.oneOf);
});
test('caller abort kills the process group and drains close before rejection',async t=>{
  const root=await workspace(t),controller=new AbortController(),child=childFixture(()=>controller.abort()),state=fixture(child);
  await assert.rejects(state.definition.execute({prompt:'hello'},execution(root,controller.signal)),{name:'AbortError'});
  assert.deepEqual(child.killed,{pid:process.platform==='win32'?undefined:-12345,signal:'SIGKILL'});
});
test('output is bounded and excessive output terminates the process group',async t=>{
  const root=await workspace(t),child=childFixture(process=>process.stdout.write('x'.repeat(128*1024))),state=fixture(child);
  const result=await state.definition.execute({prompt:'hello'},execution(root));
  assert.equal(result.truncated,true);assert.equal(Buffer.byteLength(result.stdout),64*1024);assert.equal(result.signal,'SIGKILL');
});
test('truncation inside a secret redacts every partial prefix in stdout and stderr',async t=>{
  const root=await workspace(t),secret='synthetic-sensitive-token/value';
  for(const stream of ['stdout','stderr'])for(const value of [secret,encodeURIComponent(secret)])for(const prefixLength of [1,4,16,value.length-1]){
    const child=childFixture(process=>process[stream].write('x'.repeat(64*1024-prefixLength)+value));
    const state=fixture({...child,env:{API_TOKEN:secret}});
    const result=await state.definition.execute({prompt:'hello'},execution(root));
    assert.equal(result.truncated,true);
    assert.ok(result[stream].endsWith('[REDACTED]'));
    assert.ok(Buffer.byteLength(result[stream])<=64*1024);
    assert.ok(!result[stream].endsWith(value.slice(0,prefixLength)));
    assert.equal(result.signal,'SIGKILL');
    state.dispose();
  }
});
test('AQ-format API keys are redacted without requiring an environment copy',async t=>{
  const root=await workspace(t),child=childFixture(process=>{process.stdout.write('key AQ.synthetic_example_key_123456');process.emit('close',0,null);});
  const state=fixture({...child,env:{}});
  const result=await state.definition.execute({prompt:'hello'},execution(root));
  assert.equal(result.stdout,'key [REDACTED]');
});
test('timeouts terminate the process group and settle with timedOut',async t=>{
  const root=await workspace(t),child=childFixture(),state=fixture(child);
  const keepAlive=setTimeout(()=>{},2000);
  try{const result=await state.definition.execute({prompt:'hello',timeout:1},execution(root));assert.equal(result.timedOut,true);assert.equal(result.signal,'SIGKILL');}finally{clearTimeout(keepAlive);}
});
