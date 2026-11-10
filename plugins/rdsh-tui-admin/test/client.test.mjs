import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
test('client bridge is opt-in, exposes only public navigation, validates identities and disposes', () => {
  for (const enabled of [undefined, false, true]) {
    let definition, dispose;
    const opened = [];
    const world = { __RDSH_TUI_BRIDGE_ENABLED__: enabled, window: { __ModuleLoader__: { load(value) { definition = value; } } } };
    runInNewContext(source, world);
    const plugin = definition.factory();
    let selected;
    plugin.apply({ uiWorkspace: { openSession(id) { opened.push(id); } }, layout: { beginNavigation() {} },
      sessions: { list: { getSnapshot() { return { phase: 'ready', byId: { 'fixture-session': {} } }; } } },
      sidebarRight: { mounted: { getSnapshot() { return selected; } } }, effect(operation) { dispose = operation(); } });
    const bridge = world.__RDSH_TUI_WORKSPACE__;
    if (enabled !== true) { assert.equal(bridge, undefined); continue; }
    assert.deepEqual(Object.keys(bridge), ['navigationReady', 'openSession', 'selectedSessionId', 'openWorkspacePath']);
    assert.equal(bridge.selectedSessionId(), null);
    assert.equal(bridge.openSession('fixture-session').requestedSessionId, 'fixture-session');
    assert.equal(bridge.selectedSessionId(), null, 'request receipt must not masquerade as mounted selection');
    selected = 'observed-session';
    assert.equal(bridge.selectedSessionId(), 'observed-session');
    assert.deepEqual(opened, ['fixture-session']);
    for (const invalid of ['', null, {}, 'a'.repeat(513), 'a\nb']) assert.throws(() => bridge.openSession(invalid));
    dispose();
    assert.equal(world.__RDSH_TUI_WORKSPACE__, undefined);
  }
});

function fixture() {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.style = {}; this.listeners = {}; this.textContent = ''; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(key, listener) { this.listeners[key] = listener; }
    append(...children) { this.children.push(...children); for (const child of children) child.parent = this; }
    replaceChildren() { this.children = []; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
    async click() { await this.listeners.click?.(); }
    all() { return [this, ...this.children.flatMap(child => child.all())]; }
  }
  const body = new Element('body');
  let definition, dispose, mounted = 'fixture-session';
  const opened = [], directories = [];
  const ctx = {
    layout: { beginNavigation() {} },
    sessions: { list: { getSnapshot() { return { phase: 'ready', byId: { 'fixture-session': {}, requested: {} } }; } } },
    uiWorkspace: { openSession() {}, async listDirectory(path) {
      directories.push(path);
      return { path, crumbs: [{ name: 'root', path: '/workspace' }], entries: [{ name: '<unsafe-name>', path: '/workspace/nested' }], truncated: false };
    } },
    sidebarRight: { mounted: { getSnapshot() { return mounted; } }, openResource(address) { opened.push(address); } },
    remote: { workspaceFiles: {
      async stat(_id, path) { return path.endsWith('/folder')
        ? { ok: false, error: { code: 'workspace-file/not-regular-file', details: { kind: 'directory' } } }
        : { ok: true, value: { absolutePath: path } }; },
      async list() { return { ok: true, value: { entries: [{ type: 'file', name: 'hello #?.txt' }], truncated: false } }; },
    } },
    effect(operation) { dispose = operation(); },
  };
  const workspaceFiles = ctx.remote.workspaceFiles;
  let declaration;
  Object.defineProperty(ctx.remote, 'workspaceFiles', { get() {
    assert.ok(declaration.inject.includes('remote.workspaceFiles'),
      'Cordis requires namespace injection; injecting remote alone cannot access workspaceFiles');
    return workspaceFiles;
  } });
  const world = { __RDSH_TUI_BRIDGE_ENABLED__: true, AbortController,
    document: { body, createElement: tag => new Element(tag) },
    window: { __ModuleLoader__: { load(value) { definition = value; } } } };
  runInNewContext(source, world);
  declaration = definition.factory();
  declaration.apply(ctx);
  return { bridge: world.__RDSH_TUI_WORKSPACE__, ctx, opened, directories, body, dispose,
    select(id) { mounted = id; }, button(text) { return body.all().find(element => element.tag === 'button' && element.textContent === text); } };
}

