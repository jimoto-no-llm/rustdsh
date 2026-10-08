// Optional integration with an installed original DSH, never a user profile.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const exec=promisify(execFile);
const repo=path.resolve(import.meta.dirname,'../..');
const original=process.env.RDSH_HARNESS_BIN;
assert.ok(original,'Set RDSH_HARNESS_BIN to the installed original DSH CLI; no credentials needed');
const {chromium}=await import(process.env.RDSH_PLAYWRIGHT_MODULE || 'playwright');
const root=await mkdtemp(path.join(tmpdir(),'rdsh-harness-e2e-'));
const output=path.resolve(process.env.RDSH_E2E_OUTPUT || path.join(repo,'target/harness-e2e'));
const settings=path.join(root,'dsh/rdsh.json');
await mkdir(path.join(root,'dsh'));await mkdir(output,{recursive:true});
const env=Object.fromEntries(['PATH','SystemRoot','WINDIR','COMSPEC','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(env,{HOME:root,USERPROFILE:root,DSH_HOME:path.join(root,'dsh'),XDG_CACHE_HOME:path.join(root,'cache'),XDG_CONFIG_HOME:path.join(root,'config'),XDG_DATA_HOME:path.join(root,'data')});
let child,browser;
const report={functional_result:'FAIL',mobile_accepted:false,scope:'original DSH Web profile settings flow, not Electron Desktop GUI or model response',viewports:[{width:1280,height:900},{width:390,height:844}],page_errors:[],console_errors:[],settings_requests:[]};
try{
 report.original_version=(await exec(original,['--version'],{env,cwd:root,timeout:15000})).stdout.trim();
 await exec(original,['plugin','--profile','web','add',path.join(repo,'plugins/rdsh-settings')],{env,cwd:root,timeout:60000});
 await writeFile(settings,JSON.stringify({extras:{enable:['serve']},context:{goal:'Before E2E'}}));
 child=spawn(original,['--profile','web','--host','127.0.0.1','--port','0','--no-open'],{env,cwd:root,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
 const url=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error('DSH Web readiness deadline exceeded')),30000);const read=b=>{text+=b;const m=text.match(/dsh web: (\S+)/);if(m){clearTimeout(timer);resolve(m[1]);}};child.stdout.on('data',read);child.stderr.on('data',read);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',()=>{clearTimeout(timer);if(!text.match(/dsh web: (\S+)/))reject(new Error('DSH exited before readiness'));});});
 browser=await chromium.launch({headless:true,...(process.env.RDSH_CHROME_PATH?{executablePath:process.env.RDSH_CHROME_PATH}:{})});
 const context=await browser.newContext({viewport:report.viewports[0],locale:'en-US'});const page=await context.newPage();
 page.on('pageerror',e=>report.page_errors.push(e.message));page.on('console',m=>{if(m.type()==='error')report.console_errors.push(m.text());});page.on('response',r=>{if(r.url().includes('/rdsh-settings'))report.settings_requests.push({method:r.request().method(),status:r.status()});});
 await page.goto(url);await page.getByRole('button',{name:'Settings',exact:true}).waitFor();
 // Do not supply a provider credential: dismiss only fixture onboarding.
 const notice=page.getByRole('button',{name:'Continue',exact:true});
 const later=page.getByRole('button',{name:'Configure later',exact:true});
 await notice.or(later).first().waitFor({timeout:15000});
 if(await notice.isVisible())await notice.click();
 await later.waitFor({timeout:15000});await later.click();
 await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'rdsh',exact:true}).click();
 const section=page.locator('.rdsh-settings');const goal=section.getByPlaceholder('例: dsh互換性を維持する');await goal.waitFor();
 await goal.fill('Genuine DSH plugin E2E');await section.getByText('ポート',{exact:true}).locator('..').locator('input').fill('');
 await section.getByRole('button',{name:'保存する',exact:true}).click();await section.locator('.rdsh-msg').filter({hasText:'保存しました'}).waitFor();
 const saved=JSON.parse(await readFile(settings,'utf8'));assert.equal(saved.context.goal,'Genuine DSH plugin E2E');assert.equal(saved.serve.port,38080);assert.deepEqual(saved.extras.enable,['serve']);
 await section.getByRole('button',{name:'再読み込み',exact:true}).click();await goal.waitFor();assert.equal(await goal.inputValue(),'Genuine DSH plugin E2E');
 await goal.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'harness-settings-saved.png')});
 await writeFile(settings,'{broken');await section.getByRole('button',{name:'再読み込み',exact:true}).click();await page.getByRole('alert').filter({hasText:'設定ファイルを読み込めません'}).waitFor();assert.equal(await page.getByRole('button',{name:'保存する',exact:true}).count(),0);
 await page.screenshot({path:path.join(output,'harness-settings-error.png')});
 await writeFile(settings,JSON.stringify(saved));await page.getByRole('button',{name:'再読み込み',exact:true}).click();await goal.waitFor();assert.equal(await goal.inputValue(),'Genuine DSH plugin E2E');
 await page.setViewportSize(report.viewports[1]);await page.screenshot({path:path.join(output,'harness-settings-mobile.png')});
 report.mobile_content_width=await section.evaluate(e=>e.getBoundingClientRect().width);
 report.mobile_readability=report.mobile_content_width>=240?'requires visual review':'FAIL: upstream DSH settings navigation compresses the content area';
 assert.deepEqual(report.page_errors,[]);assert.ok(report.console_errors.every(m=>m.includes('400 (Bad Request)')));
 assert.equal(report.settings_requests.filter(x=>x.status===400).length,1);
 report.functional_result='PASS';report.flow='Settings -> rdsh -> edit -> save -> file readback -> reload -> corrupt -> API400/error -> repair -> retry';report.port_verified=38080;report.extras_retained=true;
}catch(e){report.error=e.message;throw e;}finally{
 if(browser)await browser.close();
 if(child && child.exitCode===null){
  const stopped=new Promise(resolve=>{const timer=setTimeout(()=>{if(process.platform==='win32')child.kill();else try{process.kill(-child.pid,'SIGKILL');}catch{}},5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
  if(process.platform==='win32')await exec('taskkill.exe',['/PID',String(child.pid),'/T','/F']).catch(()=>{});
  else try{process.kill(-child.pid,'SIGTERM');}catch{}
  await stopped;
 }
 await writeFile(path.join(output,'harness-results.json'),JSON.stringify(report,null,2)+'\n');await rm(root,{recursive:true,force:true});
}
console.log(JSON.stringify({functional_result:report.functional_result,mobile_accepted:report.mobile_accepted,mobile_readability:report.mobile_readability,output},null,2));
