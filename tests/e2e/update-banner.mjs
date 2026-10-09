import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { apply } from '../../plugins/rdsh-update-banner/index.js';
import { setTimeout as sleep } from 'node:timers/promises';

const repo = path.resolve(import.meta.dirname, '../..');
const output = path.resolve(process.env.RDSH_UPDATE_E2E_OUTPUT || path.join(repo, 'target/e2e/update-banner'));
const root = await mkdtemp(path.join(os.tmpdir(), 'rdsh-update-browser-'));
const previousHome = process.env.HOME, previousProfile = process.env.USERPROFILE;
process.env.HOME = root; process.env.USERPROFILE = root;
assert.equal(os.homedir(), root, 'All update state must use the temporary HOME');
const stateFile = path.join(root, '.local/share/rdsh/update-state.json');
await mkdir(path.dirname(stateFile), { recursive: true }); await mkdir(output, { recursive: true });
const START = Date.now(), PERIOD = 7200000;
const state = (to = 'DUMMY-v-next', extra = {}) => ({ updated: true, kind: 'rustdsh', from: 'DUMMY-v-old', to, at: START, ...extra });
const setState = async (value) => { await writeFile(stateFile + '.tmp', JSON.stringify(value)); await rename(stateFile + '.tmp', stateFile); };
const clientFile = path.join(repo, 'plugins/rdsh-update-banner/client.js');
const baseline = process.env.RDSH_UPDATE_BASELINE_CLIENT;
const report = { result: 'FAIL', scope: 'Actual React banner and authenticated plugin routes in two isolated loopback hosts; dummy HOME; no production DSH restart or updater execution', flows: [], page_errors: [], console_errors: [] };
const servers = [], disposers = [], bundles = new Map(); let browser;

