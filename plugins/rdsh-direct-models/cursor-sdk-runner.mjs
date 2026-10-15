import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const LIMIT=8*1024*1024;
export async function executeCursorSdk(input,{sdk,env=process.env}={}) {
  if(!input||!['models','generate'].includes(input.action))throw Object.assign(new Error(),{code:'INVALID_REQUEST'});
  sdk??=await import('@cursor/sdk');
  const auth=env.CURSOR_API_KEY?{apiKey:env.CURSOR_API_KEY}:{};
  if(input.action==='models'){
    const models=await sdk.Cursor.models.list(auth);
    if(!Array.isArray(models))throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});
    return {models:models.map(value=>{const id=value.model?.id??value.id;if(typeof id!=='string'||!id)throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});return {id,name:value.name??value.displayName??id};})};
  }
  if(typeof input.model!=='string'||!input.model||typeof input.prompt!=='string'||Buffer.byteLength(input.prompt)>LIMIT)throw Object.assign(new Error(),{code:'INVALID_REQUEST'});
  const root=await mkdtemp(path.join(tmpdir(),'rdsh-cursor-sdk-'));
  let agent,run;
  try{
    const cwd=path.join(root,'workspace');await mkdir(cwd);
    const store=new sdk.JsonlLocalAgentStore(path.join(root,'store'));
    agent=await sdk.Agent.create({...auth,model:{id:input.model},tools:[],disallowedTools:['mcp','task'],mcpServers:{},agents:{},local:{cwd,store,settingSources:[],customTools:{},enableAgentRetries:false}});
    let forbidden=false;
    const check=value=>{
      if(value?.type==='tool_call'||value?.type==='task'||value?.message?.content?.some(block=>block.type==='tool_use')||(value?.type==='system'&&value.tools?.length)){
        forbidden=true;throw Object.assign(new Error(),{code:'SDK_TOOL_DETECTED'});
      }
    };
    run=await agent.send(input.prompt,{mcpServers:{},local:{customTools:{}},onStep:({step})=>{if(step?.toolCalls?.length||step?.toolCall)throw Object.assign(new Error(),{code:'SDK_TOOL_DETECTED'});},onDelta:({update})=>{if(/tool|task/i.test(update?.type??''))throw Object.assign(new Error(),{code:'SDK_TOOL_DETECTED'});}});
    let size=0;
    for await(const event of run.stream()){size+=Buffer.byteLength(JSON.stringify(event));if(size>LIMIT)throw Object.assign(new Error(),{code:'OUTPUT_LIMIT'});check(event);}
    if(forbidden)throw Object.assign(new Error(),{code:'SDK_TOOL_DETECTED'});
    const result=await run.wait();
    if(result.status!=='finished'||typeof result.result!=='string'||Buffer.byteLength(result.result)>LIMIT)throw Object.assign(new Error(),{code:'SDK_REQUEST_FAILED'});
    return {text:result.result};
  }catch(error){try{await run?.cancel();}catch{}throw error;}
  finally{try{await agent?.close();}finally{await rm(root,{recursive:true,force:true});}}
}
async function main(){
  let size=0,input='';process.stdin.setEncoding('utf8');
  for await(const chunk of process.stdin){size+=Buffer.byteLength(chunk);if(size>LIMIT)throw Object.assign(new Error(),{code:'INPUT_LIMIT'});input+=chunk;}
  const result=await executeCursorSdk(JSON.parse(input));
  await new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(result),error=>error?reject(error):resolve()));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().then(()=>process.exit(0)).catch(error=>{
    const allowed=new Set(['INVALID_REQUEST','INVALID_RESPONSE','SDK_TOOL_DETECTED','OUTPUT_LIMIT','INPUT_LIMIT','SDK_REQUEST_FAILED']);
    const code=allowed.has(error?.code)?error.code:/auth|credential|api.?key/i.test(`${error?.name??''} ${error?.message??''}`)?'SDK_AUTH_REQUIRED':'SDK_REQUEST_FAILED';
    process.stdout.write(JSON.stringify({error:code}),()=>process.exit(1));
  });
}
