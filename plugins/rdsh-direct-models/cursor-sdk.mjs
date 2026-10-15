import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildTurnPrompt,parseTurnResponse,JsonTurnError } from './json-turn.mjs';
const SCRIPT=fileURLToPath(new URL('./cursor-sdk-runner.mjs',import.meta.url));
const LIMIT=8*1024*1024;
const ENV_KEYS=['HOME','PATH','USER','LOGNAME','TMPDIR','TMP','TEMP','LANG','LC_ALL','XDG_CONFIG_HOME','XDG_DATA_HOME','CURSOR_API_KEY'];
export function createCursorSdkRunner({spawnImpl=spawn,killImpl=process.kill.bind(process),timeoutMs=120000,env=process.env}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw new Error('Cursor SDK: invalid timeout');
 return (payload,{signal}={})=>new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(signal.reason??new Error('Cursor SDK: aborted'));return;}
  const input=JSON.stringify(payload);if(Buffer.byteLength(input)>LIMIT){reject(new Error('Cursor SDK: input exceeds limit'));return;}
  let child,timer,output=Buffer.alloc(0),size=0,done=false,failure;
  const stop=()=>{try{if(process.platform!=='win32'&&child?.pid)killImpl(-child.pid,'SIGKILL');else child?.kill('SIGKILL');}catch{try{child?.kill('SIGKILL');}catch{}}};
  const abort=()=>{failure=new Error('Cursor SDK: aborted');stop();};
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  try{
   child=spawnImpl(process.execPath,[SCRIPT],{stdio:['pipe','pipe','pipe'],shell:false,detached:process.platform!=='win32',env:Object.fromEntries(ENV_KEYS.filter(key=>typeof env[key]==='string').map(key=>[key,env[key]]))});
   child.stdout.on('data',chunk=>{size+=chunk.length;if(size>LIMIT){failure=new Error('Cursor SDK: output exceeds limit');stop();}else output=Buffer.concat([output,chunk]);});
   let diagnosticSize=0;child.stderr.on('data',chunk=>{diagnosticSize+=chunk.length;if(diagnosticSize>LIMIT){failure=new Error('Cursor SDK: diagnostics exceed limit');stop();}});
   child.stdin.on('error',()=>{});
   child.on('error',()=>finish(new Error('Cursor SDK: bridge process could not start')));
   child.on('close',code=>{
    if(failure){finish(failure);return;}
    let value;try{value=JSON.parse(output.toString('utf8'));}catch{finish(new Error('Cursor SDK: invalid bridge response'));return;}
    const errors=new Set(['SDK_AUTH_REQUIRED','SDK_TOOL_DETECTED','SDK_REQUEST_FAILED','INVALID_REQUEST','INVALID_RESPONSE','INPUT_LIMIT','OUTPUT_LIMIT']);
    if(value?.error||code!==0){finish(new Error(`Cursor SDK: ${errors.has(value?.error)?value.error:'SDK_REQUEST_FAILED'}`));return;}
    finish(null,value);
   });
   signal?.addEventListener('abort',abort,{once:true});
   timer=setTimeout(()=>{failure=new Error('Cursor SDK: timed out');stop();},timeoutMs);timer.unref?.();
   if(signal?.aborted)abort();else child.stdin.end(input);
  }catch{stop();finish(new Error('Cursor SDK: bridge process could not start'));}
 });
}
export function createCursorSdkBackend({runner=createCursorSdkRunner()}={}){
 return {
  async discover({signal}={}){const value=await runner({action:'models'},{signal});if(!Array.isArray(value?.models)||value.models.some(model=>typeof model.id!=='string'||!model.id))throw new Error('Cursor SDK: invalid model catalog');return value.models;},
  async generate(options){
   let repair;
   for(let attempt=0;attempt<2;attempt++){
    options.signal?.throwIfAborted();
    const result=await runner({action:'generate',model:options.model,prompt:buildTurnPrompt({...options,repair})},{signal:options.signal});
    try{return parseTurnResponse(result?.text,options.tools??[]);}catch(error){if(!(error instanceof JsonTurnError)||attempt===1)throw error;repair=error.message;}
   }
  },
 };
}
