import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, readdir, rm, symlink, link, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import vm from 'node:vm';

const source = await readFile(new URL('../plugins/rdsh-update-banner/client.js', import.meta.url), 'utf8');
const update = (to = 'v-next', extra = {}) => ({ ok: true, updated: true, kind: 'rustdsh', from: 'v-old', to, at: 100, ...extra });
const prefix = 'rdsh-update-dismissed:v2:';
const key = (value) => prefix + JSON.stringify([value.kind, value.to]);
const response = (value) => ({ ok: true, json: async () => value });
const settle = () => new Promise((resolve) => setImmediate(resolve));

function host({ storage = new Map(), storageFails = false, initial = update() } = {}) {
  let state = [], cursor = 0, component, current = initial, requestOverride;
  const effects = new Map(), listeners = new Set(), intervals = new Set(), posts = [];
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat() }),
    useState(initial) {
      const i = cursor++;
      if (!(i in state)) state[i] = initial;
      return [state[i], (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v; }];
    },
    useRef(initial) {
      const i = cursor++;
      if (!(i in state)) state[i] = { current: initial };
      return state[i];
    },
    useCallback: (callback) => callback,
    useEffect(callback) { const i = cursor++; if (!effects.has(i)) effects.set(i, callback()); },
  };
  vm.runInNewContext(source, {
    localStorage: {
      getItem(k) { if (storageFails) throw new Error('storage disabled'); return storage.get(k) ?? null; },
      setItem(k, v) { if (storageFails) throw new Error('storage disabled'); storage.set(k, v); },
      removeItem(k) { if (storageFails) throw new Error('storage disabled'); storage.delete(k); },
    },
    fetch: async (_url, options) => {
      if (options.method === 'POST') { posts.push(JSON.parse(options.body)); return response({ ok: true }); }
      return requestOverride ? requestOverride() : response(current);
    },
    setInterval: (f) => { intervals.add(f); return f; },
    clearInterval: (f) => intervals.delete(f),
    window: {
      addEventListener: (_name, f) => listeners.add(f),
      removeEventListener: (_name, f) => listeners.delete(f),
      __ModuleLoader__: { load(module) {
        module.factory(() => React).apply({ slots: {
          inject: (_name, f) => f(), register: (_options, c) => { component = c; },
        } });
      } },
    },
  });
  return {
    render() { cursor = 0; return component(); },
    async poll() { await Promise.all([...intervals].map((f) => f())); },
    remount() { for (const f of effects.values()) f?.(); effects.clear(); state = []; this.render(); },
    setUpdate(value) { current = value; },
    setRequest(f) { requestOverride = f; },
    event(event) { for (const f of listeners) f(event); },
    posts, storage,
  };
}
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  return node.children.map((child) => find(child, predicate)).find(Boolean);
}
async function shown(options) {
  const fixture = host(options); fixture.render(); await settle();
  assert.ok(fixture.render()); return fixture;
}
function close(fixture, which = 'dismiss') {
  const button = find(fixture.render(), (n) => n.tag === 'button' &&
    (which === 'close' ? n.props['aria-label'] === 'close' : n.children.includes('dismiss')));
  assert.ok(button); button.props.onClick(); assert.equal(fixture.render(), null);
}

