// Real banner/React and plugin HTTP routes in an isolated browser host.
// No agent loop, user profile, real updater, provider, or external network.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { apply } from '../../plugins/rdsh-update-banner/index.js';
import { setTimeout as sleep } from 'node:timers/promises';

const repo = path.resolve(import.meta.dirname, '../..');
const output = path.resolve(process.env.RDSH_UPDATE_E2E_OUTPUT || path.join(repo, 'target/e2e/update-banner'));
const root = await mkdtemp(path.join(os.tmpdir(), 'rdsh-update-browser-'));
const previousHome = process.env.HOME;
const previousProfile = process.env.USERPROFILE;
process.env.HOME = root;
process.env.USERPROFILE = root;
assert.equal(os.homedir(), root, 'All update state must use the temporary HOME');
const stateFile = path.join(root, '.local/share/rdsh/update-state.json');
await mkdir(path.dirname(stateFile), { recursive: true });
await mkdir(output, { recursive: true });
const state = (to = 'DUMMY-v-next', extra = {}) => ({ updated: true, kind: 'rustdsh', from: 'DUMMY-v-old', to, at: 1700000000000, ...extra });
const setState = (value) => writeFile(stateFile, JSON.stringify(value));
const clientFile = path.join(repo, 'plugins/rdsh-update-banner/client.js');
const baseline = process.env.RDSH_UPDATE_BASELINE_CLIENT;
const report = { result: 'FAIL', scope: 'Actual React banner and authenticated plugin routes in isolated loopback hosts; not a production DSH restart', flows: [], page_errors: [], console_errors: [] };
const servers = [], routes = new Map(), bundles = new Map();
let browser;

