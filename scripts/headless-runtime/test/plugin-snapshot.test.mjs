import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const files = ['cleanup.mjs', 'cordis.patch.yml', 'index.js', 'package.json'];

test('candidate plugin snapshot exactly matches the canonical cleanup plugin', async () => {
  for (const file of files) {
    const [canonical, snapshot] = await Promise.all([
      readFile(path.join('plugins/rdsh-session-cleanup', file)),
      readFile(path.join('scripts/headless-runtime/runtime/plugins/rdsh-session-cleanup', file)),
    ]);
    assert.deepEqual(snapshot, canonical, `${file} must be copied into the immutable runtime unchanged`);
  }
});
