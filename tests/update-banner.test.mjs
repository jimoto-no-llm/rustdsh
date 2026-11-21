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
const START = 1700000000000;
const CLOSE_KEY = 'rdsh-update-dismissals:v4';
const { compareVersions, selectDshTarget, installPrefixFor, activeDshInstall, APPLIED_STATE_TTL_MS } =
  await import('../plugins/rdsh-update-banner/index.js');

const dsh = (extra = {}) => ({
  available: true, from: '0.9.0', to: '1.0.0', at: START, channel: 'stable',
  command: 'npm install --prefix /tmp/runtime @deepseek-ai/dsh@1.0.0',
  details: 'https://www.npmjs.com/package/@deepseek-ai/dsh/v/1.0.0', installPrefix: '/tmp/runtime', managed: true, ...extra,
});
const applied = (to = 'v-next', extra = {}) => ({ ok: true, updated: true, kind: 'rustdsh', from: 'v-old', to, at: START, ...extra });
const state = (extra = {}) => ({ ok: true, updated: false, dsh: null, ...extra });
const response = (value) => ({ ok: true, json: async () => value });
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };

function host({ storage = new Map(), storageFails = false, locale = null, language = 'en-US',
  current = state(), streaming = false, failFetch = false, now = START } = {}) {
  let cursor = 0, component, requestOverride, postOverride, clock = now, waiting, failureCount = 0;
  const effects = new Map(), listeners = new Map(), intervals = new Set(), timers = new Map(), posts = [], chunks = [];
  const stateSlots = [];
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat() }),
    useState(initial) { const i = cursor++; if (!(i in stateSlots)) stateSlots[i] = typeof initial === 'function' ? initial() : initial;
      return [stateSlots[i], (v) => { stateSlots[i] = typeof v === 'function' ? v(stateSlots[i]) : v; }]; },
    useRef(initial) { const i = cursor++; if (!(i in stateSlots)) stateSlots[i] = { current: initial }; return stateSlots[i]; },
    useCallback(callback, deps) {
      const i = cursor++;
      const previous = stateSlots[i];
      if (previous && (!deps || !previous.deps || deps.every((value, index) => Object.is(value, previous.deps[index])))) return previous.callback;
      stateSlots[i] = { callback, deps };
      return callback;
    },
    useEffect(callback, deps) {
      const i = cursor++;
      const previous = effects.get(i);
      if (previous && deps && previous.deps && deps.length === previous.deps.length &&
        deps.every((value, index) => Object.is(value, previous.deps[index]))) return;
      if (previous && typeof previous.cleanup === 'function') previous.cleanup();
      effects.set(i, { deps, cleanup: callback() });
    },
  };
  const documentEvents = new EventEmitter();
  const windowEvents = new EventEmitter();
  windowEvents.setMaxListeners(40); documentEvents.setMaxListeners(40);
  const reader = {
    read: () => chunks.length ? Promise.resolve(chunks.shift()) : new Promise((resolve) => { waiting = resolve; }),
    cancel: async () => { waiting?.({ done: true }); waiting = null; },
  };
  let moduleExports;
  vm.runInNewContext(source, {
    Date: class extends Date { static now() { return clock; } }, AbortController, TextDecoder,
    localStorage: {
      getItem(key) { if (storageFails) throw new Error('storage disabled'); return storage.get(key) ?? null; },
      setItem(key, value) { if (storageFails) throw new Error('storage disabled'); storage.set(key, value); },
      removeItem(key) { if (storageFails) throw new Error('storage disabled'); storage.delete(key); },
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
      if (failFetch && failureCount++ >= 0) throw new Error('offline');
      return requestOverride ? requestOverride() : response(current);
    },
    setInterval: (fn) => { intervals.add(fn); return fn; }, clearInterval: (fn) => intervals.delete(fn),
    setTimeout: (fn, ms) => { const id = {}; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    document: { addEventListener: (n, f) => documentEvents.on(n, f), removeEventListener: (n, f) => documentEvents.off(n, f),
      visibilityState: 'visible', documentElement: { lang: '' }, activeElement: { focus() { API.focused = true; } } },
    window: { addEventListener: (n, f) => windowEvents.on(n, f), removeEventListener: (n, f) => windowEvents.off(n, f),
      __ModuleLoader__: { load(module) {
        moduleExports = module.factory(() => React);
        moduleExports.apply({ slots: { inject: (_name, fn) => fn(), register: (_options, c) => { component = c; } },
          locale: locale ? {
            getLocale: () => ({ active: locale }),
            bind: () => (key, params) => {
              const dictionary = moduleExports.__internals.dictionaries[locale] || moduleExports.__internals.dictionaries.en;
              const template = dictionary[key] !== undefined ? dictionary[key] : moduleExports.__internals.dictionaries.en[key];
              return String(template === undefined ? key : template).replace(/\{(\w+)\}/g, (m, name) => params && name in params ? String(params[name]) : m);
            },
            register: () => {},
          } : undefined,
        });
      } } },
    navigator: { language, languages: [language] },
  });
  const API = {
    get component() { return component; },
    get module() { return moduleExports; },
    focused: false,
    render() {
      cursor = 0;
      let node = component();
      // The plugin registers a small localization wrapper; render through it.
      for (let depth = 0; depth < 4 && node && typeof node.tag === 'function'; depth += 1) node = node.tag(node.props);
      return node;
    },
    async poll() { await Promise.all([...intervals].map((fn) => fn())); await settle(); },
    async advance(ms) {
      const end = clock + ms;
      for (;;) { const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break; clock = entry[1].at; timers.delete(entry[0]); entry[1].fn(); await settle(); }
      clock = end; await settle();
    },
    remount() { for (const entry of effects.values()) entry.cleanup?.(); effects.clear(); stateSlots.length = 0; cursor = 0; this.render(); },
    dispose() { for (const entry of effects.values()) entry.cleanup?.(); effects.clear(); },
    setCurrent(value) { current = value; }, setRequest(fn) { requestOverride = fn; }, setPostRequest(fn) { postOverride = fn; },
    setFailFetch(value) { failFetch = value; failureCount = 0; },
    async push(event, value) {
      const chunk = { value: new TextEncoder().encode('event: ' + event + '\ndata: ' + JSON.stringify(value) + '\n\n'), done: false };
      if (waiting) { const resolve = waiting; waiting = null; resolve(chunk); } else chunks.push(chunk);
      await settle();
    },
    key(key) { windowEvents.emit('keydown', { key, preventDefault() {} }); },
    storageEvent(key, newValue) { windowEvents.emit('storage', { key, newValue }); },
    storage, posts, intervals, timers,
  };
  return API;
}
function findAll(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  for (const child of node.children || []) findAll(child, predicate, found);
  return found;
}
function find(node, predicate) { return findAll(node, predicate)[0] || null; }
const text = (node) => {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (node.tag === 'style') return '';
  return (node.children || []).map(text).join('');
};
const byTestId = (id) => (node) => node.props && node.props['data-testid'] === id;
async function shown(t, options) {
  const fixture = host(options); t.after(() => fixture.dispose()); fixture.render(); await settle();
  return fixture;
}
function press(fixture, testId) {
  const button = find(fixture.render(), byTestId(testId));
  assert.ok(button, 'expected button ' + testId);
  button.props.onClick();
}

