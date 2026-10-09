// Captures the real UI using an empty HOME, synthetic data and a fresh browser.
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile, copyFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {pathToFileURL} from 'node:url';

const repo = path.resolve(import.meta.dirname, '../../..');
const output = path.resolve(import.meta.dirname, process.env.RDSH_VIDEO_CAPTURE_DIR || '../public');
const deviceScaleFactor = Number(process.env.RDSH_VIDEO_DPR || 2);
assert.ok([2, 4, 6].includes(deviceScaleFactor), 'Capture DPR must be 2, 4 or 6');
const root = await mkdtemp(path.join(tmpdir(), 'rdsh-video-demo-'));
const originalEnv = {...process.env};
const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
Object.assign(env, {
  HOME: root, USERPROFILE: root, DSH_HOME: path.join(root, 'dsh'),
  XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
  XDG_DATA_HOME: path.join(root, 'data'), RDSH_DASHBOARD_HOME: path.join(root, 'dashboard-state'),
  RDSH_ORIG_BIN: path.join(root, 'no-original'),
});
for (const k of Object.keys(process.env)) delete process.env[k];
Object.assign(process.env, env);
await mkdir(env.DSH_HOME, {recursive: true});
await mkdir(output, {recursive: true});
const {chromium} = await import(pathToFileURL(path.join(repo, 'tests/e2e/node_modules/playwright/index.mjs')));
const binary = path.join(repo, 'target/debug/rdsh');
const children = [];
const errors = [];
const inspected = [];
let dashboard;
let browser;
const forbidden = [/\/home\//i, /\/mnt\//i, /[A-Z]:\\Users\\/i, /\b[a-f0-9]{64}\b/i, /\b(?:sk-|ghp_|eyJ)[A-Za-z0-9_-]{12,}/, /Flaxia/i];
async function shot(page, file, selector) {
  await page.evaluate(async () => {await document.fonts.ready;});
  const element = selector ? page.locator(selector) : page.locator('body');
  const text = await element.innerText();
  for (const pattern of forbidden) assert.ok(!pattern.test(text), `Privacy check failed in ${file}`);
  inspected.push({file, visible_text: text});
  // Fixed navigation must not cover a cropped content panel.
  if (selector) await page.locator('#quick-actions').evaluateAll(nodes => nodes.forEach(e => e.style.visibility = 'hidden'));
  try {
    await (selector ? element : page).screenshot({path: path.join(output, file)});
  } finally {
    if (selector) await page.locator('#quick-actions').evaluateAll(nodes => nodes.forEach(e => e.style.removeProperty('visibility')));
  }
}
async function freePort() {
  const server = net.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise(r => server.close(r));
  return port;
}
async function launch(args) {
  const child = spawn(binary, args, {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
  children.push(child);
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => reject(new Error('Demo server startup timeout')), 20000);
    const read = chunk => {
      data += chunk;
      const match = data.match(/http:\/\/127\.0\.0\.1:\d+\/#key=[a-f0-9]+/);
      if (match) {clearTimeout(timer); resolve(match[0]);}
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.once('error', e => {clearTimeout(timer); reject(e);});
    child.once('exit', () => {clearTimeout(timer); if (!data.match(/#key=/)) reject(new Error('Demo server exited'));});
  });
}
try {
  await copyFile(path.join(repo, 'assets/icon.png'), path.join(output, 'icon.png'));
  await copyFile('/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf', path.join(output, 'Japanese.ttf'));
  await copyFile('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', path.join(output, 'Latin.ttf'));
  await copyFile('/usr/share/doc/fonts-ipafont-gothic/copyright', path.join(output, 'Japanese-font-license.txt'));
  await copyFile('/usr/share/doc/fonts-dejavu-core/copyright', path.join(output, 'Latin-font-license.txt'));
  const projectPath = path.join(root, 'rdsh-demo');
  await mkdir(projectPath);
  await writeFile(path.join(projectPath, 'README.md'), '# rdsh demo\n\nTODO: add a welcome screen\n');
  const run = args => execFileSync(binary, args, {cwd: projectPath, env, encoding: 'utf8'}).trim();
  const cli = {
    version: run(['--version']),
    search: run(['search', 'TODO', '--dir', '.', '--max', '10']),
    tokens: run(['tokens', 'README.md']),
  };
  for (const p of forbidden) assert.ok(!p.test(JSON.stringify(cli)));
  await writeFile(path.join(output, 'cli.json'), JSON.stringify(cli, null, 2) + '\n');
  browser = await chromium.launch({headless: true, executablePath: '/usr/bin/google-chrome'});
  const context = await browser.newContext({viewport: {width: 1280, height: 900}, deviceScaleFactor, locale: 'ja-JP', colorScheme: 'dark'});
  const setup = await context.newPage();
  setup.on('pageerror', e => errors.push(e.message));
  await setup.goto(await launch(['setup', '--web', '--port', '0']));
  await setup.locator('#extras .row').first().waitFor();
  // Only the settings card is captured: the app's decorative backdrop is excluded.
  await shot(setup, 'setup-off.png', '.card');
  await setup.locator('#extras .row').filter({hasText: 'rdsh serve'}).click();
  await setup.waitForFunction(() => document.querySelector('#extras .row')?.textContent.includes('有効'));
  await shot(setup, 'setup-on.png', '.card');
  assert.deepEqual(JSON.parse(await readFile(path.join(env.DSH_HOME, 'rdsh.json'), 'utf8')).extras.enable, ['serve']);

  const {identity, ProjectStore} = await import(pathToFileURL(path.join(repo, 'dashboard/state.mjs')));
  const {startDashboard} = await import(pathToFileURL(path.join(repo, 'dashboard/server.mjs')));
  const project = await identity(projectPath);
  const store = await ProjectStore.open(project);
  for (const task of [
    {id: 'T1', title: 'ウェルカム画面を実装', status: 'doing', milestone: 'デモアプリ'},
    {id: 'T2', title: '操作テストを追加', status: 'todo', milestone: 'デモアプリ'},
    {id: 'T3', title: '画面構成を整理', status: 'done', milestone: 'デモアプリ'},
  ]) await store.mutate('task', task);
  await store.mutate('metrics', {total_cost_usd: 1.28, total_budget_usd: 5, input_tokens: 12000, cached_input_tokens: 8400, tool_calls: 24, tool_errors: 0, model_calls: 6});
  await store.mutate('event', {title: 'ウェルカム画面の構成を作成', detail: 'デモ用の進捗報告です。次に色の方針を確認します。'});
  await store.mutate('question', {id: 'Q1', question: 'ウェルカム画面の配色はどちらにしますか？', urgency: 'normal', default_action: '回答を待ちます'});
  dashboard = await startDashboard({project, port: await freePort(), tailscale: false});
  const desktop = await context.newPage();
  desktop.on('pageerror', e => errors.push(e.message));
  await desktop.emulateMedia({colorScheme: 'light'});
  await desktop.goto(dashboard.browserUrl);
  await desktop.locator('#question-Q1 textarea').waitFor();
  await desktop.locator('#overview-task').selectOption('T1');
  await shot(desktop, 'project-desktop.png');
  await shot(desktop, 'project-overview.png', '#project-overview');
  await desktop.locator('#question-Q1 textarea').fill('ブルーを基調に、シンプルな配色で進めてください。');
  await shot(desktop, 'question-draft.png', '#question-Q1');
  await desktop.locator('#question-Q1').getByRole('button', {name: '回答を返す'}).click();
  await desktop.locator('#questions').filter({hasText: '未回答の質問はありません'}).waitFor();
  assert.equal(dashboard.store.value.questions[0].answer, 'ブルーを基調に、シンプルな配色で進めてください。');
  await desktop.locator('#answered').evaluate(e => e.open = true);
  await desktop.locator('#answers').filter({hasText: 'ブルーを基調'}).waitFor();
  await shot(desktop, 'question-saved.png', '#answered');
  await desktop.locator('#metrics-detail').evaluate(e => e.open = true);
  await shot(desktop, 'project-metrics.png', '#cards');
  await desktop.locator('#tasks-detail').evaluate(e => e.open = true);
  await shot(desktop, 'project-tasks.png', '#tasks-detail');

  await dashboard.mutate('question', {id: 'Q2', question: 'デモの完成画面を確認しますか？', urgency: 'normal', default_action: '回答を待ちます'});
  const mobile = await context.newPage();
  mobile.on('pageerror', e => errors.push(e.message));
  await mobile.setViewportSize({width: 390, height: 844});
  await mobile.emulateMedia({colorScheme: 'light'});
  await mobile.goto(dashboard.browserUrl);
  await mobile.locator('#question-Q2 textarea').waitFor();
  await shot(mobile, 'project-mobile.png');
  await mobile.locator('#question-Q2').scrollIntoViewIfNeeded();
  await shot(mobile, 'project-mobile-question.png');
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'capture-audit.json'), JSON.stringify({
    result: 'PASS', data: 'synthetic only', desktop_capture: false, device_scale_factor: deviceScaleFactor,
    environment: 'empty temporary HOME/DSH_HOME/XDG/RDSH_DASHBOARD_HOME',
    tailscale: false, model_calls: false, personal_browser: false,
    checks: ['visible-text privacy patterns', 'setup saved to isolated config', 'browser answer saved to isolated ledger', 'no browser page errors'],
    captures: inspected,
  }, null, 2) + '\n');
  console.log(JSON.stringify({result: 'PASS', captures: inspected.length, cli: Object.keys(cli)}));
} finally {
  await browser?.close();
  await dashboard?.close();
  for (const child of children) {
    if (child.exitCode !== null) continue;
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => {clearTimeout(timer); resolve();}); child.kill('SIGTERM');
    });
  }
  await rm(root, {recursive: true, force: true});
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
}
