import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink, stat, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSettingsDocuments, MAX_DOCUMENT_BYTES } from '../settings-document.js';
import { apply } from '../index.js';

const modules = process.env.DSH_TEST_NODE_MODULES;
const setup = async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rdsh-document-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'cordis.patch.yml');
  await writeFile(path, '[]\n');
  const profile = { dir: directory, patchPath: path, installAnchor: join(modules, '..', 'package.json'),
    name: 'fixture', home: join(directory, 'home'), cwd: directory, startedBundles: [], overlays: [] };
  await mkdir(profile.home);
  await writeFile(join(directory, 'package.json'), '{"name":"rdsh-document-fixture","private":true,"dsh":{"profile":{"bundles":[]}}}');
  const require = createRequire(profile.installAnchor);
  const load = name => import(pathToFileURL(require.resolve(name)).href);
  return { directory, path, profile, load };
};

test('real Host Gateway and settings provider edit, apply and reread an isolated profile; reject nonoperator and conflicts',
  { skip: !modules }, async t => {
    const { directory, path, profile, load } = await setup(t);
    const [boot, { default: Registry }, { default: Gateway }, connection, { default: Editor }, { default: Settings }] = await Promise.all([
      load('@deepseek-ai/dsh-app-boot'), load('@deepseek-ai/dsh-typert-registry'), load('@deepseek-ai/dsh-api-gateway'),
      load('@deepseek-ai/dsh-client-connection'), load('@deepseek-ai/dsh-config-editor'), load('@deepseek-ai/dsh-settings'),
    ]);
    const base = join(directory, 'base.yml');
    const pluginPath = join(directory, 'fixture.mjs');
    await writeFile(base, '[]\n');
    await writeFile(pluginPath, 'export function apply(ctx, config) { ctx.provide("fixtureDocumentValue", config.value); }');
    const content = value => `- insert:\n  - id: fixture\n    name: ${JSON.stringify(pathToFileURL(pluginPath).href)}\n    config:\n      value: ${value}\n`;
    const ctx = await boot.boot('dsh', base, [], ctx => ctx.provide('profileContext', profile));
    t.after(() => ctx.fiber.dispose());
    new Registry(ctx);
    new Editor(ctx);
    new Settings(ctx);
    let credential;
    ctx.provide('credentials', { async modifyRecord(_key, change) { credential = await change(credential) ?? credential; return credential; } });
    await connection.apply(ctx);
    const gateway = new Gateway(ctx, { websocketHeartbeatIntervalMs: 2000, streamInboxBytes: 262144 });
    await apply(ctx);
    const authority = '127.0.0.1:39119';
    assert.equal(ctx.connection.admit({ headers: { host: authority } }).rejection, 401);
    const url = new URL(ctx.connection.authenticatedUrl(`http://${authority}/`));
    let cookie;
    ctx.connection.authorizeIndex({ method: 'GET', url: url.pathname + url.search, headers: { host: authority } },
      { writeHead(code, headers) { assert.equal(code, 303); cookie = headers['set-cookie'].split(';')[0]; }, end() {} });
    const admission = ctx.connection.admit({ headers: { host: authority, cookie } });
    assert.ok(admission.peer);
    assert.equal(ctx.connection.admit({ headers: { host: authority, cookie, origin: 'https://invalid.example' } }).rejection, 403);
    const invoke = (method, args = {}, peer = admission.peer) => gateway.invoke({ namespace: 'rdshTuiAdmin', method, args, peer });
    const before = await invoke('readSettingsDocument');
    assert.equal(before.path, path);
    assert.equal(before.content, '[]\n');
    assert.equal(before.writable, true);
    for (const method of ['readSettingsDocument', 'saveSettingsDocument'])
      await assert.rejects(invoke(method, method.startsWith('save') ? { content: content(8), expectedRevision: before.revision } : {}, { id: 'member', ctx }),
        error => error.code === 'gateway/forbidden');
    assert.equal(await readFile(path, 'utf8'), before.content);
    const saved = await invoke('saveSettingsDocument', { content: content(7), expectedRevision: before.revision });
    assert.equal(saved.applied, true);
    assert.equal(ctx.get('fixtureDocumentValue'), 7, 'normal Loader reconciliation applies the saved patch');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(saved.backupPath)).mode & 0o777, 0o600);
    assert.equal(await readFile(saved.backupPath, 'utf8'), before.content);
    const after = await invoke('readSettingsDocument');
    assert.equal(after.revision, saved.revision);
    assert.equal(after.content, content(7));
    await assert.rejects(invoke('saveSettingsDocument', { content: content(9), expectedRevision: before.revision }),
      error => error.code === 'settings/document-conflict');
    assert.equal((await invoke('readSettingsDocument')).content, content(7));
    for (const invalid of ['[invalid: yaml', '{}', '[null]', '[1]'])
      await assert.rejects(invoke('saveSettingsDocument', { content: invalid, expectedRevision: saved.revision }),
        error => error.code === 'settings/document-invalid');
    assert.equal(await readFile(path, 'utf8'), content(7));
    await assert.rejects(invoke('readSettingsDocument', { path: '/etc/passwd' }), error => error.code === 'gateway/arguments-invalid');
    const catalog = await invoke('catalog');
    for (const id of ['rdshTuiAdmin/readSettingsDocument', 'rdshTuiAdmin/saveSettingsDocument'])
      assert.equal(catalog.actions.find(action => action.id === id).sensitive, true);
  });

