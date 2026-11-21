import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const repo = path.resolve(import.meta.dirname, '../..');
const output = path.resolve(process.env.RDSH_UPDATE_E2E_OUTPUT || path.join(repo, 'target/e2e/update-banner'));
const root = await mkdtemp(path.join(os.tmpdir(), 'rdsh-update-browser-'));
const previousHome = process.env.HOME, previousProfile = process.env.USERPROFILE;
const previousVersion = process.env.DSH_VERSION, previousCheck = process.env.RDSH_DESKTOP_UPDATE_CHECK;
process.env.HOME = root; process.env.USERPROFILE = root;
// The dsh half is driven by a pinned active version and a seeded cache; no
// registry query and no real updater ever runs in this test.
process.env.DSH_VERSION = '0.9.0';
process.env.RDSH_DESKTOP_UPDATE_CHECK = '0';
assert.equal(os.homedir(), root, 'All update state must use the temporary HOME');
const stateFile = path.join(root, '.local/share/rdsh/update-state.json');
const closeFile = path.join(root, '.local/share/rdsh/update-notice-close.json');
const cacheFile = path.join(root, '.cache/rdsh-desktop/update-check.json');
await mkdir(path.dirname(stateFile), { recursive: true });
await mkdir(path.dirname(cacheFile), { recursive: true });
await mkdir(output, { recursive: true });
const START = Date.now();
const state = (to = 'DUMMY-v-next', extra = {}) => ({ updated: true, kind: 'rustdsh', from: 'DUMMY-v-old', to, at: START, ...extra });
const setState = async (value) => { await writeFile(stateFile + '.tmp', JSON.stringify(value)); await rename(stateFile + '.tmp', stateFile); };
const dshCache = (newest, checkedAt = Date.now()) => writeFile(cacheFile, JSON.stringify({ checkedAt, newest, channel: 'stable' }));
const report = { result: 'FAIL', scope: 'Actual React banner and authenticated state/close/stream routes in isolated loopback hosts; dsh pinned by DSH_VERSION and a seeded cache; updater responses mocked; dummy HOME; no registry query, no production DSH restart and no real updater execution', flows: [], page_errors: [], console_errors: [] };
const servers = [], disposers = [], bundles = new Map(); let browser;

