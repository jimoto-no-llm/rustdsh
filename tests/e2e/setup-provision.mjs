// Real setup HTML/JS with synthetic API responses. No model or credential access.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const artifacts = resolve(process.env.RDSH_SETUP_EVIDENCE || 'target/e2e/setup-provision');
await mkdir(artifacts, {recursive: true});
const html = (await readFile('src/setup.html', 'utf8')).replaceAll('__RDSH_LOCALE__', 'ja');
const before = execFileSync('git', ['show', 'HEAD:src/setup.html'], {encoding:'utf8'}).replaceAll('__RDSH_LOCALE__', 'ja');
const js = await readFile('src/setup-provision.js', 'utf8');
const server = createServer((req, res) => {
  if (req.url === '/icon.png') { readFile('assets/icon-256.png').then(data => {res.setHeader('Content-Type','image/png');res.end(data);}); return; }
  res.setHeader('Content-Type', req.url === '/setup-provision.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/setup-provision.js' ? js : req.url === '/before' ? before : html);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {})});
let checks = 0;
try {
  const context = await browser.newContext({viewport:{width:1280,height:960}, reducedMotion:'reduce'});
  await context.addInitScript(() => sessionStorage.setItem('rdsh_setup_token','fixture-only'));
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let ready = false, posts = [], selected = null, job = {}, choices = [], connected = false;
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    let response = {};
    if (path === '/api/status') response = {needed:!connected, defaults:[], refs_stored:[], records:[], sharing:{inventory:[]}};
    if (path === '/api/env') response = {rdsh:'0.15.0', node:{found:ready,supported:ready},pnpm:ready,dsh:{found:ready},codex:false,opencode:false};
    if (path === '/api/provision') {
      if (req.method() === 'POST') {
        const body = req.postDataJSON(); posts.push(body);
        if (body.action === 'cancel') job = {...job,running:false,error:'CANCELLED',phase:'failed'};
        else job = {running:true,phase:'preparing',action:body.action};
      }
      response = {job,selected,choices};
    }
    if (path === '/api/extras') response = {enable:[]};
    await route.fulfill({json:response});
  });
  await page.goto(`${base}/before`);
  await page.waitForSelector('#step-ready:not([hidden])');
  await page.screenshot({path:resolve(artifacts,'before-ready.png'),fullPage:true});
  await page.goto(base);
  const prepare = page.getByRole('button',{name:'必要なものを自動で準備',exact:true});
  await prepare.waitFor();
  assert.equal(await page.locator('#ready-next').isDisabled(),true); checks++;
  await page.screenshot({path:resolve(artifacts,'after-ready.png'),fullPage:true});
  await prepare.click();
  await page.waitForFunction(() => document.querySelector('.provision-progress:not([hidden])'));
  assert.equal(posts.length,1); assert.equal(posts[0].action,'runtime'); checks++;
  assert.equal(await prepare.isDisabled(),true); checks++;
  job={running:true,phase:'ollama-download',completed:50000000,total:100000000};
  await page.waitForFunction(() => document.querySelector('progress').value===50000000);
  assert.equal(await page.locator('progress').getAttribute('tabindex'),null); checks++;
  await page.getByRole('button',{name:'準備を中止',exact:true}).click();
  await page.getByRole('button',{name:'もう一度試す',exact:true}).waitFor();
  assert.equal(posts.at(-1).action,'cancel'); checks++;
  await page.getByRole('button',{name:'もう一度試す',exact:true}).click();
  assert.equal(posts.at(-1).action,'runtime'); checks++;
  ready=true; job={running:false,ready:true,phase:'complete',action:'runtime'};
  await page.waitForFunction(() => !document.getElementById('ready-next').disabled);
  await page.locator('#ready-next').click();
  await page.locator('.local-choice').waitFor({state:'visible'});
  await page.screenshot({path:resolve(artifacts,'after-models.png'),fullPage:true});
  await page.locator('#local-model-0').check();
  await page.getByRole('button',{name:'このモデルを自動で準備',exact:true}).click();
  assert.deepEqual(posts.at(-1),{action:'local-model',model:'qwen3:1.7b'}); checks++;
  job={running:true,phase:'model-download',completed:350000000,total:1400000000};
  await page.waitForFunction(() => document.querySelector('progress').value===350000000);
  await page.screenshot({path:resolve(artifacts,'after-progress.png'),fullPage:true});
  selected={provider:'rdsh-local',model:'qwen3:1.7b',profiles:['web','tui']};
  job={running:false,ready:true,phase:'complete',action:'local-model'};
  await page.waitForSelector('#step-finish:not([hidden])');
  assert.match(await page.locator('#model-line').textContent(),/qwen3:1.7b/); checks++;
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:resolve(artifacts,'after-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth),true); checks++;
  // Existing accounts choose a catalog model automatically, preserving profile scope.
  posts=[]; selected=null; job={}; connected=true;
  choices=[{provider:'openai-codex',model:'fixture-mini',profiles:['web']}];
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.provision-progress:not([hidden])'));
  assert.deepEqual(posts,[{action:'select',provider:'openai-codex',model:'fixture-mini'}]); checks++;
  selected={...choices[0]};job={running:false,ready:true,phase:'complete',action:'select'};
  await page.waitForFunction(() => document.querySelector('#model-line').textContent.includes('fixture-mini'));
  assert.equal(await page.getByRole('button',{name:'ターミナルで会話をはじめる',exact:true}).count(),0); checks++;
  assert.deepEqual(errors,[]); checks++;
  console.log(`PASS: ${checks} setup UX checks; desktop/mobile screenshots: ${artifacts}`);
  await context.close();
} finally { await browser.close(); await new Promise(r=>server.close(r)); }
