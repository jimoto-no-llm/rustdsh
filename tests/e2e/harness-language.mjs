// Optional integration with the installed DSH locale service and Language menu.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const repo = path.resolve(import.meta.dirname, '../..');
const original = process.env.RDSH_HARNESS_BIN;
assert.ok(original, 'Set RDSH_HARNESS_BIN to an installed DSH with locale.addLanguage');
const { chromium } = await import(process.env.RDSH_PLAYWRIGHT_MODULE || 'playwright');
const root = await mkdtemp(path.join(tmpdir(), 'rdsh-language-e2e-'));
const output = path.resolve(process.env.RDSH_E2E_OUTPUT || path.join(repo, 'target/harness-language-e2e'));
await mkdir(output, { recursive: true });
const report = { result: 'FAIL', scope: 'Installed DSH Web UI, real rdsh plugin and Host locale preference; isolated homes; no credentials or model calls', page_errors: [], preference_writes: [] };
const children = new Set();
let browser;

function environment(home) {
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  return { ...env, HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, 'dsh'),
    XDG_CACHE_HOME: path.join(home, 'cache'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data') };
}

async function stop(child) {
  if (child.exitCode !== null) { children.delete(child); return; }
  const stopped = new Promise(resolve => {
    const timer = setTimeout(() => {
      if (process.platform === 'win32') child.kill();
      else try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  if (process.platform === 'win32') await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']).catch(error => { if (child.exitCode === null) throw error; });
  else try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  await stopped;
  children.delete(child);
}

async function launch(home, plugin, install = true) {
  const env = environment(home);
  await mkdir(env.DSH_HOME, { recursive: true });
  if (install) {
    await writeFile(path.join(env.DSH_HOME, 'rdsh.json'), JSON.stringify({ discord: { enabled: false }, features: { discord: false } }));
    await exec(original, ['plugin', '--profile', 'web', 'add', plugin], { env, cwd: home, timeout: 60000 });
  }
  const child = spawn(original, ['--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], { env, cwd: home,
    stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  children.add(child);
  const url = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('DSH Web readiness deadline exceeded')), 30000);
    const read = chunk => {
      text += chunk;
      const match = text.match(/dsh web: (\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); if (!text.match(/dsh web: (\S+)/)) reject(new Error('DSH exited before readiness')); });
  });
  return { child, url };
}

async function openSettings(page) {
  // Fixture homes deliberately have no provider credential, so onboarding
  // offers Configure later again on reload and after a process restart.
  const notice = page.getByRole('button', { name: 'Continue', exact: true });
  const later = page.getByRole('button', { name: 'Configure later', exact: true });
  await notice.or(later).first().waitFor();
  if (await notice.isVisible()) await notice.click();
  await later.click();
  await page.getByRole('button', { name: /^(Settings|設定)$/, exact: true }).click();
}

async function open(url, { theme = true, locale = 'en-US' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale });
  const page = await context.newPage();
  page.on('pageerror', error => report.page_errors.push(error.message));
  await page.goto(url);
  await openSettings(page);
  if (theme) await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await page.getByText('Unable to create default workspace. Use Choose workspace to select a folder.', { exact: true }).waitFor({ state: 'hidden' });
  return { page, context };
}

async function englishMenu(page) {
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.getByRole('menuitem', { name: 'English', exact: true }).waitFor();
}

async function selectLanguage(page, label, id) {
  const saved = page.waitForResponse(response => {
    const request = response.request();
    const body = request.postData() || '';
    return request.method() === 'POST' && body.includes('"locale"')
      && body.includes('"preference"') && body.includes(`"value":"${id}"`);
  });
  await page.getByRole('menuitem', { name: label, exact: true }).click();
  const response = await saved;
  assert.equal(response.status(), 200);
  const reply = await response.json();
  assert.equal(reply.result.ok, true, 'The Host must accept the locale preference');
  report.preference_writes.push(id);
}

try {
  report.dsh_version = (await exec(original, ['--version'], { timeout: 15000 })).stdout.trim();
  browser = await chromium.launch({ headless: true, ...(process.env.RDSH_CHROME_PATH ? { executablePath: process.env.RDSH_CHROME_PATH } : {}) });
  const plugin = path.join(repo, 'plugins/rdsh-settings');
  const baseline = process.env.RDSH_LANGUAGE_BASELINE_CLIENT;
  if (baseline) {
    const beforePlugin = path.join(root, 'before-plugin');
    await cp(plugin, beforePlugin, { recursive: true });
    await writeFile(path.join(beforePlugin, 'client.js'), await readFile(path.resolve(repo, baseline)));
    const before = await launch(path.join(root, 'before'), beforePlugin);
    const { page, context } = await open(before.url);
    await englishMenu(page);
    assert.equal(await page.getByRole('menuitem', { name: '日本語', exact: true }).count(), 0);
    await page.screenshot({ path: path.join(output, 'language-before.png') });
    report.before_options = await page.getByRole('menuitem').allTextContents();
    await context.close(); await stop(before.child);
  }
  const home = path.join(root, 'after');
  const after = await launch(home, plugin);
  const { page, context } = await open(after.url);
  await englishMenu(page);
  await page.getByRole('menuitem', { name: '日本語', exact: true }).waitFor();
  report.after_options = await page.getByRole('menuitem').allTextContents();
  await page.screenshot({ path: path.join(output, 'language-after.png') });
  await selectLanguage(page, '日本語', 'ja');
  await page.getByText('言語', { exact: true }).waitFor();
  await page.getByText('外観', { exact: true }).waitFor();
  await page.getByText('作業の詳細', { exact: true }).waitFor();
  await page.getByText('実行中の送信方法', { exact: true }).waitFor();
  await page.getByText('文字サイズ', { exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'ja');
  await page.screenshot({ path: path.join(output, 'language-japanese.png') });
  // A missing Japanese key still displays the upstream English label.
  await page.getByRole('button', { name: 'Models', exact: true }).waitFor();
  report.english_fallback = 'Models';
  await page.getByRole('button', { name: '日本語', exact: true }).click();
  await selectLanguage(page, '中文', 'zh');
  await page.getByText('语言', { exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  await page.getByRole('button', { name: '中文', exact: true }).click();
  await selectLanguage(page, 'English', 'en');
  await page.getByText('Language', { exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  await englishMenu(page);
  await selectLanguage(page, '日本語', 'ja');
  await page.getByText('言語', { exact: true }).waitFor();
  // Reload must retain an explicit Japanese preference on an English browser.
  await page.reload();
  await openSettings(page);
  await page.getByText('言語', { exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'ja');
  await context.close(); await stop(after.child);
  // A new process and fresh browser eliminate in-memory and browser-storage state.
  const restarted = await launch(home, plugin, false);
  const fresh = await open(restarted.url, { theme: false });
  await fresh.page.getByText('言語', { exact: true }).waitFor();
  assert.equal(await fresh.page.locator('html').getAttribute('lang'), 'ja');
  assert.equal(await fresh.page.getByRole('button', { name: '日本語', exact: true }).count(), 1);
  report.restart_preference = 'ja';
  await fresh.context.close(); await stop(restarted.child);
  assert.deepEqual(report.page_errors, []);
  report.result = 'PASS';
  report.flow = 'English menu -> Japanese -> Chinese -> English -> Japanese -> reload -> process restart with fresh English browser';
} catch (error) {
  report.error = error.message.slice(0, 300);
  const currentPage = browser?.contexts().at(-1)?.pages().at(-1);
  if (currentPage) await currentPage.screenshot({ path: path.join(output, 'language-failure.png') });
  throw error;
} finally {
  if (browser) await browser.close();
  for (const child of children) await stop(child);
  await writeFile(path.join(output, 'language-results.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(root, { recursive: true, force: true });
}
