import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = join(dirname(fileURLToPath(import.meta.url)), 'deepinfra-load-test.mjs');

test('failed requests cannot push attempts above the configured cap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rdsh-deepinfra-test-'));
  const keyFile = join(dir, 'dummy.env');
  try {
    writeFileSync(keyFile, 'DEEPINFRA_API_KEY=dummy\n');
    const mock = `
      let posts = 0;
      globalThis.fetch = async (url) => {
        if (String(url).endsWith('/v1/me/rate_limit'))
          return new Response(JSON.stringify({ rate_limit: 200 }), { status: 200 });
        posts++;
        if (posts === 1) return new Response('{}', { status: 500 });
        return new Response(JSON.stringify({
          model: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
          choices: [{ message: { content: 'READY' } }],
          usage: { estimated_cost: 0.00000038, prompt_tokens: 15, completion_tokens: 2 },
        }), { status: 200 });
      };
    `;
    const run = spawnSync(process.execPath, [
      '--import', `data:text/javascript,${encodeURIComponent(mock)}`, script,
      '--key-file', keyFile, '--max-success', '3', '--max-requests', '3',
      '--concurrency', '3', '--budget-usd', '0.001', '--seconds', '30',
    ], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 2, run.stderr);
    const result = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(result.attempted, 3);
    assert.equal(result.succeeded, 2);
    assert.equal(result.stopReason, 'request_limit');
    assert.equal(result.peakClientInFlight, 3);
  } finally {
    unlinkSync(keyFile);
    rmdirSync(dir);
  }
});
