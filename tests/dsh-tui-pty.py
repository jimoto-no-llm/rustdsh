#!/usr/bin/env python3
"""Unix PTY + DSH Remote wire smoke; all HTTP/WS traffic stays on loopback.

Requires Node, Python pyte, and the Node ws package. The installed DSH package
already supplies ws; pass --ws-package /path/to/@deepseek-ai/dsh/package.json,
or set DSH_TEST_WS_PACKAGE to a package.json from which require('ws') resolves.
Usage: python3 tests/dsh-tui-pty.py /absolute/path/to/rdsh --ws-package PACKAGE

RDSH_ORIG_BIN points exclusively at the embedded mock. HOME/DSH_HOME/config
are disposable, inherited API credentials are excluded, and no model runs.
"""
import argparse
import codecs
import importlib.util
import json
import os
import pty
import signal
import subprocess
import tempfile
import termios
import time
from pathlib import Path

import pyte


MOCK = r"""import fs from 'node:fs';
import http from 'node:http';
import {createRequire} from 'node:module';
import {isDeepStrictEqual} from 'node:util';
const require=createRequire(process.env.DSH_TEST_WS_PACKAGE || import.meta.url);
const {WebSocketServer}=require('ws');
const root=process.cwd(), logPath=root+'/wire.jsonl';
const log=value=>fs.appendFileSync(logPath,JSON.stringify(value)+'\n');
const check=(ok,message)=>{if(!ok){log({kind:'assertion',message});throw new Error(message);}};
check(JSON.stringify(process.argv.slice(2))===JSON.stringify(['--profile','web','--no-open','--port','0']),'host CLI arguments');
const sockets=new Set(), sessions=new Map(), terminals=new Map();
let settingsRevision=7, settingsValue={label:'ADMIN_SETTING_INITIAL'};
const object=(properties={},required=[])=>({type:'object',properties,required});
const action=(id,schema=object(),extra={})=>({id,label:id,description:'Loopback management fixture',transport:'rpc',mode:'unary',schema,defaults:{},...extra});
const adminActions=[
 action('settings/describe'),
 action('settings/update',object({ns:{type:'string'},patch:{type:'object'},expectedRevision:{type:'integer'}},['ns','patch','expectedRevision'])),
 action('credentials/set',object({ref:{type:'string'},value:{type:'string',writeOnly:true}},['ref','value']),{sensitive:true}),
 action('fixture/watch',object(),{mode:'stream',uplink:true}),
 action('fileUploads/upload',object({agentId:{type:'string'},request:{type:'object'}},['agentId','request'])),
 action('workspaceFiles/readBytes'),
 ...['create','follow','write','resize','close'].map(name=>action('terminal/'+name,object(),name==='follow'?{mode:'stream'}:{})),
 {id:'GET /api/rdsh-context',label:'RDSH HTTP fixture',description:'Existing authenticated HTTP handler',transport:'http',mode:'unary',method:'GET',path:'/api/rdsh-context',schema:object(),defaults:{}},
];
const terminalInfo=t=>({id:t.id,title:'Fixture terminal',shell:{path:'/mock/sh',args:[],name:'Mock'},cwd:root,cols:t.cols,rows:t.rows,state:t.closed?'exited':'running',exitCode:t.closed?0:null,controllerId:t.attachment});
const terminalOutput=(t,data)=>{t.screen+=data;const frame={type:'output',sequence:++t.seq,data};for(const ws of sockets)for(const [stream,info] of ws.terminalFollows??[])if(info.id===t.id)item(ws,stream,frame);};
let creates=0, prompts=0, connections=0, failResume=true;
const fresh=id=>({id,seq:0,records:[],projections:{modelSelection:{next:{provider:'demo',model:'m1'}},plan:{active:false,pending:false},permissions:{currentValue:'safe'}}});
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
  case 'rdshTuiAdmin/catalog':check(JSON.stringify(args)==='{}','admin catalog args');return {version:1,actions:adminActions};
  case 'settings/update':{
   check(args.ns==='fixture'&&Number.isInteger(args.expectedRevision)&&typeof args.patch?.label==='string','settings update schema');
   if(args.expectedRevision!==settingsRevision)return {mockError:'settings/revision-conflict'};
   settingsValue={...settingsValue,...args.patch};settingsRevision++;log({kind:'settings-updated',revision:settingsRevision,label:settingsValue.label});
   return {ns:'fixture',value:settingsValue,revision:settingsRevision,applies:'live'};
  }
  case 'credentials/set':
   check(args.ref==='fixture-key'&&args.value==='ADMIN_SECRET_NEVER_ECHO','secret transport value');log({kind:'credential-stored',ref:args.ref});return {message:args.value};
  case 'fileUploads/upload':{
   check(sessions.has(args.agentId)&&args.request?.name==='attachment.txt','attachment envelope');
   const bytes=Buffer.from(args.request.data,'base64');check(bytes.toString()==='ADMIN_ATTACHMENT_BYTES','attachment bytes');log({kind:'attachment-uploaded',bytes:bytes.length});return {receiptId:'fixture-receipt',file:{attachmentId:'fixture-attachment',name:'attachment.txt',bytes:bytes.length}};
  }
  case 'workspaceFiles/readBytes':return {mockBinary:true};
  case 'terminal/create':{
   const r=args.request;check(sessions.has(args.agentId)&&typeof r?.id==='string'&&r.cols>0&&r.rows>0,'terminal create envelope');
   check(!terminals.has(r.id),'terminal created only once');const t={id:r.id,agentId:args.agentId,cols:r.cols,rows:r.rows,seq:0,screen:'FIXTURE_SHELL_READY\r\nfixture$ ',line:'',closed:false};terminals.set(r.id,t);log({kind:'terminal-created',id:r.id});return terminalInfo(t);
  }
  case 'terminal/write':{
   const t=terminals.get(args.id);check(t&&!t.closed&&args.agentId===t.agentId&&args.attachmentId===t.attachment&&typeof args.data==='string','terminal write exact attachment');
   log({kind:'terminal-written',id:t.id,data:args.data});
   for(const c of args.data){if(c==='\r'||c==='\n'){terminalOutput(t,'\r\nRESULT:'+(t.line.startsWith('echo ')?t.line.slice(5):t.line)+'\r\nfixture$ ');t.line='';}else{t.line+=c;terminalOutput(t,c);}}return {};
  }
  case 'terminal/resize':{
   const t=terminals.get(args.id);check(t&&!t.closed&&args.agentId===t.agentId&&args.attachmentId===t.attachment&&args.cols>0&&args.rows>0,'terminal resize exact attachment');t.cols=args.cols;t.rows=args.rows;log({kind:'terminal-resized',id:t.id,cols:t.cols,rows:t.rows});return {};
  }
  case 'terminal/close':{
   const t=terminals.get(args.id);check(t&&args.agentId===t.agentId,'terminal close identity');t.closed=true;log({kind:'terminal-closed',id:t.id});for(const ws of sockets)for(const[stream,info]of ws.terminalFollows??[])if(info.id===t.id){item(ws,stream,{type:'state',info:terminalInfo(t)});ws.send(JSON.stringify({type:'end',streamId:stream}));}return {};
  }
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
   return {items:[...sessions.values()].map(s=>({sessionId:s.id,projections:{asOfSeq:s.seq,values:{title:s.id==='saved-session'?'Saved durable conversation':s.id}},cwd:root,running:false}))};
  case 'session/page':{
   const r=args.request;check(r.address?.kind==='session'&&r.address.sessionId==='saved-session'&&r.beforeSeq===2&&r.throughSeq===2&&r.maxMessages===500,'history page envelope');
   return {records:saved.records.slice(0,1),hasMore:false};
  }
  case 'session/selectModel':{
   const r=args.request;check(sessions.has(r?.sessionId)&&r.provider==='demo'&&r.model==='m2','model selection envelope');
   projection(r.sessionId,'modelSelection',{next:{provider:r.provider,model:r.model}});return {};
  }
  case 'commands/list':
   check(sessions.has(args.agentId)&&Object.keys(args).length===1,'command roster envelope');
   return [{name:'plan',description:'Plan mode'},{name:'permission',description:'Permissions'},{name:'compact',description:'Compact context'}];
  case 'permissionPresets/catalog':
   check(JSON.stringify(args)==='{}','permission catalog envelope');
   return {options:[{value:'safe',name:'Safe',description:'Every tool requires approval'},{value:'auto',name:'Auto',description:'All tools automatically approved'}],defaultOptions:[],defaultPreset:'safe'};
  case 'commands/execute':{
   check(sessions.has(args.agentId)&&JSON.stringify(args.submittedAttachments)==='[]'&&Object.keys(args).length===3,'command execute envelope');
   check(['/plan','/plan off','/permission safe','/permission auto','/compact keep literal words'].includes(args.line),'exact allowed command');
   log({kind:'control-command',line:args.line});
   if(args.line.startsWith('/compact')) return {commandId:'compact',result:{kind:'success',text:'COMPACT_COMMAND_ACCEPTED'}};
   if(args.line.startsWith('/plan')){
    const on=args.line==='/plan';
    projection(args.agentId,'plan',{active:!on,pending:true});
    setTimeout(()=>projection(args.agentId,'plan',{active:on,pending:false}),50);
   }else projection(args.agentId,'permissions',{currentValue:args.line.split(' ')[1]});
   return {commandId:'fixture-command',result:{kind:'success',text:'CONTROL_COMMAND_ACCEPTED'}};
  }
  case 'pluginInventory/list':check(JSON.stringify(args)==='{}','plugins read args');return {plugins:[{name:'FIXTURE_PLUGIN_INVENTORY',enabled:true}]};
  case 'settings/describe':check(JSON.stringify(args)==='{}','settings read args');return {description:'FIXTURE_SETTINGS_READONLY',apiKey:'FIXTURE_PRIVATE_SETTING',namespaces:[{ns:'fixture',value:settingsValue,revision:settingsRevision,applies:'live'}]};
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
  if(req.method==='GET'&&url.pathname==='/api/rdsh-context'){log({kind:'rdsh-http'});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,config:{label:'RDSH_HTTP_PROOF'}}));return;}
  check(req.method==='POST'&&url.pathname.startsWith('/api/'),'RPC route');
  let body='';for await(const chunk of req)body+=chunk;
  const e=JSON.parse(body),method=url.pathname.slice(5);
  check(e.type==='client-request'&&e.method===method&&typeof e.rpcId==='string'&&e.rpcId.length>0&&e.payload?.args&&typeof e.payload.args==='object','RPC envelope');
  log({kind:'rpc',method,args:method==='credentials/set'?{ref:e.payload.args.ref,value:'[OMITTED]'}:e.payload.args});
  const value=await rpc(method,e.payload.args);
  if(value?.mockBinary){
   const metadata={type:'server-response',rpcId:e.rpcId,result:{ok:true,value:{bytes:null}},attachments:[{path:['bytes'],codec:'bytes',part:'bytes-0'}]};
   const binary=Buffer.from([0,1,255,13,10,128]),boundary='rdsh-admin-fixture';
   const prefix=`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="bytes-0"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`;
   res.writeHead(200,{'Content-Type':'multipart/form-data; boundary='+boundary});res.end(Buffer.concat([Buffer.from(prefix),binary,Buffer.from(`\r\n--${boundary}--\r\n`)]));return;
  }
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
  if(e.type==='cancel'){log({kind:'stream-cancel',streamId:e.streamId});ws.terminalFollows?.delete(e.streamId);return;}
  if(e.type==='item'){check(ws.adminStream===e.streamId,'admin uplink stream identity');check(e.value?.proof==='ADMIN_UPLINK_PROOF','admin uplink value');log({kind:'admin-uplink'});item(ws,e.streamId,{proof:'ADMIN_UPLINK_ACK'});return;}
  check(e.type==='open'&&typeof e.streamId==='string'&&e.payload?.args,'WS open envelope');
  log({kind:'open',endpoint:e.endpoint,args:e.payload.args});
  if(e.endpoint==='fixture/watch'){
   check(JSON.stringify(e.payload.args)==='{}','admin stream args');ws.adminStream=e.streamId;item(ws,e.streamId,{proof:'ADMIN_STREAM_READY'});
  }else if(e.endpoint==='terminal/follow'){
   const r=e.payload.args,t=terminals.get(r.id);check(t&&!t.closed&&r.agentId===t.agentId&&typeof r.attachmentId==='string','terminal follow envelope');t.attachment=r.attachmentId;
   if(!ws.terminalFollows)ws.terminalFollows=new Map();ws.terminalFollows.set(e.streamId,{id:t.id});item(ws,e.streamId,{type:'snapshot',sequence:t.seq,screen:t.screen,info:terminalInfo(t)});
  }else if(e.endpoint==='$events'){
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
"""


