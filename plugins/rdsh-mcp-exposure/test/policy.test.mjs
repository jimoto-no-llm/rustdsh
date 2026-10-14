import test from 'node:test';
import assert from 'node:assert/strict';
import { compileConfig, compileServer } from '../policy.js';
import { connection } from './fixtures.mjs';

test('exact public names override patterns; patterns use their declared order and retain sources', () => {
  const server = compileServer({ connection: connection('docs'), exposure: 'deferred', source: 'project-profile', toolExposure: [
    { match: 'mcp__docs__read*', exposure: 'ptc-only' },
    { match: 'mcp__docs__*', exposure: 'hidden' },
    { match: 'mcp__docs__read_fast', exposure: 'direct' },
  ] });
  assert.deepEqual(server.resolve('mcp__docs__read_fast'), { exposure: 'direct', source: {
    configuration: 'project-profile', path: 'toolExposure[2]', kind: 'exact', match: 'mcp__docs__read_fast', order: 2 } });
  assert.equal(server.resolve('mcp__docs__read_slow').exposure, 'ptc-only');
  assert.equal(server.resolve('mcp__docs__read_slow').source.order, 0);
  assert.equal(server.resolve('mcp__docs__delete').exposure, 'hidden');
  assert.throws(() => server.resolve('mcp__other__read'), { code: 'RDSH_MCP_NAMESPACE' });
});

test('reject ambiguous config before registering or connecting and keep hidden-only servers dormant', () => {
  const server = { connection: connection('docs'), exposure: 'hidden' };
  assert.equal(compileServer(server).mayConnect, false);
  assert.equal(compileServer({ ...server, toolExposure: [{ match: 'mcp__docs__read', exposure: 'deferred' }] }).mayConnect, true);
  for (const input of [{ servers: [] }, { servers: [server, server] }, { servers: [server], maxLoadedTools: 0 },
    { servers: [{ ...server, toolExposure: [{ match: 'read', exposure: 'direct' }] }] },
    { servers: [{ ...server, toolExposure: [{ match: 'mcp__docs__*?', exposure: 'direct' }] }] },
    { servers: [{ ...server, toolExposure: [{ match: 'mcp__docs__read', exposure: 'direct' }, { match: 'mcp__docs__read', exposure: 'hidden' }] }] }])
    assert.throws(() => compileConfig(input), { code: 'RDSH_MCP_CONFIG' });
});
