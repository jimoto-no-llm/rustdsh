import test from 'node:test';
import assert from 'node:assert/strict';
import { SEARCH, DESCRIBE, normalizedIdentifier, validateConfig } from '../catalog.js';
import { fixture, tool, renderers, sdkSchemas, canonicalValue } from './fixtures.mjs';

test('catalog reads only the real calling scope, including shadowing and inherited restrictions', async t => {
  const f = fixture(); t.after(() => f.close());
  f.tools.register(tool('mcp.github.list', 'List open pull requests.'));
  f.tools.register(tool('mcp/github/list', 'Read GitHub issue discussions.'));
  f.tools.register(tool('mcp:github:list', 'HIDDEN_GLOBAL_SENTINEL'));
  const a = f.agent(), b = f.agent(), child = f.agent(a);
  b.ctx.tools.register(tool('other.private', 'OTHER_SCOPE_SENTINEL'));
  a.ctx.tools.register(tool('mcp.github.list', 'VISIBLE_SHADOW_SENTINEL'));
  a.ctx.tools.restrict({ deny: ['mcp:github:list'] });
  const scoped = f.catalog.search(a, { namespace: 'mcp' });
  assert.equal(scoped.total, 2);
  assert.ok(scoped.tools.every(entry => entry.normalizationCollision));
  assert.match(JSON.stringify(scoped), /VISIBLE_SHADOW_SENTINEL/);
  assert.doesNotMatch(JSON.stringify(scoped), /HIDDEN_GLOBAL_SENTINEL|OTHER_SCOPE_SENTINEL|mcp:github:list|other.private/);
  assert.deepEqual(f.catalog.describe(a, { name: 'mcp:github:list' }, 'typescript'), { version: 1, status: 'not_found' });
  assert.deepEqual(f.catalog.describe(a, { name: 'other.private' }, 'typescript'), f.catalog.describe(a, { name: 'missing' }, 'typescript'));
  const collision = f.catalog.describe(a, { name: 'mcp.github.list' }, 'typescript');
  assert.deepEqual(collision.collisionNames, ['mcp.github.list', 'mcp/github/list']);
  assert.equal(collision.collisionTotal, 2);
  child.ctx.tools.restrict({ deny: ['mcp.github.list'] });
  assert.deepEqual(f.catalog.search(child, { namespace: 'mcp' }).tools.map(entry => entry.name), ['mcp/github/list']);
  assert.doesNotMatch(JSON.stringify(f.catalog.search(undefined, {})), /OTHER_SCOPE_SENTINEL|VISIBLE_SHADOW_SENTINEL/);
  // A sibling/global-hidden addition must not change this view or its digest.
  const before = JSON.stringify(f.catalog.search(a, {}));
  b.ctx.tools.register(tool('other.new', 'OTHER_NEW_SENTINEL'));
  assert.equal(JSON.stringify(f.catalog.search(a, {})), before);
});

test('describe preserves complete nested input/output schemas and reuses both original SDK renderers', async t => {
  const f = fixture(); t.after(() => f.close());
  const definition = tool('mcp.report/read');
  definition.parameters = { type: 'object', properties: { rows: { type: 'array', minItems: 1,
    items: { type: 'object', properties: { code: { type: 'string', enum: ['日本語', 'B'] }, weight: { type: 'number', minimum: 0 } },
      required: ['code'], additionalProperties: false } } }, required: ['rows'], additionalProperties: false };
  definition.output.schema = { oneOf: [{ type: 'null' }, { type: 'object', properties: { result: { type: 'string' },
    errors: { type: 'array', items: { type: 'string' } } }, required: ['result', 'errors'], additionalProperties: false }] };
  f.tools.register(definition);
  for (const language of ['typescript', 'python']) {
    const result = f.catalog.describe(undefined, { name: definition.name }, language);
    assert.deepEqual(result.tool.input, definition.parameters);
    assert.deepEqual(result.tool.output, definition.output.schema);
    assert.equal(result.declaration.source, renderers[language]([{ name: definition.name, description: definition.description,
      parameters: definition.parameters, output: definition.output.schema }]));
    result.tool.input.properties.rows.items.properties.code.enum.push('mutated');
    assert.equal(definition.parameters.properties.rows.items.properties.code.enum.length, 2);
  }
  assert.throws(() => f.catalog.describe(undefined, { name: definition.name }, 'unsupported'), { code: 'RDSH_CATALOG_LANGUAGE' });
});