test('one overlay card holds every notice; dsh never nests a second card', async (t) => {
  const fixture = await shown(t, { current: state({ updated: true, kind: 'rustdsh', from: 'v-old', to: 'v-next', at: START, dsh: dsh() }) });
  const tree = fixture.render();
  assert.equal(findAll(tree, byTestId('update-card')).length, 1);
  assert.equal(findAll(tree, byTestId('update-row-dsh')).length, 1);
  assert.equal(findAll(tree, byTestId('update-row-rustdsh')).length, 1);
  assert.equal(tree.props.role, 'status');
  assert.equal(tree.props['aria-live'], 'polite');
  // One dismissal control exists per row plus the card-level close.
  const dismissals = findAll(tree, (n) => n.props && /^dismiss-/.test(n.props['data-testid'] || ''));
  assert.deepEqual(dismissals.map((n) => n.props['data-testid']).sort(), ['dismiss-dsh', 'dismiss-rustdsh']);
  assert.equal(findAll(tree, byTestId('close-notices')).length, 1);
});

test('from == to and to-less payloads never render; malformed notices are ignored', async (t) => {
  const fixture = await shown(t, { current: state({ updated: true, kind: 'rustdsh', from: 'v-same', to: 'v-same', at: START }) });
  assert.equal(fixture.render(), null);
  fixture.setCurrent(state({ updated: true, kind: 'rustdsh', from: 'v-old', to: null, at: START }));
  await fixture.poll(); assert.equal(fixture.render(), null);
  fixture.setCurrent(state({ updated: true, kind: 'rustdsh', from: 'v-old', to: 'v-next', at: START,
    dsh: dsh({ from: '1.0.0', to: '1.0.0' }) }));
  await fixture.poll();
  const tree = fixture.render();
  assert.ok(find(tree, byTestId('update-row-rustdsh')));
  assert.equal(find(tree, byTestId('update-row-dsh')), null);
});