test('workspace file opening uses session resource preview, validates requests and refuses navigation races', async () => {
  const f = fixture();
  const result = await f.bridge.openWorkspacePath({ path: '/workspace/a #?.txt', application: '/Applications/Editor.app' });
  assert.equal(result.view, 'document');
  assert.equal(f.opened[0], 'dsh-resource://file/session/fixture-session//workspace/a%20%23%3F.txt');
  assert.equal(f.directories.length, 0);
  for (const request of [null, { path: '' }, { path: '/x', action: 'execute' }, { path: '/x', arbitrary: true }])
    await assert.rejects(f.bridge.openWorkspacePath(request));
  f.ctx.remote.workspaceFiles.stat = async () => { f.select('different'); return { ok: true, value: { absolutePath: '/x' } }; };
  await assert.rejects(f.bridge.openWorkspacePath({ path: '/x' }), /セッション/);
  assert.equal(f.opened.length, 1);
  f.select(undefined);
  assert.equal(f.bridge.selectedSessionId(), null);
  await assert.rejects(f.bridge.openWorkspacePath({ path: '/x' }), /セッション/);
  f.dispose();
});

test('explicit session navigation cancels pending restoration before opening and never cancels for invalid input', async () => {
  const f = fixture();
  const previous = new AbortController();
  const order = [];
  let observed = 'before';
  let finishRestoration;
  const restoration = new Promise(resolve => { finishRestoration = resolve; }).then(() => {
    if (!previous.signal.aborted) observed = 'restored';
  });
  f.ctx.layout.beginNavigation = () => { order.push('cancel'); previous.abort(); return new AbortController().signal; };
  f.ctx.uiWorkspace.openSession = id => { order.push('open'); observed = id; };
  assert.throws(() => f.bridge.openSession(''));
  assert.equal(previous.signal.aborted, false);
  f.bridge.openSession('requested');
  assert.deepEqual(order, ['cancel', 'open']);
  finishRestoration();
  await restoration;
  assert.equal(observed, 'requested');
  f.dispose();
});

test('navigation readiness waits for public catalog baseline and requested session arrival', () => {
  const f = fixture();
  let state = { phase: 'pending', byId: {} };
  f.ctx.sessions.list.getSnapshot = () => state;
  assert.equal(f.bridge.navigationReady(), false);
  assert.equal(f.bridge.navigationReady('fixture-session'), false);
  assert.throws(() => f.bridge.openSession('fixture-session'), /一覧同期/);
  state = { phase: 'ready', byId: {} };
  assert.equal(f.bridge.navigationReady(), true);
  assert.equal(f.bridge.navigationReady('fixture-session'), false);
  assert.throws(() => f.bridge.openSession('fixture-session'), /一覧同期/);
  state.byId['fixture-session'] = {};
  assert.equal(f.bridge.navigationReady('fixture-session'), true);
  assert.equal(f.bridge.navigationReady({}), false);
  assert.equal(f.bridge.openSession('fixture-session').requestedSessionId, 'fixture-session');
  f.dispose();
});

test('reveal opens exact parent, shows target, browses directories, previews files and cleans up', async () => {
  const f = fixture();
  const result = await f.bridge.openWorkspacePath({ path: '/workspace/hello #?.txt', action: 'reveal' });
  assert.equal(result.view, 'directory');
  assert.equal(result.revealedPath, '/workspace/hello #?.txt');
  assert.equal(f.directories[0], '/workspace');
  assert.ok(f.body.all().some(element => element.textContent === '表示対象: /workspace/hello #?.txt'));
  assert.ok(f.button('フォルダ: <unsafe-name>'), 'untrusted names stay textContent, never HTML');
  await f.button('ファイル: hello #?.txt').click();
  assert.equal(f.opened[0], 'dsh-resource://file/session/fixture-session//workspace/hello%20%23%3F.txt');
  assert.equal(f.body.children.length, 0);
  await f.bridge.openWorkspacePath({ path: '/workspace/folder' });
  assert.equal(f.directories.at(-1), '/workspace/folder');
  await f.button('閉じる').click();
  assert.equal(f.body.children.length, 0);
  await f.bridge.openWorkspacePath({ path: '/workspace/folder' });
  f.dispose();
  assert.equal(f.body.children.length, 0);
});

test('directory failure is reported instead of claiming a successful open', async () => {
  const f = fixture();
  f.ctx.uiWorkspace.listDirectory = async () => { throw new Error('private-value'); };
  await assert.rejects(f.bridge.openWorkspacePath({ path: '/workspace/folder' }), /表示を完了できません/);
  assert.ok(f.body.all().some(element => element.textContent.includes('フォルダを開けません')));
  assert.equal(f.body.all().some(element => element.textContent.includes('private-value')), false);
  f.dispose();
});

