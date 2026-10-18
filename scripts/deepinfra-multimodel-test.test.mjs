import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = join(dirname(fileURLToPath(import.meta.url)), 'deepinfra-multimodel-test.mjs');

test('multi-model burst respects total request cap and per-model limit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rdsh-multimodel-test-'));
  const keyFile = join(dir, 'dummy.env');
  const out = join(dir, 'result.json');
  try {
    writeFileSync(keyFile, 'DEEPINFRA_API_KEY=dummy\n');
    const mock = `
      globalThis.fetch = async (url, options = {}) => {
        if (String(url).endsWith('/v1/me/rate_limit'))
          return new Response(JSON.stringify({ rate_limit: 3, tpm_rate_limit: 100 }), { status: 200 });
        if (String(url).endsWith('/v1/openai/models'))
          return new Response(JSON.stringify({ data: ['a/one', 'b/two'].map(id => ({
            id, metadata: { tags: ['chat'], pricing: { input_tokens: 0.02, output_tokens: 0.04 } },
          })) }), { status: 200 });
        const request = JSON.parse(options.body);
        return new Response(JSON.stringify({ model: request.model,
          choices: [{ message: { content: '1' } }],
          usage: { estimated_cost: 0.0000002, prompt_tokens: 8, completion_tokens: 1 },
        }), { status: 200 });
      };
    `;
    const run = spawnSync(process.execPath, [
      '--import', `data:text/javascript,${encodeURIComponent(mock)}`, script,
      '--key-file', keyFile, '--out', out, '--max-requests', '6',
      '--budget-usd', '0.001', '--seconds', '30',
    ], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(result.attempted, 6);
    assert.equal(result.http200, 6);
    assert.equal(result.plannedBurst, 4);
    assert.equal(result.pilotAttempted, 2);
    assert.equal(result.peakClientInFlight, 4);
    assert.ok(Object.values(result.byModel).every((model) => model.attempted <= 3));
  } finally {
    unlinkSync(keyFile);
    if (existsSync(out)) unlinkSync(out);
    rmdirSync(dir);
  }
});

function runFailureCase(kind) {
  const dir = mkdtempSync(join(tmpdir(), 'rdsh-multimodel-fallback-'));
  const keyFile = join(dir, 'dummy.env');
  const out = join(dir, 'result.json');
  try {
    writeFileSync(keyFile, 'DEEPINFRA_API_KEY=dummy\n');
    const mock = `
      let posts = 0;
      globalThis.fetch = async (url, options = {}) => {
        if (String(url).endsWith('/v1/me/rate_limit'))
          return new Response(JSON.stringify({ rate_limit: 10, tpm_rate_limit: 1000 }), { status: 200 });
        if (String(url).endsWith('/v1/openai/models'))
          return new Response(JSON.stringify({ data: ['a/one', 'b/two', 'c/three'].map(id => ({
            id, metadata: { tags: ['chat'], pricing: { input_tokens: 0.02, output_tokens: 0.04 } },
          })) }), { status: 200 });
        posts++;
        if (posts === 4 && '${kind}' === 'rate_limit')
          return new Response('{}', { status: 429 });
        if (posts === 4 && '${kind}' === 'server')
          return new Response('{}', { status: 503 });
        if (posts === 4 && '${kind}' === 'unknown')
          throw Object.assign(new TypeError('connect failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
        const request = JSON.parse(options.body);
        return new Response(JSON.stringify({ model: request.model,
          choices: [{ message: { content: '1' } }],
          usage: { estimated_cost: 0.0000002, prompt_tokens: 8, completion_tokens: 1 },
        }), { status: 200 });
      };
    `;
    const run = spawnSync(process.execPath, [
      '--import', `data:text/javascript,${encodeURIComponent(mock)}`, script,
      '--key-file', keyFile, '--out', out, '--max-requests', '20',
      '--budget-usd', '0.001', '--seconds', '30', '--max-in-flight', '2',
    ], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 2, run.stderr);
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally {
    unlinkSync(keyFile);
    if (existsSync(out)) unlinkSync(out);
    rmdirSync(dir);
  }
}

test('confirmed 429 switches model within the request cap', () => {
  const result = runFailureCase('rate_limit');
  assert.equal(result.pilotAttempted, 3);
  assert.equal(result.attempted, 20);
  assert.equal(result.rateLimited, 1);
  assert.equal(result.fallbackAttempted, 1);
  assert.equal(result.http200, 19);
  assert.equal(result.transportUnknown, 0);
});

test('unknown outcome opens circuit without retrying or filling the cap', () => {
  const result = runFailureCase('unknown');
  assert.ok(result.attempted < 20);
  assert.equal(result.transportUnknown, 1);
  assert.equal(result.fallbackAttempted, 0);
  assert.equal(result.stopReason, 'unreconciled_transport_unknown');
  assert.equal(result.transportErrors['TypeError:UND_ERR_CONNECT_TIMEOUT'], 1);
});

test('server error is treated as unknown instead of a safe fallback', () => {
  const result = runFailureCase('server');
  assert.ok(result.attempted < 20);
  assert.equal(result.serverUnknown, 1);
  assert.equal(result.fallbackAttempted, 0);
  assert.equal(result.stopReason, 'unreconciled_server_unknown');
});
