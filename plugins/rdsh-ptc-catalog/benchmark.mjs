import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { getEncoding } from 'js-tiktoken';
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { SEARCH, DESCRIBE } from './catalog.js';
import { fixture, tool, canonicalValue } from './test/fixtures.mjs';

const require = createRequire(import.meta.url);
const encoder = getEncoding('cl100k_base');
const tokens = text => encoder.encode(text, [], []).length;
const arguments_ = process.argv.slice(2);
if (arguments_.length !== 0 && (arguments_.length !== 2 || arguments_[0] !== '--output' || !arguments_[1]))
  throw new Error('Usage: node benchmark.mjs [--output NEW-FILE.json]');

const cases = Array.from({ length: 80 }, (_, index) => {
  const service = String((index * 7) % 20).padStart(2, '0');
  const action = String((index * 13) % 50).padStart(2, '0');
  return { name: `mcp/service${service}/read_${action}`, query: `service${service} action${action}`,
    namespace: index % 2 ? `mcp/service${service}` : '', key: `expected-${index}` };
});

async function measure(enabled) {
  const f = fixture({ catalog: enabled });
  let bodyCalls = 0, incorrectCalls = 0, completed = 0, lookupSuccesses = 0, roundTrips = 0;
  const bodyNames = [];
  try {
    for (let service = 0; service < 20; service++) for (let action = 0; action < 50; action++) {
      const server = String(service).padStart(2, '0'), op = String(action).padStart(2, '0');
      const name = `mcp/service${server}/read_${op}`;
      const definition = tool(name, `Read service${server} action${op} job status and its immutable receipt.`, async args => {
        bodyCalls++; bodyNames.push(name);
        return { value: args.key };
      });
      definition.parameters.properties.options = { type: 'object', properties: {
        mode: { type: 'string', enum: ['summary', 'full'] },
        labels: { type: 'array', items: { type: 'string' } },
        includeHistory: { type: 'boolean' },
      }, required: ['mode'], additionalProperties: false };
      f.tools.register(definition);
    }
    f.tools.register(tool('hidden/fixture', 'HIDDEN_BENCHMARK_SENTINEL'));
    const agent = f.agent(), sibling = f.agent();
    sibling.ctx.tools.register(tool('sibling/fixture', 'SIBLING_BENCHMARK_SENTINEL'));
    agent.ctx.tools.restrict({ deny: ['hidden/fixture'] });
    // Measure the actual original assembly, including its full SDK work even
    // when the public post-assembly hook replaces the model-facing section.
    const times = [];
    let assembly;
    for (let iteration = 0; iteration < 5; iteration++) {
      const start = performance.now();
      assembly = await f.prompt.assemble({ scope: agent });
      times.push(performance.now() - start);
    }
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk').text;
    const prompt = renderPrompt(assembly), inputTokens = tokens(prompt);
    assert.doesNotMatch(prompt, /HIDDEN_BENCHMARK_SENTINEL|SIBLING_BENCHMARK_SENTINEL/);
    if (enabled) {
      assert.ok(Buffer.byteLength(sdk, 'utf8') <= 16384);
      assert.ok(tokens(sdk) <= Buffer.byteLength(sdk, 'utf8'));
    }
    let payloadInputTokens = 0;
    const retrievalTimes = [];
    for (const item of cases) {
      let name = item.name;
      if (enabled) {
        const start = performance.now();
        const discovery = canonicalValue(await f.run(agent, async bindings => {
          const found = await bindings[SEARCH]({ query: item.query, namespace: item.namespace, limit: 3 });
          const candidate = found.tools[0]?.name;
          if (!candidate) return { status: 'not_found' };
          return { search: found, description: await bindings[DESCRIBE]({ name: candidate, revision: found.revision }) };
        })).result;
        retrievalTimes.push(performance.now() - start);
        roundTrips++;
        name = discovery.description?.tool.name;
        if (name === item.name && discovery.description.status === 'ok') lookupSuccesses++;
        payloadInputTokens += inputTokens + tokens(JSON.stringify(discovery));
      } else {
        // Oracle lookup in the complete original declarations. This is a
        // controlled fixture baseline, NOT a model's tool-selection accuracy.
        if (sdk.includes(item.name)) lookupSuccesses++;
      }
      if (name !== item.name) { incorrectCalls++; continue; }
      const before = bodyNames.length;
      const outcome = canonicalValue(await f.run(agent, bindings => bindings[name]({ key: item.key }))).result;
      roundTrips++;
      payloadInputTokens += inputTokens;
      if (bodyNames.length !== before + 1 || bodyNames.at(-1) !== item.name || outcome.value !== item.key) incorrectCalls++;
      else completed++;
    }
    const beforeAddition = sdk;
    f.tools.register(tool('new/unrelated', 'Added after measurement.'));
    const afterAddition = (await f.prompt.assemble({ scope: agent })).sections.find(section => section.name === 'tools:sdk').text;
    times.sort((a, b) => a - b);
    retrievalTimes.sort((a, b) => a - b);
    assert.equal(incorrectCalls, 0);
    assert.equal(completed, cases.length);
    assert.equal(bodyCalls, cases.length);
    assert.equal(lookupSuccesses, cases.length);
    if (enabled) assert.equal(afterAddition, beforeAddition);
    return {
      visibleCapabilityTools: 1000, queryFixtures: cases.length,
      encoding: 'cl100k_base', sdkInputTokens: tokens(sdk), completePromptInputTokens: inputTokens,
      sdkUtf8Bytes: Buffer.byteLength(sdk, 'utf8'), inlineBudgetTokenUpperBound: enabled ? 16384 : null,
      inputPayloadTokens: payloadInputTokens, inputPayloadTokensPerFixture: payloadInputTokens / cases.length,
      lookupSuccesses, lookupSuccessRate: lookupSuccesses / cases.length,
      incorrectBodyCalls: incorrectCalls, scriptedMiscallRate: incorrectCalls / cases.length,
      completed, actualBodyCalls: bodyCalls, ptcSubmissions: roundTrips, ptcSubmissionsPerFixture: roundTrips / cases.length,
      nestedDispatches: f.events.filter(event => event.type === 'tool/ptc-dispatch').length,
      sdkStableAfterUnrelatedAddition: afterAddition === beforeAddition,
      assemblyMedianMs: times[Math.floor(times.length / 2)],
      retrievalMedianMs: retrievalTimes.length ? retrievalTimes[Math.floor(retrievalTimes.length / 2)] : null,
    };
  } finally { await f.close(); }
}

