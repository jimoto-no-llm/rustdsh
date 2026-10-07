import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';

// Never run the real updater in a regression test.
let updateCalls = 0;
const execFile = childProcess.execFile;
childProcess.execFile = (...args) => {
  updateCalls++;
  queueMicrotask(() => args.at(-1)(null, 'test updater', ''));
  return new EventEmitter();
};
syncBuiltinESMExports();
const settings = await import('../plugins/rdsh-settings/index.js');
const updates = await import('../plugins/rdsh-update-banner/index.js');

test('plugin security boundary and settings preservation', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'rdsh-plugin-security-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    childProcess.execFile = execFile;
    syncBuiltinESMExports();
    await rm(home, { recursive: true, force: true });
  });
  const routes = new Map();
  const ctx = {
    effect: (effect) => effect(),
    webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
    connection: { requestRejection(req) { return req.rejection; } },
  };
  assert.ok(settings.inject.includes('connection'));
  assert.ok(updates.inject.includes('connection'));
  const disposeSettings = settings.apply(ctx, {});
  const disposeUpdates = updates.apply(ctx, { demo: true });
  t.after(() => { disposeSettings(); disposeUpdates(); });

  async function request(path, { rejection, method = 'GET', body = '{}' } = {}) {
    const req = Readable.from([Buffer.from(body)]);
    Object.assign(req, { method, rejection, headers: {} });
    let status, output;
    const res = { writeHead(code) { status = code; }, end(value) { output = value; } };
    await routes.get(path)(req, res);
    return { status, body: JSON.parse(output), consumed: req.readableEnded };
  }

  const original = {
    schema: 1, extras: { enable: ['serve', 'setup'] },
    guard: { deny: ['*secret*'], reason: 'keep' },
    context: { goal: 'keep goal', future_key: 'keep nested' },
    search: { max: 10, future_key: 'keep search' }, future_section: { flag: true },
  };
  const settingsFile = join(home, 'rdsh.json');
  const contextFile = join(home, 'rdsh-context.json');
  await writeFile(settingsFile, JSON.stringify(original));
  await writeFile(contextFile, JSON.stringify({ goal: 'legacy goal' }));
  const initialSettings = await readFile(settingsFile, 'utf8');
  const initialContext = await readFile(contextFile, 'utf8');

  await t.test('all six routes reject before body consumption or side effects', async () => {
    assert.equal(routes.size, 6);
    for (const rejection of [401, 403]) {
      for (const path of routes.keys()) {
        for (const method of ['GET', 'HEAD', 'POST']) {
          const result = await request(path, { rejection, method, body: '{invalid' });
          assert.equal(result.status, rejection, `${method} ${path}`);
          assert.equal(result.consumed, false);
        }
      }
    }
    const connection = ctx.connection;
    for (const missing of [undefined, {}]) {
      ctx.connection = missing;
      for (const path of routes.keys()) assert.equal((await request(path, { method: 'POST' })).status, 503);
    }
    ctx.connection = connection;
    assert.equal(await readFile(settingsFile, 'utf8'), initialSettings);
    assert.equal(await readFile(contextFile, 'utf8'), initialContext);
    assert.equal(updateCalls, 0);
  });

  await t.test('authenticated reads, saves and updater remain usable', async () => {
    for (const path of ['/api/rdsh-settings', '/api/rdsh-context', '/api/rdsh-update']) {
      assert.equal((await request(path)).status, 200);
      assert.equal((await request(path, { method: 'DELETE' })).status, 405);
    }
    const saved = await request('/api/rdsh-context/save', { method: 'POST', body: JSON.stringify({ goal: 'new legacy goal' }) });
    assert.equal(saved.status, 200);
    assert.equal(JSON.parse(await readFile(contextFile, 'utf8')).goal, 'new legacy goal');
    assert.equal((await request('/api/rdsh-update/run', { method: 'POST' })).status, 200);
    assert.equal(updateCalls, 1);
  });

  await t.test('round-trip and partial saves preserve keys outside the form', async () => {
    const loaded = (await request('/api/rdsh-settings')).body.config;
    assert.deepEqual(loaded.extras, original.extras);
    loaded.search.max = 42;
    loaded.extras.enable = [];
    loaded.future_section.flag = false;
    loaded.search.future_key = 'client must not overwrite';
    loaded.injected_section = { flag: true };
    const saved = await request('/api/rdsh-settings/save', { method: 'POST', body: JSON.stringify({ config: loaded }) });
    assert.equal(saved.status, 200);
    const stored = JSON.parse(await readFile(settingsFile, 'utf8'));
    assert.deepEqual(stored.extras, original.extras);
    assert.deepEqual(stored.future_section, original.future_section);
    assert.equal(stored.search.future_key, original.search.future_key);
    assert.equal(stored.injected_section, undefined);
    assert.equal(stored.search.max, 42);
    const partial = await request('/api/rdsh-settings/save', { method: 'POST', body: JSON.stringify({ search: { max: 999 } }) });
    assert.equal(partial.status, 200);
    assert.equal(partial.body.config.search.max, 100);
    assert.deepEqual(partial.body.config.guard, original.guard);
    assert.equal(partial.body.config.context.goal, original.context.goal);
    assert.equal(partial.body.config.context.future_key, 'keep nested');
  });

  await t.test('unreadable settings are never replaced with defaults', async () => {
    for (const raw of ['{broken', 'null', '[]']) {
      await writeFile(settingsFile, raw);
      const result = await request('/api/rdsh-settings/save', { method: 'POST', body: '{}' });
      assert.equal(result.status, 400);
      assert.equal(await readFile(settingsFile, 'utf8'), raw);
    }
  });
});
