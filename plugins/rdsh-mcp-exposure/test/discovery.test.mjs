import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Discovery, digest, LOAD, SEARCH } from '../discovery.js';
import { compileConfig } from '../policy.js';
import { renderToolsSdk, renderToolsSdkPy } from '@deepseek-ai/dsh-tools';
import { fixture, definition, connection, value } from './fixtures.mjs';

const config = { servers: [{ connection: connection('docs'), exposure: 'deferred', toolExposure: [
  { match: 'mcp__docs__direct', exposure: 'direct' }, { match: 'mcp__docs__ptc', exposure: 'ptc-only' },
  { match: 'mcp__docs__secret', exposure: 'hidden' },
] }] };
function populate(f) {
  let calls = 0;
  const bridge = f.discovery.bridge(f.compiled.servers[0], 'fixed-route');
  const removers = new Map();
  for (const name of ['direct', 'deferred', 'ptc', 'secret']) removers.set(name, bridge.register(definition(`mcp__docs__${name}`,
    name === 'secret' ? 'HIDDEN_DESCRIPTION_SENTINEL' : `Read ${name} fixture.`, async () => { calls++; return { value: name }; })));
  return { bridge, removers, get calls() { return calls; } };
}

test('hidden tools never register, search, bind or execute; direct and deferred use the original pipeline', async t => {
  const f = fixture({ config, mode: 'both' }); t.after(() => f.close());
  const owner = f.agent(), peer = f.agent(), filled = populate(f);
  assert.equal(f.tools.get('mcp__docs__secret'), undefined);
  const initial = await f.prompt.assemble({ scope: owner });
  assert.deepEqual(initial.tools.filter(tool => tool.name.startsWith('mcp__')).map(tool => tool.name), ['mcp__docs__direct']);
  const sdk = initial.sections.find(section => section.name === 'tools:sdk').text;
  assert.match(sdk, /mcp__docs__ptc/);
  assert.doesNotMatch(sdk, /mcp__docs__deferred/);
  assert.equal(JSON.stringify(initial).includes('HIDDEN_DESCRIPTION_SENTINEL'), false);
  assert.equal(value(await f.execute(owner, 'mcp__docs__direct')).value, 'direct');
  assert.equal((await f.execute(owner, 'mcp__docs__deferred')).isError, true);
  assert.equal((await f.execute(owner, 'mcp__docs__secret')).isError, true);
  const search = value(await f.execute(owner, SEARCH, { query: 'fixture' }));
  assert.equal(search.results.length, 3);
  assert.equal(JSON.stringify(search).includes('secret'), false);
  const loaded = value(await f.execute(owner, LOAD, { names: ['mcp__docs__deferred'], revision: search.revision }));
  assert.deepEqual(loaded.tools[0].schema.output, f.tools.get('mcp__docs__deferred').output.schema);
  assert.match(loaded.tools[0].types.typescript, /value.*string/s);
  assert.match(loaded.tools[0].types.python, /value.*str/s);
  assert.equal(value(await f.execute(owner, 'mcp__docs__deferred')).value, 'deferred');
  assert.match((await f.prompt.assemble({ scope: owner })).sections.find(section => section.name === 'tools:sdk').text,
    /mcp__docs__deferred/);
  assert.equal((await f.execute(peer, 'mcp__docs__deferred')).isError, true);
  assert.equal((await f.execute(owner, 'mcp__docs__ptc')).isError, true);
  assert.equal(value(await f.ptc(owner, async tools => {
    assert.equal(tools.mcp__docs__secret, undefined);
    return tools.mcp__docs__ptc({});
  })).result.value, 'ptc');
  assert.equal(filled.calls, 3);
  assert.deepEqual(value(await f.execute(owner, LOAD, { names: ['mcp__docs__secret'] })), { status: 'not_found' });
  assert.deepEqual(value(await f.execute(owner, LOAD, { names: ['mcp__docs__missing'] })), { status: 'not_found' });
});

test('receipt schema fingerprints retain object and array identity while ignoring object property order', () => {
  assert.notEqual(digest({ enum: [{ key: 'fixed' }] }), digest({ enum: [[['key', 'fixed']]] }));
  assert.equal(digest({ type: 'object', properties: { z: { type: 'string' }, a: { type: 'number' } } }),
    digest({ properties: { a: { type: 'number' }, z: { type: 'string' } }, type: 'object' }));
});

