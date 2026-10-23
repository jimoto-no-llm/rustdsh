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

function serve(env) {
  let handler = null;
  const ctx = {
    webServer: {
      register({ path: route, handler: value }) {
        if (route === '/api/rdsh-subagent-route') handler = value;
        return () => { handler = null; };
      },
    },
    effect(run) { return run(); },
  };
  apply(ctx, { env });
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

test('a profile without a patch reports unsupported instead of creating one', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'rdsh-subagent-route-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'profiles', 'web'), { recursive: true });
  const handler = serve({ DSH_HOME: root });
  const value = await request(handler, 'GET');
  assert.equal(value.body.supported, false);
  const post = await request(handler, 'POST', { model: 'm' });
  assert.equal(post.status, 409);
  assert.equal(post.body.error, 'RDSH_SUBAGENT_ROUTE_NO_PROFILE');
});