test('a dsh dismissal is stable across registry re-checks and only a new release notifies again', async (t) => {
  const fixture = await shown(t, { current: state({ dsh: dsh() }) });
  press(fixture, 'dismiss-dsh');
  const post = fixture.posts.find((p) => p.url.endsWith('/dismiss'));
  assert.equal(post.kind, 'dsh'); assert.equal(post.to, '1.0.0'); assert.equal(post.from, '0.9.0');
  assert.equal(fixture.render(), null);
  fixture.setCurrent(state({ dsh: dsh({ at: START + 12 * 3600 * 1000 }) }));
  await fixture.poll(); assert.equal(fixture.render(), null);
  fixture.remount(); await settle(); assert.equal(fixture.render(), null);
  const reload = host({ storage: fixture.storage, now: START + 24 * 3600 * 1000,
    current: state({ dsh: dsh({ at: START + 24 * 3600 * 1000 }) }) });
  t.after(() => reload.dispose()); reload.render(); await settle(); assert.equal(reload.render(), null);
  fixture.setCurrent(state({ dsh: dsh({ from: '1.0.0', to: '1.1.0' }) }));
  await fixture.poll();
  const tree = fixture.render();
  assert.ok(tree); assert.match(text(tree), /1\.0\.0/); assert.match(text(tree), /1\.1\.0/);
});

test('a dismissed applied confirmation never returns; a different release notifies once', async (t) => {
  const fixture = await shown(t, { current: state({ updated: true, kind: 'rustdsh', from: 'v-old', to: 'v-next', at: START }) });
  press(fixture, 'dismiss-rustdsh');
  await fixture.poll(); assert.equal(fixture.render(), null);
  fixture.remount(); await settle(); assert.equal(fixture.render(), null);
  fixture.setCurrent(state({ updated: true, kind: 'rustdsh', from: 'v-old', to: 'v-later', at: START + 1 }));
  await fixture.poll(); assert.ok(fixture.render());
});

test('an applied update is a short-lived confirmation, not a permanent alert', async (t) => {
  const fixture = await shown(t, { current: state({ updated: true, kind: 'rustdsh', from: 'v-old', to: 'v-next', at: START }) });
  assert.match(text(fixture.render()), /rustdsh updated/);
  await fixture.advance(9000); await fixture.poll();
  assert.equal(fixture.render(), null);
  await fixture.poll(); assert.equal(fixture.render(), null);
  // A poll carrying the same record does not resurrect it.
  fixture.setCurrent(state({ updated: true, kind: 'rustdsh', from: 'v-old', to: 'v-next', at: START }));
  await fixture.poll(); assert.equal(fixture.render(), null);
  const other = host({ storage: fixture.storage, now: START + 60000,
    current: state({ updated: true, kind: 'rustdsh', from: 'v-old', to: 'v-next', at: START }) });
  t.after(() => other.dispose()); other.render(); await settle(); assert.equal(other.render(), null);
});

test('restart-required survives a reload, is announced, and is cleared by dismissing it', async (t) => {
  const fixture = await shown(t, { current: state({ dsh: dsh() }) });
  fixture.setPostRequest(() => response({ ok: true, restartRequired: true, version: '1.0.0', prefix: '/tmp/runtime' }));
  const update = find(fixture.render(), byTestId('update-dsh'));
  assert.ok(update); await update.props.onClick(); await settle(); await fixture.poll();
  const tree = fixture.render();
  assert.match(text(tree), /Restart required/);
  assert.match(text(tree), /restart the DSH web service/i);
  assert.equal(find(tree, byTestId('update-dsh')), null);
  const reload = host({ storage: fixture.storage, current: state({ dsh: dsh() }) });
  t.after(() => reload.dispose()); reload.render(); await settle(); await reload.poll();
  const reloaded = reload.render();
  assert.ok(reloaded); assert.match(text(reloaded), /Restart required/);
  press(reload, 'dismiss-dsh'); assert.equal(reload.render(), null);
});

