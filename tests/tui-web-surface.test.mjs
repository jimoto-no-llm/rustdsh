import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper=process.env.RDSH_SURFACE_TEST_HELPER||fileURLToPath(new URL('../assets/tui-web-surface.mjs',import.meta.url));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function serve(handler){const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return {server,url:`http://127.0.0.1:${server.address().port}/`};}
async function start(url,root){
  const child=spawn(process.execPath,[helper],{stdio:['pipe','pipe','pipe']});let state={},stderr='';
  child.stderr.on('data',data=>stderr+=data);
  createInterface({input:child.stdout}).on('line',line=>{const message=JSON.parse(line);if(message.type==='state') state=message.value;});
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  const wait=async(predicate,description,timeout=16000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(predicate(state)) return state;if(state.status==='failed') throw new Error(`surface failed: ${state.error}`);await pause(80);}throw new Error(`timeout ${description}: ${JSON.stringify({...state,frame:undefined,text:state.text?.slice(0,400)})}; stderr=${stderr}`);};
  send({type:'init',url,cookie:'fixture_auth=not-a-real-secret',storagePath:join(root,'profile','storage.json'),workspace:root,width:1000,height:700,sessionId:'session-one'});
  const input=async(value,predicate,description=value.kind)=>{const before=state.commandSequence||0;send({type:'input',value});return wait(predicate||((s)=>(s.commandSequence||0)>before),description);};
  const activate=async(name,predicate)=>{await wait(s=>s.controls?.some(c=>c.name===name),`control ${name}`);return input({kind:'activate',id:state.controls.find(c=>c.name===name).id},predicate,`activate ${name}`);};
  const close=async()=>{send({type:'close'});let timer;await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>{timer=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');resolve();},4000);})]);clearTimeout(timer);};
  await wait(s=>s.status==='ready','initial ready',25000);
  return {child,input,activate,wait,close,state:()=>state};
}

test('private Chrome surface supports Web-only controls without an external window', {timeout:120000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'rdsh-surface-test-'));let app,second,engine;let leakedHttp=0,leakedWs=0,authenticatedWs=0;let settings='{"test":true}',revision='one',openCalls=0;
 try{
  second=await serve((req,res)=>{if(req.headers.cookie?.includes('fixture_auth'))leakedHttp++;res.setHeader('content-type','text/html');res.end(`<button style="width:130px;height:50px" onclick="parent.postMessage('iframe-click','*')">Frame button</button>`);});
  second.server.on('upgrade',(req,socket)=>{if(req.headers.cookie?.includes('fixture_auth'))leakedWs++;socket.destroy();});
  const handler=async(req,res)=>{
   if(!req.headers.cookie?.includes('fixture_auth=not-a-real-secret')){res.writeHead(401);res.end('unauthorized');return;}
   if(req.url.startsWith('/api/')){
    let raw='';for await(const chunk of req)raw+=chunk;const request=JSON.parse(raw);let result;
    if(req.url==='/api/rdshTuiAdmin/readSettingsDocument') result={path:join(root,'settings.jsonc'),content:settings,revision,writable:true};
    else if(req.url==='/api/rdshTuiAdmin/saveSettingsDocument'){assert.equal(request.payload.args.expectedRevision,revision);settings=request.payload.args.content;revision='two';result={revision,applied:true};}
    else {openCalls++;result={opened:true};}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({type:'server-response',rpcId:request.rpcId,result:{ok:true,value:result}}));return;
   }
   if(req.url==='/fixture-worker.js'){res.setHeader('content-type','application/javascript');res.end(`self.onmessage=event=>event.waitUntil((async()=>{await fetch('${second.url}worker',{credentials:'include'}).catch(()=>{});await new Promise(resolve=>{const socket=new WebSocket('${second.url.replace('http:','ws:')}worker');socket.onerror=resolve;socket.onopen=()=>{socket.close();resolve();};});event.source.postMessage('service-worker-boundary');})());`);return;}
   if(req.url==='/popup'){res.setHeader('content-type','text/html');res.end('<title>Popup fixture</title><h1>Popup content</h1>');return;}
   res.setHeader('content-type','text/html');res.end(`<!doctype html><title>Surface fixture</title><style>body{font:16px sans-serif}canvas{position:absolute;left:500px;top:40px}iframe{position:absolute;left:500px;top:160px;width:180px;height:90px}</style>
    <h1>Fixture workspace</h1><div id="result">ready</div>
    <input aria-label="Message"><input aria-label="Password" type="password" value="fixture-password">
    <button onclick="result.textContent=document.querySelector('input').value">Submit</button>
    <button onclick="result.textContent=prompt('Fixture prompt','default')">Prompt</button>
    <input aria-label="Upload" type="file" onchange="this.files[0].text().then(t=>result.textContent=t)">
    <button onclick="__DSH_DIRECTORY_PICKER__.pick().then(p=>result.textContent='directory:'+p)">Directory</button>
    <button onclick="fetch('/api/settings/openSettingsDocument',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'document-fixture',method:'settings/openSettingsDocument',payload:{args:{}}})}).then(r=>r.json()).then(r=>result.textContent=r.result.ok?'document-saved':'document-cancelled')">Settings document</button>
    <button onclick="fetch('/api/session/openWorkspacePath',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'workspace-fixture',method:'session/openWorkspacePath',payload:{args:{request:{path:'README.md',application:'Finder'}}}})}).then(r=>r.json()).then(r=>result.textContent=r.result.ok?'preview-opened':'preview-failed')">Workspace preview</button>
    <button onclick="localStorage.setItem('fixture','persisted');result.textContent='stored'">Store</button>
    <button onclick="result.textContent=localStorage.getItem('fixture')||'missing'">Restore</button>
    <button onclick="navigator.clipboard.readText().then(t=>result.textContent=t).catch(()=>result.textContent='clipboard-cancelled')">Paste</button>
    <button onclick="fetch('${second.url}leak',{credentials:'include'}).catch(()=>{});new WebSocket('${second.url.replace('http:','ws:')}leak');result.textContent='boundary-tested'">Port boundary</button>
    <button onclick="const socket=new WebSocket(location.origin.replace('http:','ws:')+'/socket');socket.onopen=()=>{result.textContent='authenticated-socket';socket.close();}">Host socket</button>
    <button onclick="const worker=new Worker(globalThis.URL.createObjectURL(new Blob([document.getElementById('worker-source').textContent],{type:'text/javascript'})));worker.onmessage=e=>{result.textContent=e.data;if(e.data==='worker-boundary')worker.terminate();};worker.onerror=e=>result.textContent='worker-error:'+e.message;">Worker boundary</button>
    <button onclick="navigator.serviceWorker.addEventListener('message',e=>result.textContent=e.data,{once:true});navigator.serviceWorker.register('/fixture-worker.js').then(()=>navigator.serviceWorker.ready).then(r=>r.active.postMessage('test'));">Service worker boundary</button>
    <script id="worker-source" type="text/plain">(async()=>{postMessage('worker-started');await fetch('${second.url}worker',{credentials:'include'}).catch(()=>{});await new Promise(resolve=>{const socket=new WebSocket('${second.url.replace('http:','ws:')}worker');socket.onerror=resolve;socket.onopen=()=>{socket.close();resolve();};});postMessage('worker-boundary');})()</script>
    <button onclick="const frame=document.createElement('iframe');frame.hidden=true;frame.onload=()=>result.textContent='frame-boundary';frame.src='${second.url}frame';document.body.append(frame);">Frame boundary</button>
    <button onclick="new Notification('Fixture notice',{body:'inside terminal'})">Notify</button>
    <a download="fixture.txt" href="data:text/plain,download-content">Download</a>
    <button onclick="window.open('/popup')">Popup</button>
    <canvas width="180" height="80"></canvas><iframe src="${second.url.replace('127.0.0.1','localhost')}"></iframe>
    <script>const canvas=document.querySelector('canvas');canvas.getContext('2d').fillRect(0,0,180,80);canvas.onclick=()=>result.textContent='canvas-click';addEventListener('message',e=>result.textContent=e.data);
    let selected; if(__RDSH_TUI_BRIDGE_ENABLED__)globalThis.__RDSH_TUI_WORKSPACE__={navigationReady(){return document.readyState==='complete'},openSession(id){setTimeout(()=>selected=id,60);return {requestedSessionId:id}},selectedSessionId(){return selected},openWorkspacePath(request){return Promise.resolve({opened:true,view:'document',requestedPath:request.path})}};</script>`);
  };
  app=await serve(handler);
  app.server.on('upgrade',(req,socket)=>{if(req.headers.cookie?.includes('fixture_auth'))authenticatedWs++;const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');setTimeout(()=>socket.destroy(),500).unref();});
  engine=await start(app.url,root);assert.equal(engine.state().sessionId,'session-one');assert.ok(engine.state().frame.png.length>100);
  assert.equal(engine.state().controls.find(c=>c.name==='Password').password,true);assert.ok(!JSON.stringify({...engine.state(),frame:undefined}).includes('fixture-password'));
  await engine.activate('Message');await engine.input({kind:'text',text:'日本語 text'});await engine.input({kind:'key',key:'!'});await engine.activate('Submit',s=>s.text?.includes('日本語 text!'));
  await engine.input({kind:'click',x:530,y:70},s=>s.text?.includes('canvas-click'));
  await engine.input({kind:'click',x:550,y:195},s=>s.text?.includes('iframe-click'));
  await engine.activate('Prompt',s=>!!s.dialog);await engine.input({kind:'dialog',id:engine.state().dialog.id,accept:true,text:'dialog-answer'},s=>s.text?.includes('dialog-answer'));
  await engine.activate('Upload',s=>!!s.fileChooser);const file=join(root,'upload.txt');await writeFile(file,'uploaded-content');await engine.input({kind:'files',id:engine.state().fileChooser.id,paths:[file]},s=>s.text?.includes('uploaded-content'));
  await engine.activate('Directory',s=>!!s.directoryChooser);await engine.input({kind:'directory',id:engine.state().directoryChooser.id,path:root},s=>s.text?.includes('directory:'+root));
  await engine.activate('Settings document',s=>!!s.document);assert.equal(engine.state().document.content,settings);await engine.input({kind:'document',id:engine.state().document.id,content:'{"changed":true}',expectedRevision:revision,accept:true},s=>s.text?.includes('document-saved'));assert.equal(settings,'{"changed":true}');assert.equal(openCalls,0);
  await engine.activate('Settings document',s=>!!s.document);await engine.input({kind:'document',id:engine.state().document.id,accept:false},s=>s.text?.includes('document-cancelled'));assert.equal(openCalls,0);
  await engine.activate('Workspace preview',s=>s.text?.includes('preview-opened'));assert.equal(openCalls,0);
  await engine.activate('Paste',s=>s.dialog?.type==='clipboard');await engine.input({kind:'dialog',id:engine.state().dialog.id,accept:true,text:'clipboard-value'},s=>s.text?.includes('clipboard-value'));
  await engine.activate('Paste',s=>s.dialog?.type==='clipboard');await engine.input({kind:'dialog',id:engine.state().dialog.id,accept:false},s=>s.text?.includes('clipboard-cancelled'));
  await engine.activate('Port boundary',s=>s.text?.includes('boundary-tested'));await pause(600);assert.equal(leakedHttp,0,'cookie leaked to another HTTP port');assert.equal(leakedWs,0,'cookie leaked to another WebSocket port');
  await engine.activate('Host socket',s=>s.text?.includes('authenticated-socket'));assert.equal(authenticatedWs,1,'same-authority socket was not authenticated');
  await engine.activate('Worker boundary',s=>s.text?.includes('worker-boundary'));await engine.activate('Service worker boundary',s=>s.text?.includes('service-worker-boundary'));assert.equal(leakedHttp,0,'worker cookie leaked via HTTP');assert.equal(leakedWs,0,'worker cookie leaked via WebSocket');
  await engine.activate('Frame boundary',s=>s.text?.includes('frame-boundary'));assert.equal(leakedHttp,0,'frame cookie leaked via HTTP');
  await engine.activate('Notify',s=>s.notifications?.some(n=>n.title==='Fixture notice'));
  await engine.activate('Download',s=>s.downloads?.some(d=>d.state==='completed'));const download=engine.state().downloads.find(d=>d.state==='completed');assert.equal(await readFile(download.path,'utf8'),'download-content');assert.equal((await stat(download.path)).mode&0o777,0o600);
  const first=engine.state().tabs[0].id;await engine.activate('Popup',s=>s.tabs?.length===2&&s.text?.includes('Popup content'));const popup=engine.state().tabs.find(t=>t.selected).id;await engine.input({kind:'tab',id:first},s=>s.text?.includes('Fixture workspace'));await engine.input({kind:'close_tab',id:popup},s=>s.tabs?.length===1);
  await engine.input({kind:'session',sessionId:'session-two'},s=>s.sessionId==='session-two');
  await engine.input({kind:'session_snapshot',id:'barrier-one'},s=>s.sessionBarrier==='barrier-one'&&s.sessionId==='session-two');
  await engine.input({kind:'activate',id:'unknown'},s=>s.error==='CONTROL_EXPIRED');
  await engine.activate('Store',s=>s.text?.includes('stored'));await pause(1800);await engine.close();engine=null;
  assert.equal((await stat(join(root,'profile','storage.json'))).mode&0o777,0o600);
  await new Promise(resolve=>app.server.close(resolve));app=await serve(handler);
  engine=await start(app.url,root);await engine.activate('Restore',s=>s.text?.includes('persisted'));
 } finally {if(engine)await engine.close();await Promise.all([app?.server,second?.server].filter(Boolean).map(server=>new Promise(resolve=>server.close(resolve))));await rm(root,{recursive:true,force:true});}
});