const baseline = await measure(false), catalog = await measure(true);
const files = ['catalog.js', 'tools.js', 'index.js', 'benchmark.mjs', 'test/fixtures.mjs', 'package-lock.json'];
const sourceFiles = {};
for (const name of files) sourceFiles[name] = createHash('sha256').update(await readFile(new URL(name, import.meta.url))).digest('hex');
const tokenizerPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.resolve('js-tiktoken')), 'utf8'));
const report = {
  version: 1, fixture: '1000-tool-scoped-original-ptc',
  runtime: { node: process.versions.node, platform: process.platform,
    dshTools: require('@deepseek-ai/dsh-tools/package.json').version,
    tokenizer: `js-tiktoken ${tokenizerPackage.version} cl100k_base` },
  limitations: [
    'No model or paid API was called. Fixed callbacks exercise the original run_code dispatcher with a test provider; the separate Node-provider test exercises real program execution.',
    'Encoded strings use cl100k_base, not a DeepSeek tokenizer or provider-billed usage. Input payload totals include the complete prompt per PTC submission and the discovery result, excluding request envelopes and earlier conversation.',
    'Lookup and miscall rates are scripted fixture results; the baseline knows the intended exact name. They are not model-quality measurements.',
    'PTC submissions count outer run_code requests. Search and describe are nested calls in one discovery submission; invocation is the second submission.',
    'The public assembly hook still incurs original full SDK assembly CPU cost. The budget bounds model-facing declarations, not that upstream allocation.',
  ],
  sourceFiles, baseline, catalog,
  comparison: { sdkInputTokenReduction: 1 - catalog.sdkInputTokens / baseline.sdkInputTokens,
    payloadInputTokenReduction: 1 - catalog.inputPayloadTokens / baseline.inputPayloadTokens },
};
if (arguments_.length) await writeFile(arguments_[1], JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
