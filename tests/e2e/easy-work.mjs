// Uses synthetic files and the actual plugin HTTP handlers + browser renderer.
// No live DSH profile, credentials, model requests or user folders are touched.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createOrganizer } from '../../plugins/rdsh-easy-work/organizer.js';
import { registerWeb } from '../../plugins/rdsh-easy-work/index.js';

const artifacts = resolve(process.env.RDSH_EASY_EVIDENCE || 'target/e2e/easy-work');
await mkdir(artifacts, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'rdsh-easy-browser-'));
const folder = join(temporary, 'Downloads'); await mkdir(folder);
await writeFile(join(folder, '旅行の写真.png'), 'synthetic photo');
await writeFile(join(folder, '会議の資料.pdf'), 'synthetic document');
await writeFile(join(folder, '家計.csv'), 'month,amount\n1,1200');
const organizer = createOrganizer();
const handlers = new Map();
const dispose = registerWeb({
  webServer: { register(route) { handlers.set(route.path, route.handler); return () => handlers.delete(route.path); } },
  connection: { requestRejection: req => req.headers['x-rdsh-test-gui'] === 'fixture' ? undefined : 401 },
}, organizer);
const client = await readFile(new URL('../../plugins/rdsh-easy-work/client.js', import.meta.url), 'utf8');
const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>rdsh ファイル整理の検証</title><style>body{margin:0;background:#eef4fb;padding:24px;color:#18324c}header{max-width:720px;margin:auto;font:18px sans-serif}main{max-width:764px;margin:auto;display:flex;align-items:center;gap:2px;min-width:0}</style><header>rdsh</header><main><section id="panel" aria-label="ファイル整理"></section></main><script>
window.__ModuleLoader__={load(definition){window.plugin=definition.factory(()=>({}));}};
const fetchNative=window.fetch; window.fetch=(url,options={})=>fetchNative(url,{...options,headers:{...options.headers,'x-rdsh-test-gui':'fixture'}});
</script><script src="/client.js"></script><script>window.destroy=window.plugin.mount(document.querySelector('#panel'),{pick:async()=>${JSON.stringify(folder).replaceAll('<', '\\u003c')}});</script></html>`;
const server = createServer((req, res) => {
  for (const action of ['preview', 'execute', 'undo', 'recover', 'status', 'release']) {
    const route = '/api/rdsh-easy-work/' + action;
    if (req.url === route) return void handlers.get(route)(req, res);
  }
  if (req.url === '/' || req.url === '/client.js') {
    res.setHeader('content-type', req.url === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
    return res.end(req.url === '/' ? html : client);
  }
  res.writeHead(404).end();
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, ...(process.env.RDSH_E2E_BROWSER ? { executablePath: process.env.RDSH_E2E_BROWSER } : {}) });
  const page = await browser.newPage({ viewport: { width: 1080, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'フォルダを、すっきり。' }).waitFor();
  await page.screenshot({ path: join(artifacts, 'easy-work-before.png') });
  await page.getByRole('button', { name: 'フォルダを選ぶ', exact: true }).click();
  await page.getByText('内容を確認してから実行してください。').waitFor();
  assert.equal(await page.locator('tbody tr').count(), 3);
  await page.screenshot({ path: join(artifacts, 'easy-work-preview.png') });
  const preview = await page.screenshot();
  await page.getByRole('button', { name: '確認した内容でコピーする' }).click();
  await page.getByText('3ファイルの整理が終わりました。').waitFor();
  const completed = await page.screenshot();
  await page.screenshot({ path: join(artifacts, 'easy-work-after.png') });
  await page.getByRole('button', { name: '整理を取り消す（コピーを保管）' }).click();
  await page.getByText('整理を取り消しました。元ファイルはそのままです。').waitFor();
  const undone = await page.screenshot();
  await page.screenshot({ path: join(artifacts, 'easy-work-undone.png') });
  assert.equal(await readFile(join(folder, '旅行の写真.png'), 'utf8'), 'synthetic photo');
  await writeFile(join(artifacts, 'flow-preview.png'), preview);
  await writeFile(join(artifacts, 'flow-completed.png'), completed);
  await writeFile(join(artifacts, 'flow-undone.png'), undone);
  await page.getByRole('button', { name: '別のフォルダを選ぶ' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'フォルダを選ぶ', exact: true }).click();
  await page.getByText('内容を確認してから実行してください。').waitFor();
  await page.screenshot({ path: join(artifacts, 'easy-work-mobile.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: '確認した内容でコピーする' }).focus();
  assert.equal(await page.getByRole('button', { name: '確認した内容でコピーする' }).evaluate(el => el === document.activeElement), true);
  assert.deepEqual(errors, []);
  console.log('PASS easy-work: preview -> copy -> archive undo; mobile layout; keyboard focus; synthetic originals preserved');
} finally {
  await browser?.close(); await dispose();
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
