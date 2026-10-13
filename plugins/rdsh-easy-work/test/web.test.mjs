import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerWeb } from '../index.js';
import { createOrganizer } from '../organizer.js';

test('GUI routes authenticate, require JSON confirmation and suppress filesystem error paths', async t => {
  const handlers = new Map(); let called = 0, closed = false;
  const dispose = registerWeb({ webServer: { register(route) { handlers.set(route.path, route.handler); return () => handlers.delete(route.path); } },
    connection: { requestRejection: req => req.headers['x-fixture-gui'] === 'yes' ? undefined : 401 } }, {
    async preview() { called++; throw new Error('private /path/never-shown'); },
    async execute(id, confirmed) { called++; return { id, confirmed }; },
    async close() { closed = true; },
  });
  const routes = ['preview', 'execute', 'undo', 'recover', 'status', 'release'].map(action => '/api/rdsh-easy-work/' + action);
  const server = createServer((req, res) => {
    for (const route of routes) if (req.url === route) return handlers.get(route)(req, res);
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await dispose(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/api/rdsh-easy-work/`;
  let response = await fetch(url + 'preview', { method: 'POST', body: '{}' });
  assert.equal(response.status, 401); assert.equal(called, 0);
  response = await fetch(url + 'preview', { method: 'GET', headers: { 'x-fixture-gui': 'yes' } });
  assert.equal(response.status, 405); assert.equal(called, 0);
  response = await fetch(url + 'preview', { method: 'POST', headers: { 'x-fixture-gui': 'yes', 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(response.status, 409); assert.equal(called, 0);
  response = await fetch(url + 'preview', { method: 'POST', headers: { 'x-fixture-gui': 'yes', 'content-type': 'application/json' }, body: '{}' });
  assert.deepEqual(await response.json(), { ok: false, error: 'REQUEST_FAILED' });
  response = await fetch(url + 'execute', { method: 'POST', headers: { 'x-fixture-gui': 'yes', 'content-type': 'application/json' }, body: '{"id":"fixture-id","confirmed":true}' });
  assert.equal((await response.json()).result.confirmed, true);
  await dispose(); assert.equal(handlers.size, 0); assert.equal(closed, true);
});

test('actual HTTP mutations reject forged plans, ambiguous confirmation and oversized JSON', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'rdsh-easy-http-'));
  await writeFile(join(folder, 'a.txt'), 'synthetic source');
  const handlers = new Map(), organizer = createOrganizer();
  const dispose = registerWeb({ webServer: { register(route) { handlers.set(route.path, route.handler); return () => handlers.delete(route.path); } },
    connection: { requestRejection: () => undefined } }, organizer);
  const routes = ['preview', 'execute', 'undo', 'recover', 'status', 'release'].map(action => '/api/rdsh-easy-work/' + action);
  const server = createServer((req, res) => {
    for (const route of routes) if (req.url === route) return handlers.get(route)(req, res);
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await dispose(); await new Promise(resolve => server.close(resolve)); await rm(folder, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}/api/rdsh-easy-work/`;
  const post = (action, body) => fetch(url + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const preview = await post('preview', JSON.stringify({ path: folder })), plan = (await preview.json()).result;
  assert.equal(preview.headers.get('cache-control'), 'no-store'); assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
  for (const confirmed of [false, 'true', 1, null]) {
    const response = await post('execute', JSON.stringify({ id: plan.id, confirmed, entries: [{ name: 'client-forged.txt' }] }));
    assert.equal(response.status, 409); assert.equal((await response.json()).error, 'CONFIRMATION_REQUIRED');
  }
  let response = await post('execute', '{"id":"client-forged-plan","confirmed":true}');
  assert.equal((await response.json()).error, 'PLAN_EXPIRED');
  for (const body of ['{', 'null', '[]', JSON.stringify({ path: 'あ'.repeat(3000) })]) {
    response = await post('preview', body); assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { ok: false, error: 'REQUEST_FAILED' });
  }
  assert.deepEqual(await readdir(folder), ['a.txt']);
  response = await post('status', JSON.stringify({ id: plan.id })); assert.equal((await response.json()).result.state, 'preview');
  assert.equal((await post('unknown', '{}')).status, 404);
});

test('GUI routes fail closed when the native authentication guard is absent', async t => {
  const handlers = new Map(); let called = false;
  const dispose = registerWeb({ webServer: { register(route) { handlers.set(route.path, route.handler); return () => handlers.delete(route.path); } } },
    { preview() { called = true; }, async close() {} });
  t.after(dispose);
  let status, value;
  await handlers.get('/api/rdsh-easy-work/preview')({ method: 'POST', headers: {} }, {
    writeHead(code) { status = code; }, end(body) { value = JSON.parse(body); },
  });
  assert.equal(status, 503); assert.equal(called, false); assert.equal(value.error, 'GUI_AUTH_REQUIRED');
});