test('a failed apply is an error state with retry, role=alert and localized copy', async (t) => {
  const fixture = await shown(t, { current: state({ dsh: dsh() }), locale: 'ja' });
  fixture.setPostRequest(() => response({ ok: false, message: 'DUMMY npm failure' }));
  await find(fixture.render(), byTestId('update-dsh')).props.onClick(); await settle();
  const tree = fixture.render();
  assert.equal(tree.props.role, 'alert');
  assert.equal(tree.props['aria-live'], 'assertive');
  assert.match(text(tree), /DUMMY npm failure/);
  assert.match(text(tree), /再試行/);
  assert.ok(find(tree, byTestId('update-dsh')));
  fixture.setPostRequest(null);
  await find(fixture.render(), byTestId('update-dsh')).props.onClick(); await settle();
  const recovered = fixture.render();
  assert.equal(recovered.props.role, 'status');
  assert.equal(findAll(recovered, byTestId('update-row-dsh')).length, 1);
  // A successful apply is a transient confirmation, not a permanent alert.
  await fixture.advance(9000); await fixture.poll();
  assert.equal(fixture.render(), null);
});

test('a failed check is an error with retry instead of looking up to date', async (t) => {
  const fixture = host({ failFetch: true }); t.after(() => fixture.dispose());
  fixture.render(); await settle(); await fixture.poll(); await fixture.poll();
  const tree = fixture.render();
  assert.ok(tree); assert.equal(tree.props.role, 'alert');
  assert.match(text(tree), /Could not check for updates/);
  assert.ok(find(tree, byTestId('retry-check')));
});

test('locale dictionaries cover every key and render Japanese, Chinese and English copy', async (t) => {
  const dictionaries = host({}).module.__internals.dictionaries;
  const english = Object.keys(dictionaries.en).sort();
  assert.deepEqual(Object.keys(dictionaries.ja).sort(), english);
  assert.deepEqual(Object.keys(dictionaries.zh).sort(), english);
  const cases = [['ja', /dsh のアップデートがあります/], ['zh', /dsh 有可用更新/], ['en', /dsh update available/]];
  for (const [locale, pattern] of cases) {
    const fixture = await shown(t, { current: state({ dsh: dsh() }), locale });
    const tree = fixture.render();
    assert.match(text(tree), pattern);
    assert.equal(find(tree, byTestId('close-notices')).props['aria-label'],
      locale === 'ja' ? '更新のお知らせをすべて閉じる' : locale === 'zh' ? '关闭所有更新通知' : 'Dismiss all update notifications');
  }
  // Without a DSH locale the browser language decides.
  const browser = await shown(t, { current: state({ dsh: dsh() }), language: 'zh-CN' });
  assert.match(text(browser.render()), /dsh 有可用更新/);
});

test('accessibility: expansion state, Escape closes, and focus returns to the page', async (t) => {
  const fixture = await shown(t, { current: state({ dsh: dsh() }) });
  const toggle = find(fixture.render(), byTestId('toggle-dsh'));
  assert.equal(toggle.props['aria-expanded'], false);
  toggle.props.onClick();
  const expanded = find(fixture.render(), byTestId('toggle-dsh'));
  assert.equal(expanded.props['aria-expanded'], true);
  assert.ok(find(fixture.render(), (n) => n.tag === 'a' && n.props.href === dsh().details));
  fixture.key('Escape');
  assert.equal(fixture.render(), null);
  assert.equal(fixture.focused, true);
  assert.ok(fixture.posts.some((p) => p.url.endsWith('/dismiss') && p.kind === 'dsh'));
  assert.match(source, /\.rub-close\{[^}]*width:44px;height:44px/);
  assert.match(source, /\.rub-btn,\.rub-link\{[^}]*min-height:44px/);
});

test('dsh channel and relative checked time are shown, and same versions are not repeated', async (t) => {
  const fixture = await shown(t, { current: state({ dsh: dsh({ channel: 'prerelease', at: START - 2 * 3600 * 1000 }) }) });
  const tree = fixture.render();
  assert.match(text(tree), /Prerelease/);
  assert.match(text(tree), /Checked 2 h ago/);
  assert.doesNotMatch(text(tree), /0\.9\.0 → 0\.9\.0/);
});

// ---- server contract -------------------------------------------------------