test('native receipts survive disk restore and exact forks without sharing a sibling or another project', async t => {
  const f = fixture({ config }); t.after(() => f.close()); populate(f);
  const parent = f.agent(), before = f.sessions.fork(parent.session, undefined, 'before-load');
  const args = { names: ['mcp__docs__deferred'] };
  const result = await f.execute(parent, LOAD, args); value(result);
  f.persistNative(parent, LOAD, args, result);
  const child = f.sessions.fork(parent.session, undefined, 'after-load');
  const folder = await mkdtemp(join(tmpdir(), 'rdsh-mcp-receipt-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, 'session-fixture.json');
  await writeFile(path, JSON.stringify(parent.session.snapshotEvents()));
  const seed = JSON.parse(await readFile(path, 'utf8'));
  const restored = f.sessions.create('restored-load', { seed, meta: { cwd: parent.session.header.cwd } });
  const elsewhere = f.sessions.create('different-project', { seed, meta: { cwd: join(parent.session.header.cwd, 'different-project') } });
  for (const session of [child, restored]) assert.equal(value(await f.execute(f.agent({ session }), 'mcp__docs__deferred')).value, 'deferred');
  for (const session of [before, elsewhere]) assert.equal((await f.execute(f.agent({ session }), 'mcp__docs__deferred')).isError, true);
  assert.equal(seed.some(event => event.type === 'tool/result' && event.data.meta?.rdshMcpLoad), true);
  assert.equal(seed.some(event => event.type.startsWith('rdsh/')), false);
});

test('original nested PTC dispatch receipts restore branch-local discovery', async t => {
  const f = fixture({ config, mode: 'both' }); t.after(() => f.close()); populate(f);
  const parent = f.agent();
  assert.equal(value(await f.ptc(parent, tools => tools[LOAD]({ names: ['mcp__docs__deferred'] }))).result.status, 'loaded');
  const snapshot = parent.session.snapshotEvents();
  assert.equal(snapshot.some(event => event.type === 'tool/ptc-dispatch' && event.data.name === LOAD && !event.data.isError), true);
  const fork = f.agent({ session: f.sessions.fork(parent.session, undefined, 'ptc-fork') });
  assert.equal(value(await f.execute(fork, 'mcp__docs__deferred')).value, 'deferred');
});

test('withdrawal, schema changes and scope restrictions invalidate receipts; monotonic guards still deny bodies', async t => {
  const f = fixture({ config }); t.after(() => f.close()); const filled = populate(f), agent = f.agent();
  value(await f.execute(agent, LOAD, { names: ['mcp__docs__deferred'] }));
  const firstCalls = filled.calls;
  const deny = f.tools.guard(exec => exec.name === 'mcp__docs__deferred' ? 'fixed permission denial' : undefined);
  assert.equal((await f.execute(agent, 'mcp__docs__deferred')).isError, true);
  assert.equal(filled.calls, firstCalls); deny();
  const restrict = agent.ctx.tools.restrict({ deny: ['mcp__docs__deferred'] });
  assert.deepEqual(value(await f.execute(agent, LOAD, { names: ['mcp__docs__deferred'] })), { status: 'not_found' });
  assert.equal((await f.execute(agent, 'mcp__docs__deferred')).isError, true);
  assert.equal((await f.prompt.assemble({ scope: agent })).tools.some(tool => tool.name === 'mcp__docs__deferred'), false);
  restrict();
  filled.removers.get('deferred')();
  assert.equal((await f.execute(agent, 'mcp__docs__deferred')).isError, true);
  const changed = definition('mcp__docs__deferred'); changed.parameters.properties.key.type = 'integer';
  filled.bridge.register(changed);
  assert.equal((await f.execute(agent, 'mcp__docs__deferred', { key: 1 })).isError, true);
  assert.equal((await f.prompt.assemble({ scope: agent })).tools.some(tool => tool.name === 'mcp__docs__deferred'), false);
  value(await f.execute(agent, LOAD, { names: ['mcp__docs__deferred'] }));
  assert.equal(value(await f.execute(agent, 'mcp__docs__deferred', { key: 1 })).value, 'FIXED');
});

test('paging is stable and stale revisions never return another page; denied loads cannot settle', async t => {
  const f = fixture({ config, mode: 'both' }); t.after(() => f.close()); const filled = populate(f), owner = f.agent();
  const page = value(await f.execute(owner, SEARCH, { limit: 1 }));
  assert.equal(page.results.length, 1); assert.equal(page.nextOffset, 1);
  assert.equal(value(await f.execute(owner, SEARCH, { limit: 1, offset: 1, revision: page.revision })).status, 'ok');
  filled.bridge.register(definition('mcp__docs__new'));
  assert.equal(value(await f.execute(owner, SEARCH, { limit: 1, offset: 1, revision: page.revision })).status, 'stale');
  const stop = f.tools.guard(exec => exec.name === LOAD ? 'fixed discovery permission denial' : undefined);
  assert.equal((await f.execute(owner, LOAD, { names: ['mcp__docs__deferred'] })).isError, true);
  stop();
  assert.equal((await f.execute(owner, 'mcp__docs__deferred')).isError, true);
  assert.equal((await f.prompt.assemble({ scope: owner })).tools.some(tool => tool.name === 'mcp__docs__deferred'), false);
});

test('agent-local registration metadata never appears to a sibling and native mode stays native', async t => {
  const f = fixture({ config }); t.after(() => f.close()); populate(f);
  const owner = f.agent(), sibling = f.agent(), child = f.agent({ parent: owner });
  const scopedConfig = compileConfig({ servers: [{ connection: connection('private'), exposure: 'direct' }] });
  const local = new Discovery(owner.ctx.tools, scopedConfig, { typescript: renderToolsSdk, python: renderToolsSdkPy });
  local.bridge(scopedConfig.servers[0], 'scoped').register(definition('mcp__private__read', 'SCOPED_DESCRIPTION_SENTINEL'));
  assert.equal(local.visible(owner).length, 1); assert.equal(local.visible(child).length, 1);
  assert.equal(local.visible(sibling).length, 0);
  assert.equal(JSON.stringify(await f.prompt.assemble({ scope: sibling })).includes('SCOPED_DESCRIPTION_SENTINEL'), false);
  assert.equal(f.tools.get('run_code', owner), undefined);
});

test('post-body cancellation and invalid canonical output never activate a deferred declaration', async t => {
  const f = fixture({ config }); t.after(() => f.close()); populate(f);
  const agent = f.agent(), controller = new AbortController();
  const cancel = f.ctx.on('tools/execute', async (exec, next) => {
    const result = await next();
    if (exec.name === LOAD) controller.abort(new Error('fixed metadata cancellation'));
    return result;
  });
  assert.equal((await f.execute(agent, LOAD, { names: ['mcp__docs__deferred'] }, controller.signal)).isError, true);
  cancel();
  assert.equal((await f.execute(agent, 'mcp__docs__deferred')).isError, true);
  const malformed = f.ctx.on('tools/execute', async (exec, next) => {
    const result = await next();
    return exec.name === LOAD && !result.isError ? { ...result, value: 'invalid-object-output' } : result;
  });
  assert.equal((await f.execute(agent, LOAD, { names: ['mcp__docs__deferred'] })).isError, true);
  malformed();
  assert.equal((await f.execute(agent, 'mcp__docs__deferred')).isError, true);
});

test('complete prompts and preexisting SDK budget transformations remain owned by their original providers', async t => {
  const f = fixture({ config, mode: 'both' }); t.after(() => f.close()); populate(f);
  const agent = f.agent();
  f.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const result = await next(); return { ...result, sections: result.sections.map(section => section.name === 'tools:sdk'
      ? { ...section, text: 'PREEXISTING_BOUNDED_SDK' } : section) };
  });
  assert.equal((await f.prompt.assemble({ scope: agent })).sections.find(section => section.name === 'tools:sdk').text, 'PREEXISTING_BOUNDED_SDK');
  agent.ctx.systemPrompt.section({ name: 'fixture.complete', order: 0, text: 'EXACT_COMPLETE_PROMPT', complete: true });
  assert.deepEqual((await f.prompt.assemble({ scope: agent })).sections, [{ name: 'fixture.complete', text: 'EXACT_COMPLETE_PROMPT' }]);
});

