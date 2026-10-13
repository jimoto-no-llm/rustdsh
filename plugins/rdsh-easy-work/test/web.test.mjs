import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { registerWeb } from '../index.js';

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
