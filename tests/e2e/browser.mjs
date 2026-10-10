// Real Rust servers and the project CLI/MCP in isolated directories.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {writeQaMatrix} from './qa-matrix.mjs';

const repo=path.resolve(import.meta.dirname,'../..');
const {chromium}=await import(process.env.RDSH_PLAYWRIGHT_MODULE || 'playwright');
const binary=path.resolve(repo,process.env.RDSH_E2E_BIN || path.join(repo,'target', 'debug', process.platform==='win32'?'rdsh.exe':'rdsh'));
const output=path.resolve(process.env.RDSH_E2E_OUTPUT || path.join(repo,'target/e2e'));
const root=await mkdtemp(path.join(tmpdir(),'rdsh-browser-e2e-'));
const env=Object.fromEntries(['PATH','SystemRoot','WINDIR','COMSPEC','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(env,{HOME:root,USERPROFILE:root,DSH_HOME:path.join(root,'dsh'),XDG_CACHE_HOME:path.join(root,'cache'),XDG_CONFIG_HOME:path.join(root,'config'),XDG_DATA_HOME:path.join(root,'data'),RDSH_ORIG_BIN:path.join(root,'no-original'),RDSH_DASHBOARD_HOME:path.join(root,'projects-state')});
await mkdir(env.DSH_HOME);await mkdir(output,{recursive:true});
let sourceSha=process.env.RDSH_E2E_SOURCE_SHA||null;
if(!sourceSha){try{sourceSha=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{sourceSha=null;}}
const children=new Set(); const contexts=[]; const report={scope:'real Rust setup/serve and Node project CLI+HTTP MCP+browser; no model calls, Tailscale or Electron Desktop',source_sha:sourceSha,tested_at:new Date().toISOString(),environment:{platform:process.platform,arch:process.arch,node:process.version,browser:null},viewports:[{width:1280,height:900},{width:390,height:844}],flows:[],qa_results:[],page_errors:[],console_errors:[]};
let activeQaCase=null;
function beginQaCase(caseId){activeQaCase=caseId;}
function passQaCase(caseId,evidenceRef){report.qa_results.push({case_id:caseId,status:'pass',mode:'browser',source_sha:report.source_sha,tested_at:new Date().toISOString(),evidence_ref:evidenceRef});activeQaCase=null;}
function launch(command,args,pattern){
 const child=spawn(command,args,{env,cwd:root,stdio:['ignore','pipe','pipe']});children.add(child);
 return new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error('server readiness deadline exceeded')),20000);
 const read=b=>{text+=b;const match=text.match(pattern);if(match){clearTimeout(timer);resolve({child,url:match[1]});}};
 child.stdout.on('data',read);child.stderr.on('data',read);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);if(!pattern.test(text))reject(new Error(`server exited ${code}`));});});
}
async function stop(child){if(child.exitCode!==null)return;await new Promise(resolve=>{const t=setTimeout(()=>{child.kill('SIGKILL');},5000);child.once('exit',()=>{clearTimeout(t);resolve();});child.kill('SIGTERM');});children.delete(child);}
async function pageFor(browser,url){const context=await browser.newContext({viewport:report.viewports[0],locale:'ja-JP'});contexts.push(context);const page=await context.newPage();page.on('pageerror',e=>report.page_errors.push(e.message));page.on('console',msg=>{if(msg.type()==='error')report.console_errors.push({text:msg.text(),path:msg.location().url?new URL(msg.location().url).pathname:''});});await page.goto(url);return page;}
async function screenshot(page,name){await page.evaluate(async()=>{window.scrollTo(0,0);await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});await page.screenshot({path:path.join(output,name+'.png'),fullPage:false});}
async function freePort(){const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise(resolve=>server.close(resolve));return String(port);}
async function check(page,title){assert.match(await page.title(),title);assert.ok((await page.locator('body').innerText()).trim().length>100);assert.equal(await page.locator('vite-error-overlay,nextjs-portal').count(),0);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1),'page overflow');}
const browser=await chromium.launch({headless:true,...(process.env.RDSH_CHROME_PATH?{executablePath:process.env.RDSH_CHROME_PATH}:{})});
report.environment.browser=browser.version();
try{
 const setup=await launch(binary,['setup','--web','--port','0'],/(http:\/\/127\.0\.0\.1:\d+\/#key=[a-f0-9]+)/);
 const page=await pageFor(browser,setup.url);await page.locator('#extras .row').first().waitFor();await check(page,/rdsh setup/);
 assert.equal(new URL(page.url()).hash,'');await page.locator('#extras .row').filter({hasText:'rdsh serve'}).click();
 await page.waitForFunction(()=>document.querySelector('#extras .row')?.textContent.includes('有効'));
 assert.deepEqual(JSON.parse(await readFile(path.join(env.DSH_HOME,'rdsh.json'),'utf8')).extras.enable,['serve']);
 await page.reload();await page.waitForFunction(()=>document.querySelector('#extras .row')?.textContent.includes('有効'));
 await screenshot(page,'setup-desktop');await page.setViewportSize(report.viewports[1]);await check(page,/rdsh setup/);await screenshot(page,'setup-mobile');
 await page.close();await stop(setup.child);report.flows.push('setup: missing model connection rendered -> Extras enable -> file readback -> reload retained');

 const session=path.join(env.DSH_HOME,'sessions','example','session-one');await mkdir(session,{recursive:true});await writeFile(path.join(session,'messages.jsonl'),'synthetic session');
 const skills=path.join(env.DSH_HOME,'skills','e2e-skill');await mkdir(skills,{recursive:true});await writeFile(path.join(skills,'SKILL.md'),'# Synthetic skill');
 const serve=await launch(binary,['serve','--port','0'],/(http:\/\/127\.0\.0\.1:\d+\/#key=[a-f0-9]+)/);
 const native=await pageFor(browser,serve.url);await native.locator('#sess').filter({hasText:'session-one'}).waitFor();await check(native,/rdsh dashboard/);
 await native.locator('#ttext').fill('abcd日本語');await native.getByRole('button',{name:'推定する',exact:true}).click();await native.waitForFunction(()=>document.querySelector('#tout').textContent.includes('4'));
 await native.locator('#ptext').fill('START\n'+'日本語 context\n'.repeat(1000)+'END');await native.locator('#pmax').fill('100');await native.getByRole('button',{name:'prune実行',exact:true}).click();await native.locator('#pout').filter({hasText:'rdsh pruned'}).waitFor();
 assert.ok((await native.locator('#pout').innerText()).includes('START'));assert.ok((await native.locator('#pout').innerText()).includes('END'));
 await screenshot(native,'native-desktop');await native.reload();await native.locator('#sess').filter({hasText:'session-one'}).waitFor();await native.setViewportSize(report.viewports[1]);await check(native,/rdsh dashboard/);await screenshot(native,'native-mobile');
 await native.close();await stop(serve.child);report.flows.push('native serve: authenticated URL -> tokens -> prune -> sessions -> reload key retained');

 const {identity}=await import(pathToFileURL(path.join(repo,'dashboard/state.mjs')));
 process.env.RDSH_DASHBOARD_HOME=env.RDSH_DASHBOARD_HOME;
 const {Client}=await import(pathToFileURL(path.join(repo,'dashboard/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')));
 const {StreamableHTTPClientTransport}=await import(pathToFileURL(path.join(repo,'dashboard/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js')));
 const project=path.join(root,'alpha');await mkdir(project);const identityAlpha=await identity(project);
 const dashboard=await launch(process.execPath,[path.join(repo,'dashboard/cli.mjs'),'project','--project',project,'--port',await freePort(),'--no-tailscale'],/project: (http:\/\/127\.0\.0\.1:\d+\/)/);
 const runtime=JSON.parse(await readFile(path.join(identityAlpha.directory,'runtime.json'),'utf8'));
 const client=new Client({name:'browser-e2e',version:'1.0.0'},{capabilities:{}});
 await client.connect(new StreamableHTTPClientTransport(new URL(runtime.local_url+'mcp'),{requestInit:{headers:{authorization:`Bearer ${runtime.mcp_token}`}}}));
 try{
 const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});assert.notEqual(result.isError,true);return result;};
 await call('dashboard_upsert_task',{id:'T1',title:'E2E task',status:'doing'});
 await call('dashboard_ask_question',{id:'Q1',question:'E2E: choose an answer',urgency:'high'});
 const projectPage=await pageFor(browser,runtime.browser_url);await projectPage.locator('#question-Q1 textarea').waitFor();await check(projectPage,/dashboard/i);
 await projectPage.locator('#question-Q1 textarea').fill('Keep this draft');
 beginQaCase('desktop.sse-draft');
 const stateUpdate=projectPage.waitForResponse(r=>r.url().endsWith('/api/state')&&r.status()===200);
 await call('dashboard_update_metrics',{input_tokens:1000,cached_input_tokens:500,tool_calls:10,tool_errors:0});await stateUpdate;
 assert.equal(await projectPage.locator('#question-Q1 textarea').inputValue(),'Keep this draft');
 passQaCase('desktop.sse-draft','browser-results.json#qa_results.desktop.sse-draft');
 await projectPage.locator('#question-Q1 textarea').fill('E2E saved answer');await projectPage.locator('#question-Q1').getByRole('button',{name:'回答を返す'}).click();
 await projectPage.locator('#questions').filter({hasText:'未回答の質問はありません'}).waitFor();await projectPage.locator('#answered').evaluate(e=>e.open=true);await projectPage.locator('#answers').filter({hasText:'E2E saved answer'}).waitFor();
 const feedback=await client.callTool({name:'dashboard_get_feedback',arguments:{}});assert.notEqual(feedback.isError,true);assert.ok(feedback.content[0].text.includes('E2E saved answer'));
 const state=await fetch(runtime.local_url+'api/state',{headers:{authorization:`Bearer ${runtime.token}`}});assert.equal((await state.json()).questions[0].answer,'E2E saved answer');
 const readState=async()=>{const response=await fetch(runtime.local_url+'api/state',{headers:{authorization:`Bearer ${runtime.token}`}});assert.equal(response.status,200);return response.json();};

 await call('dashboard_ask_question',{id:'Q2',question:'E2E double-submit fixture',urgency:'normal'});
 await projectPage.locator('#question-Q2 textarea').waitFor();
 await projectPage.locator('#question-Q2 textarea').fill('One answer only');
 let doubleSubmitRequests=0;
 await projectPage.route('**/api/update/answer',async route=>{if(route.request().postDataJSON()?.id==='Q2')doubleSubmitRequests++;await route.continue();});
 beginQaCase('desktop.double-submit');
 const doubleSubmitResponse=projectPage.waitForResponse(response=>response.url().endsWith('/api/update/answer')&&response.request().postDataJSON()?.id==='Q2');
 await projectPage.locator('#question-Q2').getByRole('button',{name:'回答を返す'}).dblclick({delay:40});
 assert.equal((await doubleSubmitResponse).status(),200);
 await projectPage.unroute('**/api/update/answer');
 let stateAfter=await readState();
 assert.equal(doubleSubmitRequests,1);
 assert.equal(stateAfter.feedback.filter(item=>item.question_id==='Q2'&&item.type==='question_answered').length,1);
 passQaCase('desktop.double-submit','browser-results.json#qa_results.desktop.double-submit');

 await call('dashboard_ask_question',{id:'Q3',question:'E2E offline retry fixture',urgency:'normal'});
 await projectPage.locator('#question-Q3 textarea').waitFor();
 await projectPage.locator('#question-Q3 textarea').fill('Retry this draft after reconnecting');
 beginQaCase('desktop.offline-retry');
 await projectPage.context().setOffline(true);
 await projectPage.locator('#question-Q3').getByRole('button',{name:'回答を返す'}).click();
 await projectPage.waitForFunction(()=>Boolean(document.querySelector('#question-Q3 [role="alert"]')?.textContent));
 assert.equal(await projectPage.locator('#question-Q3 textarea').inputValue(),'Retry this draft after reconnecting');
 assert.equal((await readState()).questions.find(item=>item.id==='Q3').answer,null);
 await projectPage.context().setOffline(false);
 const retryResponse=projectPage.waitForResponse(response=>response.url().endsWith('/api/update/answer')&&response.request().postDataJSON()?.id==='Q3');
 await projectPage.locator('#question-Q3').getByRole('button',{name:'回答を返す'}).click();
 assert.equal((await retryResponse).status(),200);
 stateAfter=await readState();
 assert.equal(stateAfter.questions.find(item=>item.id==='Q3').answer,'Retry this draft after reconnecting');
 assert.equal(stateAfter.feedback.filter(item=>item.question_id==='Q3'&&item.type==='question_answered').length,1);
 passQaCase('desktop.offline-retry','browser-results.json#qa_results.desktop.offline-retry');

 await call('dashboard_ask_question',{id:'Q4',question:'E2E lost-response fixture',urgency:'normal'});
 await projectPage.locator('#question-Q4 textarea').waitFor();
 await projectPage.locator('#question-Q4 textarea').fill('Server committed before the response was lost');
 let serverCommitted=false;
 await projectPage.route('**/api/update/answer',async route=>{
   if(route.request().postDataJSON()?.id!=='Q4')return route.continue();
   const response=await route.fetch();serverCommitted=response.status()===200;await response.text();await route.abort('failed');
 });
 beginQaCase('desktop.lost-response');
 await projectPage.locator('#question-Q4').getByRole('button',{name:'回答を返す'}).click();
 await projectPage.locator('#answered').evaluate(e=>e.open=true);
 await projectPage.locator('#answers').filter({hasText:'Server committed before the response was lost'}).waitFor();
 await projectPage.unroute('**/api/update/answer');
 stateAfter=await readState();
 assert.equal(serverCommitted,true);
 assert.equal(stateAfter.questions.find(item=>item.id==='Q4').answer,'Server committed before the response was lost');
 assert.equal(stateAfter.feedback.filter(item=>item.question_id==='Q4'&&item.type==='question_answered').length,1);
 passQaCase('desktop.lost-response','browser-results.json#qa_results.desktop.lost-response');

 const alphaState=await readFile(path.join(identityAlpha.directory,'state.json'),'utf8');assert.ok(alphaState.includes('E2E saved answer'));
 await screenshot(projectPage,'project-desktop');await projectPage.setViewportSize(report.viewports[1]);await check(projectPage,/dashboard/i);passQaCase('mobile.viewport','project-mobile.png');await screenshot(projectPage,'project-mobile');
 await projectPage.close();await client.close();await stop(dashboard.child);
 const restarted=await launch(process.execPath,[path.join(repo,'dashboard/cli.mjs'),'project','--project',project,'--port',await freePort(),'--no-tailscale'],/project: (http:\/\/127\.0\.0\.1:\d+\/)/);
 const fresh=JSON.parse(await readFile(path.join(identityAlpha.directory,'runtime.json'),'utf8'));
 assert.notEqual(fresh.browser_url,runtime.browser_url);
 const staleToken=new URL(runtime.browser_url).hash.slice('#key='.length);assert.equal((await fetch(fresh.local_url+'api/state',{headers:{'x-rdsh-browser-token':staleToken}})).status,401);
 const newPage=await pageFor(browser,fresh.browser_url);await newPage.locator('#tasks-detail').evaluate(e=>e.open=true);await newPage.locator('#task-T1').waitFor();await newPage.locator('#answered').evaluate(e=>e.open=true);await newPage.locator('#answers').filter({hasText:'E2E saved answer'}).waitFor();await check(newPage,/dashboard/i);
 const persisted=await fetch(fresh.local_url+'api/state',{headers:{authorization:`Bearer ${fresh.token}`}});assert.equal(persisted.status,200);const persistedState=await persisted.json();assert.equal(persistedState.questions.find(item=>item.id==='Q1').answer,'E2E saved answer');assert.equal(persistedState.feedback.filter(item=>item.question_id==='Q1'&&item.type==='question_answered').length,1);
 passQaCase('desktop.answer-reload','browser-results.json#qa_results.desktop.answer-reload');await stop(restarted.child);
 report.flows.push('project CLI: real MCP task/question -> browser draft preserved on SSE -> browser answer -> MCP/file readback -> process restart retained answer and revoked old key');
 }finally{await client.close();}
 assert.deepEqual(report.page_errors,[]);assert.deepEqual(report.console_errors,[]);
 report.result='PASS';
}catch(error){report.result='FAIL';report.error=error.message;if(activeQaCase)report.qa_results.push({case_id:activeQaCase,status:'fail',mode:'browser',source_sha:report.source_sha,tested_at:new Date().toISOString(),reason:error.message,evidence_ref:'browser-results.json'});throw error;}finally{
 for(const context of contexts)await context.close();await browser.close();for(const child of children)await stop(child);
 report.tested_at=new Date().toISOString();await writeFile(path.join(output,'browser-results.json'),JSON.stringify(report,null,2)+'\n');await writeQaMatrix(report,output);await rm(root,{recursive:true,force:true});
}
console.log(JSON.stringify({result:report.result,source_sha:report.source_sha,qa_results:report.qa_results,flows:report.flows,output},null,2));