for (const which of ['dismiss', 'close']) {
  test(`${which} survives timestamp changes, old timestamps, remount and reload`, async () => {
    const fixture = await shown(); close(fixture, which);
    fixture.setUpdate(update('v-next', { at: Date.now() + 3 * 3600000 }));
    await fixture.poll(); assert.equal(fixture.render(), null);
    fixture.remount(); await settle(); assert.equal(fixture.render(), null);
    const reload = host({ storage: fixture.storage, initial: update('v-next', { at: -1 }) });
    reload.render(); await settle(); assert.equal(reload.render(), null);
    assert.ok(fixture.posts.every((p) => p.to === 'v-next' && p.kind === 'rustdsh'));
  });
}
test('multiple dismissed targets stay hidden; another kind or genuinely new target appears', async () => {
  const fixture = await shown(); close(fixture);
  fixture.setUpdate(update('v-second')); await fixture.poll(); assert.ok(fixture.render()); close(fixture);
  for (const to of ['v-next', 'v-second']) {
    fixture.setUpdate(update(to)); await fixture.poll(); assert.equal(fixture.render(), null);
  }
  fixture.setUpdate(update('v-next', { kind: 'dsh' })); await fixture.poll(); assert.ok(fixture.render());
  fixture.setUpdate(update('v-third')); await fixture.poll(); assert.ok(fixture.render());
});
test('storage errors never overwrite an in-memory dismissal, including remount', async () => {
  const fixture = await shown({ storageFails: true }); close(fixture);
  for (let i = 0; i < 3; i++) { await fixture.poll(); assert.equal(fixture.render(), null); }
  fixture.remount(); await settle(); assert.equal(fixture.render(), null);
});
test('old expired records migrate and corrupt records do not break rendering', async () => {
  const storage = new Map([['rdsh-update-dismissed', JSON.stringify({ key: 'v-next@1', at: 1 })]]);
  const fixture = host({ storage }); fixture.render(); await settle(); assert.equal(fixture.render(), null);
  assert.equal(storage.get(key(update())), '1');
  assert.equal(fixture.posts.length, 1); // Migrated dismissal also reaches the account.
  assert.equal(storage.has('rdsh-update-dismissed'), false);
  fixture.setUpdate(update('v-next', { kind: 'dsh' })); await fixture.poll(); assert.ok(fixture.render());
  for (const raw of ['{broken', JSON.stringify({ key: 'v-nextX' }), 'null', '[]']) {
    await shown({ storage: new Map([['rdsh-update-dismissed', raw]]) });
  }
});
test('another tab closes an already visible banner immediately and persists on remount', async () => {
  const storage = new Map(); const a = await shown({ storage }); const b = await shown({ storage });
  close(a); b.event({ key: key(update()), newValue: '1' }); assert.equal(b.render(), null);
  b.remount(); await settle(); assert.equal(b.render(), null);
  assert.equal(b.posts.length, 1);
});
test('a delayed poll cannot resurrect a dismissal or overwrite a newer update', async () => {
  const fixture = await shown(); let finish;
  fixture.setRequest(() => new Promise((resolve) => { finish = resolve; }));
  const pending = fixture.poll(); close(fixture); finish(response(update())); await pending;
  assert.equal(fixture.render(), null);
  fixture.setRequest(() => new Promise((resolve) => { finish = resolve; }));
  const old = fixture.poll();
  fixture.setRequest(null); fixture.setUpdate(update('v-newest')); await fixture.poll();
  finish(response(update('v-stale'))); await old;
  assert.ok(JSON.stringify(fixture.render()).includes('v-newest'));
});
test('server acknowledgement hides the banner without browser storage; minimizing is not dismissal', async () => {
  const fixture = host({ storageFails: true, initial: update('v-next', { dismissed: true }) });
  fixture.render(); await settle(); assert.equal(fixture.render(), null);
  const visible = await shown();
  find(visible.render(), (n) => n.props.className === 'rub-row1').props.onClick();
  assert.ok(find(visible.render(), (n) => n.props.className === 'rub-mini'));
  assert.equal(visible.posts.length, 0); await visible.poll();
  assert.ok(find(visible.render(), (n) => n.props.className === 'rub-mini'));
});

