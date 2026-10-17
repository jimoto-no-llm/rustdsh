// Real local criterion execution and multilingual outcome cards; no model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const repo=path.resolve(import.meta.dirname,'../..');
const {startDashboard}=await import(pathToFileURL(path.join(repo,'dashboard/server.mjs')));
const {createOutcomeProject}=await import(pathToFileURL(path.join(repo,'dashboard/test/fixtures/task-outcomes-project.mjs')));
const {catalog}=await import(pathToFileURL(path.join(repo,'dashboard/locale.mjs')));
// The public runtime.json carries no browser URL; the owner credentials do.
const {readLocalRuntime}=await import(pathToFileURL(path.join(repo,'dashboard/private-runtime.mjs')));
const {chromium}=await import(pathToFileURL(path.join(repo,'tests/e2e/node_modules/playwright/index.mjs')));
const recordFlow=process.env.RDSH_OUTCOME_RECORD_FLOW==='1';
const output=path.resolve(process.env.RDSH_OUTCOME_LANGUAGES_OUTPUT || path.join(repo,'target/e2e/outcome-languages'));await fs.mkdir(output,{recursive:true});
const root=await fs.mkdtemp(path.join(os.tmpdir(),'rdsh-outcome-languages-'));
const browser=await chromium.launch({headless:true,...(process.env.RDSH_CHROME_PATH ? {executablePath:process.env.RDSH_CHROME_PATH} : {})});
const report={scope:'real local HTTP+Chromium and actual synthetic criterion processes; no provider/model/Tailscale/production',cases:[],source_files:[]};
for(const name of ['dashboard/server.mjs','dashboard/task-outcomes-ui.mjs','dashboard/app.mjs','dashboard/locale.mjs','dashboard/ui.html'])report.source_files.push({path:name,sha256:createHash('sha256').update(await fs.readFile(path.join(repo,name))).digest('hex')});
try{
 for(const language of ['en','zh-CN','ja']){
  const f=await createOutcomeProject(path.join(root,language));const server=await startDashboard({project:f.project,port:0,tailscale:false,language});const context=await browser.newContext({locale:language,viewport:{width:1280,height:1000},...(recordFlow?{recordVideo:{dir:path.join(output,'video'),size:{width:1280,height:1000}}}:{})});
  const errors=[];const page=await context.newPage();const video=page.video();page.on('pageerror',e=>errors.push(e.message));
  try{
   const runtime=await readLocalRuntime(f.project.directory);await page.goto(runtime.browser_url);await page.locator('#tasks-detail').evaluate(e=>e.open=true);
   const task=page.locator('#task-goal');await task.waitFor();const copy=catalog[language];
   assert.equal(await page.locator('html').getAttribute('lang'),language);
   assert.ok((await task.innerText()).includes('必要な値と出力を提供する'));
   assert.ok((await task.innerText()).includes(copy['outcome.latest']));assert.ok((await task.innerText()).includes(copy['task.status.done']));
   if(recordFlow)await page.screenshot({path:path.join(output,`${language}-initial.png`)});
   await task.getByRole('button',{name:copy['outcome.check'],exact:true}).click();await task.getByText(copy['outcome.unmet'],{exact:false}).waitFor();
   assert.equal(await task.locator('.outcome-checks li').count(),2);
   if(recordFlow)await page.screenshot({path:path.join(output,`${language}-unmet.png`)});
   await f.run('value');await f.run('shape');await task.getByRole('button',{name:copy['outcome.refresh'],exact:true}).click();await task.getByText(copy['outcome.allVerified'],{exact:false}).waitFor();
   assert.equal(await task.getByText(copy['outcome.verified'],{exact:true}).count(),2);
   if(recordFlow)await page.screenshot({path:path.join(output,`${language}-verified.png`)});
   for(const [label,width,height] of [['desktop',1280,1000],['mobile',390,844]]){
    await page.setViewportSize({width,height});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await task.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,`${language}-${label}.png`)});
   }
   assert.deepEqual(errors,[]);report.cases.push({language,result:'PASS',criteria:2,real_checks:2,raw_Japanese_preserved:true,viewports:2,page_errors:errors,...(recordFlow?{video:`${language}-outcome-flow.webm`}:{})});
  }finally{await context.close();if(video)await video.saveAs(path.join(output,`${language}-outcome-flow.webm`));await server.close();}
 }
 report.result='PASS';await fs.writeFile(path.join(output,'results.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await browser.close();await fs.rm(root,{recursive:true,force:true});}
