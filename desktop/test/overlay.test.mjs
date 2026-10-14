import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import * as path from 'node:path';
import { planOverlay, contentHash, PATCH_PATHS, FEED_URL } from '../overlay.mjs';
import { source } from './fixtures/upstream-source.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'rdsh-overlay-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const [path, value] of Object.entries(source)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); }
  return { root, source, lock: { revision: 'a'.repeat(40), harnessVersion: '0.2.1-alpha.2', patchInputs: Object.fromEntries(Object.entries(source).map(([path, value]) => [path, contentHash(value.replace(/\r\n/g, '\n'))])) } };
}
test('overlay prepares a Rust identity and dedicated feed without changing official runtime manifests', t => {
  const f = fixture(t); const result = planOverlay(f.root, f.lock, '0.3.3', 'rdsh');
  const builder = result[PATCH_PATHS[0]], updater = result[PATCH_PATHS[1]];
  assert.match(builder, /const buildVersion = '0.3.3'/);
  assert.match(builder, /rdshHarnessVersion: '0.2.1-alpha.2'/);
  assert.ok(builder.includes(FEED_URL)); assert.ok(updater.includes(FEED_URL));
  assert.match(result[PATCH_PATHS[3]], /CHANNEL = 'rdsh-desktop'/);
  assert.match(result[PATCH_PATHS[2]], /setAsDefaultProtocolClient\('rdsh'\)/);
  assert.match(result[PATCH_PATHS[7]], /const environment = invocation.unsigned/);
  assert.match(result[PATCH_PATHS[8]], /rdsh Desktop\.exe/);
  assert.doesNotMatch(result[PATCH_PATHS[8]], /DeepSeek Harness/);
  assert.match(result[PATCH_PATHS[9]], /if \(!options.unsigned\) resolveDesktopPolicyEnvironment/);
  assert.match(result[PATCH_PATHS[10]], /const base = `rdsh-desktop-/);
  assert.match(result['apps/desktop/rdsh-bootstrap.cjs'], /process\.env\.DSH_HOME = home/);
  assert.match(result['apps/desktop/rdsh-bootstrap.cjs'], /Bundled Rust launcher is missing/);
  assert.equal(Object.hasOwn(result, 'package.json'), false);
  for (const [path, before] of Object.entries(f.source)) assert.equal(readFileSync(join(f.root, path), 'utf8'), before);
});
test('changed hashes, changed anchors, invalid identity and arbitrary input paths are refused', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, PATCH_PATHS[1]), 'changed');
  assert.throws(() => planOverlay(f.root, f.lock, '0.3.3', 'rdsh'), /reviewed lock/);
  f.lock.patchInputs[PATCH_PATHS[1]] = contentHash('changed');
  assert.throws(() => planOverlay(f.root, f.lock, '0.3.3', 'rdsh'), /anchor changed/);
  assert.throws(() => planOverlay(f.root, f.lock, 'invalid', 'rdsh'));
  f.lock.patchInputs['../../unrelated'] = '0'.repeat(64);
  assert.throws(() => planOverlay(f.root, f.lock, '0.3.3', 'rdsh'), /Unexpected patch paths/);
});

test('source hashes tolerate Git checkout line endings while retaining all patch guards', t => {
  const f = fixture(t);
  for (const [path, before] of Object.entries(f.source)) {
    const canonical = before.replace(/\r\n/g, '\n');
    f.lock.patchInputs[path] = contentHash(canonical);
    writeFileSync(join(f.root, path), canonical.replace(/\n/g, '\r\n'));
  }
  assert.ok(planOverlay(f.root, f.lock, '0.3.3', 'rdsh.exe')['apps/desktop/rdsh-bootstrap.cjs'].includes('rdsh.exe'));
});

test('generated carrier isolates Electron and Harness homes before importing the official engine', t => {
  const f = fixture(t), generated = planOverlay(f.root, f.lock, '0.3.3', 'rdsh')['apps/desktop/rdsh-bootstrap.cjs'];
  const script = generated.replace("import('./lib/main.js');", 'engineImported = true;');
  const home = join(f.root, 'private-harness'), userData = join(f.root, 'private-electron');
  const dirs = [], paths = {}, process = { platform: 'linux', resourcesPath: join(f.root, 'resources'),
    env: { RDSH_DESKTOP_HOME: home, RDSH_DESKTOP_USER_DATA: userData, DSH_HOME: join(f.root, 'unrelated') } };
  const context = { process, engineImported: false, require(name) {
    if (name === 'electron') return { app: { setName(value) { paths.name = value; }, getPath() { return join(f.root, 'appData'); }, setPath(key, value) { paths[key] = value; } } };
    if (name === 'node:path') return path;
    if (name === 'node:fs') return { existsSync: () => true, mkdirSync(value) { dirs.push(value); } };
    throw new Error('unexpected carrier import');
  } };
  vm.runInNewContext(script, context);
  assert.equal(paths.name, 'rdsh Desktop'); assert.equal(paths.userData, userData);
  assert.deepEqual(dirs, [userData]); assert.equal(process.env.DSH_HOME, home); assert.equal(context.engineImported, true);
  process.env.RDSH_DESKTOP_USER_DATA = 'relative'; dirs.length = 0;
  const invalidContext = { ...context, engineImported: false };
  assert.throws(() => vm.runInNewContext(script, invalidContext), /absolute/);
  assert.deepEqual(dirs, []); assert.equal(invalidContext.engineImported, false);
});
