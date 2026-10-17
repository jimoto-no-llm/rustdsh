import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createOptimizer, policy, DEFAULT_POLICY } from '../optimizer.js';

const code = value => error => error.code === value;
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(config = {}) {
  const received = [];
  const backend = { inheritsParentContext: false, capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    async start(request) {
      received.push(request);
      return { id: String(received.length), localAgent: undefined, result: Promise.resolve({ output: [], stopReason: 'completed' }), async dispose() {} };
    } };
  const parent = { options: { provider: 'fixture-provider', model: 'fixture-model', maxTokens: 8000 }, permission: 'restricted' };
  const optimizer = createOptimizer({ getBackend: () => backend, snapshotContext: value => ({ agentOptions: { ...value.options }, policy: value.permission }), config });
  const request = text => ({ parent, prompt: [{ type: 'text', text }], signal: new AbortController().signal });
  return { optimizer, provider: optimizer.provider, backend, parent, request, received };
}

/** Policy keys the bundled DSH patch pins, read back from its YAML entry. */
async function bundlePolicy() {
  const text = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex(line => line.trim() === 'name: rdsh-subagent-optimizer');
  assert.notEqual(start, -1, 'cordis.patch.yml declares the optimizer');
  const config = {};
  let inConfig = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*-\s*id:/.test(line)) break;
    if (/^\s+config:\s*$/.test(line)) { inConfig = true; continue; }
    if (!inConfig) continue;
    const match = /^\s+([A-Za-z][A-Za-z0-9]*):\s*(\d+)\s*$/.exec(line);
    if (match) config[match[1]] = Number(match[2]);
  }
  return config;
}

test('the shipped policy admits one planned wave and its wait covers a queued run', async () => {
  // One default `rdsh subagents plan` wave is `max_parallel: 3` (src/subagent_plan.rs).
  assert.deepEqual(policy({}), { ...DEFAULT_POLICY });
  assert.equal(DEFAULT_POLICY.maxConcurrent, 3);
  assert.equal(DEFAULT_POLICY.waitTimeoutMs, 120000);
  // The wait ceiling has to allow a queue longer than one batch of real runs.
  assert.equal(policy({ waitTimeoutMs: 600000 }).waitTimeoutMs, 600000);
  assert.throws(() => policy({ waitTimeoutMs: 600001 }), code('RDSH_SUBAGENT_INVALID_POLICY'));
  const bundled = await bundlePolicy();
  assert.deepEqual(Object.keys(bundled).sort(), ['maxConcurrent', 'maxDepth', 'maxQueued', 'maxTokens', 'waitTimeoutMs']);
  for (const [key, value] of Object.entries(bundled)) {
    assert.equal(value, DEFAULT_POLICY[key], `bundled ${key} must equal the code default`);
  }
});

test('the effective policy is observable per optimizer and config overrides win', () => {
  const f = fixture({ maxConcurrent: 5, waitTimeoutMs: 60000 });
  assert.deepEqual(f.optimizer.limits, { ...DEFAULT_POLICY, maxConcurrent: 5, waitTimeoutMs: 60000 });
  assert.equal(Object.isFrozen(f.optimizer.limits), true);
  assert.deepEqual(fixture().optimizer.limits, { ...DEFAULT_POLICY });
});

test('fresh provider caps output/depth and forwards the prompt, model, schema and tool restrictions unchanged', async () => {
  const f = fixture();
  const request = { ...f.request('self-contained task'), agentOptions: { provider: 'other', model: 'selected', reasoningEffort: 'high', maxTokens: 2000 }, maxDepth: 0,
    toolFilter: { allow: ['read-file'] }, outputSchema: { type: 'object' }, persona: 'selected persona' };
  const original = structuredClone({ prompt: request.prompt, agentOptions: request.agentOptions });
  const run = await f.provider.start(request);
  assert.equal(f.provider.inheritsParentContext, false);
  assert.equal(f.provider.prepareContinuable, undefined);
  assert.deepEqual(f.received[0].agentOptions, request.agentOptions);
  assert.equal(f.received[0].prompt, request.prompt);
  assert.equal(f.received[0].toolFilter, request.toolFilter);
  assert.equal(f.received[0].outputSchema, request.outputSchema);
  assert.equal(f.received[0].maxDepth, 0);
  assert.deepEqual({ prompt: request.prompt, agentOptions: request.agentOptions }, original);
  await run.dispose();
  const capped = await f.provider.start(f.request('different task'));
  assert.equal(f.received[1].agentOptions.maxTokens, 4096);
  assert.equal(f.received[1].maxDepth, 1);
  await capped.dispose();
});

