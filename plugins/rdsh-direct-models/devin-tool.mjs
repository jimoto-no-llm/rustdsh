import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const name='rdsh-devin-cli-tool';
export const inject=['tools'];
const MAX_OUTPUT=64*1024;
const MAX_PROMPT=32000;
const ENV_ALLOWLIST=['HOME','PATH','USER','LOGNAME','TMPDIR','TMP','TEMP','LANG','LC_ALL','TERM','XDG_CONFIG_HOME','XDG_DATA_HOME'];

function validateArgs(args) {
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!['prompt','cwd','timeout'].includes(key)))throw new Error('Invalid devin_cli arguments');
  if(typeof args.prompt!=='string'||!args.prompt.trim()||args.prompt.length>MAX_PROMPT||args.prompt.includes('\0'))throw new Error('devin_cli prompt must contain 1–32000 characters');
  if(args.cwd!==undefined&&(typeof args.cwd!=='string'||args.cwd.includes('\0')))throw new Error('Invalid devin_cli working directory');
  const timeout=args.timeout??120;
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>300)throw new Error('devin_cli timeout must be 1–300 seconds');
  return {prompt:args.prompt,cwd:args.cwd,timeout};
}
async function workspaceCwd(args,exec) {
  const root=exec.agent?.session?.header?.cwd;
  if(typeof root!=='string'||!path.isAbsolute(root))throw new Error('devin_cli requires an identified DSH session workspace');
  let workspace,cwd;
  try {workspace=await realpath(root);cwd=await realpath(path.resolve(workspace,args.cwd??'.'));if(!(await stat(cwd)).isDirectory())throw new Error();}
  catch{throw new Error('devin_cli working directory is unavailable');}
  const relative=path.relative(workspace,cwd);
  if(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw new Error('devin_cli working directory must stay inside the DSH session workspace');
  return cwd;
}
function sanitizedEnvironment(source) {
  return Object.fromEntries(ENV_ALLOWLIST.filter(key=>typeof source[key]==='string').map(key=>[key,source[key]]));
}
function redact(text,env,{truncated=false}={}) {
  const secrets=Object.entries(env).filter(([key,value])=>/token|secret|password|api.?key|credential|authorization/i.test(key)&&typeof value==='string'&&value.length>=4).map(([,value])=>value).sort((a,b)=>b.length-a.length);
  for(const secret of secrets)for(const value of new Set([secret,encodeURIComponent(secret)])){
    // A bounded byte capture can end inside a credential. Remove every
    // nonempty matching suffix before ordinary whole-value redaction.
    if(truncated){for(let length=Math.min(value.length-1,text.length);length>0;length--){if(text.endsWith(value.slice(0,length))){text=text.slice(0,-length)+'[REDACTED]';break;}}}
    text=text.split(value).join('[REDACTED]');
  }
  text=text.replace(/Bearer\s+[^\s,;]+/gi,'Bearer [REDACTED]').replace(/\b(?:sk-|eyJ|AQ\.)[A-Za-z0-9_./+-]{12,}/g,'[REDACTED]');
  if(Buffer.byteLength(text)>MAX_OUTPUT)text=Buffer.from(text).subarray(0,MAX_OUTPUT-10).toString('utf8').replace(/\uFFFD$/,'')+'[REDACTED]';
  return text;
}
async function runCli(args,cwd,signal,{spawnImpl,killImpl,env,executable}) {
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    let child,timer,stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),timedOut=false,truncated=false,aborted=false,settled=false;
    const stop=()=>{try{if(process.platform!=='win32'&&child?.pid)killImpl(-child.pid,'SIGKILL');else child?.kill('SIGKILL');}catch{try{child?.kill('SIGKILL');}catch{}}};
    const onAbort=()=>{aborted=true;stop();};
    const finish=(code,termination)=>{
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);
      if(aborted||signal?.aborted){try{signal?.throwIfAborted();}catch(error){reject(error);return;}reject(new Error('devin_cli canceled'));return;}
      resolve({exitCode:Number.isInteger(code)?code:null,signal:typeof termination==='string'?termination:null,stdout:redact(stdout.toString('utf8'),env,{truncated}),stderr:redact(stderr.toString('utf8'),env,{truncated}),timedOut,truncated});
    };
    try {
      // No permission/trust bypass flags: keep the installed CLI defaults and let
      // headless calls stop when Devin itself needs an additional approval.
      child=spawnImpl(executable,['-p',args.prompt],{cwd,env:sanitizedEnvironment(env),stdio:['ignore','pipe','pipe'],shell:false,detached:process.platform!=='win32'});
      const collect=which=>chunk=>{
        const buffer=Buffer.from(chunk),current=which==='stdout'?stdout:stderr;
        const next=Buffer.concat([current,buffer.subarray(0,Math.max(0,MAX_OUTPUT-current.length))]);
        if(which==='stdout')stdout=next;else stderr=next;
        if(current.length+buffer.length>MAX_OUTPUT){truncated=true;stop();}
      };
      child.stdout.on('data',collect('stdout'));child.stderr.on('data',collect('stderr'));
      child.on('error',()=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);reject(new Error('devin_cli could not start the installed Devin executable'));});
      child.on('close',finish);
      signal?.addEventListener('abort',onAbort,{once:true});
      timer=setTimeout(()=>{timedOut=true;stop();},args.timeout*1000);timer.unref?.();
      if(signal?.aborted)onAbort();
    }catch{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);reject(new Error('devin_cli could not start the installed Devin executable'));}
  });
}

