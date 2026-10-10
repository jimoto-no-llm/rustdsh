import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, readdir, rm, symlink, link, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const source = await readFile(new URL('../plugins/rdsh-update-banner/client.js', import.meta.url), 'utf8');
const PERIOD = 7200000, START = 1700000000000, CLOSE_KEY = 'rdsh-update-close:v3';
const update = (to = 'v-next', extra = {}) => ({ ok: true, updated: true, kind: 'rustdsh', from: 'v-old', to, at: START, ...extra });
const response = (value) => ({ ok: true, json: async () => value });
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };

function host({ storage = new Map(), storageFails = false, initial = update(), now = START, streaming = false } = {}) {
  let state = [], cursor = 0, component, current = initial, requestOverride, postOverride, clock = now, waiting;
  const effects = new Map(), listeners = new Map(), intervals = new Set(), timers = new Map(), posts = [], chunks = [];
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat() }),
    useState(initial) { const i = cursor++; if (!(i in state)) state[i] = initial;
      return [state[i], (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v; }]; },
    useRef(initial) { const i = cursor++; if (!(i in state)) state[i] = { current: initial }; return state[i]; },
    useCallback: (callback) => callback,
    useEffect(callback) { const i = cursor++; if (!effects.has(i)) effects.set(i, callback()); },
  };
  const events = {
    addEventListener(name, f) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(f); },
    removeEventListener(name, f) { listeners.get(name)?.delete(f); },
  };
  const reader = {
    read: () => chunks.length ? Promise.resolve(chunks.shift()) : new Promise((resolve) => { waiting = resolve; }),
    cancel: async () => { waiting?.({ done: true }); waiting = null; },
  };
  vm.runInNewContext(source, {
    Date: class extends Date { static now() { return clock; } }, AbortController, TextDecoder,
    localStorage: {
      getItem(k) { if (storageFails) throw new Error('storage disabled'); return storage.get(k) ?? null; },
      setItem(k, v) { if (storageFails) throw new Error('storage disabled'); storage.set(k, v); },
    },
    fetch: async (url, options) => {
      if (options.method === 'POST') {
        posts.push({ url, ...JSON.parse(options.body || '{}') });
        return url.endsWith('/run') && postOverride ? postOverride() : response({ ok: true });
      }
      if (url.endsWith('/events')) {
        if (!streaming) return { ok: false };
        options.signal.addEventListener('abort', () => reader.cancel(), { once: true });
        return { ok: true, body: { getReader: () => reader } };
      }
      return requestOverride ? requestOverride() : response(current);
    },
    setInterval: (f) => { intervals.add(f); return f; }, clearInterval: (f) => intervals.delete(f),
    setTimeout: (f, ms) => { const id = {}; timers.set(id, { f, at: clock + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    document: { ...events, visibilityState: 'visible' },
    window: { ...events, __ModuleLoader__: { load(module) {
      module.factory(() => React).apply({ slots: { inject: (_name, f) => f(), register: (_options, c) => { component = c; } } });
    } } },
  });
  return {
    render() { cursor = 0; return component(); },
    async poll() { await Promise.all([...intervals].map((f) => f())); await settle(); },
    async advance(ms) {
      const end = clock + ms;
      for (;;) { const entry = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break; clock = entry[1].at; timers.delete(entry[0]); entry[1].f(); await settle(); }
      clock = end; await settle();
    },
    remount() { for (const f of effects.values()) f?.(); effects.clear(); state = []; this.render(); },
    dispose() { for (const f of effects.values()) f?.(); effects.clear(); },
    setUpdate(value) { current = value; }, setRequest(f) { requestOverride = f; },
    setPostRequest(f) { postOverride = f; },
    setStreaming(value) { streaming = value; },
    async disconnect() { await reader.cancel(); await settle(); },
    jump(ms) { clock += ms; },
    event(event, name = 'storage') { for (const f of listeners.get(name) || []) f(event); },
    async push(event, value) {
      const chunk = { value: new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`), done: false };
      if (waiting) { const resolve = waiting; waiting = null; resolve(chunk); } else chunks.push(chunk);
      await settle();
    },
    posts, storage, timers, intervals,
  };
}
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  return node.children.map((child) => find(child, predicate)).find(Boolean);
}
async function shown(t, options) {
  const fixture = host(options); t.after(() => fixture.dispose()); fixture.render(); await settle();
  assert.ok(fixture.render()); return fixture;
}
function close(fixture, which = 'dismiss') {
  const button = find(fixture.render(), (n) => n.tag === 'button' &&
    (which === 'close' ? n.props['aria-label'] === 'close' : n.children.includes('dismiss')));
  assert.ok(button); button.props.onClick(); assert.equal(fixture.render(), null);
}
for (const which of ['dismiss', 'close']) {
  test(`${which} closes only this occurrence; remount keeps it closed and full reload shows it`, async (t) => {
    const fixture = await shown(t); close(fixture, which); await fixture.poll(); assert.equal(fixture.render(), null);
    fixture.remount(); await settle(); assert.equal(fixture.render(), null);
    await shown(t, { storage: fixture.storage });
    assert.equal(fixture.posts[0].at, START); assert.equal(fixture.posts[0].cycle, 0);
  });
}
test('two-hour cadence is anchored to update time, continues through close/reload, and repeats', async (t) => {
  const fixture = await shown(t, { now: START + PERIOD - 600000 }); close(fixture);
  await fixture.advance(599999); assert.equal(fixture.render(), null);
  await fixture.advance(1); assert.ok(fixture.render()); close(fixture);
  await fixture.advance(PERIOD - 1); assert.equal(fixture.render(), null);
  await fixture.advance(1); assert.ok(fixture.render());
  const reload = await shown(t, { storage: fixture.storage, now: START + 2 * PERIOD + 3600000 }); close(reload);
  await reload.advance(3599999); assert.equal(reload.render(), null);
  await reload.advance(1); assert.ok(reload.render());
});
test('live state reaches an idle page without polling; a new update time starts a new occurrence', async (t) => {
  const fixture = host({ initial: { ok: true, updated: false }, streaming: true }); t.after(() => fixture.dispose());
  fixture.render(); await settle(); assert.equal(fixture.render(), null);
  await fixture.push('state', update()); assert.ok(fixture.render()); close(fixture);
  await fixture.push('state', update()); assert.equal(fixture.render(), null);
  await fixture.push('state', update('v-next', { at: START + 1 })); assert.ok(fixture.render());
});
test('late reads cannot resurrect a close or overwrite a streamed newer update', async (t) => {
  const fixture = await shown(t); let finish;
  fixture.setRequest(() => new Promise((resolve) => { finish = resolve; }));
  const pending = fixture.poll(); close(fixture); finish(response(update())); await pending; assert.equal(fixture.render(), null);
  const live = await shown(t, { streaming: true });
  live.setRequest(() => new Promise((resolve) => { finish = resolve; }));
  live.event({}, 'focus'); await settle();
  await live.push('state', update('v-newest')); finish(response(update('v-stale'))); await settle();
  assert.ok(JSON.stringify(live.render()).includes('v-newest'));
});
test('storage and stream closes match the current update and period, never a later reminder', async (t) => {
  const fixture = await shown(t, { streaming: true });
  const ack = { kind: 'rustdsh', to: 'v-next', at: START, cycle: 0 };
  fixture.event({ key: CLOSE_KEY, newValue: JSON.stringify({ ...ack, to: 'wrong' }) }); assert.ok(fixture.render());
  fixture.event({ key: CLOSE_KEY, newValue: '{broken' }); assert.ok(fixture.render());
  fixture.event({ key: CLOSE_KEY, newValue: JSON.stringify(ack) }); assert.equal(fixture.render(), null);
  await fixture.advance(PERIOD); assert.ok(fixture.render());
  await fixture.push('close', ack); assert.ok(fixture.render());
  await fixture.push('close', { ...ack, cycle: 1 }); assert.equal(fixture.render(), null);
});
test('legacy permanent dismissals are ignored; storage failures still support close, remount and reminders', async (t) => {
  await shown(t, { initial: update('v-next', { dismissed: true }), storage: new Map([
    ['rdsh-update-dismissed', JSON.stringify({ key: 'v-next@1', at: 1 })],
    ['rdsh-update-dismissed:v2:["rustdsh","v-next"]', '1'],
  ]) });
  const fixture = await shown(t, { storageFails: true }); close(fixture); fixture.remount(); await settle();
  assert.equal(fixture.render(), null); await fixture.advance(PERIOD); assert.ok(fixture.render());
});
test('disconnected streams fall back to polling and reconnect without reopening a closed occurrence', async (t) => {
  const fixture = await shown(t, { streaming: true }); close(fixture);
  fixture.setStreaming(false); await fixture.disconnect();
  fixture.setUpdate(update('v-during-disconnect')); await fixture.poll(); assert.ok(fixture.render()); close(fixture);
  fixture.setStreaming(true); await fixture.advance(1000);
  await fixture.push('state', update('v-during-disconnect')); assert.equal(fixture.render(), null);
  await fixture.push('state', update('v-after-reconnect')); assert.ok(fixture.render());
});
test('returning to a suspended page catches up to the fixed cadence without resetting it', async (t) => {
  const fixture = await shown(t); close(fixture); fixture.jump(PERIOD + 3600000);
  fixture.event({}, 'visibilitychange'); await settle(); assert.ok(fixture.render()); close(fixture);
  await fixture.advance(3599999); assert.equal(fixture.render(), null);
  await fixture.advance(1); assert.ok(fixture.render());
});
test('successful updater check closes its occurrence, preserves the cadence and allows reload', async (t) => {
  const fixture = await shown(t);
  await fixture.advance(PERIOD - 600000);
  await run(fixture); await settle(); assert.equal(fixture.render(), null);
  await fixture.poll(); assert.equal(fixture.render(), null);
  fixture.remount(); await settle(); assert.equal(fixture.render(), null);
  await shown(t, { storage: fixture.storage });
  await fixture.advance(599999); assert.equal(fixture.render(), null);
  await fixture.advance(1); assert.ok(fixture.render());
});
function run(fixture, label = 'update') {
  const button = find(fixture.render(), (n) => n.tag === 'button' && n.children.includes(label));
  assert.ok(button); return button.props.onClick();
}
test('failed updater remains retryable; success closes the card; HTTP errors never acknowledge it', async (t) => {
  const fixture = await shown(t); fixture.setPostRequest(() => response({ ok: false, message: 'DUMMY failure' }));
  await run(fixture); await settle(); assert.ok(JSON.stringify(fixture.render()).includes('DUMMY failure'));
  assert.equal(fixture.posts.filter((p) => p.url.endsWith('/dismiss')).length, 0);
  fixture.setPostRequest(() => ({ ...response({ ok: true }), ok: false }));
  await run(fixture, 'update again'); await settle(); assert.ok(fixture.render());
  fixture.setPostRequest(null); await run(fixture, 'update again'); await settle(); assert.equal(fixture.render(), null);
  assert.equal(fixture.posts.filter((p) => p.url.endsWith('/run')).length, 3);
});
test('an in-flight updater blocks duplicate clicks and cannot dismiss a newer update', async (t) => {
  const fixture = await shown(t, { streaming: true }); let finish;
  fixture.setPostRequest(() => new Promise((resolve) => { finish = resolve; }));
  const button = find(fixture.render(), (n) => n.tag === 'button' && n.children.includes('update'));
  const pending = button.props.onClick(); await button.props.onClick();
  assert.equal(fixture.posts.filter((p) => p.url.endsWith('/run')).length, 1);
  await fixture.push('state', update('v-during-run')); fixture.setUpdate(update('v-during-run'));
  finish(response({ ok: true })); await pending; await settle(); assert.ok(fixture.render());
  assert.ok(JSON.stringify(fixture.render()).includes('v-during-run'));
  assert.ok(find(fixture.render(), (n) => n.tag === 'button' && n.children.includes('update')));
  assert.equal(fixture.posts.filter((p) => p.url.endsWith('/dismiss')).length, 0);
  fixture.setPostRequest(null); await run(fixture); await settle(); assert.equal(fixture.render(), null);
  assert.equal(fixture.posts.filter((p) => p.url.endsWith('/run')).length, 2);
});
test('minimize persists within an occurrence; the next reminder expands it; cleanup removes timers', async (t) => {
  const fixture = await shown(t);
  find(fixture.render(), (n) => n.props.className === 'rub-row1').props.onClick(); await fixture.poll();
  assert.ok(find(fixture.render(), (n) => n.props.className === 'rub-mini')); assert.equal(fixture.posts.length, 0);
  await fixture.advance(PERIOD); assert.ok(find(fixture.render(), (n) => n.props.className === 'rub-card'));
  fixture.dispose(); assert.equal(fixture.timers.size, 0); assert.equal(fixture.intervals.size, 0);
});

test('authenticated occurrence-close API keeps updater state intact and streams bounded', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rdsh-update-close-'));
  const originalHome = os.homedir; os.homedir = () => root; syncBuiltinESMExports();
  t.after(async () => { os.homedir = originalHome; syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); });
  const { apply } = await import('../plugins/rdsh-update-banner/index.js');
  const directory = path.join(root, '.local/share/rdsh'), closePath = path.join(directory, 'update-notice-close.json');
  await mkdir(directory, { recursive: true });
  const statePath = path.join(directory, 'update-state.json');
  const setState = (value) => writeFile(statePath, JSON.stringify(value));
  const routes = new Map();
  const ctx = { effect: (f) => f(), connection: { requestRejection: (req) => req.rejection },
    webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } } };
  const dispose = apply(ctx, {}); t.after(dispose);
  async function request(route, { method = 'GET', body = '{}', rejection } = {}) {
    const req = Readable.from([Buffer.from(body)]); Object.assign(req, { method, rejection });
    let status, data; await routes.get(route)(req, { writeHead(v) { status = v; }, end(v) { data = JSON.parse(v); } });
    return { status, data, consumed: req.readableEnded };
  }
  const dismiss = (value) => request('/api/rdsh-update/dismiss', { method: 'POST', body: JSON.stringify(value) });
  const get = () => request('/api/rdsh-update');
  await setState(update()); const initialRaw = await readFile(statePath, 'utf8');
  await t.test('authentication precedes stream/body access; methods, bodies and occurrence inputs are bounded', async () => {
    for (const rejection of [401, 403, 503]) for (const route of ['/api/rdsh-update/dismiss', '/api/rdsh-update/events']) {
      const result = await request(route, { method: 'POST', rejection, body: '{bad' });
      assert.equal(result.status, rejection); assert.equal(result.consumed, false);
    }
    assert.equal((await request('/api/rdsh-update/dismiss')).status, 405);
    assert.equal((await request('/api/rdsh-update/events', { method: 'POST' })).status, 405);
    for (const body of ['{bad', 'null', '[]', '{}', JSON.stringify({ to: 'v-next', kind: '' }), JSON.stringify({ to: 'x'.repeat(513), kind: 'dsh' }), ' '.repeat(4097)]) {
      assert.equal((await request('/api/rdsh-update/dismiss', { method: 'POST', body })).status, 400);
    }
    for (const cycle of [-1, 0.5, '0', 1000001]) assert.equal((await dismiss({ ...update(), cycle })).status, 400);
    assert.equal((await dismiss(update('wrong'))).status, 409);
    assert.equal((await dismiss(update('v-next', { at: START + 1 }))).status, 409);
    assert.equal(await readFile(statePath, 'utf8'), initialRaw);
  });
  await t.test('atomic private closes never suppress reload or mutate update state; legacy markers stay intact', async () => {
    const markers = path.join(directory, 'update-dismissals'); await mkdir(markers);
    await writeFile(path.join(markers, 'legacy'), 'DUMMY_LEGACY');
    assert.equal((await dismiss({ ...update(), cycle: 0 })).status, 200);
    assert.equal(await readFile(statePath, 'utf8'), initialRaw);
    assert.equal((await get()).data.dismissed, undefined);
    await Promise.all(Array.from({ length: 8 }, () => dismiss({ ...update(), cycle: 1 })));
    const value = JSON.parse(await readFile(closePath, 'utf8')); assert.equal(value.cycle, 1);
    assert.equal((await readdir(directory)).filter((n) => n.endsWith('.tmp')).length, 0);
    assert.equal(await readFile(path.join(markers, 'legacy'), 'utf8'), 'DUMMY_LEGACY');
    if (process.platform !== 'win32') assert.equal((await stat(closePath)).mode & 0o777, 0o600);
    await setState(update('v-without-kind', { kind: '', at: -1 }));
    const legacy = (await get()).data; assert.equal(legacy.kind, 'update'); assert.ok(legacy.at > 0);
    assert.equal((await get()).data.at, legacy.at);
    await setState(update());
  });
  if (process.platform !== 'win32') await t.test('planted state and close links cannot read or modify outside files', async () => {
    const outside = path.join(root, 'DUMMY-outside'); await writeFile(outside, 'DUMMY_UNCHANGED');
    await rm(closePath); await symlink(outside, closePath);
    assert.equal((await dismiss(update())).status, 500); assert.equal(await readFile(outside, 'utf8'), 'DUMMY_UNCHANGED');
    await rm(closePath); await link(outside, closePath); assert.equal((await dismiss(update())).status, 500);
    assert.equal(await readFile(outside, 'utf8'), 'DUMMY_UNCHANGED'); await rm(closePath);
    const outsideState = path.join(root, 'DUMMY-update-state-outside'); await writeFile(outsideState, initialRaw);
    await rm(statePath); await symlink(outsideState, statePath);
    assert.deepEqual((await get()).data, { ok: false });
    assert.equal(await readFile(outsideState, 'utf8'), initialRaw);
    await rm(statePath); await setState(update());
    const real = path.join(root, 'real'); await mkdir(real); await writeFile(path.join(real, 'update-state.json'), initialRaw);
    await rm(directory, { recursive: true }); await symlink(real, directory);
    assert.equal((await dismiss(update())).status, 500); assert.deepEqual(await readdir(real), ['update-state.json']);
    await rm(directory); await mkdir(directory); await setState(update());
  });
  await t.test('streams cap subscribers, disconnect slow readers, bootstrap without old closes, and dispose', async () => {
    const streams = [];
    class Sink extends EventEmitter {
      frames = []; status; blocked = false;
      writeHead(status) { this.status = status; }
      write(frame) { this.frames.push(frame); return !this.blocked; }
      end(frame) { if (frame) this.frames.push(frame); this.emit('close'); }
      destroy() { this.emit('close'); }
    }
    const subscribe = async (sink) => { await routes.get('/api/rdsh-update/events')({ method: 'GET' }, sink); return sink; };
    for (let i = 0; i < 32; i++) streams.push(await subscribe(new Sink()));
    const excess = await subscribe(new Sink()); assert.equal(excess.status, 429);
    assert.ok(streams.every((s) => s.frames.some((v) => v.includes('event: state'))));
    assert.ok(streams.every((s) => !s.frames.some((v) => v.includes('event: close'))));
    streams[0].blocked = true; await dismiss({ ...update(), cycle: 0 });
    assert.ok(streams[1].frames.some((v) => v.includes('event: close')));
    const fresh = await subscribe(new Sink()); assert.equal(fresh.status, 200);
    assert.ok(!fresh.frames.some((v) => v.includes('event: close')));
    dispose(); assert.equal(routes.size, 0);
  });
  await t.test('demo closes never write account files and use a stable update time', async () => {
    const before = await readdir(directory), disposeDemo = apply(ctx, { demo: true });
    const demo = (await get()).data; assert.equal((await get()).data.at, demo.at);
    assert.equal((await dismiss({ ...demo, cycle: 0 })).status, 200);
    assert.deepEqual(await readdir(directory), before); disposeDemo();
  });
});

test('updater resolves from its installed plugin and refuses missing or unsafe scripts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rdsh-update-script-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pluginDirectory = path.join(root, 'plugins', 'rdsh-update-banner');
  await mkdir(pluginDirectory, { recursive: true });
  const modulePath = path.join(pluginDirectory, 'index.mjs');
  await writeFile(modulePath, await readFile(new URL('../plugins/rdsh-update-banner/index.js', import.meta.url), 'utf8'));
  const { apply } = await import(pathToFileURL(modulePath).href);
  const routes = new Map();
  const ctx = { effect: (f) => f(), connection: { requestRejection: (req) => req.rejection },
    webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } } };
  async function runWith() {
    const dispose = apply(ctx, {});
    const req = Readable.from([Buffer.from('{}')]); Object.assign(req, { method: 'POST' });
    let data;
    await routes.get('/api/rdsh-update/run')(req, { writeHead() {}, end(raw) { data = JSON.parse(raw); } });
    dispose();
    return data;
  }

  const syncScript = path.join(root, 'sync-dsh.sh');
  const missing = await runWith();
  assert.equal(missing.ok, false); assert.match(missing.message, /updater not found/);
  const target = path.join(root, 'DUMMY-sync-target.sh');
  await writeFile(target, "printf '%s\\n' 'DUMMY updater ran'\n", { mode: 0o700 });
  if (typeof process.getuid === 'function') {
    await symlink(target, syncScript);
    const unsafe = await runWith();
    assert.equal(unsafe.ok, false); assert.match(unsafe.message, /regular file owned by the current user/);
    await rm(syncScript);
    await writeFile(syncScript, await readFile(target, 'utf8'), { mode: 0o700 });
    const result = await runWith();
    assert.equal(result.ok, true); assert.match(result.message, /DUMMY updater ran/);
  } else {
    await writeFile(syncScript, await readFile(target, 'utf8'), { mode: 0o700 });
    const unverified = await runWith();
    assert.equal(unverified.ok, false); assert.match(unverified.message, /owned by the current user/);
  }
});
