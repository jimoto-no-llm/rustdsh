import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('the original Node PTC provider searches, describes and invokes through the original guarded dispatch', { timeout: 45000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rdsh-ptc-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
  await mkdir(home); await mkdir(workspace);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|LANG|LC_ALL)$/i.test(key)));
  Object.assign(environment, { HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, '.dsh') });
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./node-provider-fixture.mjs', import.meta.url))],
    { cwd: workspace, env: environment, timeout: 40000, maxBuffer: 1048576, windowsHide: true });
  const line = result.stdout.trim().split(/\r?\n/).find(candidate => candidate.startsWith('{"fixture":'));
  assert.ok(line, result.stdout + result.stderr);
  const proof = JSON.parse(line);
  assert.equal(proof.actualBodyCalls, 1);
  assert.equal(proof.guardDenied, true);
  assert.equal(proof.result.credentialAbsent, true);
  assert.equal(proof.nestedEvents, 5);
  t.diagnostic(JSON.stringify(proof));
});
