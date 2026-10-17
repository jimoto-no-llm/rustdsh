// Real Rust servers and the project CLI/MCP in isolated directories.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {classifyBrowserConsoleError,writeQaMatrix} from './qa-matrix.mjs';

const repo=path.resolve(import.meta.dirname,'../..');
const {chromium}=await import(process.env.RDSH_PLAYWRIGHT_MODULE || 'playwright');
const binary=path.resolve(repo,process.env.RDSH_E2E_BIN || path.join(repo,'target', 'debug', process.platform==='win32'?'rdsh.exe':'rdsh'));
const output=path.resolve(process.env.RDSH_E2E_OUTPUT || path.join(repo,'target/e2e'));
const language=process.env.RDSH_E2E_LANGUAGE || 'ja';
const copies={
 ja:{connect:'接続',enabled:'有効',estimate:'推定する',prune:'prune実行',nativeTitle:'rdsh ダッシュボード',projectTitle:'プロジェクトダッシュボード',answer:'回答を返す',empty:'未回答の質問はありません',tokens:'トークン',projects:'プロジェクト'},
 en:{connect:'Connect',enabled:'on',estimate:'Estimate',prune:'Run prune',nativeTitle:'rdsh dashboard',projectTitle:'PROJECT DASHBOARD',answer:'Submit answer',empty:'No unanswered questions',tokens:'tokens',projects:'projects'},
 'zh-CN':{connect:'连接',enabled:'已启用',estimate:'估算',prune:'执行裁剪',nativeTitle:'rdsh 仪表板',projectTitle:'项目仪表板',answer:'提交回答',empty:'没有待回答的问题',tokens:'令牌',projects:'个项目'},
};
assert.ok(Object.hasOwn(copies,language));const copy=copies[language];
const {catalog}=await import(pathToFileURL(path.join(repo,'dashboard/locale.mjs')));
const root=await mkdtemp(path.join(tmpdir(),'rdsh-browser-e2e-'));
const env=Object.fromEntries(['PATH','SystemRoot','WINDIR','COMSPEC','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(env,{RDSH_LANG:language,HOME:root,USERPROFILE:root,DSH_HOME:path.join(root,'dsh'),XDG_CACHE_HOME:path.join(root,'cache'),XDG_CONFIG_HOME:path.join(root,'config'),XDG_DATA_HOME:path.join(root,'data'),RDSH_ORIG_BIN:path.join(root,'no-original'),RDSH_DASHBOARD_HOME:path.join(root,'projects-state')});
await mkdir(env.DSH_HOME);await mkdir(output,{recursive:true});
let sourceSha=process.env.RDSH_E2E_SOURCE_SHA||null;
if(!sourceSha){try{sourceSha=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{sourceSha=null;}}
const children=new Set(); const contexts=[]; const handoffFiles=[]; const report={scope:'real Rust setup/serve and Node project CLI+HTTP MCP+browser; no model calls, Tailscale or Electron Desktop',browser:'Browser plugin not available; Playwright',source_sha:sourceSha,tested_at:new Date().toISOString(),environment:{platform:process.platform,arch:process.arch,node:process.version,browser:null},viewports:[{width:1280,height:900},{width:390,height:844}],flows:[],qa_results:[],page_errors:[],console_errors:[],expected_console_errors:[]};
let activeQaCase=null;
function beginQaCase(caseId){activeQaCase=caseId;}
function passQaCase(caseId,evidenceRef){report.qa_results.push({case_id:caseId,status:'pass',mode:'browser',source_sha:report.source_sha,tested_at:new Date().toISOString(),evidence_ref:evidenceRef});activeQaCase=null;}
function launch(command,args,pattern){
 const child=spawn(command,args,{env,cwd:root,stdio:['ignore','pipe','pipe']});children.add(child);
 return new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error('server readiness deadline exceeded')),20000);
 const read=b=>{text+=b;const match=text.match(pattern);if(match){clearTimeout(timer);resolve({child,url:match[1],tokenFile:match[2]?.trim()});}};
 child.stdout.on('data',read);child.stderr.on('data',read);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);if(!pattern.test(text))reject(new Error(`server exited ${code}`));});});
}
async function stop(child){if(child.exitCode!==null)return;await new Promise(resolve=>{const t=setTimeout(()=>{child.kill('SIGKILL');},5000);child.once('exit',()=>{clearTimeout(t);resolve();});child.kill('SIGTERM');});children.delete(child);}
async function pageFor(browser,url){const context=await browser.newContext({viewport:report.viewports[0],locale:'ja-JP'});contexts.push(context);const page=await context.newPage();page.on('pageerror',e=>report.page_errors.push(e.message));page.on('console',msg=>{if(msg.type()==='error'){const error={case_id:activeQaCase,text:msg.text(),path:msg.location().url?new URL(msg.location().url).pathname:''};report[classifyBrowserConsoleError(error)==='expected'?'expected_console_errors':'console_errors'].push(error);}});await page.goto(url);return page;}
async function screenshot(page,name){await page.evaluate(async()=>{window.scrollTo(0,0);await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});await page.screenshot({path:path.join(output,name+'.png'),fullPage:false});}
async function freePort(){const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise(resolve=>server.close(resolve));return String(port);}
async function check(page,title){assert.match(await page.title(),title);assert.ok((await page.locator('body').innerText()).trim().length>100);assert.equal(await page.locator('html').getAttribute('lang'),language);assert.equal(await page.locator('vite-error-overlay,nextjs-portal').count(),0);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1),'page overflow');}
const browser=await chromium.launch({headless:true,...(process.env.RDSH_CHROME_PATH?{executablePath:process.env.RDSH_CHROME_PATH}:{})});
report.environment.browser=browser.version();
try{
 const setup=await launch(binary,['setup','--web','--port','0'],/(http:\/\/127\.0\.0\.1:\d+\/)[\s\S]*?(?:token handoff file|トークン引き渡しファイル|令牌交接文件): ([^\r\n]+)/);handoffFiles.push(setup.tokenFile);assert.equal(new URL(setup.url).hash,'');
 const page=await pageFor(browser,setup.url);await page.locator('#token-box').waitFor({state:'visible'});await page.locator('#setup-token').fill((await readFile(setup.tokenFile,'utf8')).trim());await page.getByRole('button',{name:copy.connect}).click();await page.locator('#extras .row').first().waitFor();await check(page,/rdsh setup/);
 assert.equal(new URL(page.url()).hash,'');await page.locator('#extras .row').filter({hasText:'rdsh serve'}).click();
 await page.waitForFunction(value=>document.querySelector('#extras .row')?.textContent.includes(value),copy.enabled);
 assert.deepEqual(JSON.parse(await readFile(path.join(env.DSH_HOME,'rdsh.json'),'utf8')).extras.enable,['serve']);
 await page.reload();await page.waitForFunction(value=>document.querySelector('#extras .row')?.textContent.includes(value),copy.enabled);
 await screenshot(page,'setup-desktop');await page.setViewportSize(report.viewports[1]);await check(page,/rdsh setup/);await screenshot(page,'setup-mobile');
 const sharingFile=path.join(env.DSH_HOME,'rdsh-auth-sharing.json');await writeFile(sharingFile,'{broken policy');await page.evaluate(()=>load());
 const policyCopy={en:'invalid credential sharing policy; imports are disabled','zh-CN':'凭据共享策略无效；已禁用导入',ja:'認証情報の共有ポリシーが無効です。インポートは無効です'}[language];
 assert.ok((await page.locator('#sharehint').innerText()).includes(policyCopy));
 const rawPolicy=await page.evaluate(async()=>{const response=await fetch('/api/status',{headers:{'X-RDSH-Token':setupToken}});return(await response.json()).sharing.policy_error;});
 assert.equal(rawPolicy,'invalid credential sharing policy; imports are disabled');assert.equal(await readFile(sharingFile,'utf8'),'{broken policy');await screenshot(page,'setup-policy-error-mobile');await rm(sharingFile);await page.evaluate(()=>load());assert.ok(!(await page.locator('#sharehint').innerText()).includes(policyCopy));
 await page.close();await stop(setup.child);await rm(setup.tokenFile,{force:true});report.flows.push('setup: protected token handoff -> Extras enable -> file readback -> reload retained -> corrupt sharing policy localized with canonical API JSON -> repair');

 const session=path.join(env.DSH_HOME,'sessions','example','session-one');await mkdir(session,{recursive:true});await writeFile(path.join(session,'messages.jsonl'),'synthetic session');
 const skills=path.join(env.DSH_HOME,'skills','e2e-skill');await mkdir(skills,{recursive:true});await writeFile(path.join(skills,'SKILL.md'),'# Synthetic skill');
 const serve=await launch(binary,['serve','--port','0'],/(http:\/\/127\.0\.0\.1:\d+\/)[\s\S]*?(?:token handoff file|トークン引き渡しファイル|令牌交接文件): ([^\r\n]+)/);handoffFiles.push(serve.tokenFile);assert.equal(new URL(serve.url).hash,'');
 const native=await pageFor(browser,serve.url);await native.locator('#auth').waitFor({state:'visible'});await native.locator('#dashboard-token').fill((await readFile(serve.tokenFile,'utf8')).trim());await native.getByRole('button',{name:copy.connect}).click();await native.locator('#sess').filter({hasText:'session-one'}).waitFor();await check(native,new RegExp(copy.nativeTitle));
 await native.locator('#ttext').fill('abcd日本語');await native.getByRole('button',{name:copy.estimate,exact:true}).click();await native.waitForFunction(()=>document.querySelector('#tout').textContent.includes('4'));
 assert.ok((await native.locator('#tout').innerText()).includes(copy.tokens));
 assert.ok((await native.locator('#sess').innerText()).includes(copy.projects));
 assert.equal(await native.evaluate(()=>formatSessionTime('2026-10-14 00:01')),new Intl.DateTimeFormat(language,{timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',timeZoneName:'short'}).format(new Date('2026-10-14T00:01:00Z')));
 assert.equal(await native.evaluate(()=>formatSessionTime('-')),'-');
 await native.locator('#ptext').fill('START\n'+'日本語 context\n'.repeat(1000)+'END');await native.locator('#pmax').fill('100');await native.getByRole('button',{name:copy.prune,exact:true}).click();await native.locator('#pout').filter({hasText:'rdsh pruned'}).waitFor();
 assert.ok((await native.locator('#pout').innerText()).includes('START'));assert.ok((await native.locator('#pout').innerText()).includes('END'));
 await screenshot(native,'native-desktop');await native.reload();await native.locator('#sess').filter({hasText:'session-one'}).waitFor();await native.setViewportSize(report.viewports[1]);await check(native,new RegExp(copy.nativeTitle));await screenshot(native,'native-mobile');
 await native.close();await stop(serve.child);await rm(serve.tokenFile,{force:true});report.flows.push('native serve: protected token handoff -> tokens -> prune -> sessions -> reload retained');

 const {identity}=await import(pathToFileURL(path.join(repo,'dashboard/state.mjs')));
 const {readLocalRuntime}=await import(pathToFileURL(path.join(repo,'dashboard/private-runtime.mjs')));
 process.env.RDSH_DASHBOARD_HOME=env.RDSH_DASHBOARD_HOME;
 const {Client}=await import(pathToFileURL(path.join(repo,'dashboard/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')));
 const {StreamableHTTPClientTransport}=await import(pathToFileURL(path.join(repo,'dashboard/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js')));
 const project=path.join(root,'alpha');await mkdir(project);const identityAlpha=await identity(project);
 const dashboard=await launch(process.execPath,[path.join(repo,'dashboard/cli.mjs'),'project','--project',project,'--port',await freePort(),'--no-tailscale'],/project[^\n]*?(http:\/\/127\.0\.0\.1:\d+\/)/);
 const runtime=await readLocalRuntime(identityAlpha.directory);
 const client=new Client({name:'browser-e2e',version:'1.0.0'},{capabilities:{}});
 await client.connect(new StreamableHTTPClientTransport(new URL(runtime.local_url+'mcp'),{requestInit:{headers:{authorization:`Bearer ${runtime.mcp_token}`}}}));
 try{
 const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});assert.notEqual(result.isError,true);return result;};
 await call('dashboard_upsert_task',{id:'T1',title:'E2E task',status:'doing'});
 await call('dashboard_ask_question',{id:'Q1',question:'E2E: choose an answer',urgency:'high'});
 const projectPage=await pageFor(browser,runtime.browser_url);await projectPage.locator('#question-Q1 textarea').waitFor();await check(projectPage,new RegExp(copy.projectTitle));
 const updateSummary=projectPage.locator('#update-summary');
 await projectPage.waitForFunction(()=>document.querySelector('#update-summary-status')?.textContent.includes('初回確認'));
 await projectPage.evaluate(async()=>{
  const {createHumanMetricsPanel}=await import(new URL('/human-metrics-ui.mjs',location.href).href);
  const root=document.createElement('section');root.id='human-metrics-ui-regression';document.body.append(root);
  const calls=[];
  const metrics={enabled:true,retention_days:30,warning:null,coverage:{status:'observed',from:null,to:null,partial:false},decision_time:{status:'observed',sample_count:0,pending_count:0,unpaired_count:0,median_ms:null,total_ms:0},recovery_time:{status:'observed',sample_count:0,pending_count:0,unpaired_count:0,median_ms:null,total_ms:0},question_recurrence:{status:'observed',count:0},instruction_resend:{status:'observed',count:0},queue_revision_conflicts:{status:'observed',count:0},active_timer:null};
  const panel=createHumanMetricsPanel(root,{api:async(_route,input)=>{if(input)calls.push(input);return structuredClone(metrics);},node:(tag,text,className)=>{const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(className)element.className=className;return element;},confirm:()=>true});
  await panel.reload();panel.render({questions:[{id:'Q1',question:'Synthetic question',answer:null}],tasks:[{id:'T1',title:'Synthetic blocked task',status:'blocked'}],instructions:{requests:{C1:{command_id:'C1',text:'Synthetic instruction',mode:'normal',created_at:'2026-10-11T00:00:00.000Z'}}}});
  window.__humanMetricsRegression={calls};
 });
 const metricsPanel=projectPage.locator('#human-metrics-ui-regression');const metricSelects=metricsPanel.locator('select');
 for(const step of [
  {select:1,value:'Q1',button:'判断時間を計測開始',action:'start_decision_timer'},
  {select:2,value:'T1',button:'ブロック復旧の計測開始',action:'start_recovery_timer'},
  {select:3,value:'Q1',button:'質問の再発として記録',action:'mark_question_recurrence'},
  {select:4,value:'C1',button:'指示の再送として記録',action:'mark_instruction_resend'},
 ]){
  await metricSelects.nth(step.select).selectOption(step.value);
  const button=metricsPanel.getByRole('button',{name:step.button});assert.equal(await button.isEnabled(),true,`${step.button} should enable after selection`);
  await metricSelects.nth(step.select).selectOption('');assert.equal(await button.isDisabled(),true,`${step.button} should disable after clearing selection`);
  await metricSelects.nth(step.select).selectOption(step.value);assert.equal(await button.isEnabled(),true,`${step.button} should enable again after reselection`);
  await button.click();await projectPage.waitForFunction(action=>window.__humanMetricsRegression.calls.some(call=>call.action===action),step.action);
 }
 assert.deepEqual(await projectPage.evaluate(()=>window.__humanMetricsRegression.calls),[
  {action:'start_decision_timer',question_id:'Q1'},
  {action:'start_recovery_timer',task_id:'T1'},
  {action:'mark_question_recurrence',question_id:'Q1'},
  {action:'mark_instruction_resend',command_id:'C1'},
 ]);
 await metricsPanel.evaluate(element=>element.remove());report.flows.push('human metrics UI: selecting each action target enables its button and submits the selected id');
 await projectPage.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(runtime.local_url).origin});
 await projectPage.locator('#tasks-detail').evaluate(e=>e.open=true);
 await projectPage.locator('#task-T1').getByRole('button',{name:/認証情報を含まないリンクをコピー/}).click();
 await projectPage.locator('#task-T1').getByText('リンクをコピーしました。認証情報は含まれません。').waitFor();
 const taskLink=await projectPage.evaluate(()=>navigator.clipboard.readText());
 const taskLinkUrl=new URL(taskLink);assert.equal(taskLinkUrl.searchParams.get('rdsh_project'),identityAlpha.id);assert.equal(taskLinkUrl.searchParams.get('rdsh_kind'),'task');assert.equal(taskLinkUrl.searchParams.get('rdsh_id'),'T1');assert.equal(taskLinkUrl.hash,'');assert.equal(taskLinkUrl.searchParams.has('key'),false);
 await projectPage.locator('#question-Q1').getByRole('button',{name:/認証情報を含まないリンクをコピー/}).click();
 await projectPage.locator('#question-Q1').getByText('リンクをコピーしました。認証情報は含まれません。').waitFor();
 const questionLink=await projectPage.evaluate(()=>navigator.clipboard.readText());
 const questionLinkUrl=new URL(questionLink);assert.equal(questionLinkUrl.searchParams.get('rdsh_kind'),'question');assert.equal(questionLinkUrl.searchParams.get('rdsh_id'),'Q1');assert.equal(questionLinkUrl.hash,'');
 // Open the shareable target before pairing, then authenticate in another tab
 // on the same project origin. The navigation hint is restored from localStorage;
 // the copied URL itself contains no browser credential.
 const pairedContext=await browser.newContext({viewport:report.viewports[0],locale:'ja-JP'});contexts.push(pairedContext);
 const unauthenticatedPage=await pairedContext.newPage();await unauthenticatedPage.goto(taskLink);
 await unauthenticatedPage.waitForFunction(()=>localStorage.getItem('rdsh_pending_project_deep_link_v1')!==null);
 const pairedPage=await pairedContext.newPage();await pairedPage.goto(runtime.browser_url);await pairedPage.locator('#task-T1').waitFor();
 await pairedPage.waitForFunction(()=>document.querySelector('#tasks-detail')?.open&&document.activeElement?.id==='task-T1');
 await pairedPage.waitForTimeout(5200);assert.equal(await pairedPage.evaluate(()=>document.activeElement?.id==='task-T1'),true,'a same-revision refresh must preserve deep-link focus');
 assert.equal(new URL(pairedPage.url()).hash,'');assert.equal(new URL(pairedPage.url()).searchParams.has('rdsh_id'),false);
 assert.equal(await pairedPage.evaluate(()=>localStorage.getItem('rdsh_pending_project_deep_link_v1')),null);
 await pairedPage.setViewportSize(report.viewports[1]);await pairedPage.goto(questionLink);await pairedPage.locator('#question-Q1').waitFor();
 await pairedPage.waitForFunction(()=>document.activeElement?.id==='question-Q1');await check(pairedPage,new RegExp(copy.projectTitle));
 assert.equal(new URL(pairedPage.url()).hash,'');assert.equal(new URL(pairedPage.url()).searchParams.has('rdsh_id'),false);
 report.flows.push('project deep links: task/question URLs omit auth key; unauthenticated target resumes after pairing and opens exact task; mobile returns to exact question');
 const observedCli=projectPage.locator('#observed-cli-panel');
 assert.equal(await observedCli.count(),1,'the read-only CLI observation panel should remain in a workspace pane');
 assert.equal(await observedCli.locator('#observed-cli-form').count(),1,'the observation registration form should remain available');
 assert.equal(await observedCli.locator('#observed-cli-refresh').count(),1,'the observation refresh action should remain available');
 await observedCli.locator('summary').click();
 await observedCli.locator('#observed-cli-list').getByText(catalog[language]['observed.empty'],{exact:true}).waitFor();
 assert.equal(await observedCli.locator('#observed-cli-task option[value="T1"]').count(),1,'the panel should retain its task selector integration');
 const config=await projectPage.evaluate(async()=>{const token=sessionStorage.getItem('rdsh_project_browser_token');const response=await fetch('/api/config',{headers:{'x-rdsh-browser-token':token}});return response.json();});
 assert.equal(typeof config.project?.id,'string');
 const layoutKey=`rdsh:workspace-layout:v1:${encodeURIComponent(config.project.id)}`;
 assert.equal(await projectPage.locator('#workspace-grid').getAttribute('data-layout'),'3');
 await projectPage.getByLabel(catalog[language]['workspace.two']).check();
 assert.equal(await projectPage.locator('#workspace-grid').getAttribute('data-layout'),'2');
 assert.equal(await projectPage.evaluate(key=>localStorage.getItem(key),layoutKey),'2');
 await projectPage.evaluate(()=>localStorage.setItem('rdsh:workspace-layout:v1:another-project','1'));
 await projectPage.reload();await projectPage.locator('#question-Q1 textarea').waitFor();
 assert.equal(await projectPage.locator('#workspace-grid').getAttribute('data-layout'),'2','the layout should restore for the same project');
 await projectPage.locator('#workspace-grid').evaluate(e=>{const panes=[...e.querySelectorAll('.workspace-pane')];return panes.every(p=>p.id&&p.getAttribute('aria-labelledby')&&document.getElementById(p.getAttribute('aria-labelledby')))}).then(value=>assert.equal(value,true));
 const paneLink=projectPage.getByRole('navigation',{name:catalog[language]['workspace.navigate']}).getByRole('link',{name:catalog[language]['workspace.work']});
 await paneLink.focus();await projectPage.keyboard.press('Enter');
 assert.equal(await projectPage.evaluate(()=>document.activeElement.id),'workspace-work','keyboard pane navigation should focus its destination');
 await projectPage.setViewportSize(report.viewports[1]);
 const mobileColumns=await projectPage.locator('#workspace-grid').evaluate(e=>new Set([...e.querySelectorAll('.workspace-pane')].map(p=>Math.round(p.getBoundingClientRect().left))).size);
 assert.equal(mobileColumns,1,'narrow layouts should use one column');
 await check(projectPage,new RegExp(copy.projectTitle));
 await projectPage.setViewportSize(report.viewports[0]);
 await projectPage.locator('#device-detail').evaluate(e=>e.open=true);
 await projectPage.locator('#device-name').fill('E2E viewer');await projectPage.locator('#device-create').click();
 await projectPage.waitForFunction(()=>document.querySelector('#device-link')?.value.includes('#key=rdsh_dev_'));
 const viewerLink=await projectPage.locator('#device-link').inputValue();const viewerPage=await pageFor(browser,viewerLink);
 await viewerPage.locator('#question-Q1 textarea').waitFor();await viewerPage.locator('#device-access-notice').filter({hasText:'閲覧'}).waitFor();
 assert.equal(await viewerPage.locator('#question-Q1 textarea').isDisabled(),true);assert.equal(await viewerPage.locator('#question-Q1 button[type=submit]').isDisabled(),true);
 assert.equal(await viewerPage.locator('#share-toggle').isHidden(),true);assert.equal(await viewerPage.locator('#device-detail').isHidden(),true);
 await viewerPage.setViewportSize(report.viewports[1]);await check(viewerPage,new RegExp(copy.projectTitle));
 const viewerToken=await viewerPage.evaluate(()=>sessionStorage.getItem('rdsh_project_browser_token'));
 const deniedAnswer=await fetch(new URL('api/update/answer',viewerPage.url()),{method:'POST',headers:{'x-rdsh-browser-token':viewerToken,'content-type':'application/json'},body:JSON.stringify({id:'Q1',answer:'forged'})});
 assert.equal(deniedAnswer.status,403);
 await projectPage.locator('#device-list article').filter({hasText:'E2E viewer'}).getByRole('button',{name:'この端末を失効'}).waitFor();
 projectPage.once('dialog',dialog=>dialog.accept());await projectPage.locator('#device-list article').filter({hasText:'E2E viewer'}).getByRole('button',{name:'この端末を失効'}).click();
 await projectPage.locator('#device-list article').filter({hasText:'失効済み'}).waitFor();
 const revokedState=await fetch(new URL('api/state',viewerPage.url()),{headers:{'x-rdsh-browser-token':viewerToken}});
 assert.equal(revokedState.status,401);
 await viewerPage.close();
 await projectPage.locator('#question-Q1 textarea').fill('Keep this draft');
 beginQaCase('desktop.sse-draft');
 assert.equal(await projectPage.evaluate(()=>document.activeElement===document.querySelector('#question-Q1 textarea')),true);
 const stateUpdate=projectPage.waitForResponse(r=>r.url().endsWith('/api/state')&&r.status()===200);
 await call('dashboard_update_metrics',{input_tokens:1000,cached_input_tokens:500,tool_calls:10,tool_errors:0});await stateUpdate;
 assert.equal(await projectPage.locator('#question-Q1 textarea').inputValue(),'Keep this draft');
 assert.equal(await projectPage.evaluate(()=>document.activeElement===document.querySelector('#question-Q1 textarea')),true);
 await projectPage.waitForFunction(()=>document.querySelector('#update-summary-status')?.textContent.includes('1 件'));
 assert.match(await updateSummary.innerText(),/数値レポートが更新/);
 const browserToken=new URL(runtime.browser_url).hash.slice('#key='.length);
 const metricState=await fetch(runtime.local_url+'api/changes?after_revision=2',{headers:{'x-rdsh-browser-token':browserToken}}).then(r=>r.json());
 const metricRecord=metricState.records.findLast(record=>record.name==='dashboard.metrics.updated');
 assert.ok(metricRecord,'cursor endpoint should expose a redacted source record');
 assert.equal(metricState.revision,3);
 assert.equal('summary' in metricRecord,false,'raw free text must stay private');
 await updateSummary.locator('#update-summary-items button').filter({hasText:'元記録を開く'}).waitFor();
 await updateSummary.locator('#update-summary-items li').filter({hasText:'数値レポートが更新'}).getByRole('button',{name:'元記録を開く'}).click();
 assert.equal(await projectPage.locator('#change-records-detail').evaluate(e=>e.open),true);
 assert.equal(await projectPage.evaluate(id=>document.getElementById(`change-${id}`)?.textContent.includes(id),metricRecord.event_id),true,'summary source should navigate to the matching update event');
 await updateSummary.locator('#update-summary-mark-read').focus();
 const summaryFocusUpdate=projectPage.waitForResponse(r=>r.url().endsWith('/api/state')&&r.status()===200);
 await call('dashboard_update_metrics',{input_tokens:1500,cached_input_tokens:600,tool_calls:11,tool_errors:0});await summaryFocusUpdate;
 await projectPage.waitForFunction(()=>document.querySelector('#update-summary-status')?.textContent.includes('現在版 4'));
 assert.equal(await projectPage.evaluate(()=>document.activeElement.id),'update-summary-mark-read','summary refresh must preserve its active control');
 assert.match(await updateSummary.innerText(),/数値レポートが更新/);
 passQaCase('desktop.sse-draft','browser-results.json#qa_results.desktop.sse-draft');

 beginQaCase('desktop.command-palette');
 await projectPage.locator('#question-Q1 textarea').focus();
 assert.equal(await projectPage.evaluate(()=>document.activeElement===document.querySelector('#question-Q1 textarea')),true);
 await projectPage.keyboard.press('Control+k');
 assert.equal(await projectPage.locator('#palette').evaluate(e=>e.open),false,'Ctrl+K must not steal answer-form focus');
 assert.equal(await projectPage.evaluate(()=>document.activeElement===document.querySelector('#question-Q1 textarea')),true,'Ctrl+K must keep the answer-form focus');
 await projectPage.locator('#palette-toggle').click();
 const palette=projectPage.locator('#palette'),paletteSearch=projectPage.locator('#palette-search');
 await palette.waitFor({state:'visible'});
 assert.equal(await projectPage.locator('#palette-list [role="option"]').count(),5);
 assert.equal(await paletteSearch.getAttribute('aria-expanded'),'true');
 assert.equal(await paletteSearch.getAttribute('aria-activedescendant'),'palette-option-toggle-share');
 for(const composition of [{isComposing:true,keyCode:0},{isComposing:false,keyCode:229}]){
  await paletteSearch.evaluate(e=>e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'共有'})));
  for(const key of ['ArrowDown','ArrowUp','Escape','Enter']){
   const result=await paletteSearch.evaluate((e,{key,composition})=>{
    const snapshot=()=>({open:document.querySelector('#palette').open,active:e.getAttribute('aria-activedescendant'),expanded:e.getAttribute('aria-expanded'),focus:document.activeElement.id});
    const before=snapshot(),event=new KeyboardEvent('keydown',{key,...composition,bubbles:true,cancelable:true});
    e.dispatchEvent(event);return {before,after:snapshot(),prevented:event.defaultPrevented};
   },{key,composition});
   assert.deepEqual(result.after,result.before,`IME ${key} must leave the palette unchanged (${JSON.stringify(composition)})`);
   assert.equal(result.prevented,false,`IME ${key} must remain available for composition`);
  }
  await paletteSearch.evaluate(e=>e.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'共有'})));
 }
 await paletteSearch.fill('share');
 assert.equal(await projectPage.locator('#palette-list [role="option"]').count(),2);
 assert.equal(await projectPage.locator('#palette-count').getAttribute('role'),'status');
 await paletteSearch.press('ArrowDown');
 assert.equal(await paletteSearch.getAttribute('aria-activedescendant'),'palette-option-refresh-share');
 assert.equal(await projectPage.locator('#palette-list [aria-selected="true"]').count(),1);
 await paletteSearch.press('ArrowUp');
 await paletteSearch.fill('no such command');
 assert.equal(await projectPage.locator('#palette-list [role="option"]').count(),0);
 assert.equal(await paletteSearch.getAttribute('aria-activedescendant'),null);
 assert.equal(await projectPage.locator('#palette-count').innerText(),'該当なし');
 await paletteSearch.press('Enter');
 assert.equal(await palette.evaluate(e=>e.open),true,'Enter with no results must not run a command');
 await paletteSearch.press('Escape');
 await palette.waitFor({state:'hidden'});
 await projectPage.waitForFunction(()=>document.activeElement.id==='palette-toggle');
 await projectPage.waitForFunction(()=>document.querySelector('#palette-toggle').getAttribute('aria-expanded')==='false');
 assert.equal(await projectPage.evaluate(()=>document.activeElement.id),'palette-toggle');
 assert.equal(await projectPage.locator('#share').isHidden(),true,'Esc must cancel without running the selected command');
 assert.equal(await projectPage.locator('#palette-toggle').getAttribute('aria-expanded'),'false');

 await projectPage.keyboard.press('Control+k');
 await palette.waitFor({state:'visible'});
 assert.equal(await projectPage.evaluate(()=>document.activeElement.id),'palette-search');
 await paletteSearch.fill('answered');
 assert.equal(await projectPage.locator('#palette-list [role="option"]').count(),1,'English aliases should filter commands');
 assert.match(await projectPage.locator('#palette-count').innerText(),new RegExp(catalog[language]['palette.toggleAnswered']));
 const paletteUpdate=projectPage.waitForResponse(r=>r.url().endsWith('/api/state')&&r.status()===200);
 await call('dashboard_update_metrics',{input_tokens:2000,cached_input_tokens:700,tool_calls:11,tool_errors:0});await paletteUpdate;
 assert.equal(await paletteSearch.inputValue(),'answered');
 assert.equal(await paletteSearch.evaluate(e=>document.activeElement===e),true,'SSE must leave palette search focus intact');
 assert.equal(await palette.evaluate(e=>e.open),true,'SSE must not close the palette');
 await paletteSearch.press('Enter');
 await palette.waitFor({state:'hidden'});
 await projectPage.waitForFunction(()=>document.querySelector('#answered').open);
 await projectPage.waitForFunction(()=>document.activeElement.id==='palette-toggle');
 assert.equal(await projectPage.locator('#answered').evaluate(e=>e.open),true,'Enter should run the selected safe command');
 assert.equal(await projectPage.evaluate(()=>document.activeElement.id),'palette-toggle');
 await projectPage.locator('#palette-toggle').click();
 await paletteSearch.fill('未回答');
 assert.equal(await projectPage.locator('#palette-list [role="option"]').count(),1,'Japanese labels should filter commands');
 await paletteSearch.press('Enter');
 await palette.waitFor({state:'hidden'});
 await projectPage.waitForFunction(()=>document.activeElement.id==='pending-heading');
 assert.equal(await projectPage.evaluate(()=>document.activeElement.id),'pending-heading','navigation command should focus its destination');
 passQaCase('desktop.command-palette','browser-results.json#qa_results.desktop.command-palette');
 await projectPage.locator('#question-Q1 textarea').fill('E2E saved answer');await projectPage.locator('#question-Q1').getByRole('button',{name:copy.answer}).click();
 await projectPage.locator('#questions').filter({hasText:copy.empty}).waitFor();await projectPage.locator('#answered').evaluate(e=>e.open=true);await projectPage.locator('#answers').filter({hasText:'E2E saved answer'}).waitFor();
 await projectPage.waitForFunction(()=>document.querySelector('#update-summary-items')?.textContent.includes('質問への回答が保存'));
 await updateSummary.locator('#update-summary-mark-read').click();
 await projectPage.waitForFunction(()=>document.querySelector('#update-summary-status')?.textContent.includes('変更はありません'));
 assert.equal(await projectPage.evaluate(()=>document.activeElement.id),'update-summary-status');
 const summaryCheckpoint=await projectPage.evaluate(id=>JSON.parse(localStorage.getItem(`rdsh.update-summary.v1.${id}`)),identityAlpha.id);
 assert.deepEqual(Object.keys(summaryCheckpoint).sort(),['eventSequence','metricRecords','revision','schema','taskStates','timestamp']);
 assert.equal(summaryCheckpoint.revision,(await (await fetch(runtime.local_url+'api/state',{headers:{authorization:`Bearer ${runtime.token}`}})).json()).revision);
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
 await projectPage.locator('#question-Q2').getByRole('button',{name:copy.answer}).dblclick({delay:40});
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
 await projectPage.locator('#question-Q3').getByRole('button',{name:copy.answer}).click();
 await projectPage.waitForFunction(()=>Boolean(document.querySelector('#question-Q3 [role="alert"]')?.textContent));
 assert.equal(await projectPage.locator('#question-Q3 textarea').inputValue(),'Retry this draft after reconnecting');
 assert.equal((await readState()).questions.find(item=>item.id==='Q3').answer,null);
 await projectPage.context().setOffline(false);
 const retryResponse=projectPage.waitForResponse(response=>response.url().endsWith('/api/update/answer')&&response.request().postDataJSON()?.id==='Q3');
 await projectPage.locator('#question-Q3').getByRole('button',{name:copy.answer}).click();
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
 await projectPage.locator('#question-Q4').getByRole('button',{name:copy.answer}).click();
 await projectPage.locator('#answered').evaluate(e=>e.open=true);
 await projectPage.locator('#answers').filter({hasText:'Server committed before the response was lost'}).waitFor();
 await projectPage.unroute('**/api/update/answer');
 stateAfter=await readState();
 assert.equal(serverCommitted,true);
 assert.equal(stateAfter.questions.find(item=>item.id==='Q4').answer,'Server committed before the response was lost');
 assert.equal(stateAfter.feedback.filter(item=>item.question_id==='Q4'&&item.type==='question_answered').length,1);
 passQaCase('desktop.lost-response','browser-results.json#qa_results.desktop.lost-response');

 const alphaState=await readFile(path.join(identityAlpha.directory,'state.json'),'utf8');assert.ok(alphaState.includes('E2E saved answer'));
 await screenshot(projectPage,'project-desktop');await projectPage.setViewportSize(report.viewports[1]);await check(projectPage,new RegExp(copy.projectTitle));passQaCase('mobile.viewport','project-mobile.png');await screenshot(projectPage,'project-mobile');
 await projectPage.close();await client.close();await stop(dashboard.child);
 const restarted=await launch(process.execPath,[path.join(repo,'dashboard/cli.mjs'),'project','--project',project,'--port',await freePort(),'--no-tailscale'],/project[^\n]*?(http:\/\/127\.0\.0\.1:\d+\/)/);
 const fresh=await readLocalRuntime(identityAlpha.directory);
 assert.notEqual(fresh.browser_url,runtime.browser_url);
 const staleToken=new URL(runtime.browser_url).hash.slice('#key='.length);assert.equal((await fetch(fresh.local_url+'api/state',{headers:{'x-rdsh-browser-token':staleToken}})).status,401);
 const newPage=await pageFor(browser,fresh.browser_url);await newPage.locator('#tasks-detail').evaluate(e=>e.open=true);await newPage.locator('#task-T1').waitFor();await newPage.locator('#answered').evaluate(e=>e.open=true);await newPage.locator('#answers').filter({hasText:'E2E saved answer'}).waitFor();await check(newPage,new RegExp(copy.projectTitle));
 const persisted=await fetch(fresh.local_url+'api/state',{headers:{authorization:`Bearer ${fresh.token}`}});assert.equal(persisted.status,200);const persistedState=await persisted.json();assert.equal(persistedState.questions.find(item=>item.id==='Q1').answer,'E2E saved answer');assert.equal(persistedState.feedback.filter(item=>item.question_id==='Q1'&&item.type==='question_answered').length,1);
 passQaCase('desktop.answer-reload','browser-results.json#qa_results.desktop.answer-reload');await newPage.close();await stop(restarted.child);
 report.flows.push('project CLI: real MCP task/question -> preserved read-only CLI observation panel -> project-specific pane layout persistence, keyboard navigation and mobile one-column -> browser draft and focus preserved on SSE plus change summary -> command palette English/Japanese search, arrows, Enter, Escape, ARIA state and SSE resilience -> browser answer -> per-project summary checkpoint, MCP/file readback -> process restart retained answer and revoked old key');
 }finally{await client.close();}
 assert.deepEqual(report.page_errors,[]);assert.deepEqual(report.console_errors,[]);
 report.result='PASS';
}catch(error){report.result='FAIL';report.error=error.message;if(activeQaCase)report.qa_results.push({case_id:activeQaCase,status:'fail',mode:'browser',source_sha:report.source_sha,tested_at:new Date().toISOString(),reason:error.message,evidence_ref:'browser-results.json'});throw error;}finally{
 for(const context of contexts)await context.close();await browser.close();for(const child of children)await stop(child);for(const file of handoffFiles)await rm(file,{force:true});
 report.tested_at=new Date().toISOString();await writeFile(path.join(output,'browser-results.json'),JSON.stringify(report,null,2)+'\n');await writeQaMatrix(report,output);await rm(root,{recursive:true,force:true});
}
console.log(JSON.stringify({result:report.result,source_sha:report.source_sha,qa_results:report.qa_results,flows:report.flows,output},null,2));