test('bounded file adapter rejects symlinks, directories, invalid UTF8, oversize and absent/read-only providers',
  { skip: !modules }, async t => {
    const { directory, path, profile, load } = await setup(t);
    const { RemoteError } = await load('@deepseek-ai/dsh-typert-protocol');
    const providers = { profileContext: profile, configEditor: { documentPath: path },
      settings: { writable: true, async prepareDocument() { return path; } } };
    const ctx = { get: key => providers[key] };
    const docs = createSettingsDocuments(ctx, RemoteError);
    const before = await docs.read();
    providers.settings.writable = false;
    await assert.rejects(docs.save('[]\n', before.revision), error => error.code === 'settings/document-readonly');
    providers.settings.writable = true;
    await rm(path);
    const other = join(directory, 'protected.yml');
    await writeFile(other, 'keep-secret-fixture');
    await symlink(other, path);
    await assert.rejects(docs.read(), error => error.code === 'settings/document-unsafe');
    await assert.rejects(docs.save('[]\n', before.revision), error => error.code === 'settings/document-unsafe');
    assert.equal(await readFile(other, 'utf8'), 'keep-secret-fixture');
    await rm(path);
    await mkdir(path);
    await assert.rejects(docs.read(), error => error.code === 'settings/document-unsafe');
    await rm(path, { recursive: true });
    await writeFile(path, Buffer.from([0xff]));
    await assert.rejects(docs.read(), error => error.code === 'settings/document-invalid');
    await writeFile(path, 'x'.repeat(MAX_DOCUMENT_BYTES + 1));
    await assert.rejects(docs.read(), error => error.code === 'settings/document-too-large');
    delete providers.settings;
    await assert.rejects(docs.read(), error => error.code === 'settings/document-unavailable');
  });

test('save sanitizes write failures and restores file plus runtime when activation fails', { skip: !modules }, async t => {
  const { directory, path, profile, load } = await setup(t);
  const [atomic, { RemoteError }] = await Promise.all([load('@deepseek-ai/dsh-atomic-write'), load('@deepseek-ai/dsh-typert-protocol')]);
  let mode = 'write-fails', reconciles = 0;
  const providers = { profileContext: profile, configEditor: { documentPath: path },
    settings: { writable: true, async prepareDocument() { return path; } } };
  const ctx = { get: key => providers[key], root: {} };
  const docs = createSettingsDocuments(ctx, RemoteError, async (_ctx, name) => {
    if (name === '@deepseek-ai/dsh-atomic-write') return { ...atomic, async writeFileAtomic(target, content, options) {
      if (target === path && mode === 'write-fails') throw new Error('sensitive-config-value');
      return atomic.writeFileAtomic(target, content, options);
    } };
    if (name === '@deepseek-ai/dsh-app-boot') return {
      loadProfileDirectory() { return { layers: [], patches: [] }; }, readProfilePatches(_bin, _profile, initial) { return initial?.patches ?? []; },
      composeEntries() {}, async reconcileProfilePatches() { if (++reconciles === 1) throw new Error('sensitive-config-value'); },
    };
    return load(name);
  });
  const before = await docs.read();
  await assert.rejects(docs.save('# changed\n[]\n', before.revision), error => {
    assert.equal(error.code, 'settings/document-io');
    assert.doesNotMatch(JSON.stringify(error), /sensitive-config-value/);
    return true;
  });
  assert.equal(await readFile(path, 'utf8'), before.content);
  mode = 'apply-fails';
  await assert.rejects(docs.save('# changed\n[]\n', before.revision), error => error.code === 'settings/document-apply-failed');
  assert.equal(await readFile(path, 'utf8'), before.content);
  assert.equal(reconciles, 2);
  assert.ok((await readdir(directory)).some(name => name.startsWith('cordis.patch.yml.rdsh-backup-')));
});