test('relevance, exact namespace boundaries, paged discovery and stale views are explicit', async t => {
  const f = fixture({ config: { maxSearchResults: 3 } }); t.after(() => f.close());
  for (let n = 0; n < 8; n++) f.tools.register(tool(`mcp/github/jobs/job${n}`, `Read pipeline build ${n} results.`));
  f.tools.register(tool('mcp/github/jobs/failed', 'Inspect failed deployment build logs.'));
  f.tools.register(tool('mcp/github-evil/jobs', 'Inspect failed deployment build logs.'));
  const search = f.catalog.search(undefined, { query: 'failed deployment', namespace: 'mcp/github' });
  assert.equal(search.tools[0].name, 'mcp/github/jobs/failed');
  assert.ok(search.tools.every(entry => !entry.name.includes('github-evil')));
  const names = [];
  let offset = 0, revision;
  do {
    const page = f.catalog.search(undefined, { namespace: 'mcp/github', offset, ...(revision ? { revision } : {}) });
    revision = page.revision;
    names.push(...page.tools.map(entry => entry.name));
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(names.length, 9);
  assert.equal(new Set(names).size, 9);
  f.tools.register(tool('mcp/github/new', 'New scoped metadata.'));
  const stale = f.catalog.search(undefined, { namespace: 'mcp/github', revision });
  assert.equal(stale.status, 'stale');
  assert.deepEqual(stale.tools, []);
  assert.equal(f.catalog.describe(undefined, { name: names[0], revision }, 'typescript').status, 'stale');
  assert.throws(() => f.catalog.search(undefined, { limit: 4 }), { code: 'RDSH_CATALOG_INPUT' });
  assert.throws(() => f.catalog.search(undefined, { query: 'x'.repeat(1025) }), { code: 'RDSH_CATALOG_INPUT' });
  assert.throws(() => f.catalog.search(undefined, { scope: 'other' }), { code: 'RDSH_CATALOG_INPUT' });
});

test('inline budget is enforced, skipped declarations remain discoverable, unrelated additions keep prompt bytes stable', async t => {
  const f = fixture({ config: { inlineTokenBudget: 16384, inlineTools: ['read.small', 'read.large', 'hidden.configured'] } }); t.after(() => f.close());
  f.tools.register(tool('read.small', 'Read a small fixture.'));
  f.tools.register(tool('read.large', 'LARGE_SCHEMA_MARKER ' + 'large '.repeat(12000)));
  const a = f.agent();
  const assembly = await f.prompt.assemble({ scope: a });
  const sdk = assembly.sections.find(section => section.name === 'tools:sdk').text;
  assert.ok(Buffer.byteLength(sdk) <= 16384);
  assert.match(sdk, /read\.small/);
  assert.doesNotMatch(sdk, /LARGE_SCHEMA_MARKER|hidden.configured/);
  assert.match(sdk, /omitted to meet the budget/);
  const result = f.catalog.describe(a, { name: 'read.large' }, 'typescript');
  assert.equal(result.tool.description.length, f.tools.get('read.large').description.length);
  assert.match(result.declaration.source, /LARGE_SCHEMA_MARKER/);
  f.tools.register(tool('new.unrelated', 'Unrelated schema.'));
  assert.equal((await f.prompt.assemble({ scope: a })).sections.find(section => section.name === 'tools:sdk').text, sdk);
  assert.deepEqual(assembly.tools.map(entry => entry.name), ['run_code']);
  assert.ok(sdkSchemas(f.tools, a).some(entry => entry.name === 'read.large'), 'all original execution bindings remain available');
});

test('undersized budget or filtered/shadowed discovery helper fails without exposing hidden names', async t => {
  const tiny = fixture({ config: { inlineTokenBudget: 1 } }); t.after(() => tiny.close());
  await assert.rejects(tiny.prompt.assemble(), { code: 'RDSH_CATALOG_BUDGET' });
  const f = fixture(); t.after(() => f.close());
  f.tools.register(tool('hidden.data', 'HIDDEN_INPUT_SENTINEL'));
  const a = f.agent();
  a.ctx.tools.restrict({ allow: ['hidden.data'] });
  await assert.rejects(f.prompt.assemble({ scope: a }), error => error.code === 'RDSH_CATALOG_SCOPE_UNAVAILABLE' && !error.message.includes('HIDDEN_INPUT_SENTINEL'));
  const b = f.agent();
  b.ctx.tools.register(tool(SEARCH, 'A different tool owns this name in this scope.'));
  await assert.rejects(f.prompt.assemble({ scope: b }), { code: 'RDSH_CATALOG_SCOPE_UNAVAILABLE' });
});

test('original run_code bindings dispatch discovered raw names, guards and typed-return failures remain authoritative', async t => {
  const f = fixture(); t.after(() => f.close());
  let calls = 0;
  f.tools.register(tool('__proto__', 'Read prototype-name fixture.', async () => { calls++; return { value: 'raw-name' }; }));
  const a = f.agent();
  const success = canonicalValue(await f.run(a, async bindings => {
    assert.equal(Object.getPrototypeOf(bindings), null);
    const page = await bindings[SEARCH]({ query: '__proto__' });
    assert.equal(page.tools[0].name, '__proto__');
    const description = await bindings[DESCRIBE]({ name: page.tools[0].name });
    assert.equal(description.tool.name, '__proto__');
    return bindings[page.tools[0].name]({});
  }));
  assert.deepEqual(success.result, { value: 'raw-name' });
  assert.equal(calls, 1);
  const deny = a.ctx.tools.guard(exec => exec.name === '__proto__' ? 'fixture policy denied' : undefined);
  const denied = await f.run(a, bindings => bindings.__proto__({}));
  assert.equal(denied.isError, true);
  assert.equal(calls, 1);
  assert.match(JSON.stringify(denied), /fixture policy denied/);
  deny();
  f.tools.register(tool('invalid.return', 'Return the wrong canonical type.', async () => ({ value: 7 })));
  const invalid = await f.run(a, bindings => bindings['invalid.return']({}));
  assert.equal(invalid.isError, true);
  assert.match(JSON.stringify(invalid), /invalid output|INVALID_TOOL_OUTPUT/);
  const direct = await f.tools.execute({ name: SEARCH, arguments: {}, agent: a, callId: 'direct-catalog', signal: new AbortController().signal });
  assert.equal(direct.isError, true, 'PTC still permits only run_code as a direct tool');
});

test('a restriction after discovery rejects the original captured binding instead of replaying or bypassing scope', async t => {
  const f = fixture(); t.after(() => f.close());
  let calls = 0;
  f.tools.register(tool('mcp.private.read', 'Read approved metadata.', async () => { calls++; return { value: 'should-not-run' }; }));
  const a = f.agent();
  const outcome = await f.run(a, async bindings => {
    const found = await bindings[SEARCH]({ query: 'mcp.private.read' });
    assert.equal(found.tools[0].name, 'mcp.private.read');
    a.ctx.tools.restrict({ deny: ['mcp.private.read'] });
    assert.deepEqual(await bindings[DESCRIBE]({ name: found.tools[0].name }), { version: 1, status: 'not_found' });
    return bindings[found.tools[0].name]({});
  });
  assert.equal(outcome.isError, true);
  assert.equal(calls, 0);
});

test('the original parallel scheduler and durable nested dispatch events are retained', async t => {
  const f = fixture(); t.after(() => f.close());
  let active = 0, peak = 0;
  const definition = tool('parallel.read', 'Read concurrently.', async args => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active--; return { value: args.key };
  });
  definition.isConcurrencySafe = () => true;
  f.tools.register(definition);
  const a = f.agent();
  const outcome = canonicalValue(await f.run(a, async bindings => {
    await bindings[DESCRIBE]({ name: definition.name });
    return Promise.all(['a', 'b', 'c'].map(key => bindings[definition.name]({ key })));
  }));
  assert.deepEqual(outcome.result, [{ value: 'a' }, { value: 'b' }, { value: 'c' }]);
  assert.equal(peak, 3);
  assert.equal(active, 0);
  const settled = f.events.filter(event => event.type === 'tool/ptc-dispatch');
  assert.deepEqual(settled.map(event => event.data.name), [DESCRIBE, definition.name, definition.name, definition.name]);
  assert.ok(settled.every(event => event.data.isError === false));
});