test('explicit canonical tool order and unrelated declaration positions survive MCP metadata updates', async t => {
  const localConfig = { servers: [{ connection: connection('docs'), exposure: 'direct' }] };
  const f = fixture({ config: localConfig, promptConfig: { toolOrder: ['mcp__docs__z', 'ordinary_fixture', 'mcp__docs__a', '<unlisted-tools>'] } });
  t.after(() => f.close());
  f.tools.register(definition('ordinary_fixture'));
  const bridge = f.discovery.bridge(f.compiled.servers[0], 'fixed-route'), agent = f.agent();
  const removes = ['a', 'z'].map(name => bridge.register(definition(`mcp__docs__${name}`)));
  const first = (await f.prompt.assemble({ scope: agent })).tools.map(tool => tool.name);
  assert.deepEqual(first.slice(0, 3), ['mcp__docs__z', 'ordinary_fixture', 'mcp__docs__a']);
  for (const remove of removes) remove();
  for (const name of ['z', 'a']) bridge.register(definition(`mcp__docs__${name}`, `Updated description for ${name}.`));
  assert.deepEqual((await f.prompt.assemble({ scope: agent })).tools.map(tool => tool.name), first);
});

test('declaration capacity and caller cancellation are enforced without partial receipts', async t => {
  const f = fixture({ config: { ...config, maxLoadedTools: 1 } }); t.after(() => f.close()); populate(f);
  const agent = f.agent();
  assert.equal(value(await f.execute(agent, LOAD, { names: ['mcp__docs__deferred', 'mcp__docs__direct'] })).status, 'limit');
  assert.equal((await f.execute(agent, 'mcp__docs__deferred')).isError, true);
  const controller = new AbortController(); controller.abort(new Error('fixed early abort'));
  assert.equal((await f.execute(agent, LOAD, { names: ['mcp__docs__deferred'] }, controller.signal)).isError, true);
  assert.equal((await f.execute(agent, 'mcp__docs__deferred')).isError, true);
  value(await f.execute(agent, LOAD, { names: ['mcp__docs__deferred'] }));
  assert.equal(value(await f.execute(agent, 'mcp__docs__deferred')).value, 'deferred');
});
