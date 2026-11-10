import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const modules = process.env.DSH_TEST_NODE_MODULES;
test('installed Typert registry accepts the strict catalog contribution and live schema projection', { skip: !modules }, async () => {
  const require = createRequire(join(modules, '..', 'package.json'));
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const { default: Registry } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-typert-registry')).href);
  const { apply } = await import('../index.js');
  const { z } = require('zod');
  const ctx = new Context();
  new Registry(ctx);
  try {
    await apply(ctx);
    const first = ctx.rdshTuiAdmin.catalog();
    const descriptor = ctx.typert.local.get('rdshTuiAdmin/catalog');
    assert.equal(descriptor.result.mode, 'strict');
    assert.deepEqual(descriptor.result.create().parse(first), first);
    assert.equal(ctx.typert.local.list().length, 3); // Catalog and the two bounded document methods; no execute proxy.
    const off = ctx.typert.register({ package: 'fixture', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: [{
      id: 'fixture#fixture/read', service: 'fixture', namespace: 'fixture', method: 'read', invocation: { kind: 'direct' },
      parameters: [{ name: 'count', wire: 'count', source: 'json', acceptsUndefined: true,
        codec: { mode: 'strict', typeSymbol: 'fixture#Count', create: () => z.number().default(4) } }],
      result: { mode: 'strict', typeSymbol: 'fixture#Result', create: () => z.string() },
    }] });
    const second = ctx.rdshTuiAdmin.catalog();
    const action = second.actions.find(candidate => candidate.id === 'fixture/read');
    assert.equal(action.schema.properties.count.type, 'number');
    assert.deepEqual(action.schema.required, []);
    assert.deepEqual(action.defaults, { count: 4 });
    assert.equal(second.warnings.length, 0);
    assert.ok(second.revision > first.revision);
    off();
    assert.equal(ctx.rdshTuiAdmin.catalog().actions.some(candidate => candidate.id === 'fixture/read'), false);
  } finally { await ctx.fiber.dispose(); }
});

test('real Gateway invokes catalog for a cookie-authenticated Connection peer', { skip: !modules }, async () => {
  const require = createRequire(join(modules, '..', 'package.json'));
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const { default: Registry } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-typert-registry')).href);
  const { default: Gateway } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-api-gateway')).href);
  const { apply: applyConnection } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-client-connection')).href);
  const { apply } = await import('../index.js');
  const ctx = new Context();
  // Isolated fixture store: the real signing-cookie implementation runs, but
  // no user's credential store, config or network listener is accessed.
  let credential;
  ctx.provide('credentials', { async modifyRecord(_key, change) { credential = await change(credential) ?? credential; return credential; } });
  new Registry(ctx);
  try {
    await applyConnection(ctx);
    const gateway = new Gateway(ctx, { websocketHeartbeatIntervalMs: 2000, streamInboxBytes: 262144 });
    await apply(ctx);
    const authority = '127.0.0.1:39117';
    assert.equal(ctx.connection.admit({ headers: { host: authority } }).rejection, 401);
    const login = new URL(ctx.connection.authenticatedUrl(`http://${authority}/`));
    let status, cookie;
    ctx.connection.authorizeIndex({ method: 'GET', url: login.pathname + login.search, headers: { host: authority } }, {
      writeHead(code, headers) { status = code; cookie = headers['set-cookie']; }, end() {},
    });
    assert.equal(status, 303);
    assert.equal(typeof cookie, 'string');
    const headers = { host: authority, cookie: cookie.split(';')[0] };
    const admission = ctx.connection.admit({ headers });
    assert.ok(admission.peer, 'the signing-cookie exchange must admit a real Peer');
    assert.equal(ctx.connection.admit({ headers: { ...headers, origin: 'https://example.invalid' } }).rejection, 403);
    const result = await gateway.invoke({ namespace: 'rdshTuiAdmin', method: 'catalog', args: {}, peer: admission.peer });
    assert.equal(result.version, 1);
    assert.ok(result.actions.some(action => action.id === 'rdshTuiAdmin/catalog'));
    assert.ok(result.actions.some(action => action.id === 'GET /api/rdsh-settings'));
    assert.equal(result.warnings.length, 0);
    ctx.typert.local.get('rdshTuiAdmin/catalog').result.create().parse(result);
    await assert.rejects(gateway.invoke({ namespace: 'rdshTuiAdmin', method: 'catalog', args: { unexpected: true }, peer: admission.peer }),
      error => error.code === 'gateway/arguments-invalid');
  } finally { await ctx.fiber.dispose(); }
});