test('Native/complete prompts and disposal preserve original presentation and registry ownership', async t => {
  const native = fixture({ mode: 'native' }); t.after(() => native.close());
  native.tools.register(tool('native.read'));
  const nativeAssembly = await native.prompt.assemble();
  assert.ok(nativeAssembly.tools.some(entry => entry.name === 'native.read'));
  assert.ok(nativeAssembly.tools.every(entry => entry.name !== 'run_code'));
  assert.ok(!nativeAssembly.sections.some(section => section.name === 'tools:sdk' && section.text));
  const f = fixture(); t.after(() => f.close());
  const a = f.agent();
  a.ctx.systemPrompt.section({ name: 'fixture.complete', order: 0, text: 'EXACT_COMPLETE_PROMPT', complete: true });
  assert.deepEqual((await f.prompt.assemble({ scope: a })).sections, [{ name: 'fixture.complete', text: 'EXACT_COMPLETE_PROMPT' }]);
  f.tools.register(tool('retained.read'));
  const execute = f.tools.execute, schemas = f.tools.schemas, get = f.tools.get;
  f.dispose();
  assert.equal(f.tools.get(SEARCH), undefined);
  assert.equal(f.tools.get(DESCRIBE), undefined);
  assert.ok(f.tools.get('retained.read'));
  assert.equal(f.tools.execute, execute); assert.equal(f.tools.schemas, schemas); assert.equal(f.tools.get, get);
  assert.match((await f.prompt.assemble()).sections.find(section => section.name === 'tools:sdk').text, /retained\.read/);
});

test('configuration and normalization never provide authority or executable aliases', () => {
  assert.equal(normalizedIdentifier('mcp.report/list'), normalizedIdentifier('mcp/report.list'));
  assert.equal(normalizedIdentifier('Ａ'), 'A');
  assert.equal(normalizedIdentifier('1'), '_1');
  assert.throws(() => validateConfig({ inlineTools: ['a', 'a'] }), { code: 'RDSH_CATALOG_INPUT' });
  assert.throws(() => validateConfig({ mode: 'ptc' }), { code: 'RDSH_CATALOG_INPUT' });
  assert.throws(() => validateConfig({ inlineTools: ['run_code'] }), { code: 'RDSH_CATALOG_INPUT' });
});