async function bundle(file) {
  const result = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      let root = createRoot(document.getElementById('app'));
      window.__ModuleLoader__={load(item){const plugin=item.factory(name=>{if(name==='react')return React;throw new Error(name)});
      plugin.apply({slots:{inject(_name,fn){fn()},register(_definition,Component){root.render(React.createElement(Component));
      window.remountProject=()=>{root.unmount();root=createRoot(document.getElementById('app'));root.render(React.createElement(Component));};}}});}};
      import(${JSON.stringify(file)});`, resolveDir: import.meta.dirname, loader: 'js' },
    bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"' },
  });
  return result.outputFiles[0].contents;
}
async function host() {
  const routes = new Map();
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (routes.has(pathname)) return await routes.get(pathname)(req, res);
      if (pathname === '/client.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundles.get(req.url.includes('before') ? 'before' : 'after')); return;
      }
      if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Update notification verification</title></head>
        <body style="margin:0;background:#101014;color:#a0a0a8;font:16px system-ui">
        <main style="padding:220px 48px"><h1>Update notification verification</h1>
        <p>Real rdsh component and API · isolated dummy update · project A/B</p>
        <button id="project" onclick="window.remountProject()">Switch project</button></main>
        <div id="app"></div><script src="/client.js?${pathname.includes('before') ? 'before' : 'after'}"></script></body></html>`);
    } catch { if (!res.headersSent) res.writeHead(500); res.end('fixture request failed'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  disposers.push(apply({ effect: (f) => f(), connection: { requestRejection(req) {
    if (!req.headers.cookie?.includes('fixture-session=DUMMY_AUTH')) return 401;
    if (`http://${req.headers.host}` !== origin || (req.headers.origin && req.headers.origin !== origin)) return 403;
  } }, webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } } }, {}));
  return origin;
}
async function context(origin, { storageFails = false } = {}) {
  const c = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  await c.addCookies([{ name: 'fixture-session', value: 'DUMMY_AUTH', url: origin }]);
  if (storageFails) await c.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage disabled'); } }));
  c.on('page', (p) => {
    p.on('pageerror', (e) => report.page_errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') report.console_errors.push(m.text()); });
  });
  await c.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  return c;
}
const banner = (page) => page.getByTestId('rdsh-update');
async function closeBanner(page, button = 'dismiss') {
  const ack = page.waitForResponse((r) => r.url().endsWith('/api/rdsh-update/dismiss') && r.request().method() === 'POST');
  await page.getByRole('button', { name: button, exact: true }).click(); assert.equal((await ack).status(), 200);
  await banner(page).waitFor({ state: 'hidden' });
}
async function hidden(page) { await sleep(100); assert.equal(await banner(page).count(), 0); }
async function ready(page, url) {
  const bootstrap = page.waitForResponse((r) => r.url().endsWith('/api/rdsh-update') && r.request().method() === 'GET');
  const stream = page.waitForResponse((r) => r.url().endsWith('/api/rdsh-update/events'));
  await page.goto(url); assert.equal((await bootstrap).status(), 200); assert.equal((await stream).status(), 200); await sleep(100);
}
try {
  bundles.set('after', await bundle(clientFile)); if (baseline) bundles.set('before', await bundle(path.resolve(baseline)));
  const origin = await host(), otherOrigin = await host();
  for (const route of ['/api/rdsh-update', '/api/rdsh-update/events']) {
    assert.equal((await fetch(origin + route)).status, 401);
    assert.equal((await fetch(origin + route, { headers: { cookie: 'fixture-session=DUMMY_AUTH', origin: 'https://DUMMY.invalid' } })).status, 403);
  }
  report.flows.push('State and event routes reject unauthenticated and foreign-Origin requests');
  browser = await chromium.launch({ headless: true, ...(process.env.RDSH_CHROME_PATH ? { executablePath: process.env.RDSH_CHROME_PATH } : {}) });
  if (baseline) {
    await setState({ updated: false });
    const old = await context(origin), page = await old.newPage(); await page.clock.install({ time: new Date(START - 1000) }); await page.clock.pauseAt(new Date(START));
    const loaded = page.waitForResponse((r) => r.url().endsWith('/api/rdsh-update'));
    await page.goto(origin + '/before'); await loaded; await sleep(100);
    await setState(state()); await sleep(300); await hidden(page);
    await page.screenshot({ path: path.join(output, 'before.png'), animations: 'disabled' });
    report.before = 'Baseline client receives no live update and stays hidden until reload or its 60-second poll';
    await page.reload(); await banner(page).waitFor(); await closeBanner(page); await page.reload(); await hidden(page);
    report.flows.push('Baseline: no immediate notification; permanent dismissal also suppressed reload'); await old.close();
  }
  await setState({ updated: false });
  const c = await context(origin), a = await c.newPage(), b = await c.newPage();
  await a.clock.install({ time: new Date(START - 1000) }); await a.clock.pauseAt(new Date(START)); await ready(a, origin + '/project/a'); await hidden(a);
  const detectionStarted = Date.now(); await setState(state()); await banner(a).waitFor();
  report.live_notification_ms = Date.now() - detectionStarted;
  assert.ok(report.live_notification_ms < 2000, 'Live update must arrive without waiting for the five-second fallback');
  await a.screenshot({ path: path.join(output, 'after.png'), animations: 'disabled' });
  report.flows.push('File update pushes to an open page without reload or polling');
  await ready(b, origin + '/project/b'); await banner(b).waitFor();
  const different = await context(otherOrigin), remote = await different.newPage();
  await ready(remote, otherOrigin + '/project/other'); await banner(remote).waitFor();
  await closeBanner(a, 'close'); await banner(b).waitFor({ state: 'hidden' }); await banner(remote).waitFor({ state: 'hidden' });
  await a.screenshot({ path: path.join(output, 'dismissed.png'), animations: 'disabled' });
  report.flows.push('Close propagates to another tab and another independent GUI host without reloading');
  await a.getByRole('button', { name: 'Switch project', exact: true }).click(); await hidden(a);
  await ready(a, origin + '/project/a'); await banner(a).waitFor(); await closeBanner(a);
  await a.clock.fastForward(PERIOD - 1); await hidden(a);
  await a.clock.runFor(1); await banner(a).waitFor();
  await a.screenshot({ path: path.join(output, 'reminder.png'), animations: 'disabled' });
  report.flows.push('Project remount keeps closed; full reload shows; exact two-hour boundary shows again');
  await closeBanner(a); await a.clock.fastForward(3600000); await hidden(a);
  await ready(a, origin + '/project/a'); await banner(a).waitFor(); await closeBanner(a);
  await a.clock.fastForward(3599999); await hidden(a); await a.clock.runFor(1); await banner(a).waitFor();
  report.flows.push('Reload and Dismiss midway through the next period preserve the original repeat cadence');
  await a.locator('.rub-row1').click(); await a.locator('.rub-mini').waitFor();
  await a.clock.fastForward(PERIOD); await a.locator('.rub-card').waitFor();
  report.flows.push('Minimize/expand retained; the next reminder opens the full card');
  await closeBanner(a); await setState(state('DUMMY-v-new', { at: START + 1 })); await banner(a).waitFor();
  await closeBanner(a); await setState(state('DUMMY-v-new', { at: START + 2 })); await banner(a).waitFor();
  report.flows.push('A new version or a new update time notifies immediately after closing the previous occurrence');
  await a.evaluate(() => {
    localStorage.setItem('rdsh-update-dismissed', JSON.stringify({ key: 'DUMMY-v-new@1', at: 1 }));
    localStorage.setItem('rdsh-update-dismissed:v2:["rustdsh","DUMMY-v-new"]', '1');
  });
  await ready(a, origin + '/project/a'); await banner(a).waitFor();
  report.flows.push('Old permanent dismissal records cannot suppress the requested new notification behavior');
  const denied = await context(origin, { storageFails: true }), d = await denied.newPage();
  await ready(d, origin + '/project/no-storage'); await banner(d).waitFor(); await closeBanner(d);
  await d.getByRole('button', { name: 'Switch project', exact: true }).click(); await hidden(d);
  await ready(d, origin + '/project/no-storage'); await banner(d).waitFor();
  report.flows.push('Disabled browser storage still supports close, project remount suppression, and reload notification');
  await d.screenshot({ path: path.join(output, 'reload.png'), animations: 'disabled' });
  assert.deepEqual(report.page_errors, []); assert.deepEqual(report.console_errors, []); report.result = 'PASS';
} catch (error) { report.error = error.message; throw error; }
finally {
  if (browser) await browser.close(); for (const dispose of disposers) dispose();
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
  await writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n'); await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ result: report.result, flows: report.flows.length, live_notification_ms: report.live_notification_ms, output }, null, 2));
