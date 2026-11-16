// Boots the real rdsh and the real DSH with the home each arm gets. No model
// is called: the boot stops at `--help`. Needs RDSH_BIN and RDSH_DSH_RUNTIME,
// the same variables tests/compaction-dsh.test.mjs uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepare, ARMS } from '../lib/runner.mjs';

const exec = promisify(execFile);
const binary = process.env.RDSH_BIN;
const runtime = process.env.RDSH_DSH_RUNTIME;

test('every arm boots through rdsh with one compaction row configured', {
  skip: binary && runtime ? false : 'RDSH_BIN and RDSH_DSH_RUNTIME are required', timeout: 180000,
}, async () => {
  const config = { rdsh: binary, dshRuntime: runtime,
    provider: { name: 'evalroute', baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnv: 'RDSH_EVAL_KEY',
      model: 'eval-model', contextWindow: 65536, outputReserve: 2048 },
    thresholds: { trigger_tokens: 6000, retain_tokens: 1200, max_tokens: 4096 } };
  for (const arm of ARMS) {
    const root = await mkdtemp(join(tmpdir(), 'rdsh-compaction-eval-boot-'));
    try {
      const { env, cwd, dshHome } = await prepare(root, config, arm, arm === 'candidate' ? 'Keep exact values.\nDo not call tools.' : undefined);
      const boot = await exec(binary, ['--no-slim', '--profile', 'headless', '--', '--help'], { env, cwd, timeout: 60000, maxBuffer: 4e6 });
      assert.match(boot.stderr, /policy overlay applied \(1 rows\)/, arm);
      // The overlay's file name is rdsh's business; find it by what it patches.
      const dir = join(dshHome, 'compaction');
      const overlays = (await readdir(dir)).filter(name => name.endsWith('.yml'));
      let patch;
      for (const name of overlays) {
        if ((await readFile(join(dir, name), 'utf8')).startsWith('- id: compaction-basic')) patch = join(dir, name);
      }
      assert.ok(patch, `${arm}: ${overlays.join(', ')}`);
      const dump = await exec(process.execPath, [env.RDSH_ORIG_BIN, '--profile', 'headless', '--patch', patch,
        '--dump-config'], { env, cwd, maxBuffer: 4e6 });
      assert.match(dump.stdout, /headroomTokens: 57488/, arm);
      assert.match(dump.stdout, /provider: evalroute/, arm);
      assert.equal(/method: '?off/.test(dump.stdout), arm === 'none', arm);
      assert.equal(dump.stdout.includes('Keep exact values.'), arm === 'candidate', arm);
      for (const id of ['tool-bash', 'tool-fs', 'tool-web']) {
        assert.match(dump.stdout, new RegExp(`- id: ${id}\\n(?:  .*\\n)*?  disabled: true`), `${arm} ${id}`);
      }
    } finally {
      assert.ok(root.startsWith(join(tmpdir(), 'rdsh-compaction-eval-boot-')));
      await rm(root, { recursive: true, force: true });
    }
  }
});
