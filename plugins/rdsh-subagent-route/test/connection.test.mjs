import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply, inject } from '../index.js';

const modules = process.env.DSH_TEST_NODE_MODULES;
const PATCH = '- id: tool-subagent\n  config:\n    provider: spawn\n';
const endpoint = '/api/rdsh-subagent-route';

function call(url, method, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers = { ...headers, 'content-length': Buffer.byteLength(payload) };
    const req = request(url, { method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('route declares the real Connection service as a required injection', () => {
  assert.deepEqual(inject, ['webServer', 'connection']);
});

test('Cordis optional profile lookup selects the active non-web profile in a plugin fiber', { skip: !modules }, async t => {
  const require = createRequire(join(modules, '..', 'package.json'));
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const root = await mkdtemp(join(tmpdir(), 'rdsh-route-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, 'ourin-tui');
  await mkdir(profile);
  await writeFile(join(profile, 'cordis.patch.yml'), PATCH);
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  ctx.provide('profileContext', { dir: profile, name: 'ourin-tui' });
  ctx.provide('connection', { admit: () => ({ peer: {} }) });
  let handler;
  ctx.provide('webServer', { register(route) { handler = route.handler; return () => {}; } });
  await ctx.plugin({ name: 'fixture-profile-route', inject, apply });
  const response = {};
  await handler({ method: 'GET' }, { writeHead(status) { response.status = status; }, end(body) { response.body = JSON.parse(body); } });
  assert.equal(response.status, 200);
  assert.equal(response.body.patch, join(profile, 'cordis.patch.yml'));
});

test('real Connection signed-cookie and Origin checks protect all HTTP methods', { skip: !modules }, async t => {
  const require = createRequire(join(modules, '..', 'package.json'));
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const { apply: applyConnection } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-client-connection')).href);
  const root = await mkdtemp(join(tmpdir(), 'rdsh-route-connection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, 'profiles', 'web');
  const patch = join(profile, 'cordis.patch.yml');
  await mkdir(profile, { recursive: true });
  await writeFile(patch, PATCH);
  const ctx = new Context();
  let credential;
  ctx.provide('credentials', { async modifyRecord(_key, change) {
    credential = await change(credential) ?? credential;
    return credential;
  } });
  await applyConnection(ctx);
  let handler;
  ctx.provide('webServer', { register(route) {
    if (route.kind === 'exact' && route.path === endpoint) handler = route.handler;
    return () => {};
  } });
  apply(ctx, { env: { DSH_HOME: root, RDSH_PROFILE: 'web' } });
  assert.equal(typeof handler, 'function');
  const server = createServer((req, res) => {
    if (req.url.startsWith('/?')) {
      const allowed = ctx.connection.authorizeIndex(req, res);
      if (allowed) { res.writeHead(200); res.end('authenticated'); }
      return;
    }
    Promise.resolve(handler(req, res)).catch(() => { res.writeHead(500); res.end('fixture failure'); });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await ctx.fiber.dispose();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const method of ['GET', 'HEAD', 'POST']) {
    const result = await call(base + endpoint, method, {}, { model: 'denied' });
    assert.equal(result.status, 401);
    if (method === 'HEAD') assert.equal(result.text, '');
    else assert.deepEqual(JSON.parse(result.text), { ok: false, error: 'unauthorized' });
  }
  assert.equal(await readFile(patch, 'utf8'), PATCH);

  // The real process-token exchange mints a signed cookie in fixture memory.
  // Neither cookie values nor the launch URL are logged or persisted.
  const login = await call(ctx.connection.authenticatedUrl(base + '/'), 'GET');
  assert.equal(login.status, 303);
  assert.ok(Array.isArray(login.headers['set-cookie']));
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const headers = { cookie, 'content-type': 'application/json', origin: base };
  const before = await call(base + endpoint, 'GET', headers);
  assert.equal(before.status, 200);
  assert.equal(JSON.parse(before.text).route, null);
  const head = await call(base + endpoint, 'HEAD', headers);
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.equal(head.headers['content-length'], before.headers['content-length']);

  for (const method of ['GET', 'HEAD', 'POST']) {
    const denied = await call(base + endpoint, method, { ...headers, origin: 'https://example.invalid' }, { model: 'denied' });
    assert.equal(denied.status, 403);
  }
  assert.equal((await call(base + endpoint, 'GET', { ...headers, host: 'example.invalid' })).status, 403);
  assert.equal((await call(base + endpoint, 'POST', { cookie: cookie + 'invalid' }, { model: 'denied' })).status, 401);
  assert.equal(await readFile(patch, 'utf8'), PATCH);

  const route = { provider: 'fixture', model: 'fixture-model', reasoningEffort: 'high' };
  assert.equal((await call(base + endpoint, 'POST', headers, route)).status, 200);
  const after = await call(base + endpoint, 'GET', { cookie }); // Native TUI has no Origin header.
  assert.equal(after.status, 200);
  assert.deepEqual(JSON.parse(after.text).route, route);
  assert.match(await readFile(patch, 'utf8'), /fixture-model/);
  assert.equal((await call(base + endpoint, 'POST', headers, { clear: true })).status, 200);
  assert.equal(JSON.parse((await call(base + endpoint, 'GET', { cookie })).text).route, null);
});
