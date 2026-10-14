import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as pause } from 'node:timers/promises';
import { getEncoding } from 'js-tiktoken';
import * as McpClient from '@deepseek-ai/dsh-mcp-client';
import * as bundle from './index.js';
import { SEARCH, LOAD } from './discovery.js';
import { fixture, value } from './test/fixtures.mjs';
import { mcpFixture, tool } from './test/mcp-fixture.mjs';

// Fixed, offline ground truth. The real MCP SDK/client speak only loopback HTTP.
// No agent/model generation, credentials, external server or billing API.
const count = 1000, cases = 80, controlledListDelayMs = 250;
const descriptors = Array.from({ length: count }, (_, index) => tool(`read_${String(index).padStart(4, '0')}`,
  `Read fixed fixture record ${index}. Return its fixture value for the supplied key. This tool has no external side effects.`));
const queries = Array.from({ length: cases }, (_, index) => ({
  rawName: descriptors[(index * 13 + 7) % count].name, key: `case-${String(index).padStart(3, '0')}`,
}));
const tokenizer = getEncoding('cl100k_base');
const require = createRequire(import.meta.url);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const timing = values => ({ samples: values.length, median: median(values), min: Math.min(...values), max: Math.max(...values) });
const tokens = value => tokenizer.encode(JSON.stringify(value)).length;
const sourceFiles = ['index.js', 'policy.js', 'discovery.js', 'tools.js', 'package.json', 'package-lock.json',
  'benchmark.mjs', 'test/fixtures.mjs', 'test/mcp-fixture.mjs'];
const arguments_ = process.argv.slice(2);
assert.ok(arguments_.length === 0 || (arguments_.length === 2 && arguments_[0] === '--output'), 'use --output <new-json-path>');

async function sampleAssembly(f, agent) {
  const times = [];
  for (let index = 0; index < 5; index++) {
    const start = performance.now(); await f.prompt.assemble({ scope: agent }); times.push(performance.now() - start);
  }
  return timing(times);
}

async function run(candidate) {
  const remote = await mcpFixture({ tools: descriptors, blocked: true, listDelayMs: controlledListDelayMs });
  const f = fixture({ setupDiscovery: false });
  try {
    const connection = McpClient.Config({ transport: 'streamable-http', serverName: 'fixed', url: remote.url,
      failOnStartupError: true, reconnect: { enabled: false } });
    const start = performance.now();
    if (candidate) await bundle.apply(f.ctx, bundle.Config({ servers: [{ connection, exposure: 'deferred' }] }));
    else await McpClient.apply(f.ctx, connection);
    const activationMs = performance.now() - start;
    // Proof instrumentation: make the candidate's first prompt while the
    // original tools/list request is actually pending, not before it is sent.
    for (let attempt = 0; !remote.listing && attempt < 100; attempt++) await pause(1);
    assert.ok(remote.listing > 0, 'the actual MCP client must send tools/list');
    const agent = f.agent(), initial = await f.prompt.assemble({ scope: agent });
    const firstPromptMs = performance.now() - start, firstPromptBeforeListRelease = !remote.released;
    const initialMcpTools = initial.tools.filter(schema => schema.name.startsWith('mcp__')).length;
    assert.equal(initialMcpTools, candidate ? 0 : count);
    if (candidate) assert.equal(firstPromptBeforeListRelease, true, 'a deferred server must not hold the first prompt');
    if (candidate) value(await f.execute(agent, SEARCH, { query: queries[0].rawName }));
    const initialAssemblyMs = await sampleAssembly(f, agent);
    const discoveryTimes = [], callTimes = [];
    let correct = 0, lookupCorrect = 0, exampleCall;
    for (const query of queries) {
      const publicName = `mcp__fixed__${query.rawName}`;
      if (candidate) {
        const discoveryStart = performance.now();
        const found = value(await f.execute(agent, SEARCH, { query: publicName }));
        assert.equal(found.results.length, 1);
        assert.equal(found.results[0].name, publicName); lookupCorrect++;
        const args = { names: [publicName], revision: found.revision };
        const loaded = await f.execute(agent, LOAD, args); assert.equal(value(loaded).status, 'loaded');
        f.persistNative(agent, LOAD, args, loaded);
        discoveryTimes.push(performance.now() - discoveryStart);
      }
      const callStart = performance.now();
      const result = value(await f.execute(agent, publicName, { key: query.key }));
      callTimes.push(performance.now() - callStart);
      const actual = remote.calls.at(-1);
      assert.deepEqual(actual, { name: query.rawName, arguments: { key: query.key } });
      assert.equal(result.structuredContent.value, `FIXTURE:${query.rawName}:${query.key}`); correct++;
      exampleCall ??= { actualWireRequest: actual, actualStructuredContent: result.structuredContent };
    }
    assert.equal(remote.calls.length, cases);
    const final = await f.prompt.assemble({ scope: agent });
    const finalMcpTools = final.tools.filter(schema => schema.name.startsWith('mcp__')).length;
    assert.equal(finalMcpTools, candidate ? cases : count);
    return {
      output: { firstDeclarations: initial.tools.slice(0, 5).map(schema => schema.name),
        lastDeclarations: final.tools.slice(0, 5).map(schema => schema.name), exampleCall },
      initial: { declaredMcpTools: initialMcpTools, totalDeclaredTools: initial.tools.length,
        schemaTokens: tokens(initial.tools), fullAssemblyTokens: tokens(initial),
        schemaBytes: Buffer.byteLength(JSON.stringify(initial.tools)), activationMs, firstPromptMs,
        firstPromptBeforeListRelease, assemblyMs: initialAssemblyMs },
      after80Loads: { declaredMcpTools: finalMcpTools, totalDeclaredTools: final.tools.length,
        schemaTokens: tokens(final.tools), fullAssemblyTokens: tokens(final), assemblyMs: await sampleAssembly(f, agent) },
      correctness: { cases, correctWireCalls: correct, wrongWireCalls: cases - correct,
        ...(candidate ? { exactLookupMatches: lookupCorrect } : {}) },
      calls: { nativeMcpCalls: remote.calls.length, helperCalls: candidate ? cases * 2 : 0,
        startupProbeSearchCalls: candidate ? 1 : 0, nativeMcpCallMs: timing(callTimes),
        ...(candidate ? { searchAndLoadMs: timing(discoveryTimes) } : {}) },
    };
  } finally {
    remote.release();
    const results = await Promise.allSettled([f.close(), remote.close()]);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'MCP benchmark cleanup failed');
  }
}

const hashes = [];
for (const path of sourceFiles) hashes.push({ path, sha256: createHash('sha256').update(await readFile(new URL(path, import.meta.url))).digest('hex') });
const result = { format: 'rdsh-mcp-exposure-fixture-v1', measuredAt: new Date().toISOString(),
  platform: process.platform, arch: process.arch, node: process.version,
  source: { files: hashes, sha256: createHash('sha256').update(JSON.stringify(hashes)).digest('hex') },
  fixture: { tools: count, cases, controlledListDelayMs, transport: 'real MCP SDK/client over loopback HTTP',
    tokenizer: 'offline js-tiktoken 1.0.21 cl100k_base', dshVersion: require('@deepseek-ai/dsh-tools/package.json').version,
    baseline: 'original MCP client and native ToolRuntime', candidate: 'same original runtime plus deferred exposure bundle',
    realModel: false, externalMcpServer: false, credentials: false, billingApi: false },
  baseline: await run(false), candidate: await run(true),
};
if (arguments_.length) await writeFile(arguments_[1], `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