async function serverFixture(t, config = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rdsh-update-server-'));
  const originalHome = os.homedir;
  os.homedir = () => root; syncBuiltinESMExports();
  const { apply } = await import('../plugins/rdsh-update-banner/index.js?' + Math.random());
  const directory = path.join(root, '.local/share/rdsh');
  await mkdir(directory, { recursive: true });
  const routes = new Map();
  const ctx = { effect: (f) => f(), connection: { requestRejection: (req) => req.rejection },
    webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } } };
  const dispose = apply(ctx, config);
  t.after(async () => { dispose?.(); os.homedir = originalHome; syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); });
  const setState = async (value) => writeFile(path.join(directory, 'update-state.json'), JSON.stringify(value));
  const setDshCache = async (value) => {
    const cache = path.join(root, '.cache/rdsh-desktop/update-check.json');
    await mkdir(path.dirname(cache), { recursive: true });
    await writeFile(cache, JSON.stringify(value));
  };
  async function request(route, { method = 'GET', body = '{}', rejection } = {}) {
    const req = Readable.from(body === '' ? [] : [Buffer.from(body)]); Object.assign(req, { method, rejection });
    let status, data;
    await routes.get(route)(req, { writeHead(value) { status = value; }, end(value) { data = value ? JSON.parse(value) : undefined; } });
    return { status, data };
  }
  const dismiss = (value) => request('/api/rdsh-update/dismiss', { method: 'POST', body: JSON.stringify(value) });
  const get = () => request('/api/rdsh-update');
  return { root, directory, routes, setState, setDshCache, request, dismiss, get, dispose };
}

