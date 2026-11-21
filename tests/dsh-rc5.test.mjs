import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The published 0.2.2-rc.* runtimes share one entry layout. RC.1 kept the
// alpha.3 dsh-tools bytes and rc.2 re-cut them, so each adapter stays separate.
const runtimes = {
  '0.2.2-rc.4': process.env.RDSH_AUDITED_RUNTIME_RC4_022,
  '0.2.2-rc.5': process.env.RDSH_AUDITED_RUNTIME_RC5_022,
};
const preload = path.resolve('security/preload.mjs');

function run(target, adapter, script) {
  return spawnSync(process.execPath, ['--import', preload, ...script], {
    env: { ...process.env,
      RDSH_TOOL_RUNTIME: target, RDSH_TOOL_ADAPTER: `dsh-tools-${adapter}`,
      RDSH_SECURE_WORKSPACE: process.cwd(), RDSH_SHARED_FILES: '[]',
      RDSH_SECURITY_LANG: 'en',
    }, encoding: 'utf8', timeout: 15000,
  });
}

for (const [version, runtime] of Object.entries(runtimes)) {
  test(`${version} constructs the guarded Cordis service and executes rdsh_inspect`, t => {
    if (!runtime) return t.skip(`set RDSH_AUDITED_RUNTIME_${version.endsWith('rc.5') ? 'RC5_022' : 'RC4_022'} to the published runtime`);
    const result = run(runtime, version, [path.resolve('tests/guarded-runtime-probe-022.mjs')]);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'ok');
  });

  test(`${version} refuses changed runtime bytes before importing them`, t => {
    if (!runtime) return t.skip(`set the ${version} runtime path`);
    const root = mkdtempSync(path.join(tmpdir(), 'rdsh-rc5-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const changed = path.join(root, 'runtime.mjs');
    writeFileSync(changed, readFileSync(runtime, 'utf8') + '\nthrow new Error("UNTRUSTED_RUNTIME_EXECUTED");');
    const result = run(changed, version, ['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(changed).href)})`]);
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /RDSH_SECURITY\[UNSUPPORTED_RUNTIME\]/);
    assert.doesNotMatch(result.stderr, /Error: UNTRUSTED_RUNTIME_EXECUTED/);
  });
}