test('FIFO capacity remains occupied after result settlement until native cleanup confirms quiescence', async () => {
  const f = fixture({ maxConcurrent: 1 });
  const first = await f.provider.start(f.request('first'));
  await first.result;
  const waiting = f.provider.start(f.request('second'));
  await tick();
  assert.equal(f.received.length, 1);
  assert.deepEqual(f.optimizer.stats(), { active: 1, queued: 1, starts: 1, duplicates: 0 });
  await first.dispose();
  const second = await waiting;
  assert.equal(f.received[1].prompt[0].text, 'second');
  await second.dispose();
  assert.equal(f.optimizer.stats().active, 0);
});

test('active duplicates are rejected only within one exact parent; later explicit repetition remains possible', async () => {
  const f = fixture();
  const first = await f.provider.start(f.request('same task'));
  await assert.rejects(f.provider.start(f.request('same task')), code('RDSH_SUBAGENT_DUPLICATE_ACTIVE'));
  const other = await f.provider.start({ ...f.request('same task'), parent: { options: { ...f.parent.options }, permission: 'restricted' } });
  await first.dispose(); await other.dispose();
  const repeated = await f.provider.start(f.request('same task'));
  await repeated.dispose();
  assert.equal(f.optimizer.stats().starts, 3);
});

test('queue overflow, cancellation and deadline never start a backend operation', async () => {
  const f = fixture({ maxConcurrent: 1, maxQueued: 1, waitTimeoutMs: 30 });
  const first = await f.provider.start(f.request('first'));
  const abort = new AbortController();
  const waiting = f.provider.start({ ...f.request('second'), signal: abort.signal });
  await tick();
  await assert.rejects(f.provider.start(f.request('third')), code('RDSH_SUBAGENT_QUEUE_FULL'));
  abort.abort();
  await assert.rejects(waiting, code('RDSH_SUBAGENT_CANCELLED'));
  await assert.rejects(f.provider.start(f.request('deadline')), code('RDSH_SUBAGENT_WAIT_TIMEOUT'));
  assert.equal(f.received.length, 1);
  await first.dispose();
});

test('queued requests reject changed parent model or permission rather than inheriting the new state', async () => {
  for (const change of [f => f.parent.options.model = 'changed', f => f.parent.permission = 'broader']) {
    const f = fixture({ maxConcurrent: 1 });
    const first = await f.provider.start(f.request('first'));
    const waiting = f.provider.start(f.request('queued'));
    await tick(); change(f); await first.dispose();
    await assert.rejects(waiting, code('RDSH_SUBAGENT_CONTEXT_CHANGED'));
    assert.equal(f.received.length, 1);
    assert.equal(f.optimizer.stats().active, 0);
  }
});

test('failed startup frees admission while failed native disposal retains it until a successful retry', async () => {
  const f = fixture({ maxConcurrent: 1 });
  const normal = f.backend.start;
  f.backend.start = async () => { throw new Error('fixture startup failure'); };
  await assert.rejects(f.provider.start(f.request('retry')));
  assert.equal(f.optimizer.stats().active, 0);
  let disposals = 0;
  f.backend.start = async request => {
    const run = await normal(request);
    run.dispose = async () => { if (++disposals === 1) throw new Error('fixture uncertain cleanup'); };
    return run;
  };
  const run = await f.provider.start(f.request('retry'));
  await assert.rejects(run.dispose());
  assert.equal(f.optimizer.stats().active, 1);
  await run.dispose(); await run.dispose();
  assert.equal(disposals, 2);
  assert.equal(f.optimizer.stats().active, 0);
});

