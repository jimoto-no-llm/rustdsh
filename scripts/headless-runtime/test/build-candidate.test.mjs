import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCandidate } from '../build-candidate.mjs';

test('failed candidate construction removes its uniquely-owned staging directory', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'rdsh-candidate-failure-'));
  const before = await readdir(parent);
  await assert.rejects(
    buildCandidate(path.join(parent, 'candidate'), { runCommand: async () => { throw new Error('injected offline install failure'); } }),
    /injected offline install failure/,
  );
  assert.deepEqual(await readdir(parent), before);
});
