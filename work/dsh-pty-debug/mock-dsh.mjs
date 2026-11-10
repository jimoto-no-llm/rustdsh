import fs from 'node:fs';
import http from 'node:http';
import {createRequire} from 'node:module';
import {isDeepStrictEqual} from 'node:util';
const require=createRequire(process.env.DSH_TEST_WS_PACKAGE || import.meta.url);
const {WebSocketServer}=require('ws');
const root=process.cwd(), logPath=root+'/wire.jsonl';
const log=value=>fs.appendFileSync(logPath,JSON.stringify(value)+'\n');
const check=(ok,message)=>{if(!ok){log({kind:'assertion',message});throw new Error(message);}};
check(JSON.stringify(process.argv.slice(2))===JSON.stringify(['--profile','web','--no-open','--port','0']),'host CLI arguments');
const sockets=new Set(), sessions=new Map();
let creates=0, prompts=0, connections=0, failResume=true;
const fresh=id=>({id,seq:0,records:[],projections:{modelSelection:{next:{provider:'demo',model:'m1'}}}});
const saved=fresh('saved-session');
saved.records=[
 {type:'event',event:{seq:1,type:'assistant/message',data:{message:{content:[{type:'text',text:'RESUMED_SESSION_PROOF'}]},usage:{inputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:1}},surfaceOp:{op:'append'}}},
 {type:'event',event:{seq:2,type:'turn/end',data:{reason:{kind:'completed'}},surfaceOp:{op:'append'}}}
];saved.seq=2;sessions.set(saved.id,saved);
const item=(ws,streamId,value)=>{if(ws.readyState===1)ws.send(JSON.stringify({type:'item',streamId,value}));};
const broadcast=(id,value)=>{for(const ws of sockets)if(ws.follow?.session===id)item(ws,ws.follow.stream,value);};
const record=(id,type,data)=>{
 const s=sessions.get(id), row={type:'event',event:{seq:++s.seq,type,data,surfaceOp:{op:'append'}}};
 s.records.push(row);broadcast(id,row);return row;
};
const stream=(id,frame)=>broadcast(id,{type:'assistant-stream',frame});
const waterfall=(id,eventId,event,request)=>{
 for(const ws of sockets)if(ws.follow?.session===id)item(ws,ws.events,{type:'waterfall',eventId,event,agentId:id,request});
};
const projection=(id,key,value)=>{
 const s=sessions.get(id);s.projections[key]=value;
 for(const ws of sockets)if(ws.control)item(ws,ws.control,{type:'projection',sessionId:id,key,seq:s.seq,value});
};
const usage={inputTokens:20,cacheReadTokens:60,cacheWriteTokens:20,outputTokens:10};
const finish=(id,text,known=true)=>{
 record(id,'assistant/message',{message:{source:{provider:'demo',model:'m1'},content:[{type:'text',text}]},...(known?{usage}:{})});
 record(id,'turn/end',{reason:{kind:'completed'}});
};
const pending=new Map();
const questions=[
 {id:'review',header:'Plan review',question:'Review the proposed plan',detail:'PLAN_DETAIL_TOP\n'+Array.from({length:50},(_,i)=>'plan line '+i).join('\n')+'\nPLAN_DETAIL_END',options:[{label:'Approve plan'},{label:'Decline plan'}],intent:{kind:'plan-review',approve:'Approve plan'}},
 {id:'multi',question:'Choose exact labels',multiSelect:true,options:[{label:'Alpha label',description:'first description'},{label:'Beta 日本語'}]}
];
function begin(id,text){
 const n=++prompts;
 record(id,'turn/start',{});record(id,'user/message',{content:[{type:'text',text}]});
 if(text==='slow'){log({kind:'slow',sessionId:id});return;}
 if(text==='reconnect'){
  finish(id,'RECONNECT_PROOF',false);
  setTimeout(()=>{for(const ws of sockets)if(ws.follow?.session===id)ws.close();},200);return;
 }
 const attempt='attempt-'+n;
 stream(id,{type:'start',attemptId:attempt,revision:1});
 stream(id,{type:'chunk',attemptId:attempt,revision:2,index:0,chunk:{type:'text-delta',text:'STREAM_BEFORE_APPROVAL'}});
 setTimeout(()=>{
  const call='tool-'+n,event='approval-'+n;
  record(id,'tool/call',{callId:call,name:'read',arguments:JSON.stringify({path:'nonce.txt'})});
  pending.set(event,{id,n,text});
  waterfall(id,event,'approval/request',{toolName:'read',callId:call,displayReason:'Read nonce.txt after explicit approval'});
 },500);
}
function result(args){
 check(/^fixture-client-\d+$/.test(args.clientId),'event clientId');
 const p=pending.get(args.eventId);check(!!p,'known pending eventId');
 check(args.outcome?.kind==='result','event result kind');
 pending.delete(args.eventId);
 if(args.eventId.startsWith('approval-')){
  const allow=args.outcome.value;
  check(allow==='allowed-once'||allow==='rejected','approval wire verdict');
  if(allow==='rejected'){finish(p.id,'TOOL_DENIED',false);return {};}
  check(p.text==='read','only explicit read run can access nonce');
  const nonce=fs.readFileSync(root+'/nonce.txt','utf8');log({kind:'nonce-read',proof:nonce});
  record(p.id,'tool/result',{message:{content:[{type:'text',text:nonce}],isError:false}});
  record(p.id,'assistant/message',{message:{source:{provider:'demo',model:'m1'},content:[{type:'text',text:'TOOL_RESULT '+nonce}]},usage});
  setTimeout(()=>{
   const event='questions-'+p.n;pending.set(event,p);
   waterfall(p.id,event,'user-questions/request',{questions,wait:{callId:'question-call-'+p.n,timed:true}});
  },200);return {};
 }
 check(args.eventId.startsWith('questions-'),'question event kind');
 check(isDeepStrictEqual(args.outcome.value,{answers:[
  {id:'review',selected:['Decline plan']},
  {id:'multi',selected:['Alpha label','Beta 日本語'],custom:'custom 日本語'}
 ]}),'exact question answer labels/custom');
 log({kind:'questions-answered'});finish(p.id,'DSH_QUESTIONS_COMPLETE');
 projection(p.id,'tokenUsage',{uncachedInputTokens:40,cacheReadTokens:120,cacheWriteTokens:40,outputTokens:20});
 projection(p.id,'sessionStats',{steps:999});
 return {};
}
async function rpc(method,args){
 switch(method){
  case 'session/modelCatalog':
   check(JSON.stringify(args)==='{}','catalog args');
   return {default:{provider:'demo',model:'m1'},groups:[{id:'demo',models:[{id:'m1'},{id:'m2'}]}]};
  case 'session/create':{
   const r=args.request;check(!!r && (!!r.cwd !== !!r.sessionId),'create request envelope');
   if(r.sessionId){
    check(sessions.has(r.sessionId),'resume references durable session');
    if(failResume){failResume=false;return {mockError:'MOCK_RESUME_ONCE'};}
    return {sessionId:r.sessionId};
   }
   check(r.cwd===root,'workspace cwd exact');const s=fresh('session-'+(++creates));sessions.set(s.id,s);return {sessionId:s.id};
  }
  case 'session/prompt':{
   const r=args.request;check(sessions.has(r?.sessionId)&&r.mode==='queue'&&typeof r.requestId==='string','prompt request envelope');
   check(r.content?.length===1&&r.content[0].type==='text','prompt content blocks');
   setTimeout(()=>begin(r.sessionId,r.content[0].text),30);return {accepted:true};
  }
  case '$events/result':return result(args);
  case 'session/cancel':{
   const id=args.request?.sessionId;check(sessions.has(id),'cancel sessionId');
   for(const [key,value] of pending)if(value.id===id)pending.delete(key);
   record(id,'turn/end',{reason:{kind:'cancelled'}});return {};
  }
  case 'session/list':
   check(JSON.stringify(args)===JSON.stringify({_request:{}}),'list request envelope');
   return {items:[...sessions.values()].map(s=>({id:s.id,title:s.id==='saved-session'?'Saved durable conversation':s.id,cwd:root}))};
  case 'session/page':{
   const r=args.request;check(r.address?.kind==='session'&&r.address.sessionId==='saved-session'&&r.beforeSeq===2&&r.throughSeq===2&&r.maxMessages===500,'history page envelope');
   return {records:saved.records.slice(0,1),hasMore:false};
  }
  case 'session/selectModel':{
   const r=args.request;check(sessions.has(r?.sessionId)&&r.provider==='demo'&&r.model==='m2','model selection envelope');
   projection(r.sessionId,'modelSelection',{next:{provider:r.provider,model:r.model}});return {};
  }
  case 'pluginInventory/list':check(JSON.stringify(args)==='{}','plugins read args');return {plugins:[{name:'FIXTURE_PLUGIN_INVENTORY',enabled:true}]};
  case 'settings/describe':check(JSON.stringify(args)==='{}','settings read args');return {description:'FIXTURE_SETTINGS_READONLY',apiKey:'FIXTURE_PRIVATE_SETTING'};
  default:check(false,'unexpected RPC method '+method);
 }
}
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1');
  if(req.method==='GET'&&url.pathname==='/'&&url.search==='?token=fixture-launch-token'){
   log({kind:'authenticate'});res.writeHead(303,{'Set-Cookie':'fixture_session=fixture-cookie; HttpOnly; SameSite=Strict; Path=/','Location':'/'});res.end();return;
  }
  check(req.headers.cookie==='fixture_session=fixture-cookie','HTTP auth cookie');
  check(req.method==='POST'&&url.pathname.startsWith('/api/'),'RPC route');
  let body='';for await(const chunk of req)body+=chunk;
  const e=JSON.parse(body),method=url.pathname.slice(5);
  check(e.type==='client-request'&&e.method===method&&typeof e.rpcId==='string'&&e.rpcId.length>0&&e.payload?.args&&typeof e.payload.args==='object','RPC envelope');
  log({kind:'rpc',method,args:e.payload.args});
  const value=await rpc(method,e.payload.args);
  const result=value?.mockError?{ok:false,error:{code:value.mockError}}:{ok:true,value};
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({type:'server-response',rpcId:e.rpcId,result}));
 }catch(error){log({kind:'assertion',message:error.message});res.writeHead(500);res.end('mock failure');}
});
const wss=new WebSocketServer({noServer:true});
server.on('upgrade',(req,socket,head)=>{
 if(req.url!=='/api/remote.mux'||req.headers.cookie!=='fixture_session=fixture-cookie'){log({kind:'assertion',message:'WS route/auth cookie'});socket.destroy();return;}
 wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
});
wss.on('connection',ws=>{
 sockets.add(ws);const clientId='fixture-client-'+(++connections);log({kind:'ws-connect',clientId});
 ws.on('close',()=>sockets.delete(ws));
 ws.on('message',raw=>{try{
  const e=JSON.parse(raw.toString());
  if(e.type==='cancel'){log({kind:'stream-cancel',streamId:e.streamId});return;}
  check(e.type==='open'&&typeof e.streamId==='string'&&e.payload?.args,'WS open envelope');
  log({kind:'open',endpoint:e.endpoint,args:e.payload.args});
  if(e.endpoint==='$events'){
   check(JSON.stringify(e.payload.args)==='{}','events args');ws.events=e.streamId;
   item(ws,e.streamId,{type:'ready',clientId});
  }else if(e.endpoint==='session/control'){
   check(JSON.stringify(e.payload.args)==='{}','control args');ws.control=e.streamId;
   item(ws,e.streamId,{type:'baseline',value:{projections:{}}});
  }else if(e.endpoint==='session/follow'){
   const r=e.payload.args.request;check(r.address?.kind==='session'&&sessions.has(r.address.sessionId)&&r.assistantStream===true&&r.maxMessages===500,'follow request envelope');
   const s=sessions.get(r.address.sessionId);ws.follow={session:s.id,stream:e.streamId};
   item(ws,e.streamId,{type:'snapshot',header:{id:s.id},cursor:s.seq,records:s.id==='saved-session'?s.records.slice(-1):s.records,hasMore:s.id==='saved-session',projections:{asOfSeq:s.seq,values:s.projections}});
  }else if(e.endpoint==='userQuestions/attachWait'){
   check(sessions.has(e.payload.args.agentId)&&/^question-call-\d+$/.test(e.payload.args.callId),'timed wait attachment');
   item(ws,e.streamId,{remainingMs:60000});
  }else{check(false,'unexpected WS endpoint '+e.endpoint);}
 }catch(error){log({kind:'assertion',message:error.message});ws.close();}});
});
server.listen(0,'127.0.0.1',()=>console.log('dsh web: http://127.0.0.1:'+server.address().port+'/?token=fixture-launch-token'));
process.on('SIGTERM',()=>{log({kind:'shutdown'});for(const ws of sockets)ws.terminate();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),100).unref();});
