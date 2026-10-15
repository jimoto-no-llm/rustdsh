import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('exit proof accepts drained event loops and rejects forced exit 0', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rdsh-natural-exit-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = fileURLToPath(new URL('./fixtures/natural-exit-proof-child.mjs', import.meta.url));
  for (const forced of [false, true]) {
    const evidence = path.join(root, `${forced}.json`);
    await promisify(execFile)(process.execPath, [fixture], {
      env: { RDSH_CLEANUP_DIAGNOSTIC: evidence, RDSH_TEST_FORCE_EXIT: forced ? '1' : '0' },
      timeout: 5_000,
    });
    assert.equal(JSON.parse(await readFile(evidence, 'utf8')).naturalExitObserved, !forced);
  }
});