def native_client_module():
    spec = importlib.util.spec_from_file_location(
        "native_tui_pty", Path(__file__).with_name("native-tui-pty.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


NativeClient = native_client_module().Client


class Client(NativeClient):
    def __init__(self, root, binary, ws_package):
        self.master, self.slave = pty.openpty()
        self.initial = termios.tcgetattr(self.slave)
        self.screen = pyte.Screen(100, 32)
        self.stream = pyte.Stream(self.screen)
        self.decoder = codecs.getincrementaldecoder("utf8")("replace")
        self.raw = bytearray()
        self.resize(100, 32)
        env = {key: os.environ[key] for key in ("PATH", "TMPDIR", "LANG", "LC_ALL") if key in os.environ}
        env.update(
            HOME=str(root), DSH_HOME=str(root / "dsh"),
            XDG_CONFIG_HOME=str(root / "config"), XDG_DATA_HOME=str(root / "data"),
            XDG_CACHE_HOME=str(root / "cache"), TERM="xterm-256color",
            RDSH_AUTH_AUTOSYNC="0", RDSH_SECURITY="0", RDSH_TELEMETRY="off",
            RDSH_ORIG_BIN=str(root / "mock-dsh.mjs"), DSH_TEST_WS_PACKAGE=ws_package,
        )
        self.root = root
        self.proc = subprocess.Popen(
            [binary, "--language", "ja", "native-tui", "--backend", "dsh",
             "--workspace", str(root), "--dsh-profile", "web"],
            stdin=self.slave, stdout=self.slave, stderr=self.slave, env=env,
            start_new_session=True,
        )

    def events(self):
        path = self.root / "wire.jsonl"
        return [json.loads(row) for row in path.read_text().splitlines()] if path.exists() else []

    def wait_wire(self, predicate, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump(.04)
            rows = self.events()
            errors = [row for row in rows if row["kind"] == "assertion"]
            assert not errors, "Mock rejected wire: " + json.dumps(errors)
            if predicate(rows):
                return
            if self.proc.poll() is not None:
                break
        raise AssertionError("Expected wire event did not arrive\n" + self.text())

    def settled(self, seconds=.25):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.pump(.02)

    def command(self, text):
        self.send("\x15" + text + "\r")


def rpc_rows(rows, method):
    return [row for row in rows if row["kind"] == "rpc" and row["method"] == method]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary")
    parser.add_argument("--ws-package", default=os.environ.get("DSH_TEST_WS_PACKAGE", ""))
    args = parser.parse_args()
    binary = str(Path(args.binary).resolve())
    ws_package = str(Path(args.ws_package).resolve()) if args.ws_package else ""
    probe = subprocess.run(
        ["node", "--input-type=module", "-e",
         "import {createRequire} from 'node:module'; createRequire(process.argv[1] || import.meta.url)('ws');",
         ws_package], capture_output=True,
    )
    if probe.returncode:
        raise SystemExit("Node ws is required; pass --ws-package /path/to/a/package.json that resolves ws")
    verify_claude_migration(binary, ws_package)
    with tempfile.TemporaryDirectory(prefix="rdsh-dsh-tui-pty-") as folder:
        root = Path(folder).resolve()
        (root / "dsh").mkdir()
        (root / "mock-dsh.mjs").write_text("#!/usr/bin/env node\n" + MOCK)
        (root / "mock-dsh.mjs").chmod(0o755)
        (root / "nonce.txt").write_text("DSH_NONCE_READ_PROOF")
        client = Client(root, binary, ws_package)
        try:
            client.wait("DSH runtime")
            client.wait("待機中")
            client.command("/mode")
            client.wait("モード・パーミッション")
            client.wait("safe")
            client.dismiss("モード・パーミッション")
            client.command("/mode plan")
            client.wait_wire(lambda rows: any(row["kind"]=="control-command" and row["line"]=="/plan" for row in rows))
            client.wait("[plan · safe]")
            client.command("/plan off")
            client.wait("[normal · safe]")
            client.command("/permission auto")
            client.wait("パーミッション変更の確認")
            client.send("\x1b[200~y\n/permission auto\n\x1b[201~")
            client.send("\t")
            client.resize(41,13);client.wait("端末を42列")
            client.send("\t\r")
            client.resize(100,32);client.wait("パーミッション変更の確認")
            client.send("\r");client.wait_absent("パーミッション変更の確認")
            assert not any(row["kind"]=="control-command" and row["line"].startswith("/permission") for row in client.events())
            client.command("/permission auto");client.wait("パーミッション変更の確認")
            client.send("\t\r");client.wait("[normal · auto]")
            client.command("/permission safe");client.wait("パーミッション変更の確認")
            client.send("\t\r");client.wait("[normal · safe]")
            assert not rpc_rows(client.events(), "session/prompt"), "control commands became prompts"
            client.command("/mode auto");client.wait("使い方: /mode")
            client.send("\x15")
            client.send("deny\r")
            client.wait("STREAM_BEFORE_APPROVAL")
            client.wait("操作の承認")
            assert not any(row["kind"] == "nonce-read" for row in client.events())
            client.send("\r")
            client.wait("TOOL_DENIED")
            client.wait("待機中")
            client.send("read\r")
            client.wait("操作の承認")
            client.wait("nonce.txt")
            client.send("\t")
            client.resize(41, 13)
            client.wait("端末を42列")
            client.send("\t\r")
            client.settled()
            assert not any(row["kind"] == "nonce-read" for row in client.events())
            client.resize(100, 32)
            client.wait("操作の承認")
            client.send("\t\r")
            client.wait("計画レビュー")
            client.wait_wire(lambda rows: any(row["kind"] == "open" and row["endpoint"] == "userQuestions/attachWait" for row in rows))
            assert len([row for row in client.events() if row["kind"] == "nonce-read"]) == 1
            client.send("\r\x13")
            client.wait("未回答")
            assert not any(row["kind"] == "questions-answered" for row in client.events())
            client.send(" ")
            client.resize(41, 13)
            client.wait("端末を42列")
            client.send(" \x13")
            client.settled()
            assert not any(row["kind"] == "questions-answered" for row in client.events())
            client.resize(100, 32)
            client.wait("計画レビュー")
            client.send("\x13")
            client.wait("未回答")
            client.send("\x1b[F")
            client.wait("PLAN_DETAIL_END")
            client.send("\x1b[B \t")
            client.wait("Choose exact labels")
            client.send(" \x1b[B \x05")
            client.send("\x1b[200~custom 日本語\x1b[201~")
            client.wait("custom 日本語")
            client.send("\x13")
            client.wait("DSH_QUESTIONS_COMPLETE")
            client.wait("待機中")
            client.wait("In:200")
            client.wait("Cache:60.0%")
            assert "Req:999" not in client.text(), "sessionStats.steps became request count"
            client.command("/usage")
            client.wait("キャッシュ集計対象")
            client.dismiss("キャッシュ集計対象")
            client.command("/dsh")
            client.wait("/compact")
            client.dismiss("DSHコマンド")
            client.command("/dsh compact keep literal words")
            client.wait("COMPACT_COMMAND_ACCEPTED")
            client.dismiss("DSHコマンド")
            client.command("/plugins")
            client.wait("FIXTURE_PLUGIN_INVENTORY")
            client.dismiss("FIXTURE_PLUGIN_INVENTORY")
            client.command("/settings")
            client.wait("FIXTURE_SETTINGS_READONLY")
            assert "FIXTURE_PRIVATE_SETTING" not in client.text()
            client.dismiss("FIXTURE_SETTINGS_READONLY")
            client.command("/model demo m2")
            client.wait("demo / m2")
            client.send("slow\r")
            client.wait_wire(lambda rows: any(row["kind"] == "slow" for row in rows))
            before_controls=len([row for row in client.events() if row["kind"]=="control-command"])
            client.command("/mode plan");client.wait("実行中は変更できません")
            client.send("\x15")
            assert len([row for row in client.events() if row["kind"]=="control-command"])==before_controls
            cancels = len(rpc_rows(client.events(), "session/cancel"))
            client.send("\x03")
            client.wait_wire(lambda rows: len(rpc_rows(rows, "session/cancel")) > cancels)
            client.wait("待機中")
            client.send("reconnect\r")
            client.wait("RECONNECT_PROOF")
            client.wait_wire(lambda rows: len([row for row in rows if row["kind"] == "ws-connect"]) >= 2)
            client.wait("待機中")
            client.command("/sessions")
            client.wait("Saved durable conversation")
            client.send("\r")
            client.wait("MOCK_RESUME_ONCE")
            client.dismiss("Saved durable conversation")
            client.wait("/sessions")
            # The picker covers the input. Close it before checking the draft,
            # then execute the retained command to reopen and retry the resume.
            client.send("\r")
            client.wait("Saved durable conversation")
            client.send("\r")
            client.wait("RESUMED_SESSION_PROOF")
            client.wait_wire(lambda rows: bool(rpc_rows(rows, "session/page")))
            client.command("/new")
            client.wait("/sessionsで再開できます")
            client.send("\t\r")
            client.wait("Rustdshへようこそ")
            client.command("/sessions")
            client.wait("Saved durable conversation")
            client.dismiss("Saved durable conversation")
            client.send("\x15\x11")
            client.restored()
            rows = client.events()
            assert not [row for row in rows if row["kind"] == "assertion"]
            assert not rpc_rows(rows, "session/delete"), "/new deleted durable session"
            assert len([row for row in rows if row["kind"] == "questions-answered"]) == 1
            assert all(secret not in client.raw.decode("utf8", "replace") for secret in ("fixture-launch-token", "fixture-cookie", "FIXTURE_PRIVATE_SETTING"))
            assert any(row["kind"] == "shutdown" for row in rows), "mock host did not stop"
            print("PASS DSH PTY: authenticated HTTP/WS wire, streaming, explicit deny/allow, hidden-dialog guards, timed questions and exact answers, usage, readonly views, model selection, cancel/reconnect, paginated resume, /new persistence, terminal/host restoration")
        finally:
            client.close()


def verify_claude_migration(binary, ws_package):
    """A stale default and saved session must select CLI before accepting input."""
    source = MOCK.replace("next:{provider:'demo',model:'m1'}", "next:{provider:'anthropic',model:'m1'}")
    source = source.replace("failResume=true", "failResume=false")
    source = source.replace(
        "return {default:{provider:'demo',model:'m1'},groups:[{id:'demo',models:[{id:'m1'},{id:'m2'}]}]};",
        "return {default:{provider:'anthropic',model:'m1'},routableProviders:['anthropic','claude-cli'],groups:[{id:'anthropic',models:[{id:'m1'}]},{id:'claude-cli',models:[{id:'m1'},{id:'m2'}]}]};",
    )
    source = source.replace("r.provider==='demo'&&r.model==='m2'", "r.provider==='claude-cli'&&r.model==='m1'")
    with tempfile.TemporaryDirectory(prefix="rdsh-claude-migration-pty-") as folder:
        root = Path(folder).resolve()
        (root / "dsh").mkdir()
        (root / "mock-dsh.mjs").write_text("#!/usr/bin/env node\n" + source)
        (root / "mock-dsh.mjs").chmod(0o755)
        client = Client(root, binary, ws_package)
        try:
            client.wait("claude-cli / m1")
            client.command("/models")
            client.wait("モデルを選択")
            client.send("anthropic")
            client.wait("0 件")
            client.dismiss("モデルを選択")
            client.command("/model anthropic m1")
            client.wait_wire(lambda rows: len(rpc_rows(rows, "session/selectModel")) >= 2)
            client.command("/sessions")
            client.wait("DSH セッション")
            client.send("\r")
            client.wait_absent("DSH セッション")
            client.wait("RESUMED_SESSION_PROOF")
            client.wait("claude-cli / m1")
            client.wait_wire(lambda rows: len(rpc_rows(rows, "session/selectModel")) >= 3)
            selections = rpc_rows(client.events(), "session/selectModel")
            assert all(row["args"]["request"]["provider"] == "claude-cli" for row in selections)
            assert any(row["args"]["request"]["sessionId"] == "saved-session" for row in selections)
            assert not [row for row in client.events() if row["kind"] == "assertion"]
            client.command("/quit")
            client.restored()
            print("PASS Claude CLI migration: legacy models hidden; old default, explicit alias and resumed session select CLI only")
        finally:
            client.close()


if __name__ == "__main__":
    main()