test('dsh publish target comes from dist-tags, with correct prerelease ordering', () => {
  assert.equal(compareVersions('1.0.0-alpha.10', '1.0.0-alpha.2'), 1);
  assert.equal(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.11'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  const versions = ['1.0.0', '1.1.0-rc.1', '1.0.5'];
  assert.equal(selectDshTarget({ latest: '1.0.0', next: '1.1.0-rc.1' }, versions, '0.9.0').target, '1.0.0');
  assert.equal(selectDshTarget({ latest: '1.0.0', next: '1.1.0-rc.1' }, versions, '0.9.0').channel, 'stable');
  assert.equal(selectDshTarget({ latest: '1.0.0', next: '1.1.0-rc.1' }, versions, '1.1.0-rc.0').target, '1.1.0-rc.1');
  assert.equal(selectDshTarget({ latest: '1.0.0', next: '1.1.0-rc.1' }, versions, '1.1.0-rc.0').channel, 'next');
  assert.equal(selectDshTarget({ latest: '1.1.0-rc.1' }, versions, '0.9.0').target, '1.0.5');
});

test('active install shape is consistent and both npm layouts resolve a prefix', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rdsh-update-prefix-'));
  try {
    const flat = path.join(root, 'flat', 'node_modules', '@deepseek-ai', 'dsh');
    const nested = path.join(root, 'nested', 'lib', 'node_modules', '@deepseek-ai', 'dsh');
    const unscoped = path.join(root, 'plain', 'node_modules', 'dsh');
    for (const directory of [flat, nested, unscoped]) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.2.3' }));
    }
    assert.equal(installPrefixFor(flat), path.join(root, 'flat'));
    assert.equal(installPrefixFor(nested), path.join(root, 'nested'));
    assert.equal(installPrefixFor(unscoped), path.join(root, 'plain'));
    assert.equal(installPrefixFor(path.join(root, 'flat', 'node_modules')), null);
    const shape = activeDshInstall();
    assert.equal(typeof shape, 'object');
    for (const key of ['version', 'prefix', 'managed', 'environmentVersion']) assert.ok(key in shape, key);
    const previous = process.env.DSH_VERSION;
    process.env.DSH_VERSION = '9.9.9';
    assert.deepEqual(Object.keys(activeDshInstall()).sort(), Object.keys(shape).sort());
    assert.equal(activeDshInstall().version, '9.9.9');
    if (previous === undefined) delete process.env.DSH_VERSION; else process.env.DSH_VERSION = previous;
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('server suppresses same-version, stale and orphaned rustxng records', async (t) => {
  const fixture = await serverFixture(t);
  const now = Date.now();
  await fixture.setState({ updated: true, kind: 'rustdsh', from: 'v-1', to: 'v-1', at: now });
  assert.equal((await fixture.get()).data.updated, false);
  await fixture.setState({ updated: true, kind: 'rustdsh', from: 'v-1', to: 'v-2', at: now - APPLIED_STATE_TTL_MS - 60000 });
  assert.equal((await fixture.get()).data.updated, false);
  await fixture.setState({ updated: true, kind: 'rustdsh', from: 'v-1', to: 'v-2', at: now - 60000 });
  assert.equal((await fixture.get()).data.updated, true);
  // sync-dsh.sh records a rebuilt payload with the same version label as a
  // replacement (no 'from'): that is a real update and must still render.
  await fixture.setState({ updated: true, kind: 'rdsh-release', to: 'v-2', at: now, replaced: true });
  const replaced = (await fixture.get()).data;
  assert.equal(replaced.updated, true);
  assert.equal(replaced.from, null);
  assert.equal(replaced.to, 'v-2');
  await fixture.setState({ updated: true, kind: 'rustxng', from: '1.0.0', to: '1.1.0', at: now });
  const emptyPath = path.join(fixture.root, 'empty', 'bin');
  await mkdir(emptyPath, { recursive: true });
  const previousPath = process.env.PATH;
  process.env.PATH = emptyPath;
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
  assert.equal((await fixture.get()).data.updated, false);
  const withBinary = path.join(emptyPath, 'rdsh');
  if (typeof process.getuid === 'function') {
    await writeFile(withBinary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    assert.equal((await fixture.get()).data.updated, true);
  }
});

test('a dsh dismissal matches the live target, survives a cache refresh and never closes rdsh notices', async (t) => {
  const fixture = await serverFixture(t);
  const now = Date.now();
  await fixture.setState({ updated: false });
  const previousVersion = process.env.DSH_VERSION;
  process.env.DSH_VERSION = '0.9.0';
  t.after(() => { if (previousVersion === undefined) delete process.env.DSH_VERSION; else process.env.DSH_VERSION = previousVersion; });
  await fixture.setDshCache({ checkedAt: now, newest: '1.0.0', channel: 'stable' });
  const status = (await fixture.get()).data;
  assert.ok(status.dsh, 'dsh availability travels with the client state');
  // The release (to) is the identity; "from" is display-only. A stale client
  // version must not make the dismissal fail, and it cannot widen the target.
  assert.equal((await fixture.dismiss({ kind: 'dsh', from: '9.9.9', to: '1.0.0' })).status, 200);
  assert.equal((await fixture.dismiss({ kind: 'dsh', to: '2.0.0' })).status, 409);
  assert.equal((await fixture.dismiss({ kind: 'rdsh', from: 'v-1', to: '1.0.0' })).status, 409);
  assert.equal((await fixture.dismiss({ kind: 'dsh', from: '9.9.9', to: '2.0.0' })).status, 409);
  assert.equal((await fixture.dismiss({ kind: 'dsh', to: '1.0.0' })).status, 200);
  const close = JSON.parse(await readFile(path.join(fixture.directory, 'update-notice-close.json'), 'utf8'));
  assert.equal(close.kind, 'dsh'); assert.equal(close.to, '1.0.0'); assert.ok(close.closedAt > 0);
  await fixture.setDshCache({ checkedAt: now - 12 * 3600 * 1000, newest: '1.0.0', channel: 'stable' });
  assert.equal((await fixture.get()).data.dsh.to, '1.0.0');
  assert.equal((await fixture.dismiss({ kind: 'dsh', from: status.dsh.from || undefined, to: '1.0.0' })).status, 200);
  await fixture.setState({ updated: true, kind: 'rustdsh', from: 'v-1', to: 'v-2', at: now });
  assert.equal((await fixture.dismiss({ kind: 'dsh', to: '1.0.0' })).status, 200);
  assert.equal((await fixture.dismiss({ kind: 'rustdsh', from: 'v-1', to: 'v-2' })).status, 200);
});

test('dismiss streams reach other GUI tabs and the old cycle field is no longer required', async (t) => {
  const fixture = await serverFixture(t);
  const now = Date.now();
  await fixture.setState({ updated: true, kind: 'rustdsh', from: 'v-1', to: 'v-2', at: now });
  class Sink extends EventEmitter {
    frames = []; status;
    writeHead(status) { this.status = status; }
    write(frame) { this.frames.push(frame); return true; }
    end(frame) { if (frame) this.frames.push(frame); this.emit('close'); }
    destroy() { this.emit('close'); }
  }
  const sink = new Sink(); await fixture.routes.get('/api/rdsh-update/events')({ method: 'GET' }, sink);
  assert.ok(sink.frames.some((frame) => frame.includes('event: state')));
  assert.equal((await fixture.dismiss({ kind: 'rustdsh', from: 'v-1', to: 'v-2' })).status, 200);
  assert.ok(sink.frames.some((frame) => frame.includes('event: close')));
  for (const body of ['{bad', 'null', '[]', JSON.stringify({ to: '', kind: 'dsh' }),
    JSON.stringify({ to: 'x'.repeat(513), kind: 'dsh' }), JSON.stringify({ to: '1.0.0', kind: '' }), ' '.repeat(4097)]) {
    assert.equal((await fixture.request('/api/rdsh-update/dismiss', { method: 'POST', body })).status, 400);
  }
  for (const rejection of [401, 403, 503]) {
    const denied = await fixture.request('/api/rdsh-update/dismiss', { method: 'POST', rejection, body: '{bad' });
    assert.equal(denied.status, rejection);
  }
});

test('demo closes still write nothing and every update route is authenticated', async (t) => {
  const fixture = await serverFixture(t, { demo: true });
  const before = await readdir(fixture.directory);
  await fixture.dismiss({ kind: 'demo', from: '0.2.0-rc.2', to: '0.2.1-rc.1' });
  assert.deepEqual(await readdir(fixture.directory), before);
  assert.deepEqual([...fixture.routes.keys()].sort(), ['/api/rdsh-update', '/api/rdsh-update/dismiss',
    '/api/rdsh-update/dsh/run', '/api/rdsh-update/events', '/api/rdsh-update/run', '/api/rdsh-update/rustxng/run']);
});

test('feature switches gate every update route and keep polling when notifications are off', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'rdsh-update-features-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });
  const { apply } = await import('../plugins/rdsh-update-banner/index.js?features');
  const server = () => {
    const routes = new Map();
    const ctx = { effect: (f) => f(), connection: { requestRejection: (req) => req.rejection },
      webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } } };
    return { routes, ctx };
  };
  await writeFile(path.join(home, 'rdsh.json'), JSON.stringify({ features: { update_check: false } }));
  const off = server();
  const disposeOff = apply(off.ctx, { demo: true });
  assert.equal(off.routes.size, 0);
  disposeOff?.();
  await writeFile(path.join(home, 'rdsh.json'), JSON.stringify({ features: { update_notifications: false } }));
  const polling = server();
  const disposePolling = apply(polling.ctx, { demo: true });
  assert.deepEqual([...polling.routes.keys()].sort(), ['/api/rdsh-update', '/api/rdsh-update/dismiss',
    '/api/rdsh-update/dsh/run', '/api/rdsh-update/run', '/api/rdsh-update/rustxng/run']);
  disposePolling?.();
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
  }
});

