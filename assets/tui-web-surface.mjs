// Private Chrome process for the Rust TUI. Protocol and credentials use pipes only.
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const MAX_LINE = 2 * 1024 * 1024;
const MAX_TEXT = 16 * 1024;
let browser, cdp, temporary, config, guard, selected, interval, closed = false, refreshing = false;
let width = 1000, height = 700, sequence = 0, commandSequence = 0;
const tabs = new Map(), downloads = new Map(), notices = [];
let fillResult, sessionBarrier, lastFrame, error, storage = {}, persisting = Promise.resolve(), initialized = false;
const output = value => { if (!closed) process.stdout.write(JSON.stringify(value) + '\n'); };
const bounded = (value, size = 4096) => String(value ?? '').slice(0, size);
const safeUrl = raw => {
  try { const u = new URL(raw); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return bounded(u.href); }
  catch { return ''; }
};
const dimensions = value => Number.isInteger(value) && value >= 240 && value <= 1920;
const current = () => { const page = tabs.get(selected); if (!page) throw new Error('PAGE_NOT_READY'); return page; };
function fail(code) { throw new Error(code); }
class Pipe {
  constructor(child) {
    this.id = 0; this.pending = new Map(); this.buffer = Buffer.alloc(0);
    child.stdio[4].on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > 32 * 1024 * 1024) { shutdown('BROWSER_REPLY_TOO_LARGE'); return; }
      for (;;) {
        const index = this.buffer.indexOf(0); if (index < 0) break;
        const raw = this.buffer.subarray(0, index); this.buffer = this.buffer.subarray(index + 1);
        let message; try { message = JSON.parse(raw); } catch { continue; }
        if (message.id) {
          const pending = this.pending.get(message.id); if (!pending) continue;
          this.pending.delete(message.id); clearTimeout(pending.timer);
          message.error ? pending.reject(new Error('BROWSER_COMMAND_REJECTED')) : pending.resolve(message.result ?? {});
        } else onEvent(message).catch(() => { error = 'BROWSER_EVENT_FAILED'; });
      }
    });
    child.on('exit', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('BROWSER_EXITED')); } this.pending.clear(); });
  }
  send(method, params = {}, sessionId) {
    if (closed || browser.exitCode !== null) return Promise.reject(new Error('BROWSER_EXITED'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('BROWSER_TIMEOUT')); }, 12000);
      this.pending.set(id, { resolve, reject, timer });
      browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }
}
const call = (page, method, params) => cdp.send(method, params, page.sessionId);
async function executable() {
  const explicit = process.env.RDSH_BROWSER_BIN;
  const candidates = explicit ? [explicit] : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : process.platform === 'win32'
      ? [join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'), join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe')]
      : ['google-chrome', 'chromium', 'chromium-browser', 'google-chrome-stable'].flatMap(name => (process.env.PATH || '').split(':').map(path => join(path, name)));
  for (const path of candidates) {
    try { if (isAbsolute(path) && (await stat(path)).isFile()) { await access(path, constants.X_OK); return path; } } catch {}
  }
  fail('CHROME_NOT_FOUND: Chrome/ChromiumをインストールするかRDSH_BROWSER_BINを指定してください');
}
function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_.*|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|FONTCONFIG_PATH)$/.test(name)));
}
async function init(value) {
  if (config) fail('ALREADY_STARTED');
  const url = new URL(value.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) fail('INVALID_HOST');
  if (typeof value.cookie !== 'string' || !value.cookie || value.cookie.length > 16384 || /[\r\n\0]/.test(value.cookie)) fail('INVALID_COOKIE');
  if (!isAbsolute(value.storagePath || '')) fail('INVALID_STORAGE');
  config = { url: url.href, origin: url.origin, storagePath: value.storagePath, workspace: value.workspace, sessionId: value.sessionId }; 
  width = dimensions(value.width) ? value.width : width; height = dimensions(value.height) ? value.height : height;
  await mkdir(dirname(config.storagePath), { recursive: true, mode: 0o700 });
  await chmod(dirname(config.storagePath),0o700);
  try { const raw = await readFile(config.storagePath, 'utf8'); if (raw.length <= 1024 * 1024) storage = JSON.parse(raw); } catch {}
  if (!storage || typeof storage !== 'object' || Array.isArray(storage)) storage = {};
  temporary = await mkdtemp(join(tmpdir(), 'rdsh-tui-browser-')); await chmod(temporary, 0o700);
  config.downloadPath = join(dirname(config.storagePath), 'downloads'); await mkdir(config.downloadPath, { recursive: true, mode: 0o700 });
  const command = await executable();
  guard=await createGuard();
  browser = spawn(command, ['--headless=new', '--remote-debugging-pipe', `--proxy-server=http://127.0.0.1:${guard.port}`, '--proxy-bypass-list=*;<-loopback>;localhost;*.localhost;[::1];169.254.0.0/16;[fe80::]/10', `--user-data-dir=${join(temporary, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-crash-reporter', '--disable-breakpad', '--password-store=basic', '--use-mock-keychain', '--autoplay-policy=user-gesture-required', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], env: cleanEnvironment() });
  browser.on('error', () => shutdown('BROWSER_START_FAILED'));
  browser.on('exit', () => { if (!closed) shutdown('BROWSER_EXITED'); });
  cdp = new Pipe(browser);
  await cdp.send('Browser.getVersion');
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: config.downloadPath, eventsEnabled: true });
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  await cdp.send('Target.setAutoAttach', {autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter:[{type:'page',exclude:false},{exclude:true}]});
  const { targetInfos } = await cdp.send('Target.getTargets');
  const initial = targetInfos.find(target => target.type === 'page');
  const id = initial?.targetId ?? (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId;
  const page = await attach(id); selected = id;
  // Verify Chrome actually routes loopback through the guard before giving it a cookie.
  await call(page,'Page.navigate',{url:config.url});
  const guardDeadline=Date.now()+5000;while(!guard.observed()&&Date.now()<guardDeadline)await new Promise(resolve=>setTimeout(resolve,25));
  if(!guard.observed())fail('BROWSER_GUARD_UNAVAILABLE: Chromeを更新してください');
  for (const part of value.cookie.split(';')) {
    const equal = part.indexOf('='); if (equal < 1) continue;
    await call(page, 'Network.setCookie', { name: part.slice(0, equal).trim(), value: part.slice(equal + 1).trim(), url: config.url, httpOnly: true, sameSite: 'Strict' });
  }
  value.cookie = '';
  await call(page, 'Page.navigate', { url: config.url });
  if (config.sessionId) await selectSession(page, config.sessionId);
  initialized = true;
  interval = setInterval(() => refresh().catch(() => {}), 500);
  await refresh();
}
function script() {
  // Only the DSH origin gets localStorage restoration and notification delivery.
  return `(() => { globalThis.__RDSH_TUI_BRIDGE_ENABLED__=true; if (location.origin !== ${JSON.stringify(config.origin)}) return;
    const initial=${JSON.stringify(storage)};
    if (!sessionStorage.getItem('__rdsh_tui_storage_loaded')) {
      for (const [key,value] of Object.entries(initial)) if(typeof value==='string') localStorage.setItem(key,value);
      sessionStorage.setItem('__rdsh_tui_storage_loaded','1');
    }
    const pending=new Map(); globalThis.__RDSH_TUI_RESOLVE__=(id,value)=>{const callback=pending.get(id);if(callback){pending.delete(id);callback(value);}};
    globalThis.__DSH_DIRECTORY_PICKER__={pick:()=>new Promise(resolve=>{const id=crypto.randomUUID();pending.set(id,resolve);globalThis.__rdshTuiEvent(JSON.stringify({type:'directory',id}));})};
    const emit=(type,value)=>{try{globalThis.__rdshTuiEvent(JSON.stringify({type,...value}));}catch{}};
    const store=()=>{const value={};for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);value[key]=localStorage.getItem(key);}emit('storage',{value});};
    setInterval(store,1500); addEventListener('pagehide',store);
    class TuiNotification extends EventTarget {
      static permission='granted'; static requestPermission(){return Promise.resolve('granted');}
      constructor(title,options={}) {super();this.title=String(title);this.body=String(options.body||'');emit('notification',{title:this.title,body:this.body});}
      close(){this.dispatchEvent(new Event('close'));}
    }
    try{Object.defineProperty(globalThis,'Notification',{value:TuiNotification,configurable:true});}catch{}
    // Clipboard data stays inside the terminal session instead of reading the OS clipboard.
    try{Object.defineProperty(navigator,'clipboard',{value:{
      writeText:async(text)=>emit('clipboard',{text:String(text)}),
      readText:()=>new Promise((resolve,reject)=>{const id=crypto.randomUUID();pending.set(id,value=>value.accept?resolve(value.text):reject(new DOMException('Cancelled in TUI','NotAllowedError')));emit('clipboardRequest',{id});})
    }});}catch{}
  })();`;
}
// A private transport guard, not a general proxy: its only upstream is the
// already authenticated DSH listener. No credentials are added or recorded here.
async function createGuard() {
  const authority=new URL(config.url).host, port=Number(new URL(config.url).port);
  const sockets=new Set();let observed=0;
  const track=socket=>{if(sockets.size>=128){socket.destroy();return false;}sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>{});return true;};
  const deny=socket=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  const allowed=raw=>{try{const url=new URL(raw.replace(/^ws:/,'http:'));return url.origin===config.origin&&!url.username&&!url.password?url:null;}catch{return null;}};
  const limit=(stream,peer,maximum)=>{let bytes=0;stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>maximum){stream.destroy();peer.destroy();}});};
  const headers=req=>Object.fromEntries(Object.entries(req.headers).filter(([key])=>!key.startsWith('proxy-')&&key!=='host').concat([['host',authority]]));
  const server=createServer({maxHeaderSize:32768,headersTimeout:10000,requestTimeout:120000},(req,res)=>{
    const url=allowed(req.url||'');if(!url){res.writeHead(403);res.end();return;}observed++;
    const upstream=httpRequest({host:'127.0.0.1',port,path:url.pathname+url.search,method:req.method,headers:headers(req),agent:false},reply=>{res.writeHead(reply.statusCode||502,reply.headers);limit(reply,res,256*1024*1024);reply.pipe(res);});
    upstream.on('socket',track);upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
    upstream.setTimeout(120000,()=>upstream.destroy());req.on('error',()=>upstream.destroy());res.on('close',()=>upstream.destroy());
    limit(req,upstream,256*1024*1024);req.pipe(upstream);
  });
  server.on('connection',track);
  server.on('connect',(req,client,head)=>{
    if(req.url!==authority){deny(client);return;}observed++;
    const upstream=connect({host:'127.0.0.1',port});if(!track(upstream))return client.destroy();
    upstream.setTimeout(10000,()=>upstream.destroy());upstream.once('connect',()=>{
      upstream.setTimeout(120000,()=>upstream.destroy());client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head.length)upstream.write(head);limit(client,upstream,512*1024*1024);limit(upstream,client,512*1024*1024);client.pipe(upstream);upstream.pipe(client);
    });
    client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());
  });
  server.on('upgrade',(req,client,head)=>{
    const url=allowed(req.url||'');if(!url){deny(client);return;}observed++;
    const upstream=httpRequest({host:'127.0.0.1',port,path:url.pathname+url.search,method:req.method,headers:headers(req),agent:false});
    upstream.on('socket',track);upstream.on('error',()=>client.destroy());upstream.setTimeout(120000,()=>upstream.destroy());
    upstream.on('upgrade',(reply,stream,upstreamHead)=>{
      client.write(`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n`+Object.entries(reply.headers).flatMap(([key,value])=>Array.isArray(value)?value.map(v=>`${key}: ${v}`):[`${key}: ${value}`]).join('\r\n')+'\r\n\r\n');
      if(upstreamHead.length)client.write(upstreamHead);if(head.length)stream.write(head);
      limit(client,stream,512*1024*1024);limit(stream,client,512*1024*1024);client.pipe(stream);stream.pipe(client);
      client.on('close',()=>stream.destroy());stream.on('close',()=>client.destroy());
    });
    upstream.on('response',()=>{upstream.destroy();client.destroy();});upstream.end();
  });
  server.on('clientError',(_error,socket)=>socket.destroy());
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {port:server.address().port,observed:()=>observed,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
async function attach(id, attachedSessionId) {
  if (tabs.has(id)) return await tabs.get(id).ready;
  const page = { id, sessionId: '', title: '', url: '', controls: new Map(), contexts: new Map(), attaching: true };
  tabs.set(id, page);
  page.ready=(async()=>{ try {
    const result = attachedSessionId ? {sessionId:attachedSessionId} : await cdp.send('Target.attachToTarget', { targetId: id, flatten: true }); page.sessionId = result.sessionId;
    await call(page,'Network.enable');
    await call(page, 'Page.enable'); await call(page, 'Runtime.enable'); await call(page, 'DOM.enable'); await call(page, 'Accessibility.enable');
    await call(page, 'Page.setInterceptFileChooserDialog', { enabled: true });
    await call(page, 'Fetch.enable', { patterns: ['settings/openSettingsDocument','session/openWorkspacePath'].map(method=>({urlPattern:config.origin+'/api/'+method,requestStage:'Request'})) });
    await call(page, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await call(page, 'Runtime.addBinding', { name: '__rdshTuiEvent' });
    await call(page, 'Page.addScriptToEvaluateOnNewDocument', { source: script() });
    await call(page,'Runtime.runIfWaitingForDebugger');
    page.attaching = false;
    return page;
  } catch (error) { tabs.delete(id); throw error; }})();
  return await page.ready;
}
async function onEvent(event) {
  const p = event.params || {}, page = [...tabs.values()].find(page => page.sessionId === event.sessionId);
  if (event.method === 'Runtime.executionContextCreated' && page) {
    page.contexts.set(p.context.id, p.context.origin);
  } else if (event.method === 'Runtime.executionContextDestroyed' && page) {
    page.contexts.delete(p.executionContextId);
  } else if (event.method === 'Runtime.executionContextsCleared' && page) {
    page.contexts.clear();
  } else if (event.method === 'Fetch.requestPaused' && page) {
    if(new URL(p.request.url).pathname==='/api/session/openWorkspacePath')await openWorkspacePath(page,p);
    else await openDocument(page,p);
  } else if (event.method === 'Target.attachedToTarget' && config && cdp) {
    if(p.targetInfo.type!=='page'){await cdp.send('Runtime.runIfWaitingForDebugger',{},p.sessionId);return;}
    const child=await attach(p.targetInfo.targetId,p.sessionId);child.url=p.targetInfo.url;child.title=p.targetInfo.title;
    if(p.targetInfo.openerId) selected=child.id;
  } else if (event.method === 'Target.targetInfoChanged') {
    const target = tabs.get(p.targetInfo.targetId); if (target) { target.title = p.targetInfo.title; target.url = p.targetInfo.url; }
  } else if (event.method === 'Target.targetDestroyed') {
    tabs.delete(p.targetId); if (selected === p.targetId) selected = tabs.keys().next().value;
  } else if (event.method === 'Page.javascriptDialogOpening' && page) {
    page.dialog = { id: randomUUID(), type: p.type, message: bounded(p.message, MAX_TEXT), defaultPrompt: bounded(p.defaultPrompt, MAX_TEXT) };
    if(page.id===selected) emitState(page);
  } else if (event.method === 'Page.javascriptDialogClosed' && page) delete page.dialog;
  else if (event.method === 'Page.fileChooserOpened' && page) {
    page.chooser = { id: randomUUID(), multiple: p.mode === 'selectMultiple', backendNodeId: p.backendNodeId };
  } else if (event.method === 'Browser.downloadWillBegin') {
    downloads.set(p.guid, { id: p.guid, name: bounded(p.suggestedFilename, 256), state: 'inProgress', bytes: 0 });
    if (downloads.size > 128) downloads.delete(downloads.keys().next().value);
  } else if (event.method === 'Browser.downloadProgress') {
    const item = downloads.get(p.guid); if (item) { item.state = p.state; item.bytes = p.receivedBytes; if (p.state === 'completed') { item.path = join(config.downloadPath, p.guid); await chmod(item.path, 0o600).catch(() => {}); } }
  } else if (event.method === 'Runtime.bindingCalled' && page && p.name === '__rdshTuiEvent') {
    if(page.contexts.get(p.executionContextId)!==config.origin) return;
    let data; try { data = JSON.parse(p.payload); } catch { return; }
    if (data.type === 'storage' && data.value && typeof data.value === 'object' && JSON.stringify(data.value).length <= 1024 * 1024) {
      storage = data.value; const saved=JSON.stringify(storage);
      persisting=persisting.catch(()=>{}).then(async()=>{const next=config.storagePath+'.'+randomUUID()+'.new';try{await writeFile(next,saved,{mode:0o600,flag:'wx'});await rename(next,config.storagePath);}finally{await rm(next,{force:true}).catch(()=>{});}});
      await persisting;
    } else if(data.type==='directory' && typeof data.id==='string') {
      page.directoryChooser={id:data.id,contextId:p.executionContextId};
    } else if(data.type==='clipboardRequest' && typeof data.id==='string') {
      page.dialog={id:data.id,type:'clipboard',message:'Web画面へ貼り付けるテキストを入力してください',defaultPrompt:'',contextId:p.executionContextId};
      if(page.id===selected)emitState(page);
    } else if (data.type === 'notification' || data.type === 'clipboard') {
      notices.push({ id: randomUUID(), type: data.type, title: bounded(data.title), text: bounded(data.body ?? data.text, MAX_TEXT) });
      if (notices.length > 50) notices.shift();
    }
  }
}
async function snapshot(page) {
  const tree = await call(page, 'Accessibility.getFullAXTree');
  const controls = [], text = [];
  const nextControls = new Map();
  const interactable = new Set(['button','link','textbox','searchbox','checkbox','radio','combobox','listbox','option','menuitem','tab','switch','slider','spinbutton','treeitem']);
  for (const node of tree.nodes || []) {
    if (node.ignored) continue;
    const role = node.role?.value || '', name = bounded(node.name?.value, 2048), rawValue = String(node.value?.value ?? ''), value = bounded(rawValue, MAX_TEXT);
    if (role === 'StaticText' || role === 'heading') { if (name && text.length < 1000) text.push(name); }
    if (!interactable.has(role) || !node.backendDOMNodeId || controls.length >= 512) continue;
    const properties = Object.fromEntries((node.properties || []).map(item => [item.name, item.value?.value]));
    const id = `${page.id}:${node.backendDOMNodeId}`;
    let password = !!properties.protected;
    if (['textbox','searchbox','combobox','spinbutton'].includes(role)) {
      const dom=await call(page,'DOM.describeNode',{backendNodeId:node.backendDOMNodeId}).catch(()=>null);
      const attrs=dom?.node?.attributes||[];
      for(let i=0;i<attrs.length;i+=2) if(attrs[i]==='type' && attrs[i+1]==='password') password=true;
    }
    const editable = ['textbox','searchbox','combobox','spinbutton'].includes(role);
    const item = { id, role, name, ...(value ? { value: password ? '••••••' : value } : {}), editable, password, valueTruncated: Buffer.byteLength(rawValue) > MAX_TEXT, disabled: !!properties.disabled, ...(properties.checked !== undefined ? { checked: properties.checked } : {}) };
    nextControls.set(id, { backendNodeId: node.backendDOMNodeId, ...item }); controls.push(item);
  }
  page.controls = nextControls;
  return { text: text.join('\n').slice(0, 128 * 1024), controls };
}
async function refresh() {
  if (closed || !config || !selected || refreshing) return;
  refreshing = true;
  try {
    const page = current(); if (page.attaching) return;
    let content = { text: '', controls: [] };
    if (!page.dialog) {
      config.observedSessionId=await observedSession(page);
      content = await snapshot(page);
      const screenshot = await call(page, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
      if (screenshot.data?.length < 12 * 1024 * 1024) lastFrame = { png: screenshot.data, width, height, sequence: ++sequence };
    }
    page.content=content; emitState(page,content);
  } catch { if (!closed) output({ type: 'state', value: { status: 'starting', error: '画面を読込み中です', commandSequence } }); }
  finally { refreshing = false; }
}

function emitState(page,content=page.content||{text:'',controls:[]}) {
  output({ type: 'state', value: { status: 'ready', sequence, commandSequence, fillResult, requestedSessionId:config.sessionId, sessionId:config.observedSessionId, sessionBarrier, frame: lastFrame,
      ...content, title: bounded(page.title), url: safeUrl(page.url),
      tabs: [...tabs.values()].map(page => ({ id: page.id, title: bounded(page.title), selected: page.id === selected })),
      ...(page.dialog ? { dialog: page.dialog } : {}), ...(page.directoryChooser ? {directoryChooser:page.directoryChooser}:{}), ...(page.document ? {document:page.document.view}:{}), ...(page.chooser ? { fileChooser: { id: page.chooser.id, multiple: page.chooser.multiple } } : {}),
      downloads: [...downloads.values()], notifications: notices, ...(error ? { error } : {}) } });
}

async function selectSession(page, id) {
  if(typeof id!=='string'||!id||id.length>512) fail('INVALID_SESSION');
  const deadline=Date.now()+20000;
  while(Date.now()<deadline){
    const result=await call(page,'Runtime.evaluate',{expression:`typeof globalThis.__RDSH_TUI_WORKSPACE__?.openSession==='function' && globalThis.__RDSH_TUI_WORKSPACE__?.navigationReady?.(${JSON.stringify(id)})===true`,returnByValue:true});
    if(result.result?.value===true){
      const selected=await call(page,'Runtime.evaluate',{expression:`Promise.resolve(globalThis.__RDSH_TUI_WORKSPACE__.openSession(${JSON.stringify(id)})).then(result=>({requested:result?.requestedSessionId,selected:globalThis.__RDSH_TUI_WORKSPACE__.selectedSessionId()}))`,awaitPromise:true,returnByValue:true});
      const result=selected.result?.value;
      if(selected.exceptionDetails || result?.requested!==id) fail('SESSION_SELECTION_FAILED');
      while(Date.now()<deadline){
        const observed=await observedSession(page);
        if(observed===id){config.sessionId=id;config.observedSessionId=observed;return;}
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      fail('SESSION_SELECTION_FAILED');
    }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  fail('SESSION_BRIDGE_UNAVAILABLE');
}
async function observedSession(page,afterFrame=false){
  const expression='globalThis.__RDSH_TUI_WORKSPACE__?.selectedSessionId?.() ?? null';
  const result=await call(page,'Runtime.evaluate',{expression:afterFrame?`new Promise(requestAnimationFrame).then(()=>${expression})`:expression,awaitPromise:afterFrame,returnByValue:true});
  return typeof result.result?.value==='string'&&result.result.value.length<=512?result.result.value:null;
}
async function hostRpc(page,method,args) {
  const rpcId=randomUUID();
  const envelope={type:'client-request',rpcId,method,payload:{args}};
  const result=await call(page,'Runtime.evaluate',{expression:`fetch(${JSON.stringify('/api/'+method)},{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(envelope))}}).then(r=>r.json())`,awaitPromise:true,returnByValue:true});
  const response=result.result?.value;
  if(result.exceptionDetails || response?.type!=='server-response'||response.rpcId!==rpcId||response.result?.ok!==true) fail('DOCUMENT_RPC_FAILED');
  return response.result.value;
}
async function fulfillDocument(page,document,result) {
  await call(page,'Fetch.fulfillRequest',{requestId:document.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify({type:'server-response',rpcId:document.rpcId,result})).toString('base64')});
}
async function openWorkspacePath(page,request) {
  let envelope;try{envelope=JSON.parse(request.request.postData||'');}catch{}
  const pending={requestId:request.requestId,rpcId:envelope?.rpcId};
  if(!pending.rpcId || envelope.method!=='session/openWorkspacePath'){
    await call(page,'Fetch.failRequest',{requestId:request.requestId,errorReason:'Aborted'});return;
  }
  const value=envelope.payload?.args?.request;
  try{
    if(!value||typeof value.path!=='string'||value.path.length>4096)fail('INVALID_WORKSPACE_PATH');
    const result=await call(page,'Runtime.evaluate',{expression:`Promise.resolve(globalThis.__RDSH_TUI_WORKSPACE__.openWorkspacePath(${JSON.stringify(value)}))`,awaitPromise:true,returnByValue:true,userGesture:true});
    if(result.exceptionDetails||result.result?.value?.opened!==true)fail('WORKSPACE_PREVIEW_FAILED');
    await fulfillDocument(page,pending,{ok:true,value:result.result.value});
  }catch{
    await fulfillDocument(page,pending,{ok:false,error:{code:'rdsh-tui/preview-unavailable',message:'Cannot open this path in the TUI preview'}});
    error='WORKSPACE_PREVIEW_FAILED';
  }
}
async function openDocument(page,request) {
  let envelope;try{envelope=JSON.parse(request.request.postData||'');}catch{}
  const document={requestId:request.requestId,rpcId:envelope?.rpcId};
  if(!envelope?.rpcId || envelope.method!=='settings/openSettingsDocument' || page.document) {
    await call(page,'Fetch.failRequest',{requestId:request.requestId,errorReason:'Aborted'});return;
  }
  try{
    const value=await hostRpc(page,'rdshTuiAdmin/readSettingsDocument',{});
    if(typeof value.content!=='string'||Buffer.byteLength(value.content)>512*1024)fail('DOCUMENT_TOO_LARGE');
    document.view={id:randomUUID(),path:bounded(value.path),content:value.content,revision:value.revision,writable:value.writable};
    page.document=document;
  }catch{
    await fulfillDocument(page,document,{ok:false,error:{code:'rdsh-tui/document-unavailable',message:'TUI document editor is unavailable'}});
    error='DOCUMENT_UNAVAILABLE';
  }
}
async function finishDocument(page,value) {
  const document=page.document;
  if(!document || value.id!==document.view.id || typeof value.accept!=='boolean')fail('DOCUMENT_EXPIRED');
  if(value.accept) {
    if(!document.view.writable || typeof value.content!=='string'||Buffer.byteLength(value.content)>512*1024||value.expectedRevision!==document.view.revision)fail('DOCUMENT_INPUT_INVALID');
    await hostRpc(page,'rdshTuiAdmin/saveSettingsDocument',{content:value.content,expectedRevision:value.expectedRevision});
    await fulfillDocument(page,document,{ok:true,value:{opened:true}});
  } else await fulfillDocument(page,document,{ok:false,error:{code:'rdsh-tui/cancelled',message:'Cancelled in TUI'}});
  delete page.document;
}

const keyInfo = {
  Enter: [13, 'Enter'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'], Delete: [46, 'Delete'],
  ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
  Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'], Space: [32, 'Space'],
};
async function input(value) {
  if (!value || typeof value !== 'object') fail('INVALID_INPUT');
  const page = current(); error = undefined;
  switch (value.kind) {
    case 'activate': case 'fill': {
      const control = page.controls.get(value.id);
      if (!control || control.disabled || (value.kind === 'fill' && (!control.editable || control.valueTruncated))) fail('CONTROL_EXPIRED');
      if (value.kind === 'fill' && (typeof value.text !== 'string' || Buffer.byteLength(value.text) > MAX_TEXT)) fail('TEXT_TOO_LARGE');
      const { object } = await call(page, 'DOM.resolveNode', { backendNodeId: control.backendNodeId });
      try {
        // Resolve, validate and focus this control before any text is sent. A stale
        // target must never cause the subsequent edit to reach another field.
        const action = value.kind === 'fill' ? 'fill' : control.editable ? 'focus' : 'click';
        const result = await call(page, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: `async function(action,text){
          if(!this.isConnected || this.matches(':disabled') || this.getAttribute('aria-disabled')==='true')return null;
          if(action!=='click'){
            this.focus();if(this.getRootNode().activeElement!==this)return null;
            if(action==='fill'){
              if(this.readOnly || !(this.isContentEditable || typeof this.select==='function'))return null;
              const doc=this.ownerDocument;
              if(typeof this.select==='function')this.select();
              else{const range=doc.createRange();range.selectNodeContents(this);const selection=doc.getSelection();selection.removeAllRanges();selection.addRange(range);}
              await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
              if(!this.isConnected || this.getRootNode().activeElement!==this || this.readOnly || this.matches(':disabled') || this.getAttribute('aria-disabled')==='true')return null;
              // Chromium execCommand(delete) emits input without beforeinput.
              // Rich editors need the cancellable intent to update their own state.
              const intent=text?null:new InputEvent('beforeinput',{inputType:'deleteContentBackward',bubbles:true,cancelable:true});
              const applyNative=intent?this.dispatchEvent(intent):true;
              if(applyNative && (!this.isConnected || this.getRootNode().activeElement!==this))return null;
              if(applyNative && !doc.execCommand(text?'insertText':'delete',false,text))return null;
            }
            return {focused:true};
          }
          this.scrollIntoView({block:'center',inline:'center'});
          const r=this.getBoundingClientRect(),left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);
          if(right<=left || bottom<=top)return null;
          const x=(left+right)/2,y=(top+bottom)/2,hit=this.getRootNode().elementFromPoint(x,y);
          if(hit!==this && !this.contains(hit))return null;
          return {x,y};
        }`, arguments: [{ value: action },{value:value.text||''}], returnByValue: true, awaitPromise:true, userGesture: true });
        const point = result.result?.value;
        if (!point || result.exceptionDetails) fail('CONTROL_EXPIRED');
        if (action === 'click') {
          await call(page, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
          await call(page, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
        }
      } finally { await call(page, 'Runtime.releaseObject', { objectId: object.objectId }).catch(() => {}); }
      break;
    }
    case 'text':
      if (typeof value.text !== 'string' || Buffer.byteLength(value.text) > MAX_TEXT) fail('TEXT_TOO_LARGE');
      await call(page, 'Input.insertText', { text: value.text }); break;
    case 'key': {
      if (typeof value.key !== 'string' || value.key.length > 24) fail('INVALID_KEY');
      const modifiers = Number.isInteger(value.modifiers) ? value.modifiers : 0;
      if (modifiers < 0 || modifiers > 15) fail('INVALID_MODIFIERS');
      const key = keyInfo[value.key] || (value.key.length === 1 ? [value.key.toUpperCase().charCodeAt(0), `Key${value.key.toUpperCase()}`] : undefined);
      if (!key) fail('INVALID_KEY');
      const params = { key: value.key === 'Space' ? ' ' : value.key, code: key[1], windowsVirtualKeyCode: key[0], nativeVirtualKeyCode: key[0], modifiers };
      const text=value.key==='Enter'?'\r':!(modifiers&6)&&(value.key.length===1||value.key==='Space')?params.key:undefined;
      await call(page, 'Input.dispatchKeyEvent', { ...params, type: 'keyDown', ...(text?{text}: {}) });
      await call(page, 'Input.dispatchKeyEvent', { ...params, type: 'keyUp' }); break;
    }
    case 'click': case 'move': case 'scroll': {
      if (![value.x, value.y].every(Number.isFinite) || value.x < 0 || value.y < 0 || value.x > width || value.y > height) fail('INVALID_POINT');
      const button = ['left','right','middle'].includes(value.button) ? value.button : 'left';
      const buttons = Number.isInteger(value.buttons) && value.buttons>=0 && value.buttons<=7 ? value.buttons : 0;
      const clickCount=value.clickCount===2?2:1;
      if (value.kind === 'scroll') {
        if (![value.deltaX ?? 0, value.deltaY ?? 0].every(n => Number.isFinite(n) && Math.abs(n) <= 10000)) fail('INVALID_SCROLL');
        await call(page, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: value.x, y: value.y, deltaX: value.deltaX ?? 0, deltaY: value.deltaY ?? 0 });
      } else if (value.kind === 'move') await call(page, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: value.x, y: value.y,buttons });
      else {
        if(value.event!=='up') await call(page, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: value.x, y: value.y, button, clickCount });
        if(value.event!=='down') await call(page, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: value.x, y: value.y, button, clickCount });
      }
      break;
    }
    case 'resize':
      if (!dimensions(value.width) || !dimensions(value.height)) fail('INVALID_SIZE');
      width = value.width; height = value.height;
      for (const tab of tabs.values()) if (!tab.attaching) await call(tab, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      break;
    case 'dialog':
      if (!page.dialog || value.id !== page.dialog.id || typeof value.accept !== 'boolean') fail('DIALOG_EXPIRED');
      if(page.dialog.type==='clipboard'){
        await call(page,'Runtime.evaluate',{expression:`globalThis.__RDSH_TUI_RESOLVE__?.(${JSON.stringify(value.id)},${JSON.stringify({accept:value.accept,text:bounded(value.text,MAX_TEXT)})})`,contextId:page.dialog.contextId});
      }else await call(page, 'Page.handleJavaScriptDialog', { accept: value.accept, promptText: bounded(value.text, MAX_TEXT) });
      delete page.dialog; break;
    case 'files': {
      if (!page.chooser || value.id !== page.chooser.id || !Array.isArray(value.paths) || value.paths.length > (page.chooser.multiple ? 32 : 1)) fail('FILE_CHOOSER_EXPIRED');
      const files = [];
      for (const path of value.paths) {
        if (typeof path !== 'string' || path.length > 4096 || /[\0\r\n]/.test(path)) fail('INVALID_FILE');
        const absolute = resolve(config.workspace || '.', path), info = await stat(absolute);
        if (!info.isFile() || info.size > 128 * 1024 * 1024) fail('INVALID_FILE'); files.push(absolute);
      }
      await call(page, 'DOM.setFileInputFiles', { files, backendNodeId: page.chooser.backendNodeId }); delete page.chooser; break;
    }
    case 'directory': {
      if(!page.directoryChooser || value.id!==page.directoryChooser.id) fail('DIRECTORY_CHOOSER_EXPIRED');
      let path=null;
      if(value.path!==null && value.cancel!==true){if(typeof value.path!=='string'||value.path.length>4096)fail('INVALID_DIRECTORY');path=resolve(config.workspace||'.',value.path);if(!(await stat(path)).isDirectory())fail('INVALID_DIRECTORY');}
      await call(page,'Runtime.evaluate',{expression:`globalThis.__RDSH_TUI_RESOLVE__?.(${JSON.stringify(value.id)},${JSON.stringify(path)})`,contextId:page.directoryChooser.contextId});
      delete page.directoryChooser;break;
    }
    case 'document': await finishDocument(page,value);break;
    case 'session': await selectSession(page,value.sessionId);break;
    case 'session_snapshot':
      config.observedSessionId=await observedSession(page,true);sessionBarrier=value.id;emitState(page);break;
    case 'back': case 'forward': {
      const history = await call(page, 'Page.getNavigationHistory'); const index = history.currentIndex + (value.kind === 'back' ? -1 : 1);
      if (history.entries[index]) await call(page, 'Page.navigateToHistoryEntry', { entryId: history.entries[index].id }); break;
    }
    case 'reload': await call(page, 'Page.reload'); break;
    case 'tab': if (!tabs.has(value.id)) fail('TAB_EXPIRED'); selected = value.id; lastFrame = undefined; break;
    case 'close_tab':
      if (!tabs.has(value.id) || tabs.size <= 1) fail('LAST_TAB'); await cdp.send('Target.closeTarget', { targetId: value.id }); break;
    default: fail('UNKNOWN_INPUT');
  }
  commandSequence++;
  await refresh();
}
async function shutdown(code) {
  if (closed) return;
  if (code) output({ type: 'state', value: { status: 'failed', error: bounded(code), controls: [], tabs: [] } });
  closed = true; clearInterval(interval);
  if (browser && browser.exitCode === null) {
    try { browser.stdio[3].write(JSON.stringify({ id: 0x7fffffff, method: 'Browser.close' }) + '\0'); } catch {}
    await Promise.race([new Promise(resolve => browser.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 1500))]);
    if (browser.exitCode === null) browser.kill('SIGKILL');
  }
  if(guard)await guard.close();
  await persisting.catch(()=>{});
  if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {});
  process.exit(code ? 1 : 0);
}
let chain = Promise.resolve();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  if (line.length > MAX_LINE) { shutdown('INPUT_TOO_LARGE'); return; }
  let message; try { message = JSON.parse(line); } catch { shutdown('INVALID_JSON'); return; }
  // A JS dialog blocks the triggering CDP command. Its reply must bypass that queue.
  if(message.type==='close'){shutdown();return;}
  if(message.type==='input' && message.value?.kind==='dialog'){
    input(message.value).catch(()=>{error='DIALOG_EXPIRED';refresh().catch(()=>{});});return;
  }
  chain = chain.then(async () => {
    if (message.type === 'init') await init(message);
    else if (message.type === 'close') await shutdown();
    else if (message.type === 'input') {
      await input(message.value);
      if (message.value?.kind === 'fill' && typeof message.value.requestId === 'string') {
        fillResult = { id: bounded(message.value.requestId, 512), ok: true }; await refresh();
      }
    }
    else fail('INVALID_MESSAGE');
  }).catch(reason => {
    const code = /^[A-Z_]+(?::[^\r\n]{0,200})?$/.test(reason.message || '') ? reason.message : 'BROWSER_OPERATION_FAILED';
    if (message.value?.kind === 'fill' && typeof message.value.requestId === 'string') fillResult = { id: bounded(message.value.requestId, 512), ok: false, error: code };
    if (!initialized) shutdown(code); else { error = code; commandSequence++; refresh().catch(() => {}); }
  });
});
lines.on('close', () => shutdown());
process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
process.on('uncaughtException', () => shutdown('BROWSER_INTERNAL_ERROR'));
process.on('unhandledRejection', () => shutdown('BROWSER_INTERNAL_ERROR'));
