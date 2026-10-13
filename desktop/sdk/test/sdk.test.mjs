import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createHarness, desktopPaths, configureUpdater } from '../index.js';

test('official SDK uses explicit workspace, model and isolated child environment without starting a model', async () => {
  const cwd = join(tmpdir(), 'rdsh-sdk-fixture');
  const entry = join(cwd, 'lib', 'bin.js');
  const home = join(cwd, 'private-home');
  const env = { PATH: '/fixture', PROVIDER_API_KEY: 'synthetic-key', NODE_OPTIONS: '--invalid-fixture-hook', DSH_HOME: '/unrelated-home' };
  const harness = createHarness({ sdkHome: home, dshBin: entry, cwd, provider: 'fixture-provider', model: 'fixture-model', env, maxTokens: 2048 });
  assert.equal(harness.client.options.dshBin, entry);
  assert.equal(harness.client.options.dshHome, home);
  assert.equal(harness.client.options.env.DSH_HOME, home);
  assert.equal(harness.client.options.env.NODE_OPTIONS, undefined);
  assert.equal(harness.client.options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(env.NODE_OPTIONS, '--invalid-fixture-hook');
  await harness.close();
});
test('SDK refuses implicit model selection, relative paths and launch-option bypasses', () => {
  const root = join(tmpdir(), 'rdsh-sdk-fixture');
  const options = { sdkHome: root, dshBin: join(root, 'bin.js'), cwd: root, provider: 'fixture', model: 'fixture' };
  assert.throws(() => createHarness({ ...options, provider: '' }));
  assert.throws(() => createHarness({ ...options, sdkHome: 'relative' }));
  assert.throws(() => createHarness({ ...options, dshBin: join(root, 'rdsh') }));
  assert.throws(() => createHarness({ ...options, profile: 'desktop' }));
  assert.throws(() => createHarness({ ...options, maxTokens: 0 }));
  assert.throws(() => createHarness({ ...options, env: null }));
});
test('desktop paths use the fork home and bundled Rust executable', () => {
  const root = join(tmpdir(), 'rdsh-sdk-fixture');
  const paths = desktopPaths({ appData: root, resources: join(root, 'resources') });
  assert.equal(paths.home, join(root, 'rdsh-desktop', 'harness'));
  assert.equal(paths.rdshBin, join(root, 'resources', 'rdsh', process.platform === 'win32' ? 'rdsh.exe' : 'rdsh'));
  assert.throws(() => desktopPaths({ appData: root, resources: 'relative' }));
});
test('updater targets only the Rust repository and preserves separate consent for download/install', () => {
  let feed;
  const updater = { setFeedURL(value) { feed = value; }, set channel(value) { this.selected = value; this.allowDowngrade = true; } };
  configureUpdater(updater);
  assert.deepEqual(feed, { provider: 'generic', url: 'https://github.com/jimoto-no-llm/rustdsh/releases/latest/download/' });
  assert.equal(updater.selected, 'rdsh-desktop');
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.autoDownload, false); assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, false);
});

test('real official SDK transport sends the selected route to an owned fixture and closes it cleanly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rdsh-sdk-wire-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trace = join(root, 'trace.jsonl'), entry = join(root, 'fixture.mjs');
  await writeFile(entry, `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
for await (const line of createInterface({input:process.stdin})) {
 const request=JSON.parse(line); let result;
 if(request.method==='initialize') {
  appendFileSync(process.env.RDSH_SDK_TEST_TRACE,JSON.stringify({route:request.params,home:process.env.DSH_HOME,hasNodeHooks:Boolean(process.env.NODE_OPTIONS)})+'\\n');
  result={serverInfo:{name:'deepseek-harness-sdk-runtime',version:'0.2.1-alpha.2'}};
 } else if(request.method==='session/working-directory/get') result={cwd:process.cwd()};
 else if(request.method==='shutdown') result=null;
 else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'fixture method unavailable'}})+'\\n');continue;}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
}
`);
  const home = join(root, 'private-home');
  const harness = createHarness({ sdkHome: home, dshBin: entry, cwd: root, provider: 'fixture-provider', model: 'fixture-model', maxTokens: 2048,
    env: { RDSH_SDK_TEST_TRACE: trace, NODE_OPTIONS: '--invalid-hook' } });
  try { assert.equal(await harness.session('fixture-session').getWorkingDirectory(), root); }
  finally { await harness.close(); }
  const record = JSON.parse((await readFile(trace, 'utf8')).trim());
  assert.equal(record.route.provider, 'fixture-provider'); assert.equal(record.route.model, 'fixture-model');
  assert.equal(record.route.maxTokens, 2048); assert.equal(record.home, home); assert.equal(record.hasNodeHooks, false);
});
