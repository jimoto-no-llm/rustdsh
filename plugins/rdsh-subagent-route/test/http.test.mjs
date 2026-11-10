import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

const PATCH = [
  '- id: preset-standard',
  '  config:',
  '    plugins:',
  '      - id: tool-subagent',
  "        name: '@deepseek-ai/dsh-tool-subagent'",
  '        config:',
  '          provider: spawn',
  '          toolName: subagent',
  '',
].join('\n');

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'rdsh-subagent-route-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profiles', 'web');
  mkdirSync(profile, { recursive: true });
  const patch = path.join(profile, 'cordis.patch.yml');
  writeFileSync(patch, PATCH);
  return { root, profile, patch };
}

function serve(env, connection = { admit: () => ({ peer: {} }) }, profileContext) {
  let handler = null;
  const ctx = {
    connection,
    get(name) { return name === 'profileContext' ? profileContext : undefined; },
    webServer: {
      register({ path: route, handler: value }) {
        if (route === '/api/rdsh-subagent-route') handler = value;
        return () => { handler = null; };
      },
    },
    effect(run) { return run(); },
  };
  apply(ctx, env === undefined ? {} : { env });
  assert.ok(handler, 'the route must be registered');
  return handler;
}

function request(handler, method, body) {
  const req = { method };
  if (body !== undefined) {
    const payload = Buffer.from(JSON.stringify(body));
    req[Symbol.asyncIterator] = async function* () { yield payload; };
  } else {
    req[Symbol.asyncIterator] = async function* () {};
  }
  const captured = { status: 0, body: null, headers: null };
  const res = {
    writeHead(status, headers) { captured.status = status; captured.headers = headers; },
    end(text) { captured.body = text ? JSON.parse(text) : null; },
  };
  return handler(req, res).then(() => captured);
}