test('close records accept the previous on-disk shape and stay private and atomic', async (t) => {
  const fixture = await serverFixture(t);
  const file = path.join(fixture.directory, 'update-notice-close.json');
  await fixture.setState({ updated: true, kind: 'rustdsh', from: 'v-1', to: 'v-2', at: Date.now() });
  await writeFile(file, JSON.stringify({ id: '00000000-0000-4000-8000-000000000000', kind: 'rustdsh',
    to: 'v-2', at: START, cycle: 3 }), { mode: 0o600 });
  assert.equal((await fixture.dismiss({ kind: 'rustdsh', from: 'v-1', to: 'v-2' })).status, 200);
  const value = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(value.closedAt > 0);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await readdir(fixture.directory)).filter((name) => name.endsWith('.tmp')).length, 0);
});

test('planted state and close links cannot read or modify outside files', async (t) => {
  if (process.platform === 'win32') return;
  const fixture = await serverFixture(t);
  await fixture.setState({ updated: true, kind: 'rustdsh', from: 'v-1', to: 'v-2', at: Date.now() });
  const outside = path.join(fixture.root, 'DUMMY-outside');
  await writeFile(outside, 'DUMMY_UNCHANGED');
  const close = path.join(fixture.directory, 'update-notice-close.json');
  await symlink(outside, close);
  assert.equal((await fixture.dismiss({ kind: 'rustdsh', from: 'v-1', to: 'v-2' })).status, 500);
  assert.equal(await readFile(outside, 'utf8'), 'DUMMY_UNCHANGED');
  await rm(close); await link(outside, close); assert.equal((await fixture.dismiss({ kind: 'rustdsh', from: 'v-1', to: 'v-2' })).status, 500);
  await rm(close);
  const statePath = path.join(fixture.directory, 'update-state.json');
  await writeFile(outside, 'DUMMY_STATE');
  await rm(statePath, { force: true });
  await symlink(outside, statePath);
  const blocked = (await fixture.get()).data;
  assert.equal(blocked.ok, false); assert.equal(blocked.to, undefined);
});