export function registerDevinTool(ctx,{spawnImpl=spawn,killImpl=process.kill.bind(process),env=process.env,executable=path.join(homedir(),'.local/bin/devin')}={}) {
  // DSH has no readOnly annotation in ToolDefinition. The pre-execute ask is
  // the actual approval seam; absent approval support is denied by ToolRuntime.
  const unregisterPolicy=ctx.on('tools/pre-execute',async(exec,next)=>{
    if(exec.name!=='devin_cli')return next();
    const inherited=await next();
    if(inherited.kind!=='allow')return inherited;
    try{await workspaceCwd(validateArgs(exec.arguments),exec);}catch(error){return {kind:'deny',reason:error.message};}
    return {kind:'ask',reason:'Delegate this prompt to Devin CLI in the current session workspace. Devin may read files, edit files, run commands, and use its account.'};
  });
  const unregisterTool=ctx.tools.register({
    name:'devin_cli',
    description:'Delegate a bounded task to the installed Devin CLI. Requires DSH approval. Runs only in this DSH session workspace. Devin has its own agent loop and may modify files or execute commands under its existing permissions; additional headless approvals can stop the call.',
    parameters:{type:'object',properties:{prompt:{type:'string',description:'Nonempty task prompt, maximum 32000 characters.'},cwd:{type:'string',description:'Working directory relative to the DSH session workspace, or an absolute directory inside it.'},timeout:{type:'integer',default:120,description:'Maximum execution time in seconds, from 1 to 300.'}},required:['prompt'],additionalProperties:false},
    output:{schema:{type:'object',properties:{exitCode:{oneOf:[{type:'integer'},{type:'null'}]},signal:{oneOf:[{type:'string'},{type:'null'}]},stdout:{type:'string'},stderr:{type:'string'},timedOut:{type:'boolean'},truncated:{type:'boolean'}},required:['exitCode','signal','stdout','stderr','timedOut','truncated'],additionalProperties:false},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
    isConcurrencySafe:()=>false,
    async execute(raw,exec){const args=validateArgs(raw);const cwd=await workspaceCwd(args,exec);return runCli(args,cwd,exec.signal,{spawnImpl,killImpl,env,executable});},
  });
  return ()=>{unregisterTool?.();unregisterPolicy?.();};
}
export function apply(ctx){return registerDevinTool(ctx);}
