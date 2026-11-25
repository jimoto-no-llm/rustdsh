import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const unix = fs.readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
const windows = fs.readFileSync(new URL('../install.ps1', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const policy = unix.match(/<<'RDSH_RUNTIME_POLICY'[^\n]*\n([\s\S]*?)\nRDSH_RUNTIME_POLICY/)[1];
const windowsPolicy = windows.match(/\$runtimePolicy = @'\n([\s\S]*?)\n'@/)[1];
assert.equal(policy, windowsPolicy, 'both standalone installers must apply the same dependency policy');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rdsh-runtime-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'package.json');
  const run = () => spawnSync(process.execPath, ['-', file], { input: policy, encoding: 'utf8' });
  return { root, file, run };
}

test('fresh private runtimes receive the fixed policy before npm resolution', t => {
  const { file, run } = fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(file));
  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.overrides, {
    undici: '8.12.3', 'zod@>=4 <4.6.7': '4.6.7',
    '@modelcontextprotocol/client': '2.3.1', fflate: '0.8.3',
  });
  assert.equal(Object.hasOwn(manifest.overrides, 'zod'), false, 'Zod 3 consumers keep their major version');
});

test('repeat setup retains installed packages and unrelated custom overrides', t => {
  const { file, run } = fixture(t);
  const dependencies = { pnpm: '10.34.9', '@openai/codex': '0.166.0', example: '1.0.0' };
  fs.writeFileSync(file, JSON.stringify({ name: 'retained-runtime', dependencies, overrides: { example: '1.1.0', undici: '8.11.2' } }));
  assert.equal(run().status, 0);
  const first = fs.readFileSync(file, 'utf8');
  const manifest = JSON.parse(first);
  assert.equal(manifest.name, 'retained-runtime');
  assert.deepEqual(manifest.dependencies, dependencies);
  assert.equal(manifest.overrides.example, '1.1.0');
  assert.equal(manifest.overrides.undici, '8.12.3');
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), first);
});

for (const text of ['invalid-json', '[]', '{"overrides":[]}']) {
  test(`invalid manifests are refused without overwriting: ${text}`, t => {
    const { file, run } = fixture(t);
    fs.writeFileSync(file, text);
    assert.notEqual(run().status, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  });
}

test('symlinked manifests do not redirect setup writes to another file', t => {
  if (process.platform === 'win32') return t.skip('symlink creation requires Windows privileges');
  const { root, file, run } = fixture(t);
  const target = path.join(root, 'retained.json');
  fs.writeFileSync(target, '{}');
  fs.symlinkSync(target, file);
  assert.notEqual(run().status, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), '{}');
});


test('dangling symlink manifests do not create files outside the runtime', t => {
  if (process.platform === 'win32') return t.skip('symlink creation requires Windows privileges');
  const { root, file, run } = fixture(t);
  const target = path.join(root, 'uncreated.json');
  fs.symlinkSync(target, file);
  assert.notEqual(run().status, 0);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
});
