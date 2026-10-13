// Optional real Harness model-picker check. No login or model request is made.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { chromium } = await import(process.env.RDSH_PLAYWRIGHT_MODULE || 'playwright');
const original = process.env.RDSH_HARNESS_BIN;
assert.ok(original, 'Set RDSH_HARNESS_BIN to an installed original Harness CLI');
const museConfig = Object.fromEntries([
  ['nodeCommand', process.env.RDSH_MUSE_NODE_COMMAND],
  ['workerPath', process.env.RDSH_MUSE_WORKER_PATH],
  ['museCommand', process.env.RDSH_MUSE_COMMAND],
].filter(([, value]) => value));
const repo = path.resolve(import.meta.dirname, '../..');
const output = path.resolve(process.env.RDSH_E2E_OUTPUT || path.join(repo, 'target/muse-subscription-ui'));
const root = await mkdtemp(path.join(tmpdir(), 'rdsh-muse-ui-'));
const fixtureHome = path.join(root, 'dsh');
await mkdir(path.join(root, 'Workspace')); await mkdir(output, { recursive: true });
const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, { HOME: root, USERPROFILE: root, DSH_HOME: fixtureHome, XDG_CACHE_HOME: path.join(root, 'cache'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data') });
const report = { scope: 'real Harness model picker and real Muse Code catalog in temporary Web profiles; no generation', before_models: [], after_models: [], contributor_models: [], screenshots: ['before.png', 'after.png', 'contributor.png'], result: 'FAIL' };

async function capture(after) {
  if (after) {
    const profile = path.join(fixtureHome, 'profiles/web');
    await mkdir(profile, { recursive: true });
    const patch = path.join(profile, 'cordis.patch.yml');
    const existing = await readFile(patch, 'utf8').catch(() => '');
    await writeFile(patch, existing + '\n- insert:\n    - id: llm-muse-code-subscription\n      name: ' + JSON.stringify(path.join(repo, 'plugins/rdsh-llm-muse-code-subscription/index.js')) + '\n      config: ' + JSON.stringify(museConfig) + '\n');
  }
  let child, browser;
  try {
    child = spawn(original, ['--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const url = await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(Error('Harness readiness timeout')), 30000);
      const read = chunk => { text += chunk; const found = text.match(/dsh web: (\S+)/); if (found) { clearTimeout(timer); resolve(found[1]); } };
      child.stdout.on('data', read); child.stderr.on('data', read);
      child.once('error', () => { clearTimeout(timer); reject(Error('Harness spawn failed')); });
      child.once('exit', () => { clearTimeout(timer); reject(Error('Harness exited before readiness')); });
    });
    browser = await chromium.launch({ headless: true, ...(process.env.RDSH_CHROME_PATH ? { executablePath: process.env.RDSH_CHROME_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1100, height: 820 }, locale: 'en-US' });
    await page.goto(url);
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    const later = page.getByRole('button', { name: 'Configure later', exact: true });
    const notice = page.getByRole('button', { name: 'Continue', exact: true });
    if (!after) {
      await later.or(notice).first().waitFor();
      if (await notice.isVisible()) await notice.click();
      await later.click();
    } else {
      if (await notice.isVisible()) await notice.click();
      if (await later.isVisible()) await later.click();
    }
    const modelPicker = page.getByRole('button', { name: /^Select model,/ });
    await modelPicker.waitFor({ timeout: 3000 }).catch(() => {});
    if (!(await modelPicker.isVisible())) {
      await page.getByRole('button', { name: 'Choose workspace', exact: true }).click();
      const workspace = page.getByRole('menuitem', { name: 'Workspace', exact: true });
      if (await workspace.isVisible()) await workspace.click();
      await page.getByRole('button', { name: 'Open', exact: true }).click();
    }
    await modelPicker.click();
    await page.getByRole('menuitem', { name: /^Model/ }).click();
    const provider = page.getByText('Muse Code · 定額契約', { exact: true });
    if (after) {
      await provider.waitFor();
      for (const name of ['Muse Wonder 1.0', 'Muse Wonder Full 1.0', 'Muse Spark 1.3', 'Muse Spark 1.2']) {
        await page.getByText(name + ' · Muse Code 定額', { exact: true }).waitFor();
        await page.getByText(name + ' · Contributor（学習利用）', { exact: true }).waitFor();
      }
      await page.getByText('Muse Code · Contributor（学習利用）', { exact: true }).waitFor();
      report.after_models = ['muse-wonder-1.0', 'muse-wonder-full-1.0', 'muse-spark-1.3', 'muse-spark-1.2'];
      report.contributor_models = [...report.after_models];
    } else assert.equal(await provider.count(), 0);
    await page.screenshot({ path: path.join(output, after ? 'after.png' : 'before.png') });
    if (after) {
      await page.getByText('Muse Spark 1.2 · Contributor（学習利用）', { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, 'contributor.png') });
      await page.getByText('Muse Wonder Full 1.0 · Muse Code 定額', { exact: true }).click();
      await page.getByRole('button', { name: /^Select model, current Muse Wonder Full/ }).waitFor();
      report.selected_model = 'muse-wonder-full-1.0';
      await modelPicker.click(); await page.getByRole('menuitem', { name: /^Model/ }).click();
      await page.getByText('Muse Spark 1.3 · Contributor（学習利用）', { exact: true }).click();
      await page.getByRole('button', { name: /^Select model, current Muse Spark 1.3 · Contributor/ }).waitFor();
      report.selected_contributor = 'muse-spark-1.3';
      report.contributor_generation_requested = false;
    }
  } finally {
    await browser?.close();
    if (child?.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => { if (process.platform === 'win32') child.kill('SIGKILL'); else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }, 5000);
      await exited; clearTimeout(timer);
    }
  }
}

try { await capture(false); await capture(true); report.result = 'PASS'; }
finally { await writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n'); await rm(root, { recursive: true, force: true }); }
console.log(JSON.stringify(report));