async function bundle(file) {
  const result = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      const originalFetch=window.fetch.bind(window); window.__updateLoads=0;window.__updatePending=0;
      window.fetch=async(...args)=>{const loading=args[0]==='/api/rdsh-update';if(loading)window.__updatePending++;
      const r=await originalFetch(...args);if(loading){const json=r.json.bind(r);r.json=async()=>{try{return await json();}
      finally{window.__updatePending--;window.__updateLoads++;}};}return r;};
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
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (routes.has(pathname)) return await routes.get(pathname)(req, res);
      if (pathname === '/client.js') {
        const body = bundles.get(req.url.includes('before') ? 'before' : 'after');
        res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(body); return;
      }
      if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Update dismissal browser verification</title></head>
        <body style="margin:0;background:#101014;color:#a0a0a8;font:16px system-ui">
        <main style="padding:220px 48px"><h1>Update notification verification</h1>
        <p>Real rdsh component and API · isolated dummy update · project A/B</p>
        <button id="project" onclick="window.remountProject()">Switch project</button></main>
        <div id="app"></div><script src="/client.js?${pathname.includes('before') ? 'before' : 'after'}"></script></body></html>`);
    } catch (error) { res.writeHead(500); res.end('fixture request failed'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
async function context(origin, { storageFails = false } = {}) {
  const c = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  await c.addCookies([{ name: 'fixture-session', value: 'DUMMY_AUTH', url: origin }]);
  if (storageFails) await c.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage disabled'); } }));
  c.on('page', (p) => {
    p.on('pageerror', (e) => report.page_errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') report.console_errors.push(m.text()); });
  });
  await c.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  return c;
}
async function closeBanner(page, button) {
  const ack = page.waitForResponse((r) => r.url().endsWith('/api/rdsh-update/dismiss') && r.request().method() === 'POST');
  await page.getByRole('button', { name: button, exact: true }).click();
  assert.equal((await ack).status(), 200);
  await page.getByTestId('rdsh-update').waitFor({ state: 'hidden' });
}
async function hidden(page) {
  // Playwright's browser clock also freezes its network-idle timer. Wait for
  // actual JSON loading from the Node test clock instead of relying on idle.
  const deadline = Date.now() + 5000;
  while (!await page.evaluate(() => window.__updateLoads > 0 && window.__updatePending === 0)) {
    assert.ok(Date.now() < deadline, 'Update response did not settle');
    await sleep(20);
  }
  await sleep(30);
  assert.equal(await page.getByTestId('rdsh-update').count(), 0);
}
try {
  bundles.set('after', await bundle(clientFile));
  if (baseline) bundles.set('before', await bundle(path.resolve(baseline)));
  const origin = await host(), otherOrigin = await host();
  apply({ effect: (f) => f(), connection: { requestRejection(req) {
    if (!req.headers.cookie?.includes('fixture-session=DUMMY_AUTH')) return 401;
    const expected = `http://${req.headers.host}`;
    if (![origin, otherOrigin].includes(expected) || (req.headers.origin && req.headers.origin !== expected)) return 403;
  } }, webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } } }, {});
  browser = await chromium.launch({ headless: true, ...(process.env.RDSH_CHROME_PATH ? { executablePath: process.env.RDSH_CHROME_PATH } : {}) });
  await setState(state());
  if (baseline) {
    const old = await context(origin), page = await old.newPage(); await page.clock.install();
    await page.goto(origin + '/before'); await page.getByTestId('rdsh-update').waitFor();
    await page.getByRole('button', { name: 'dismiss', exact: true }).click();
    await page.getByTestId('rdsh-update').waitFor({ state: 'hidden' });
    await setState(state('DUMMY-v-next', { at: 1700000000001 }));
    await page.clock.runFor(61000); await page.getByTestId('rdsh-update').waitFor();
    await page.screenshot({ path: path.join(output, 'before.png'), animations: 'disabled' });
    report.before = 'Same target with a changed timestamp reappears on the next poll';
    await old.close();
  }
  await setState(state());
  const c = await context(origin), a = await c.newPage(), b = await c.newPage();
  await a.clock.install(); await a.goto(origin + '/project/a'); await a.getByTestId('rdsh-update').waitFor();
  await b.goto(origin + '/project/b'); await b.getByTestId('rdsh-update').waitFor();
  await a.screenshot({ path: path.join(output, 'visible.png'), animations: 'disabled' });
  await closeBanner(a, 'close'); await b.getByTestId('rdsh-update').waitFor({ state: 'hidden' });
  await setState(state('DUMMY-v-next', { at: 1700000000001 }));
  await a.clock.fastForward(3 * 3600000 + 61000); await hidden(a);
  await a.getByRole('button', { name: 'Switch project', exact: true }).click(); await hidden(a);
  await a.reload(); await hidden(a);
  await a.screenshot({ path: path.join(output, 'after.png'), animations: 'disabled' });
  report.flows.push('close -> other tab hidden immediately -> changed timestamp -> >2 hours -> project remount -> reload stays hidden');
  const different = await context(otherOrigin), remote = await different.newPage();
  await remote.goto(otherOrigin + '/project/other'); await hidden(remote);
  report.flows.push('Separate browser context and GUI port use the account acknowledgement');
  await setState(state('DUMMY-v-new'));
  await a.reload(); await a.getByTestId('rdsh-update').waitFor();
  await a.locator('.rub-row1').click(); await a.locator('.rub-mini').waitFor();
  await a.locator('.rub-mini').click(); await a.getByRole('button', { name: 'dismiss', exact: true }).waitFor();
  await a.screenshot({ path: path.join(output, 'new-update.png'), animations: 'disabled' });
  await closeBanner(a, 'dismiss');
  for (const to of ['DUMMY-v-next', 'DUMMY-v-new']) { await setState(state(to)); await a.reload(); await hidden(a); }
  report.flows.push('New target appears, minimize/expand works, dismiss works, both old targets stay dismissed');
  await setState(state('DUMMY-legacy'));
  await a.evaluate(() => localStorage.setItem('rdsh-update-dismissed', JSON.stringify({ key: 'DUMMY-legacy@1', at: 1 })));
  const migrated = a.waitForResponse((r) => r.url().endsWith('/api/rdsh-update/dismiss'));
  await a.reload(); assert.equal((await migrated).status(), 200); await hidden(a);
  await remote.reload(); await hidden(remote);
  report.flows.push('Expired legacy dismissal migrates locally and reaches a separate GUI');
  await setState(state('DUMMY-no-storage'));
  const denied = await context(origin, { storageFails: true }), d = await denied.newPage();
  await d.goto(origin + '/project/no-storage'); await d.getByTestId('rdsh-update').waitFor(); await closeBanner(d, 'dismiss');
  await d.getByRole('button', { name: 'Switch project', exact: true }).click(); await hidden(d);
  await d.reload(); await hidden(d);
  report.flows.push('Browser storage unavailable: close, remount and reload remain hidden through the account acknowledgement');
  assert.deepEqual(report.page_errors, []); assert.deepEqual(report.console_errors, []);
  report.result = 'PASS';
} catch (error) { report.error = error.message; throw error; }
finally {
  if (browser) await browser.close();
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
  await writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ result: report.result, flows: report.flows.length, output }, null, 2));