async function bundle(file) {
  const result = await build({
    stdin: { contents: "import React from 'react'; import {createRoot} from 'react-dom/client';\n      let root = createRoot(document.getElementById('app'));\n      window.__ModuleLoader__={load(item){const plugin=item.factory(name=>{if(name==='react')return React;throw new Error(name)});\n      plugin.apply({slots:{inject(_name,fn){fn()},register(_definition,Component){root.render(React.createElement(Component));\n      window.remountProject=()=>{root.unmount();root=createRoot(document.getElementById('app'));root.render(React.createElement(Component));};}}});}};\n      import(" + JSON.stringify(file) + ");", resolveDir: import.meta.dirname, loader: 'js' },
    bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"' },
  });
  return result.outputFiles[0].contents;
}
async function host() {
  const { apply } = await import('../../plugins/rdsh-update-banner/index.js');
  const routes = new Map();
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (routes.has(pathname)) return await routes.get(pathname)(req, res);
      if (pathname === '/client.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundles.get('after')); return; }
      if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Update notification verification</title></head>' +
        '<body style="margin:0;background:#101014;color:#a0a0a8;font:16px system-ui">' +
        '<main style="padding:220px 48px"><h1>Update notification verification</h1>' +
        '<p>Real rdsh component and API · isolated dummy update</p>' +
        '<button id="project" type="button" onclick="window.remountProject()">Switch project</button></main>' +
        '<div id="app"></div><script src="/client.js"></script></body></html>');
    } catch { if (!res.headersSent) res.writeHead(500); res.end('fixture request failed'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  const origin = "http://127.0.0.1:" + server.address().port;
  disposers.push(apply({ effect: (f) => f(), connection: { requestRejection(req) {
    if (!req.headers.cookie?.includes('fixture-session=DUMMY_AUTH')) return 401;
    if ("http://" + req.headers.host !== origin || (req.headers.origin && req.headers.origin !== origin)) return 403;
  } }, webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } } }, {}));
  return origin;
}
async function context(origin, { viewport = { width: 1100, height: 760 }, reducedMotion = 'no-preference', locale = 'en-US' } = {}) {
  const c = await browser.newContext({ viewport, reducedMotion, locale });
  await c.addCookies([{ name: 'fixture-session', value: 'DUMMY_AUTH', url: origin }]);
  c.on('page', (p) => {
    p.on('pageerror', (e) => report.page_errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') report.console_errors.push(m.text()); });
  });
  await c.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  return c;
}
const card = (page) => page.getByTestId('update-card');
async function ready(page, url) {
  const bootstrap = page.waitForResponse((r) => r.url().endsWith('/api/rdsh-update') && r.request().method() === 'GET');
  await page.goto(url);
  assert.equal((await bootstrap).status(), 200);
  await sleep(150);
}
async function closed(page) { await sleep(120); assert.equal(await card(page).count(), 0); }

try {
  bundles.set('after', await bundle(path.join(repo, 'plugins/rdsh-update-banner/client.js')));
  const origin = await host();
  for (const route of ['/api/rdsh-update', '/api/rdsh-update/events']) {
    assert.equal((await fetch(origin + route)).status, 401);
    assert.equal((await fetch(origin + route, { headers: { cookie: 'fixture-session=DUMMY_AUTH', origin: 'https://DUMMY.invalid' } })).status, 403);
  }
  report.flows.push('State and event routes reject unauthenticated and foreign-Origin requests');

  browser = await chromium.launch({ headless: true, ...(process.env.RDSH_CHROME_PATH ? { executablePath: process.env.RDSH_CHROME_PATH } : {}) });

  // ---- one card, one row per component ------------------------------------
  await setState({ updated: false });
  await dshCache('1.1.0');
  const primary = await context(origin), page = await primary.newPage();
  await ready(page, origin + '/project/a');
  await card(page).waitFor();
  assert.equal(await page.getByTestId('update-card').count(), 1);
  assert.equal(await page.getByTestId('update-row-dsh').count(), 1);
  assert.equal(await page.getByTestId('update-dsh').count(), 1);
  assert.equal(await page.getByTestId('update-row-rustdsh').count(), 0);
  report.flows.push('A dsh-available state renders exactly one card with one dsh row');

  await setState(state());
  await page.getByTestId('update-row-rustdsh').waitFor();
  assert.equal(await page.getByTestId('update-card').count(), 1);
  assert.equal(await page.getByTestId('update-row-dsh').count(), 1);
  assert.equal(await page.getByTestId('update-row-rustdsh').count(), 1);
  assert.equal(await page.getByRole('status').count(), 1);
  report.flows.push('An applied rdsh record joins the same card instead of adding a second fixed card');

  await page.screenshot({ path: path.join(output, 'card.png'), animations: 'disabled' });

  // ---- dsh dismissal persists across registry refreshes -------------------
  await page.getByTestId('dismiss-dsh').click();
  await page.getByTestId('update-row-dsh').waitFor({ state: 'detached' });
  // Simulate the twelve-hour registry re-check rewriting checkedAt.
  await dshCache('1.1.0', Date.now() + 12 * 3600 * 1000);
  await page.reload(); await ready(page, origin + '/project/a');
  assert.equal(await page.getByTestId('update-row-dsh').count(), 0);
  // The applied confirmation is not replayed after a reload either.
  assert.equal(await page.getByTestId('update-row-rustdsh').count(), 0);
  await dshCache('1.2.0');
  await page.getByTestId('update-row-dsh').waitFor();
  report.flows.push('A dismissed dsh release stays dismissed when checkedAt refreshes; only a new release notifies again');

  // ---- dsh dismiss reaches another GUI host -------------------------------
  const second = await host();
  const otherContext = await context(second), other = await otherContext.newPage();
  await ready(other, second + '/project/b');
  await other.getByTestId('update-row-dsh').waitFor();
  await other.getByTestId('dismiss-dsh').click();
  await page.getByTestId('update-row-dsh').waitFor({ state: 'detached' });
  report.flows.push('A dsh dismissal streams to another independent GUI host without reloading');
  await otherContext.close();

  // ---- Escape and focus ---------------------------------------------------
  await setState({ updated: false });
  await dshCache('1.1.0');
  const focusContext = await context(origin), focusPage = await focusContext.newPage();
  await ready(focusPage, origin + '/project/focus');
  await focusPage.getByTestId('update-row-dsh').waitFor();
  await focusPage.getByTestId('toggle-dsh').focus();
  const focusBefore = await focusPage.evaluate(() => document.activeElement?.getAttribute('data-testid'));
  assert.equal(focusBefore, 'toggle-dsh');
  assert.equal(await focusPage.getByTestId('toggle-dsh').getAttribute('aria-expanded'), 'false');
  await focusPage.getByTestId('toggle-dsh').click();
  assert.equal(await focusPage.getByTestId('toggle-dsh').getAttribute('aria-expanded'), 'true');
  await focusPage.keyboard.press('Escape');
  await closed(focusPage);
  await focusContext.close();
  report.flows.push('Rows are real buttons with aria-expanded, and Escape closes the card');

  // ---- locales ------------------------------------------------------------
  await dshCache('1.1.0');
  for (const [locale, marker] of [['ja-JP', /アップデートがあります/], ['zh-CN', /有可用更新/], ['en-US', /update available/]]) {
    const localized = await context(origin, { locale }), target = await localized.newPage();
    await ready(target, origin + '/project/' + locale);
    await target.getByTestId('update-row-dsh').waitFor();
    assert.match(await target.getByTestId('update-row-dsh').innerText(), marker);
    const label = await target.getByTestId('close-notices').getAttribute('aria-label');
    assert.ok(label && label.length > 4);
    await target.screenshot({ path: path.join(output, 'locale-' + locale.slice(0, 2) + '.png'), animations: 'disabled' });
    await localized.close();
  }
  report.flows.push('Japanese, Chinese and English copy render from the DSH locale');

  // ---- viewports ----------------------------------------------------------
  for (const width of [320, 375, 1100]) {
    const sized = await context(origin, { viewport: { width, height: width < 500 ? 720 : 760 } });
    const target = await sized.newPage();
    await ready(target, origin + '/project/w' + width);
    await target.getByTestId('update-row-dsh').waitFor();
    const box = await target.getByTestId('update-card').boundingBox();
    assert.ok(box && box.width <= width + 1, 'card fits the viewport');
    assert.ok(box.x >= -1 && box.x + box.width <= width + 1, 'card stays inside the viewport');
    if (width <= 480) assert.ok(box.y + box.height >= 700, 'mobile uses the bottom sheet');
    await target.screenshot({ path: path.join(output, 'viewport-' + width + '.png'), animations: 'disabled' });
    await sized.close();
  }
  report.flows.push('The card fits 320, 375 and 1100 px viewports and docks to the bottom sheet below 480 px');

  // ---- reduced motion -----------------------------------------------------
  const calm = await context(origin, { reducedMotion: 'reduce' }), calmPage = await calm.newPage();
  await ready(calmPage, origin + '/project/calm');
  await calmPage.getByTestId('update-row-dsh').waitFor();
  const animation = await calmPage.getByTestId('update-card').locator('.rub-card').evaluate((node) => getComputedStyle(node).animationName);
  assert.equal(animation, 'none');
  await calm.close();
  report.flows.push('prefers-reduced-motion removes the entry animation');

  // ---- error and retry ----------------------------------------------------
  await setState({ updated: false });
  await dshCache('1.1.0');
  const errorContext = await context(origin), errorPage = await errorContext.newPage();
  await ready(errorPage, origin + '/project/error');
  await errorPage.getByTestId('update-row-dsh').waitFor();
  await errorPage.route('**/api/rdsh-update/dsh/run', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, message: 'DUMMY update failure' }) }));
  await errorPage.getByTestId('update-dsh').click();
  await errorPage.getByRole('alert').filter({ hasText: 'DUMMY update failure' }).waitFor();
  assert.equal(await errorPage.getByRole('alert').count(), 1);
  await errorPage.getByTestId('update-dsh').waitFor();
  report.flows.push('A failed apply renders role=alert with the reason and a retry action');

  await errorPage.route('**/api/rdsh-update/dsh/run', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, restartRequired: true, version: '1.1.0' }) }));
  await errorPage.getByTestId('update-dsh').click();
  await errorPage.getByTestId('update-row-dsh').getByText('Restart required').first().waitFor();
  assert.equal(await errorPage.getByTestId('update-dsh').count(), 0);
  await errorPage.reload(); await ready(errorPage, origin + '/project/error');
  await errorPage.getByTestId('update-row-dsh').getByText('Restart required').first().waitFor();
  await errorPage.getByTestId('dismiss-dsh').click();
  await closed(errorPage);
  await errorContext.close();
  report.flows.push('A finished dsh install reports restart-required, survives reload and is dismissable');

  // ---- applied confirmation is transient ---------------------------------
  // No dsh update is pending here, so the card can only come from the record.
  await dshCache('0.9.0');
  await setState(state('DUMMY-applied'));
  const appliedContext = await context(origin), appliedPage = await appliedContext.newPage();
  await ready(appliedPage, origin + '/project/applied');
  await appliedPage.getByTestId('update-row-rustdsh').waitFor();
  await sleep(300);
  const seen = await appliedPage.getByTestId('update-row-rustdsh').innerText();
  assert.match(seen, /DUMMY-applied/);
  await appliedPage.reload(); await ready(appliedPage, origin + '/project/applied');
  await closed(appliedPage);
  await appliedContext.close();
  report.flows.push('An applied update is a short-lived confirmation and does not resurrect on reload');

  assert.deepEqual(report.page_errors, []); assert.deepEqual(report.console_errors, []); report.result = 'PASS';
} catch (error) { report.error = error.message; throw error; }
finally {
  if (browser) await browser.close(); for (const dispose of disposers) dispose();
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
  if (previousVersion === undefined) delete process.env.DSH_VERSION; else process.env.DSH_VERSION = previousVersion;
  if (previousCheck === undefined) delete process.env.RDSH_DESKTOP_UPDATE_CHECK; else process.env.RDSH_DESKTOP_UPDATE_CHECK = previousCheck;
  await writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ result: report.result, flows: report.flows.length, output }, null, 2));
