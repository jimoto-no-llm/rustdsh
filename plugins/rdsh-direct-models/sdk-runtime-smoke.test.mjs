import test from 'node:test';
import assert from 'node:assert/strict';
import { runRuntimeSmoke, DEVIN_SMOKE_PROMPT } from './sdk-runtime-smoke.mjs';
test('installed DSH runtime executes approved read and blocks rejected Devin before spawn', async () => {
  const result = await runRuntimeSmoke({ spawnImpl: () => { throw new Error('Denied call must never spawn'); } });
  assert.equal(result.invalidArgumentsBlocked, true);
  assert.equal(result.readExecuted, true);
  assert.equal(result.readDenied, true);
  assert.equal(result.resultInModelHistory, true);
  assert.equal(result.devinDeniedWithoutSpawn, true);
  assert.equal(result.spawned, 0);
  assert.equal(result.devinExecuted, false);
  assert.equal(DEVIN_SMOKE_PROMPT, 'Reply exactly RDSH_DEVIN_TOOL_OK. Do not read files or use tools.');
});
test('supplied workspace and its existing files survive fixture cleanup', async () => {
  const { mkdtemp, writeFile, readdir, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const workspace = await mkdtemp(path.join(tmpdir(), 'rdsh-existing-fixture-'));
  try {
    const sentinel = path.join(workspace, 'keep.txt');
    await writeFile(sentinel, 'keep');
    await runRuntimeSmoke({ workspace });
    assert.equal(await readFile(sentinel, 'utf8'), 'keep');
    assert.deepEqual(await readdir(workspace), ['keep.txt']);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
