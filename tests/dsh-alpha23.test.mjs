import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const runtime = process.env.RDSH_AUDITED_RUNTIME_ALPHA23;
const preload = path.resolve('security/preload.mjs');
function run(target, script) {
  return spawnSync(process.execPath, ['--import', preload, ...script], {
    env: { ...process.env,
      RDSH_TOOL_RUNTIME: target, RDSH_TOOL_ADAPTER: 'dsh-tools-0.2.2-alpha.3',
      RDSH_SECURE_WORKSPACE: process.cwd(), RDSH_SHARED_FILES: '[]',
      RDSH_SECURITY_LANG: 'en',
    }, encoding: 'utf8', timeout: 15000,
  });
}
test('alpha.3 constructs the guarded Cordis service and executes rdsh_inspect', t => {
  if (!runtime) return t.skip('set RDSH_AUDITED_RUNTIME_ALPHA23 to the published runtime');
  const result = run(runtime, [path.resolve('tests/guarded-runtime-probe-022.mjs')]);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'ok');
});
test('alpha.3 refuses changed runtime bytes before importing them', t => {
  if (!runtime) return t.skip('set RDSH_AUDITED_RUNTIME_ALPHA23 to the published runtime');
  const root = mkdtempSync(path.join(tmpdir(), 'rdsh-alpha23-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const changed = path.join(root, 'runtime.mjs');
  writeFileSync(changed, readFileSync(runtime, 'utf8') + '\nthrow new Error("UNTRUSTED_RUNTIME_EXECUTED");');
  const result = run(changed, ['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(changed).href)})`]);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RDSH_SECURITY\[UNSUPPORTED_RUNTIME\]/);
  assert.doesNotMatch(result.stderr, /Error: UNTRUSTED_RUNTIME_EXECUTED/);
});