test('a successful retry after a failed check reports up to date briefly, then hides', async (t) => {
  const fixture = host({ failFetch: true }); t.after(() => fixture.dispose());
  fixture.render(); await settle(); await fixture.poll(); await fixture.poll();
  assert.equal(fixture.render().props.role, 'alert');
  fixture.setFailFetch(false);
  fixture.setCurrent(state({ dsh: { available: false, from: '1.0.0', to: '1.0.0', at: START } }));
  await find(fixture.render(), byTestId('retry-check')).props.onClick(); await settle();
  const tree = fixture.render();
  assert.ok(tree); assert.equal(tree.props.role, 'status');
  assert.match(text(tree), /up to date/i);
  await fixture.advance(6000); await fixture.poll();
  assert.equal(fixture.render(), null);
});

test('a managed dsh install uses the running prefix, verifies package.json and requires a restart', async (t) => {
  const fixture = await serverFixture(t);
  const prefix = path.join(fixture.root, 'runtime');
  const pkg = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh');
  await mkdir(path.join(pkg, 'lib'), { recursive: true });
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.9.0' }));
  await writeFile(path.join(pkg, 'lib', 'cli.js'), '');
  const bin = path.join(fixture.root, 'bin');
  await mkdir(bin, { recursive: true });
  const log = path.join(fixture.root, 'npm.log');
  const npm = path.join(bin, 'npm');
  const script = [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "' + log + '"',
    'root=""',
    'prev=""',
    'last=""',
    'for a in "$@"; do',
    '  if [ "$prev" = "--prefix" ]; then root="$a"; fi',
    '  prev="$a"',
    '  last="$a"',
    'done',
    'if [ -z "$root" ]; then exit 3; fi',
    'ver=${last##*@}',
    'mkdir -p "$root/node_modules/@deepseek-ai/dsh"',
    'printf \x27{"name":"@deepseek-ai/dsh","version":"%s"}\x27 "$ver" > "$root/node_modules/@deepseek-ai/dsh/package.json"',
    '',
  ].join('\n');
  await writeFile(npm, script, { mode: 0o700 });
  const previousArgv = process.argv[1], previousPath = process.env.PATH, previousVersion = process.env.DSH_VERSION;
  delete process.env.DSH_VERSION;
  process.argv[1] = path.join(pkg, 'lib', 'cli.js');
  // The stub comes first; the real PATH keeps sh utilities (mkdir) resolvable.
  process.env.PATH = bin + path.delimiter + (previousPath || '');
  t.after(() => {
    process.argv[1] = previousArgv;
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousVersion === undefined) delete process.env.DSH_VERSION; else process.env.DSH_VERSION = previousVersion;
  });
  await fixture.setDshCache({ checkedAt: Date.now(), newest: '1.0.0', channel: 'stable' });
  assert.equal((await fixture.get()).data.dsh.available, true);
  const result = await fixture.request('/api/rdsh-update/dsh/run', { method: 'POST' });
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true, result.data.message);
  const args = (await readFile(log, 'utf8')).trim();
  assert.equal(result.data.restartRequired, true);
  assert.match(result.data.message, /restart/i);
  assert.match(args, /install --prefix /);
  const written = await readFile(path.join(pkg, 'package.json'), 'utf8');
  assert.match(written, /1\.0\.0/, 'stub npm wrote the requested version: ' + written);
  assert.doesNotMatch(args, /(^| )-g( |$)/);
  const installed = JSON.parse(await readFile(path.join(pkg, 'package.json'), 'utf8'));
  assert.equal(installed.version, '1.0.0');
});

test('a dsh install refuses to fall back to npm -g when the running prefix is unknown', async (t) => {
  const fixture = await serverFixture(t);
  const previousVersion = process.env.DSH_VERSION, previousPath = process.env.PATH;
  process.env.DSH_VERSION = '0.9.0';
  const bin = path.join(fixture.root, 'bin');
  await mkdir(bin, { recursive: true });
  const marker = path.join(fixture.root, 'npm-ran');
  await writeFile(path.join(bin, 'npm'), '#!/bin/sh\ntouch "' + marker + '"\nexit 0\n', { mode: 0o700 });
  process.env.PATH = bin;
  t.after(() => {
    if (previousVersion === undefined) delete process.env.DSH_VERSION; else process.env.DSH_VERSION = previousVersion;
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  });
  await fixture.setDshCache({ checkedAt: Date.now(), newest: '1.0.0', channel: 'stable' });
  const result = await fixture.request('/api/rdsh-update/dsh/run', { method: 'POST' });
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, false);
  assert.match(result.data.message, /could not locate the running dsh installation/);
  await assert.rejects(readFile(marker), /ENOENT/);
});
