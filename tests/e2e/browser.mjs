// Real Rust servers and the project CLI/MCP in isolated directories.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

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
const root=await mkdtemp(path.join(tmpdir(),'rdsh-browser-e2e-'));
const env=Object.fromEntries(['PATH','SystemRoot','WINDIR','COMSPEC','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(env,{RDSH_LANG:language,HOME:root,USERPROFILE:root,DSH_HOME:path.join(root,'dsh'),XDG_CACHE_HOME:path.join(root,'cache'),XDG_CONFIG_HOME:path.join(root,'config'),XDG_DATA_HOME:path.join(root,'data'),RDSH_ORIG_BIN:path.join(root,'no-original'),RDSH_DASHBOARD_HOME:path.join(root,'projects-state')});
await mkdir(env.DSH_HOME);await mkdir(output,{recursive:true});
const children=new Set(); const contexts=[]; const handoffFiles=[]; const report={language,scope:'real Rust setup/serve and Node project CLI+HTTP MCP+browser; no model calls, Tailscale or Electron Desktop',browser:'Browser plugin not available; Playwright',viewports:[{width:1280,height:900},{width:390,height:844}],flows:[],page_errors:[],console_errors:[]};
function launch(command,args,pattern){
 const child=spawn(command,args,{env,cwd:root,stdio:['ignore','pipe','pipe']});children.add(child);
 return new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error('server readiness deadline exceeded')),20000);
 const read=b=>{text+=b;const match=text.match(pattern);if(match){clearTimeout(timer);resolve({child,url:match[1],tokenFile:match[2]?.trim()});}};
 child.stdout.on('data',read);child.stderr.on('data',read);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);if(!pattern.test(text))reject(new Error(`server exited ${code}`));});});
}
async function stop(child){if(child.exitCode!==null)return;await new Promise(resolve=>{const t=setTimeout(()=>{child.kill('SIGKILL');},5000);child.once('exit',()=>{clearTimeout(t);resolve();});child.kill('SIGTERM');});children.delete(child);}
async function pageFor(browser,url){const context=await browser.newContext({viewport:report.viewports[0],locale:language});contexts.push(context);const page=await context.newPage();page.on('pageerror',e=>report.page_errors.push(e.message));page.on('console',msg=>{if(msg.type()==='error')report.console_errors.push({text:msg.text(),path:msg.location().url?new URL(msg.location().url).pathname:''});});await page.goto(url);return page;}
async function screenshot(page,name){await page.evaluate(async()=>{window.scrollTo(0,0);await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});await page.screenshot({path:path.join(output,name+'.png'),fullPage:false});}
async function freePort(){const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise(resolve=>server.close(resolve));return String(port);}
async function check(page,title){assert.match(await page.title(),title);assert.ok((await page.locator('body').innerText()).trim().length>100);assert.equal(await page.locator('html').getAttribute('lang'),language);assert.equal(await page.locator('vite-error-overlay,nextjs-portal').count(),0);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1),'page overflow');}
const browser=await chromium.launch({headless:true,...(process.env.RDSH_CHROME_PATH?{executablePath:process.env.RDSH_CHROME_PATH}:{})});
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
 process.env.RDSH_DASHBOARD_HOME=env.RDSH_DASHBOARD_HOME;
 const {Client}=await import(pathToFileURL(path.join(repo,'dashboard/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')));
 const {StreamableHTTPClientTransport}=await import(pathToFileURL(path.join(repo,'dashboard/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js')));
 const project=path.join(root,'alpha');await mkdir(project);const identityAlpha=await identity(project);
 const dashboard=await launch(process.execPath,[path.join(repo,'dashboard/cli.mjs'),'project','--project',project,'--port',await freePort(),'--no-tailscale'],/(http:\/\/127\.0\.0\.1:\d+\/)/);
 const runtime=JSON.parse(await readFile(path.join(identityAlpha.directory,'runtime.json'),'utf8'));
 const client=new Client({name:'browser-e2e',version:'1.0.0'},{capabilities:{}});
 await client.connect(new StreamableHTTPClientTransport(new URL(runtime.local_url+'mcp'),{requestInit:{headers:{authorization:`Bearer ${runtime.mcp_token}`}}}));
 try{
 const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});assert.notEqual(result.isError,true);return result;};
 await call('dashboard_upsert_task',{id:'T1',title:'未取得',status:'doing'});
 await call('dashboard_ask_question',{id:'Q1',question:'未取得 — 日本語の原文を保持',urgency:'high'});
 const projectPage=await pageFor(browser,runtime.browser_url);await projectPage.locator('#question-Q1 textarea').waitFor();assert.ok((await projectPage.locator('#question-Q1').innerText()).includes('未取得 — 日本語の原文を保持'));await check(projectPage,new RegExp(copy.projectTitle));
 const {catalog}=await import(pathToFileURL(path.join(repo,'dashboard/locale.mjs')));
 await projectPage.locator('#palette-toggle').focus();await projectPage.locator('#palette-toggle').press('Enter');
 for(const [query, key, name] of [['手机','palette.toggleShare','zh-CN'],['切り替える','palette.toggleShare','ja'],['Toggle phone','palette.toggleShare','en'],['Refresh share connection','palette.refreshShare','refresh']]){
  await projectPage.locator('#palette-search').fill(query);
  assert.ok(await projectPage.locator('#palette-list').getByRole('button',{name:catalog[language][key],exact:true}).isVisible(),query);
  await screenshot(projectPage,'palette-'+name);
 }
 await projectPage.keyboard.press('Escape');
 await projectPage.waitForFunction(()=>document.querySelector('#palette-toggle')===document.activeElement);
 report.flows.push('palette: Chinese, Japanese and English queries find localized commands; Escape restores focus');
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
 await projectPage.locator('#question-Q1 textarea').fill('Keep this draft');
 const stateUpdate=projectPage.waitForResponse(r=>r.url().endsWith('/api/state')&&r.status()===200);
 await call('dashboard_update_metrics',{input_tokens:1000,cached_input_tokens:500,tool_calls:10,tool_errors:0});await stateUpdate;
 assert.equal(await projectPage.locator('#question-Q1 textarea').inputValue(),'Keep this draft');
 await projectPage.locator('#question-Q1 textarea').fill('E2E saved answer');await projectPage.locator('#question-Q1').getByRole('button',{name:copy.answer}).click();
 await projectPage.locator('#questions').filter({hasText:copy.empty}).waitFor();await projectPage.locator('#answered').evaluate(e=>e.open=true);await projectPage.locator('#answers').filter({hasText:'E2E saved answer'}).waitFor();
 const feedback=await client.callTool({name:'dashboard_get_feedback',arguments:{}});assert.notEqual(feedback.isError,true);assert.ok(feedback.content[0].text.includes('E2E saved answer'));
 const state=await fetch(runtime.local_url+'api/state',{headers:{authorization:`Bearer ${runtime.token}`}});assert.equal((await state.json()).questions[0].answer,'E2E saved answer');
 const alphaState=await readFile(path.join(identityAlpha.directory,'state.json'),'utf8');assert.ok(alphaState.includes('E2E saved answer'));
 await call('dashboard_ask_question',{id:'Q-cancel',question:'Original cancellation question 日本語',urgency:'high',decision:{kind:'consultation'}});
 const cancellation=projectPage.locator('#question-Q-cancel');
 await cancellation.getByRole('button',{name:catalog[language]['question.cancel'],exact:true}).click();
 await projectPage.waitForFunction(reason=>document.querySelector('#question-Q-cancel')?.textContent.includes(reason),catalog[language]['question.humanCancelled']);
 const cancelled=JSON.parse(await readFile(path.join(identityAlpha.directory,'state.json'),'utf8')).question_contracts.cards['Q-cancel'];
 assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.cancel_reason,catalog[language]['question.humanCancelled']);
 report.flows.push('cancellation: selected-language owned reason persisted through real authenticated HTTP; original question unchanged');
 await screenshot(projectPage,'project-desktop');await projectPage.setViewportSize(report.viewports[1]);await check(projectPage,new RegExp(copy.projectTitle));await screenshot(projectPage,'project-mobile');
 await projectPage.close();await client.close();await stop(dashboard.child);
 const restarted=await launch(process.execPath,[path.join(repo,'dashboard/cli.mjs'),'project','--project',project,'--port',await freePort(),'--no-tailscale'],/(http:\/\/127\.0\.0\.1:\d+\/)/);
 const fresh=JSON.parse(await readFile(path.join(identityAlpha.directory,'runtime.json'),'utf8'));
 assert.notEqual(fresh.browser_url,runtime.browser_url);
 const staleToken=new URL(runtime.browser_url).hash.slice('#key='.length);assert.equal((await fetch(fresh.local_url+'api/state',{headers:{'x-rdsh-browser-token':staleToken}})).status,401);
 const newPage=await pageFor(browser,fresh.browser_url);await newPage.locator('#tasks-detail').evaluate(e=>e.open=true);await newPage.locator('#task-T1').waitFor();await newPage.locator('#answered').evaluate(e=>e.open=true);await newPage.locator('#answers').filter({hasText:'E2E saved answer'}).waitFor();await check(newPage,new RegExp(copy.projectTitle));await newPage.close();await stop(restarted.child);
 report.flows.push('project CLI: workspace layout persistence/navigation plus  real MCP task/question -> browser draft preserved on SSE -> browser answer -> MCP/file readback -> process restart retained answer and revoked old key');
 }finally{await client.close();}
 assert.deepEqual(report.page_errors,[]);assert.deepEqual(report.console_errors,[]);
 report.result='PASS';
}catch(error){report.result='FAIL';report.error=error.message;throw error;}finally{
 for(const context of contexts)await context.close();await browser.close();for(const child of children)await stop(child);for(const file of handoffFiles)await rm(file,{force:true});
 await writeFile(path.join(output,'browser-results.json'),JSON.stringify(report,null,2)+'\n');await rm(root,{recursive:true,force:true});
}
console.log(JSON.stringify({result:report.result,flows:report.flows,output},null,2));
