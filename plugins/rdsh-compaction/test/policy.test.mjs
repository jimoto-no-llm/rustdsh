import test from 'node:test';
import assert from 'node:assert/strict';
import { earlyConfig, policyOptions, decideWithRust } from '../policy.mjs';
import { withInstructions } from '../engine.mjs';

test('unsupported methods and malformed early policies fail at construction', () => {
  for (const method of ['provider_native', 'background', 'pause_after']) {
    assert.throws(() => policyOptions({ rdshRoutes: [{ provider: 'p', model: 'm', method }] }));
  }
  assert.throws(() => policyOptions({ rdshEarly: { expected_turns: 4, min_tokens: 100 } }));
});

test('off suppresses both automatic triggers and preserves manual compaction', async () => {
  class Base {
    constructor(_ctx, config) { this.config = config; }
    compactIfNeeded() { return 'automatic'; }
    compactNow() { return 'manual'; }
  }
  const Engine = withInstructions(Base);
  const engine = new Engine({}, { rdshRoutes: [{ provider: 'p', model: 'm', method: 'off' }] });
  const agent = { session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } };
  assert.equal(await engine.compactIfNeeded(agent, 'pressure'), null);
  assert.equal(await engine.compactIfNeeded(agent, 'context-overflow'), null);
  assert.equal(engine.compactNow(), 'manual');
  assert.equal(engine.config.rdshRoutes, undefined);
  agent.session.requestHeader = () => ({ config: { provider: 'unknown', model: 'm' } });
  assert.equal(await engine.compactIfNeeded(agent, 'pressure'), 'automatic');
});

function fixture(totalTokens = 30000) {
  return {
    engine: {
      rdshPolicy: { routes: [], early: { expected_turns: 10, min_tokens: 10000 }, binary: 'rdsh' },
      config: { thresholdRatio: 0.8, headroomTokens: 10000, retainTokens: 1000,
        maxTokens: 500, modelPolicies: [] },
      ctx: { tokenMeter: { measure: () => ({ totalTokens, surfaceTokens: totalTokens - 1000,
        nodes: [{ seq: 1, tokens: 20000 }, { seq: 2, tokens: 8000 }, { seq: 3, tokens: 1000 }] }) },
        llm: { resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 4096 }) } },
    },
    agent: { session: { surface: { nodes: [1, 2, 3] }, eventAt: () => ({ type: 'user/message' }),
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } },
  };
}

test('early compaction uses count-only Rust input without mutating shared policy', async () => {
  const { engine, agent } = fixture();
  const before = structuredClone(engine.config);
  let seen;
  const config = await earlyConfig(engine, agent, undefined, {
    balanced: () => true,
    prices: () => ({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }),
    decide: async (_binary, input) => { seen = input; return { compact: true }; },
  });
  assert.deepEqual(engine.config, before);
  assert.equal(config.modelPolicies[0].headroomTokens, 65904);
  assert.equal(seen.prices.cache_read, 0.1 / 1e6);
  assert.ok(!('messages' in seen));
  assert.ok(!('provider' in seen));
});

test('pressure, unknown prices and a separate summarizer never invoke early cost evaluation', async () => {
  for (const setup of ['pressure', 'unknown', 'separate']) {
    const { engine, agent } = fixture(setup === 'pressure' ? 90000 : 30000);
    if (setup === 'separate') engine.config.summarizationProvider = 'elsewhere';
    const config = await earlyConfig(engine, agent, undefined, {
      prices: () => undefined, decide: () => { throw new Error('must not be called'); },
    });
    assert.equal(config, undefined);
  }
});

test('real Rust cost bridge changes the decision when cache prices change', {
  skip: process.env.RDSH_BIN ? false : 'RDSH_BIN is required for the binary contract',
}, async () => {
  const input = { current: 1000, trigger: 2000, prefix: 0, replaced: 1000,
    summary: 10, tail: 0, instruction: 1, summarizer_reuses_prefix: true,
    expected_turns: 2, prices: { input: 1, output: 1, cache_read: 1, cache_write: 1 } };
  const yes = await decideWithRust(process.env.RDSH_BIN, input);
  assert.equal(yes.compact, true);
  input.prices.cache_read = 0;
  const no = await decideWithRust(process.env.RDSH_BIN, input);
  assert.equal(no.compact, false);
});
