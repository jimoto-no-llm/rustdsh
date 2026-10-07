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
    assert.equal(loaded.extras, undefined);
    loaded.search.max = 42;
    loaded.extras = { enable: [] };
    loaded.future_section = { flag: false };
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
    assert.equal(partial.body.config.context.future_key, undefined);
    assert.equal(JSON.parse(await readFile(settingsFile, 'utf8')).context.future_key, 'keep nested');
  });

  await t.test('cleared working files stay empty alongside legacy aliases', async () => {
    await writeFile(settingsFile, JSON.stringify({ ...original, context: { files: ['stale.rs'], future_key: 'keep nested' } }));
    const loaded = (await request('/api/rdsh-settings')).body.config;
    assert.deepEqual(loaded.context.working_files, ['stale.rs']);
    loaded.context.working_files = [];
    assert.equal((await request('/api/rdsh-settings/save', { method: 'POST', body: JSON.stringify(loaded) })).status, 200);
    const stored = JSON.parse(await readFile(settingsFile, 'utf8'));
    assert.deepEqual(stored.context.working_files, []);
    assert.equal(stored.context.files, undefined);
    assert.equal(stored.context.future_key, 'keep nested');
    assert.deepEqual(stored.extras, original.extras);
    assert.deepEqual((await request('/api/rdsh-settings')).body.config.context.working_files, []);
    for (const legacy of [{ files: ['legacy.rs'] }, { working_files: [], files: ['legacy.rs'] }]) {
      await writeFile(contextFile, JSON.stringify(legacy));
      assert.deepEqual((await request('/api/rdsh-context')).body.config.working_files, legacy.working_files ?? legacy.files);
    }
  });

  for (const context of [undefined, null]) {
    await t.test(`unrelated partial saves leave ${context === null ? 'null' : 'missing'} context unset`, async () => {
      const document = { search: { max: 10 }, extras: original.extras };
      if (context === null) document.context = null;
      await writeFile(settingsFile, JSON.stringify(document));
      const legacy = { goal: 'keep legacy goal', working_files: ['legacy.rs'], max_code_hits: 35, max_sessions: 4 };
      await writeFile(contextFile, JSON.stringify(legacy));
      const saved = await request('/api/rdsh-settings/save', { method: 'POST', body: JSON.stringify({ search: { max: 42 } }) });
      assert.equal(saved.status, 200);
      const stored = JSON.parse(await readFile(settingsFile, 'utf8'));
      assert.equal(stored.search.max, 42);
      assert.equal(stored.context, context);
      assert.deepEqual(stored.extras, original.extras);
      assert.equal(saved.body.config.context.goal, legacy.goal);
      assert.deepEqual(saved.body.config.context.working_files, legacy.working_files);
      assert.deepEqual(JSON.parse(await readFile(contextFile, 'utf8')), legacy);
    });
  }

  await t.test('form round-trip migrates active legacy context before unrelated edits', async () => {
    await writeFile(settingsFile, JSON.stringify({ search: { max: 10 }, extras: original.extras }));
    const legacy = { goal: 'keep legacy goal', files: ['legacy.rs'], enable_packer: false, decisions: ['keep decision'], max_code_hits: 35, max_sessions: 4 };
    await writeFile(contextFile, JSON.stringify(legacy));
    const loaded = (await request('/api/rdsh-settings')).body.config;
    assert.equal(loaded.context.goal, legacy.goal);
    assert.deepEqual(loaded.context.working_files, legacy.files);
    assert.equal(loaded.context.max_code_hits, 35);
    assert.equal(loaded.context.max_sessions, 4);
    loaded.search.max = 42;
    assert.equal((await request('/api/rdsh-settings/save', { method: 'POST', body: JSON.stringify({ config: loaded }) })).status, 200);
    const stored = JSON.parse(await readFile(settingsFile, 'utf8'));
    assert.equal(stored.context.goal, legacy.goal);
    assert.deepEqual(stored.context.working_files, legacy.files);
    assert.equal(stored.context.enable_packer, false);
    assert.deepEqual(stored.context.decisions, legacy.decisions);
    assert.equal(stored.context.files, undefined);
    assert.deepEqual(stored.extras, original.extras);
    assert.deepEqual(JSON.parse(await readFile(contextFile, 'utf8')), legacy);
  });

  await t.test('a context edit preserves other legacy values while honoring explicit clears', async () => {
    await writeFile(settingsFile, JSON.stringify({ search: { max: 10 } }));
    const legacy = { goal: 'keep legacy goal', files: ['legacy.rs'], constraints: ['keep constraint'] };
    await writeFile(contextFile, JSON.stringify(legacy));
    const saved = await request('/api/rdsh-settings/save', { method: 'POST', body: JSON.stringify({ context: { working_files: [] } }) });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.config.context.goal, legacy.goal);
    assert.deepEqual(saved.body.config.context.constraints, legacy.constraints);
    assert.deepEqual(saved.body.config.context.working_files, []);
    assert.deepEqual((await request('/api/rdsh-settings')).body.config.context.working_files, []);
    assert.deepEqual(JSON.parse(await readFile(contextFile, 'utf8')), legacy);
  });

  for (const [name, extra] of [
    ['long legacy paths', { context: { files: Array(50).fill('あ'.repeat(300)) } }],
    ['large unmodeled section', { future_section: { value: 'x'.repeat(1024 * 1024) } }],
  ]) {
    await t.test(`form round-trip remains saveable with ${name}`, async () => {
      const document = { ...original, ...extra };
      await writeFile(settingsFile, JSON.stringify(document));
      const loaded = (await request('/api/rdsh-settings')).body.config;
      loaded.search.max = 42;
      const body = JSON.stringify({ config: loaded });
      const saved = await request('/api/rdsh-settings/save', { method: 'POST', body });
      assert.equal(saved.status, 200, `form request has ${Buffer.byteLength(body)} bytes`);
      assert.ok(Buffer.byteLength(body) < 65536);
      for (const config of [loaded, saved.body.config]) {
        assert.equal(config.extras, undefined);
        assert.equal(config.future_section, undefined);
        assert.equal(config.search.future_key, undefined);
        assert.equal(config.context.files, undefined);
      }
      const stored = JSON.parse(await readFile(settingsFile, 'utf8'));
      assert.equal(stored.search.max, 42);
      assert.deepEqual(stored.extras, original.extras);
      assert.equal(stored.search.future_key, original.search.future_key);
      if (extra.future_section) assert.deepEqual(stored.future_section, extra.future_section);
      if (extra.context) assert.deepEqual(stored.context.working_files, extra.context.files);
    });
  }

  await t.test('all supported form fields fit within the bounded save body', async () => {
    // JSON escapes cost six bytes per character, exceeding multibyte UTF-8 paths.
    const text = (n) => '\u0001'.repeat(n);
    const rows = (n) => Array(50).fill(text(n));
    const document = {
      ...original,
      general: { default_profile: text(500) },
      search: { dir: text(300), searxng_url: text(500) },
      guard: { deny: rows(300), reason: text(500) },
      context: { goal: text(2000), decisions: rows(500), constraints: rows(500), working_files: rows(300), open_tasks: rows(500) },
    };
    await writeFile(settingsFile, JSON.stringify(document));
    const loaded = (await request('/api/rdsh-settings')).body.config;
    const body = JSON.stringify({ config: loaded });
    assert.ok(Buffer.byteLength(body) > 65536);
    assert.ok(Buffer.byteLength(body) < 1024 * 1024);
    const saved = await request('/api/rdsh-settings/save', { method: 'POST', body });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.config, loaded);
    const stored = await readFile(settingsFile, 'utf8');
    const oversized = JSON.stringify({ config: loaded, padding: 'x'.repeat(1024 * 1024) });
    assert.equal((await request('/api/rdsh-settings/save', { method: 'POST', body: oversized })).status, 400);
    assert.equal(await readFile(settingsFile, 'utf8'), stored);
  });

  await t.test('unreadable settings are never replaced with defaults', async () => {
    for (const raw of ['{broken', 'null', '[]']) {
      await writeFile(settingsFile, raw);
      const result = await request('/api/rdsh-settings/save', { method: 'POST', body: '{}' });
      assert.equal(result.status, 400);
      assert.equal(await readFile(settingsFile, 'utf8'), raw);
    }
  });

  await t.test('reads report corrupt settings instead of displaying defaults', async () => {
    for (const raw of ['{broken', 'null', '[]']) {
      await writeFile(settingsFile, raw);
      const result = await request('/api/rdsh-settings');
      assert.equal(result.status, 400);
      assert.equal(result.body.ok, false);
      assert.equal(result.body.config, undefined);
      assert.equal(await readFile(settingsFile, 'utf8'), raw);
    }
  });

  await t.test('missing settings use the current Rust dashboard port', async () => {
    await rm(settingsFile);
    const result = await request('/api/rdsh-settings');
    assert.equal(result.status, 200);
    assert.equal(result.body.config.serve.port, 38080);
    assert.equal((await request('/api/rdsh-settings/save', {
      method: 'POST', body: JSON.stringify(result.body.config),
    })).status, 200);
    assert.equal(JSON.parse(await readFile(settingsFile, 'utf8')).serve.port, 38080);
  });
});