test('native-only picker falls back to the workspace directory API for reveal and keeps real denials closed', async () => {
  const f = fixture();
  f.ctx.uiWorkspace.listDirectory = async () => { throw { rpcError: { code: 'directory-picker/unavailable' } }; };
  f.ctx.sessions.list.getSnapshot = () => ({ phase: 'ready', byId: { 'fixture-session': { cwd: '/workspace' } } });
  let calls = 0;
  f.ctx.remote.workspaceFiles.list = async (_id, path) => {
    calls++;
    assert.equal(path, '/workspace');
    return { ok: true, value: { path: '', entries: [
      { type: 'file', name: 'hello #?.txt' }, { type: 'directory', name: 'nested' },
    ], truncated: false } };
  };
  assert.equal((await f.bridge.openWorkspacePath({ path: '/workspace/hello #?.txt', action: 'reveal' })).view, 'directory');
  assert.equal(calls, 1, 'reuse the fallback listing for files instead of rereading');
  assert.ok(f.button('フォルダ: nested'));
  await f.button('ファイル: hello #?.txt').click();
  assert.equal(f.opened.at(-1), 'dsh-resource://file/session/fixture-session//workspace/hello%20%23%3F.txt');
  f.ctx.uiWorkspace.listDirectory = async () => { throw { rpcError: { code: 'directory-picker/unreadable' } }; };
  await assert.rejects(f.bridge.openWorkspacePath({ path: '/workspace/hello #?.txt', action: 'reveal' }));
  assert.equal(calls, 1, 'a filesystem denial is not treated as a missing capability');
  f.ctx.uiWorkspace.listDirectory = async () => { throw { rpcError: { code: 'directory-picker/unavailable' } }; };
  f.ctx.remote.workspaceFiles.list = async () => ({ ok: false, error: { code: 'workspace-file/outside-workspace' } });
  await assert.rejects(f.bridge.openWorkspacePath({ path: '/outside/file.txt', action: 'reveal' }));
  f.dispose();
});

test('preview addresses match the installed public sessionFileAddress grammar', { skip: !process.env.DSH_TEST_NODE_MODULES }, async () => {
  const require = createRequire(join(process.env.DSH_TEST_NODE_MODULES, '..', 'package.json'));
  const { sessionFileAddress } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-util-workspace-path')).href);
  const f = fixture();
  for (const path of ['/workspace/a #?.txt', 'C:\\work\\one.txt', './foo/bar.md', '//server/share/日本語.txt']) {
    await f.bridge.openWorkspacePath({ path });
    assert.equal(f.opened.at(-1), sessionFileAddress('fixture-session', path));
  }
  f.dispose();
});

test('real directory RPC rejects native chooser capability and browse returns the public listing shape',
  { skip: !process.env.DSH_TEST_NODE_MODULES }, async t => {
    const require = createRequire(join(process.env.DSH_TEST_NODE_MODULES, '..', 'package.json'));
    const load = name => import(pathToFileURL(require.resolve(name)).href);
    const [{ Context }, { default: Registry }, { default: Gateway }, { DirectoryPickerController },
      { default: Native }, { default: Browse }] = await Promise.all([
      load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-typert-registry'), load('@deepseek-ai/dsh-api-gateway'),
      load('@deepseek-ai/dsh-api-workspace-controller'), load('@deepseek-ai/dsh-host-directory-picker-native'),
      load('@deepseek-ai/dsh-host-directory-picker-browse'),
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'rdsh-picker-contract-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await mkdir(join(directory, 'child'));
    for (const Picker of [Native, Browse]) {
      const ctx = new Context();
      try {
        new Registry(ctx);
        new Picker(ctx, { maxEntries: 100 });
        new DirectoryPickerController(ctx);
        const gateway = new Gateway(ctx, { websocketHeartbeatIntervalMs: 2000, streamInboxBytes: 262144 });
        const request = { namespace: 'directoryPicker', method: 'list', args: { path: directory } };
        if (Picker === Native) {
          await assert.rejects(gateway.invoke(request), error => error.code === 'directory-picker/unavailable'
            && error.details.capability === 'native');
        } else {
          const listing = await gateway.invoke(request);
          assert.equal(listing.path, directory);
          assert.ok(listing.crumbs.some(crumb => crumb.path === directory));
          assert.ok(listing.entries.some(entry => entry.path === join(directory, 'child')));
        }
      } finally { await ctx.fiber.dispose(); }
    }
  });
