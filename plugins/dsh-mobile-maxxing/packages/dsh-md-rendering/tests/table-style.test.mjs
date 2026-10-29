import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function boot(mode, navigator = {}) {
  let definition;
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    document: { documentElement: { getAttribute: () => mode } },
    navigator,
  };
  sandbox.globalThis = sandbox;
  if (mode !== undefined) sandbox.__RDSH_DEVICE_MODE__ = mode;
  vm.createContext(sandbox);
  vm.runInContext(client, sandbox);
  const registrations = [];
  const required = [];
  const ctx = { slots: {
    inject(name, callback) { callback(); },
    register(options, component) { registrations.push({ options, component }); },
  } };
  const plugin = definition.factory((name) => {
    required.push(name);
    if (name === 'react') return { createElement: (type, props, ...children) => ({ type, props, children }) };
    throw new Error(`unexpected module ${name}`);
  });
  plugin.apply(ctx);
  return { plugin, registrations, required };
}

test('desktop is a hard no-op, including an unknown device mode', () => {
  for (const mode of ['desktop', undefined]) {
    const { plugin, registrations, required } = boot(mode);
    assert.deepEqual(required, [], 'desktop must not require React');
    assert.deepEqual(registrations, [], 'desktop must not register a stylesheet');
    assert.doesNotThrow(() => plugin.apply({}));
  }
});

test('standalone mobile detection registers styles without changing the document', () => {
  for (const navigator of [
    { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile' },
    { userAgent: 'Mozilla/5.0 (Linux; Android 14; Tablet)' },
    { platform: 'MacIntel', maxTouchPoints: 5 },
    { userAgentData: { platform: 'Android', mobile: false } },
  ]) {
    const { registrations, required } = boot(undefined, navigator);
    assert.equal(registrations.length, 1);
    assert.deepEqual(required, ['react']);
    const css = registrations[0].component().children[0];
    assert.match(css, /html \[data-chat-flow-kind="assistant-step"\]/);
    assert.doesNotMatch(css, /data-rdsh-device-mode/);
  }
  assert.equal(boot('desktop', { userAgent: 'iPhone' }).registrations.length, 0, 'explicit desktop mode wins');
  assert.equal(boot(undefined, { platform: 'Win32', maxTouchPoints: 5 }).registrations.length, 0, 'touch desktop stays unchanged');
});

test('mobile registers a stylesheet only inside the mobile chat', () => {
  const { registrations } = boot('mobile');
  assert.equal(registrations.length, 1);
  const style = registrations[0].component();
  assert.equal(style.type, 'style');
  assert.match(style.children[0], /html\[data-rdsh-device-mode="mobile"\] \[data-chat-flow-kind="assistant-step"\] div > table th/);
  assert.match(style.children[0], /background: var\(--dsw-alias-bg-base\)/);
  assert.doesNotMatch(style.children[0], /tr:nth-child\(even\)|opacity:\s*\.7/);
  assert.match(style.children[0], /overflow-x: auto/);
});

test('one installer URL installs three independent components', () => {
  const installer = readFileSync(new URL('../../../scripts/install-mobile-bundle.mjs', import.meta.url), 'utf8');
  assert.match(installer, /github:kuraneko1\/dsh-mobile-maxxing/);
  assert.match(installer, /DSH_MD_VERSION/);
  assert.match(installer, /github:kuraneko1\/dsh-locale-ja/);
  assert.match(installer, /\["plugin", "--profile", profile, "add", \.\.\.packages\]/);
});

test('installer pins specified mobile and locale refs independently', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-installer-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dsh = path.join(directory, 'dsh');
  writeFileSync(dsh, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n');
  chmodSync(dsh, 0o755);
  const env = { ...process.env, PATH: directory + path.delimiter + process.env.PATH, DSH_PROFILE: 'isolated', DSH_BUNDLE_TAG: 'v0.8.0', DSH_LOCALE_REF: 'locale-ref', DSH_BUNDLE_BASE_URL: 'https://example.test/v0.8.0' };
  const script = fileURLToPath(new URL('../../../scripts/install-mobile-bundle.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), ['plugin', '--profile', 'isolated', 'add', 'github:kuraneko1/dsh-mobile-maxxing#v0.8.0', 'https://example.test/v0.8.0/dsh-md-rendering-0.1.3.tgz', 'github:kuraneko1/dsh-locale-ja#locale-ref']);
  env.DSH_MD_VERSION = '0.1.2';
  const overridden = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.equal(JSON.parse(overridden.stdout)[5], 'https://example.test/v0.8.0/dsh-md-rendering-0.1.2.tgz');
  delete env.DSH_BUNDLE_TAG; delete env.DSH_LOCALE_REF; delete env.DSH_BUNDLE_BASE_URL; delete env.DSH_MD_VERSION;
  const defaults = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.deepEqual(JSON.parse(defaults.stdout).slice(4), ['github:kuraneko1/dsh-mobile-maxxing', 'https://github.com/kuraneko1/dsh-mobile-maxxing/releases/download/v1.0.0/dsh-md-rendering-0.1.3.tgz', 'github:kuraneko1/dsh-locale-ja']);
});

test('bundle exports its client and distribution resources', () => {
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.exports['./client'], './client.js');
  for (const file of ['client.js', 'index.js', 'cordis.patch.yml', 'icon.svg']) {
    assert.ok(manifest.files.includes(file), `${file} must be packaged`);
  }
});