test('unloading during unpublished startup cancels it and cleans a late-owned handle before returning', async () => {
  const f = fixture();
  let publish, nativeSignal, disposed = 0;
  f.backend.start = request => { nativeSignal = request.signal; return new Promise(resolve => publish = resolve); };
  const starting = f.provider.start(f.request('starting'));
  await tick();
  const closed = f.optimizer.close();
  assert.equal(nativeSignal.aborted, true);
  publish({ id: 'late', result: Promise.resolve({ output: [], stopReason: 'aborted' }), async dispose() { disposed++; } });
  await assert.rejects(starting, code('RDSH_SUBAGENT_CLOSED'));
  await closed;
  assert.equal(disposed, 1);
  assert.equal(f.optimizer.stats().active, 0);
});

test('invalid limits, oversized prompts and context-inheriting backends are refused before dispatch', async () => {
  assert.throws(() => policy({ maxConcurrent: 0 }));
  assert.throws(() => policy({ unexpected: true }));
  const f = fixture({ maxPromptBytes: 32 });
  await assert.rejects(f.provider.start(f.request('x'.repeat(64))), code('RDSH_SUBAGENT_PROMPT_TOO_LARGE'));
  f.backend.inheritsParentContext = true;
  await assert.rejects(f.provider.start(f.request('small')), code('RDSH_SUBAGENT_FRESH_BACKEND_REQUIRED'));
  assert.equal(f.received.length, 0);
});

test('a synthetic burst of 20 identical tasks starts one native run instead of 20', async () => {
  const baseline = fixture();
  const ordinary = await Promise.all(Array.from({ length: 20 }, () => baseline.backend.start(baseline.request('same'))));
  await Promise.all(ordinary.map(run => run.dispose()));
  assert.equal(baseline.received.length, 20);
  const f = fixture();
  const burst = await Promise.allSettled(Array.from({ length: 20 }, () => f.provider.start(f.request('same'))));
  assert.equal(burst.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.received.length, 1); assert.equal(f.optimizer.stats().duplicates, 19);
  await burst.find(result => result.status === 'fulfilled').value.dispose();
  await f.optimizer.close();
});

test('a queued request refuses replacement of its selected backend before dispatch', async () => {
  let selected;
  const f = fixture({ maxConcurrent: 1 }); selected = f.backend;
  const optimizer = createOptimizer({ getBackend: () => selected, snapshotContext: parent => ({ agentOptions: parent.options }), config: { maxConcurrent: 1 } });
  const first = await optimizer.provider.start(f.request('first'));
  const queued = assert.rejects(optimizer.provider.start(f.request('queued')), code('RDSH_SUBAGENT_CONTEXT_CHANGED'));
  await tick(); selected = { ...f.backend };
  await first.dispose(); await queued;
  assert.equal(f.received.length, 1); assert.equal(optimizer.stats().active, 0);
  await optimizer.close();
});

test('equal prompts with distinct model routes, schemas and tool scopes remain separate work', async () => {
  const f = fixture({ maxConcurrent: 8 });
  const variations = [{}, { agentOptions: { provider: 'other', model: 'other' } }, { outputSchema: { type: 'object' } },
    { toolFilter: { allow: ['read-file'] } }, { persona: 'selected persona' }, { maxDepth: 0 }];
  const runs = await Promise.all(variations.map(options => f.provider.start({ ...f.request('same prompt'), ...options })));
  assert.equal(f.received.length, variations.length); assert.equal(f.optimizer.stats().duplicates, 0);
  await Promise.all(runs.map(run => run.dispose())); await f.optimizer.close();
});

test('concurrent dispose calls share native cleanup and unloading rejects all queued work', async () => {
  const f = fixture({ maxConcurrent: 1 }); let finish, disposals = 0;
  f.backend.start = async () => ({ id: 'fixture', result: Promise.resolve({ output: [] }), dispose() {
    disposals++; return new Promise(resolve => finish = resolve);
  } });
  const run = await f.provider.start(f.request('active'));
  const queued = assert.rejects(f.provider.start(f.request('queued')), code('RDSH_SUBAGENT_CANCELLED'));
  const first = run.dispose(), second = run.dispose(); assert.equal(first, second);
  await tick(); assert.equal(disposals, 1);
  const closed = f.optimizer.close(); await queued;
  assert.equal(f.optimizer.stats().active, 1);
  finish(); await first; await closed;
  assert.deepEqual(f.optimizer.stats(), { active: 0, queued: 0, starts: 1, duplicates: 0 });
});
