import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const script = join(dirname(fileURLToPath(import.meta.url)), 'deepinfra-burst-10000.mjs');

function harness({ total = 6, models = 2, crash = false } = {}, check) {
  const dir = mkdtempSync(join(tmpdir(), 'rdsh-burst-test-'));
  const keyFile = join(dir, 'dummy.env');
  const mockFile = join(dir, 'mock.mjs');
  const out = join(dir, 'result.json');
  try {
    writeFileSync(keyFile, 'DEEPINFRA_API_KEY=dummy-secret-never-record\n');
    writeFileSync(mockFile, `
      import https from 'node:https';
      import { EventEmitter } from 'node:events';
      globalThis.fetch = async (url) => {
        if (String(url).endsWith('/v1/me/rate_limit'))
          return new Response(JSON.stringify({ rate_limit: 200, tpm_rate_limit: 1100000 }), { status: 200 });
        if (String(url).endsWith('/v1/openai/models'))
          return new Response(JSON.stringify({ data: Array.from({length: ${models}}, (_, i) => ({
            id: 'test/model-' + i, metadata: { tags: ['chat'], pricing: { input_tokens: 0.02, output_tokens: 0.04 } },
          })) }), { status: 200 });
        throw new Error('Unexpected fetch: no network permitted in this test');
      };
      let posts = 0;
      https.request = (url, options, callback) => {
        const req = new EventEmitter();
        const socket = new EventEmitter();
        req.destroy = () => {};
        req.end = (body) => {
          const request = JSON.parse(body);
          const id = posts++;
          const shouldCrash = ${crash} && request.model === 'test/model-1';
          setTimeout(() => {
            const response = new EventEmitter();
            response.statusCode = 200;
            response.headers = { 'x-request-id': 'local-' + id };
            response.complete = true;
            callback(response);
            response.emit('data', Buffer.from(JSON.stringify({ model: request.model,
              choices: [{ message: { content: 'SECRET-RESPONSE' } }],
              usage: { estimated_cost: 0.0000002, prompt_tokens: 8, completion_tokens: 1 },
            })));
            response.emit('end');
            if (shouldCrash && id === 0) setTimeout(() => process.exit(17), 30);
          }, shouldCrash && id > 0 ? 2000 : ${total === 10000 ? 5000 : 200});
        };
        queueMicrotask(() => { req.emit('socket', socket); socket.emit('secureConnect'); });
        return req;
      };
    `);
    const env = { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(mockFile).href}` };
    const run = spawnSync(process.execPath, [script,
      '--key-file', keyFile, '--out', out, '--total', String(total), '--models', String(models),
      '--budget-usd', '0.0266',
    ], { encoding: 'utf8', timeout: 45_000, env });
    assert.equal(run.error, undefined);
    const result = JSON.parse(readFileSync(out, 'utf8'));
    for (const name of readdirSync(`${out}.journal`)) {
      const text = readFileSync(join(`${out}.journal`, name), 'utf8');
      assert.ok(!text.includes('dummy-secret-never-record'));
      assert.ok(!text.includes('SECRET-RESPONSE'));
    }
    check({ result, run, dir, out, env });
  } finally {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name.endsWith('.journal')) {
        for (const file of readdirSync(path)) unlinkSync(join(path, file));
        rmdirSync(path);
      } else unlinkSync(path);
    }
    rmdirSync(dir);
  }
}

test('process barrier starts an exact bounded burst across models', () => {
  harness({}, ({ result, run }) => {
    assert.equal(run.status, 0, run.stderr);
    assert.equal(result.phase, 'complete');
    assert.equal(result.targetSimultaneous, 6);
    assert.equal(result.completeWorkers, 2);
    assert.equal(result.launchedReported, 6);
    assert.equal(result.recordedStarts, 6);
    assert.equal(result.http200, 6);
    assert.equal(result.peakClientInFlight, 6);
    assert.equal(result.peakClientInFlightIsLowerBound, false);
  });
});

test('worker crash preserves completed requests and offline recovery never resends', () => {
  harness({ crash: true }, ({ result, run, dir, out, env }) => {
    assert.equal(run.status, 2, run.stderr);
    assert.equal(result.launchedReported, 6);
    assert.equal(result.http200, 4);
    assert.equal(result.interruptedUnknown, 2);
    assert.equal(result.notStarted, 0);
    assert.equal(result.byModel['test/model-1'].exitCode, 17);
    assert.equal(result.peakClientInFlightIsLowerBound, true);
    assert.ok(result.unknownReserveUsd > 0);
    const recovered = join(dir, 'recovered.json');
    const noNetwork = join(dir, 'no-network.mjs');
    writeFileSync(noNetwork, `import https from 'node:https';
      globalThis.fetch = https.request = () => { throw new Error('Recovery must be offline'); };`);
    const replay = spawnSync(process.execPath, [script, '--recover', out, '--out', recovered],
      { encoding: 'utf8', timeout: 5000,
        env: { ...env, NODE_OPTIONS: '--import=' + pathToFileURL(noNetwork).href } });
    assert.equal(replay.status, 2, replay.stderr);
    assert.equal(JSON.parse(readFileSync(recovered)).http200, 4);
    assert.equal(JSON.parse(readFileSync(recovered)).interruptedUnknown, 2);
    assert.ok(existsSync(out));
  });
});

test('10,000 simultaneous mock requests retain the exact send cap and all journals', () => {
  harness({ total: 10_000, models: 50 }, ({ result, run }) => {
    assert.equal(run.status, 0, run.stderr);
    assert.equal(result.targetSimultaneous, 10_000);
    assert.equal(result.launchedReported, 10_000);
    assert.equal(result.recordedStarts, 10_000);
    assert.equal(result.http200, 10_000);
    assert.equal(result.peakClientInFlight, 10_000);
    assert.equal(result.completeWorkers, 50);
    assert.equal(result.interruptedUnknown, 0);
    assert.ok(Object.values(result.byModel).every((model) => model.resultsRecorded === 200));
  });
});