test('reports an inherited route before anything is pinned', async (t) => {
  const { root } = fixture(t);
  const handler = serve({ DSH_HOME: root });
  const value = await request(handler, 'GET');
  assert.equal(value.status, 200);
  assert.equal(value.body.ok, true);
  assert.equal(value.body.supported, true);
  assert.equal(value.body.route, null);
  assert.deepEqual(value.body.efforts, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('active Host profile owns reads and writes without an RDSH_PROFILE environment override', async t => {
  const { root, patch: webPatch } = fixture(t);
  const active = path.join(root, 'profiles', 'ourin-tui');
  mkdirSync(active);
  const activePatch = path.join(active, 'cordis.patch.yml');
  writeFileSync(activePatch, PATCH);
  const handler = serve(undefined, undefined, { dir: active, name: 'ourin-tui' });
  assert.equal((await request(handler, 'GET')).body.patch, activePatch);
  assert.equal((await request(handler, 'POST', { provider: 'fixture', model: 'active-model' })).status, 200);
  assert.equal((await request(handler, 'GET')).body.route.model, 'active-model');
  assert.match(readFileSync(activePatch, 'utf8'), /active-model/);
  assert.equal(readFileSync(webPatch, 'utf8'), PATCH);
});

test('explicit fixture environment remains isolated even when a Host profile exists', async t => {
  const { root, patch } = fixture(t);
  const active = path.join(root, 'profiles', 'other-host');
  mkdirSync(active);
  const activePatch = path.join(active, 'cordis.patch.yml');
  writeFileSync(activePatch, PATCH);
  const handler = serve({ DSH_HOME: root, RDSH_PROFILE: 'web' }, undefined, { dir: active });
  assert.equal((await request(handler, 'GET')).body.patch, patch);
  assert.equal((await request(handler, 'POST', { model: 'fixture-only' })).status, 200);
  assert.match(readFileSync(patch, 'utf8'), /fixture-only/);
  assert.equal(readFileSync(activePatch, 'utf8'), PATCH);
});

test('malformed active profile never silently falls back to another profile', () => {
  for (const profile of [{}, { dir: '' }, { dir: 'relative/profile' }])
    assert.throws(() => serve(undefined, undefined, profile), error => error.code === 'RDSH_SUBAGENT_ROUTE_INVALID_PROFILE');
});

test('a POST pins the route into the profile and reads back', async (t) => {
  const { root, patch } = fixture(t);
  const handler = serve({ DSH_HOME: root });
  const saved = await request(handler, 'POST', { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.route, { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' });
  const text = readFileSync(patch, 'utf8');
  assert.match(text, /agentOptions:/);
  assert.match(text, /model: "deepseek-v4\.1-flash"/);
  // The tool's own keys survive.
  assert.match(text, /toolName: subagent/);
});

test('clear restores inheritance', async (t) => {
  const { root, patch } = fixture(t);
  const handler = serve({ DSH_HOME: root });
  await request(handler, 'POST', { model: 'm' });
  const cleared = await request(handler, 'POST', { clear: true });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.route, null);
  assert.equal(readFileSync(patch, 'utf8').includes('agentOptions'), false);
});

test('a bad effort is a 400, not a write', async (t) => {
  const { root, patch } = fixture(t);
  const handler = serve({ DSH_HOME: root });
  const value = await request(handler, 'POST', { model: 'm', reasoningEffort: 'turbo' });
  assert.equal(value.status, 400);
  assert.equal(value.body.error, 'RDSH_SUBAGENT_ROUTE_UNKNOWN_EFFORT');
  assert.equal(readFileSync(patch, 'utf8'), PATCH);
});

test('a profile that declares no delegation entry is refused, not guessed at', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'rdsh-subagent-route-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'profiles', 'web');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'cordis.patch.yml'), ['- id: llm-pi-ai', '  config: {}', ''].join('\n'));
  const handler = serve({ DSH_HOME: root });
  const before = await request(handler, 'GET');
  assert.equal(before.body.supported, true);
  assert.equal(before.body.route, null);
  const saved = await request(handler, 'POST', { model: 'm' });
  assert.equal(saved.status, 409);
  assert.equal(saved.body.error, 'RDSH_SUBAGENT_ROUTE_NO_ENTRY');
});

test('missing, failed or malformed admission fails closed before reading the request body', async t => {
  const { root, patch } = fixture(t);
  const cases = [null, {}, { admit: () => undefined }, { admit: () => true },
    { admit: () => ({}) }, { admit: () => ({ peer: true }) },
    { admit: () => ({ peer: {}, rejection: undefined }) },
    { admit: () => { throw new Error('PRIVATE_AUTH_FAILURE'); } },
    { admit: async () => { throw new Error('PRIVATE_AUTH_FAILURE'); } }];
  for (const connection of cases) {
    const handler = serve({ DSH_HOME: root }, connection);
    for (const method of ['GET', 'HEAD', 'POST']) {
      let consumed = false;
      const captured = {};
      await handler({ method, async *[Symbol.asyncIterator]() { consumed = true; yield Buffer.from('{}'); } }, {
        writeHead(status, headers) { captured.status = status; captured.headers = headers; },
        end(body) { captured.body = body; },
      });
      assert.equal(captured.status, 503);
      assert.equal(consumed, false);
      assert.equal(captured.headers['cache-control'], 'no-store');
      if (method === 'HEAD') assert.equal(captured.body, undefined);
      else assert.deepEqual(JSON.parse(captured.body), { ok: false, error: 'authentication-unavailable' });
      assert.equal(readFileSync(patch, 'utf8'), PATCH);
    }
  }
});

test('async rejection is awaited and preserves authentication and origin status', async t => {
  const { root, patch } = fixture(t);
  for (const status of [401, 403]) {
    const handler = serve({ DSH_HOME: root }, { admit: async () => ({ rejection: status }) });
    for (const method of ['GET', 'HEAD', 'POST']) {
      const value = await request(handler, method, { model: 'must-not-be-saved' });
      assert.equal(value.status, status);
      assert.equal(value.body?.error, method === 'HEAD' ? undefined : status === 401 ? 'unauthorized' : 'forbidden');
    }
  }
  assert.equal(readFileSync(patch, 'utf8'), PATCH);
});

test('authenticated HEAD has GET headers without a response body', async t => {
  const { root } = fixture(t);
  const handler = serve({ DSH_HOME: root }, { admit: async () => ({ peer: {} }) });
  const get = await request(handler, 'GET');
  const head = await request(handler, 'HEAD');
  assert.equal(head.status, 200);
  assert.deepEqual(head.headers, get.headers);
  assert.equal(head.body, null);
});

test('authenticated oversized body and unsupported method do not alter the patch', async t => {
  const { root, patch } = fixture(t);
  const handler = serve({ DSH_HOME: root });
  const tooLarge = await request(handler, 'POST', { model: 'x'.repeat(4096) });
  assert.equal(tooLarge.status, 400);
  assert.equal(tooLarge.body.error, 'RDSH_SUBAGENT_ROUTE_BODY_TOO_LARGE');
  assert.equal((await request(handler, 'DELETE')).status, 405);
  assert.equal(readFileSync(patch, 'utf8'), PATCH);
});