test('account-wide dismissal API preserves authentication and isolated update state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rdsh-update-ack-'));
  const originalHome = os.homedir; os.homedir = () => root; syncBuiltinESMExports();
  t.after(async () => { os.homedir = originalHome; syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); });
  const updates = await import('../plugins/rdsh-update-banner/index.js');
  const directory = path.join(root, '.local/share/rdsh');
  const markers = path.join(directory, 'update-dismissals');
  await mkdir(directory, { recursive: true });
  const statePath = path.join(directory, 'update-state.json');
  const setState = (value) => writeFile(statePath, JSON.stringify(value));
  const routes = new Map();
  const ctx = { effect: (f) => f(), connection: { requestRejection: (req) => req.rejection },
    webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } } };
  const dispose = updates.apply(ctx, {}); t.after(dispose);
  async function request(route, { method = 'GET', body = '{}', rejection } = {}) {
    const req = Readable.from([Buffer.from(body)]); Object.assign(req, { method, rejection });
    let status, data; await routes.get(route)(req, { writeHead(v) { status = v; }, end(v) { data = JSON.parse(v); } });
    return { status, data, consumed: req.readableEnded };
  }
  const dismiss = (value) => request('/api/rdsh-update/dismiss', { method: 'POST', body: JSON.stringify({ to: value.to, kind: value.kind }) });
  const get = () => request('/api/rdsh-update');
  await setState(update()); const initialRaw = await readFile(statePath, 'utf8');
  await t.test('authentication precedes body reads and file writes; methods and input are bounded', async () => {
    for (const rejection of [401, 403]) {
      const result = await request('/api/rdsh-update/dismiss', { method: 'POST', rejection, body: '{bad' });
      assert.equal(result.status, rejection); assert.equal(result.consumed, false);
    }
    assert.equal((await request('/api/rdsh-update/dismiss')).status, 405);
    for (const body of ['{bad', 'null', '[]', '{}', JSON.stringify({ to: 'v-next', kind: '' }), JSON.stringify({ to: 'x'.repeat(513), kind: 'dsh' }), ' '.repeat(4097)]) {
      assert.equal((await request('/api/rdsh-update/dismiss', { method: 'POST', body })).status, 400);
    }
    assert.equal((await dismiss(update('wrong'))).status, 409);
    assert.equal(await readFile(statePath, 'utf8'), initialRaw);
    await assert.rejects(readdir(markers), { code: 'ENOENT' });
  });
  await t.test('dismissals survive timestamps, separate plugin instances and versions without changing updater state', async () => {
    assert.equal((await get()).data.dismissed, false);
    assert.equal((await dismiss(update())).status, 200);
    assert.equal(await readFile(statePath, 'utf8'), initialRaw);
    await setState(update('v-next', { at: 99999999 })); assert.equal((await get()).data.dismissed, true);
    await setState(update('v-other')); assert.equal((await get()).data.dismissed, false);
    await Promise.all(Array.from({ length: 8 }, () => dismiss(update('v-other'))));
    assert.equal((await get()).data.dismissed, true);
    await setState(update()); assert.equal((await get()).data.dismissed, true);
    const second = updates.apply(ctx, {}); assert.equal((await get()).data.dismissed, true); second();
    updates.apply(ctx, {});
    const files = await readdir(markers); assert.equal(files.length, 2);
    for (const name of files) {
      assert.match(name, /^[a-f0-9]{64}$/);
      if (process.platform !== 'win32') assert.equal((await stat(path.join(markers, name))).mode & 0o777, 0o600);
    }
    await setState(update('v-without-kind', { kind: '' }));
    assert.equal((await get()).data.kind, 'update');
    assert.equal((await dismiss(update('v-without-kind', { kind: 'update' }))).status, 200);
    assert.equal((await get()).data.dismissed, true);
  });
  if (process.platform !== 'win32') await t.test('planted marker links cannot truncate outside files; linked directories are refused', async () => {
    const outside = path.join(root, 'DUMMY-outside'); await writeFile(outside, 'DUMMY_UNCHANGED');
    const { createHash } = await import('node:crypto');
    const value = update('v-planted');
    const target = path.join(markers, createHash('sha256').update(JSON.stringify([value.kind, value.to])).digest('hex'));
    await setState(value); await symlink(outside, target);
    assert.equal((await dismiss(value)).status, 500); assert.equal((await get()).data.dismissed, false);
    assert.equal(await readFile(outside, 'utf8'), 'DUMMY_UNCHANGED');
    await rm(target); await link(outside, target); assert.equal((await dismiss(value)).status, 500);
    assert.equal(await readFile(outside, 'utf8'), 'DUMMY_UNCHANGED');
    await rm(markers, { recursive: true }); const elsewhere = path.join(root, 'elsewhere'); await mkdir(elsewhere);
    await symlink(elsewhere, markers); assert.equal((await dismiss(value)).status, 500);
    assert.deepEqual(await readdir(elsewhere), []);
  });
  await t.test('demo dismissal never writes account state', async () => {
    const before = await readdir(markers);
    const disposeDemo = updates.apply(ctx, { demo: true });
    assert.equal((await dismiss({ kind: 'demo', to: '0.2.1-rc.1' })).status, 200);
    assert.deepEqual(await readdir(markers), before);
    disposeDemo();
  });
});
