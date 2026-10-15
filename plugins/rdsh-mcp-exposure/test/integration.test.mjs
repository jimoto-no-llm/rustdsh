import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import * as bundle from '../index.js';
const { apply, Config } = bundle;
import { LOAD, SEARCH } from '../discovery.js';
import { fixture, definition, value } from './fixtures.mjs';
import { mcpFixture, tool } from './mcp-fixture.mjs';

async function until(predicate) { for (let tries = 0; tries < 100; tries++) { if (predicate()) return; await pause(20); } throw new Error('Fixed MCP fixture did not reach its expected state'); }
const serverConfig = (remote, exposure = 'deferred', toolExposure = []) => ({ servers: [{
  connection: { transport: 'streamable-http', serverName: 'actual', url: remote.url, failOnStartupError: true, reconnect: { enabled: false } },
  exposure, toolExposure,
}] });

test('original MCP background discovery does not hold the first native prompt; loading preserves wire names and guards', async t => {
  const remote = await mcpFixture({ tools: [tool('read'), tool('read.value'), tool('secret', 'HIDDEN_MCP_SENTINEL')], blocked: true });
  const f = fixture({ setupDiscovery: false });
  t.after(async () => { const results = await Promise.allSettled([f.close(), remote.close()]);
    const failures = results.filter(result => result.status === 'rejected'); if (failures.length) throw new AggregateError(failures.map(result => result.reason)); });
  const input = serverConfig(remote, 'deferred', [{ match: 'mcp__actual__secret', exposure: 'hidden' }]);
  const start = performance.now(); await apply(f.ctx, Config(input)); const activationMs = performance.now() - start;
  await until(() => remote.listing > 0);
  const agent = f.agent(), first = await f.prompt.assemble({ scope: agent });
  assert.equal(first.tools.some(schema => schema.name.startsWith('mcp__')), false);
  assert.equal(f.tools.get('run_code'), undefined);
  remote.release();
  const found = value(await f.execute(agent, SEARCH, { query: 'read' }));
  assert.equal(found.results.length, 2); assert.equal(JSON.stringify(found).includes('HIDDEN_MCP_SENTINEL'), false);
  const normalized = found.results.find(result => result.name !== 'mcp__actual__read');
  assert.match(normalized.name, /^mcp__actual__read_value_[a-f0-9]{12}$/);
  assert.equal((await f.execute(agent, normalized.name, { key: 'before-load' })).isError, true);
  const loaded = value(await f.execute(agent, LOAD, { names: [normalized.name] }));
  assert.match(loaded.tools[0].types.typescript, /structuredContent/);
  assert.equal(value(await f.execute(agent, normalized.name, { key: 'after-load' })).structuredContent.value, 'FIXTURE:read.value:after-load');
  assert.equal(remote.calls.at(-1).name, 'read.value');
  const deny = f.tools.guard(exec => exec.name === normalized.name ? 'fixed original guard denial' : undefined);
  const calls = remote.calls.length; assert.equal((await f.execute(agent, normalized.name)).isError, true);
  assert.equal(remote.calls.length, calls); deny();
  assert.equal(f.tools.get('mcp__actual__secret'), undefined);
  assert.equal((await f.execute(agent, 'mcp__actual__secret')).isError, true);
  t.diagnostic(JSON.stringify({ originalMcpClient: true, backgroundFirstPrompt: true, activationMs, wireNamePreserved: true }));
});

test('a direct server waits for original discovery; fully hidden server does not connect', async t => {
  const remote = await mcpFixture({ tools: [tool('read')], blocked: true }), f = fixture({ setupDiscovery: false });
  t.after(async () => { remote.release(); await f.close(); await remote.close(); });
  let active = false;
  const startup = apply(f.ctx, Config(serverConfig(remote, 'direct'))).then(() => { active = true; });
  await until(() => remote.listing > 0); assert.equal(active, false);
  remote.release(); await startup; assert.equal(active, true);
  assert.equal((await f.prompt.assemble({ scope: f.agent() })).tools.some(schema => schema.name === 'mcp__actual__read'), true);
  const hidden = fixture({ setupDiscovery: false }); t.after(() => hidden.close());
  const extra = serverConfig(remote, 'hidden'); extra.servers[0].connection.serverName = 'disabled';
  const calls = remote.listing; await apply(hidden.ctx, Config(extra));
  assert.equal(remote.listing, calls);
});

test('real MCP list updates invalidate withdrawn schemas and preserve deterministic declaration order', async t => {
  const remote = await mcpFixture({ tools: [tool('z'), tool('a'), tool('b')] }), f = fixture({ setupDiscovery: false });
  t.after(async () => { await f.close(); await remote.close(); });
  await apply(f.ctx, Config(serverConfig(remote, 'deferred', [{ match: 'mcp__actual__a', exposure: 'direct' }, { match: 'mcp__actual__z', exposure: 'direct' }])));
  const agent = f.agent(), args = { names: ['mcp__actual__b'] };
  value(await f.execute(agent, LOAD, args));
  assert.deepEqual((await f.prompt.assemble({ scope: agent })).tools.filter(tool => tool.name.startsWith('mcp__')).map(tool => tool.name),
    ['mcp__actual__a', 'mcp__actual__b', 'mcp__actual__z']);
  const old = f.tools.get('mcp__actual__a');
  await remote.replace([tool('a'), tool('z')]);
  await until(() => f.tools.get('mcp__actual__a') !== old && !f.tools.get('mcp__actual__b'));
  assert.equal((await f.execute(agent, 'mcp__actual__b')).isError, true);
  assert.deepEqual((await f.prompt.assemble({ scope: agent })).tools.filter(tool => tool.name.startsWith('mcp__')).map(tool => tool.name),
    ['mcp__actual__a', 'mcp__actual__z']);
});

test('actual Cordis Config/inject lifecycle releases original MCP tools and leaves unrelated registrations intact', async t => {
  const remote = await mcpFixture({ tools: [tool('read')] }), f = fixture({ setupDiscovery: false });
  t.after(async () => { await f.close(); await remote.close(); });
  f.tools.register(definition('retained_fixture'));
  const plugin = await f.ctx.plugin(bundle, serverConfig(remote, 'direct'));
  assert.ok(f.tools.get(LOAD)); assert.ok(f.tools.get('mcp__actual__read'));
  const originalExecute = f.tools.execute, originalSchemas = f.tools.schemas;
  await plugin.dispose();
  assert.equal(f.tools.get(LOAD), undefined); assert.equal(f.tools.get('mcp__actual__read'), undefined);
  assert.ok(f.tools.get('retained_fixture'));
  assert.equal(f.tools.execute, originalExecute); assert.equal(f.tools.schemas, originalSchemas);
  const replacement = await mcpFixture({ tools: [tool('read')] }); t.after(() => replacement.close());
  const again = await f.ctx.plugin(bundle, serverConfig(replacement, 'direct'));
  assert.ok(f.tools.get('mcp__actual__read'));
  await again.dispose();
});
