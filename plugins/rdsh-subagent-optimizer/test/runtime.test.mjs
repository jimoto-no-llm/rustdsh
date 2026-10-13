import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, copyFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const runtime = process.env.RDSH_PUBLIC_DSH_MODULES;
test('pinned DSH public helpers, native tool and SlotCore accept the plugins without live sessions', { skip: !runtime }, async t => {
  const modules = resolve(runtime);
  const pkg = JSON.parse(await readFile(join(modules, '@deepseek-ai/dsh-subagent/package.json'), 'utf8'));
  assert.equal(pkg.version, '0.2.0-rc.2');
  const temporary = await mkdtemp(join(tmpdir(), 'rdsh-native-contract-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  for (const file of ['index.js', 'optimizer.js', 'package.json']) await copyFile(new URL('../' + file, import.meta.url), join(temporary, file));
  await symlink(modules, join(temporary, 'node_modules'), 'dir');
  const { apply } = await import(pathToFileURL(join(temporary, 'index.js')));
  await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-tool-subagent/lib/index.js')));
  const { SlotCore } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-client-ui-slots/lib/index.js')));
  let registered, removed = false, calls = 0;
  const backend = { inheritsParentContext: false, capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    async start(request) { calls++; assert.equal(request.agentOptions.maxTokens, 4096);
      return { id: 'fixture-child', localAgent: undefined, result: Promise.resolve({ output: [], stopReason: 'completed' }), async dispose() {} }; } };
  const dispose = apply({ effect: fn => fn(), subagents: { getProvider: () => backend, registerProvider(p) { registered = p; return () => removed = true; } } }, { maxConcurrent: 1 });
  t.after(dispose);
  let model = 'fixture-current';
  const parent = { options: { model: 'fixture-created', maxTokens: 8000 }, session: { header: { cwd: '/fixture' },
    requestHeader: () => ({ config: { provider: 'fixture-provider', model } }) }, ctx: { get: () => undefined } };
  const request = text => ({ parent, signal: new AbortController().signal, prompt: [{ type: 'text', text }] });
  const first = await registered.start(request('first'));
  const queued = registered.start(request('queued'));
  model = 'fixture-changed'; await first.dispose();
  await assert.rejects(queued, error => error.code === 'RDSH_SUBAGENT_CONTEXT_CHANGED');
  assert.equal(calls, 1); await dispose(); assert.equal(removed, true);
  const core = new SlotCore();
  core.register({ name: 'root', children: { 'conversation.hero.agentPreset': { kind: 'single', scope: 'session-maybe' } } }, () => null);
  core.register({ name: 'conversation.hero.agentPreset' }, () => 'stock');
  let ui, remove;
  vm.runInNewContext(await readFile(new URL('../../rdsh-easy-work/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(definition) { ui = definition.factory(() => ({})); } } },
  });
  ui.apply({ uiWorkspace: { pickDirectory: async () => '/fixture' }, slots: {
    inject: (name, callback) => callback(), register: (options, component) => { remove = core.register(options, component); return remove; },
  } });
  assert.equal(core.entriesOfSlot('conversation.hero.agentPreset')[0].options.priority, -20);
  remove(); assert.equal(core.entriesOfSlot('conversation.hero.agentPreset').length, 1);
});
