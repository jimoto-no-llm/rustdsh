import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, cp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('..', import.meta.url));
const runtime = process.env.RDSH_DSH_RUNTIME;
const binary = process.env.RDSH_BIN;

test('real DSH headless and all Web presets receive one backend, with original config preserved', {
  skip: runtime && binary ? false : 'RDSH_DSH_RUNTIME and RDSH_BIN are required', timeout: 120000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'rdsh-compaction-dsh-'));
  const modules = join(resolve(runtime), 'node_modules');
  const dsh = join(modules, '@deepseek-ai/dsh/lib/bin.js');
  const require = createRequire(join(resolve(runtime), 'package.json'));
  const yaml = require('yaml');
  const env = { ...process.env, DSH_HOME: join(root, 'home'), RDSH_ORIG_BIN: dsh,
    RDSH_LANG: 'en', RDSH_AUTH_AUTOSYNC: '0', RDSH_NO_TMP_GUARD: '1', TMP: root, TEMP: root, TMPDIR: root };
  // Every executable/package is local, and every profile belongs to this test.
  try {
    const plugin = join(root, 'plugin');
    await cp(join(repo, 'plugins/rdsh-compaction'), plugin, {
      recursive: true, filter: p => !p.includes('node_modules'),
    });
    await symlink(modules, join(plugin, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    // Import the shipped entry and validate/construct it through the real
    // Cordis service, not only the dependency-free subclass factory.
    const { default: Engine } = await import(pathToFileURL(join(plugin, 'index.js')).href);
    const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
    const ctx = new Context();
    const configured = Engine.Config({ auto: false, instructions: 'Preserve paths.',
      rdshRoutes: [{ provider: 'test', model: 'model', method: 'off' }] });
    const instance = new Engine(ctx, configured);
    assert.equal(instance.rdshInstructions, 'Preserve paths.');
    assert.equal(instance.rdshPolicy.routes[0].method, 'off');
    assert.equal(instance.config.rdshRoutes, undefined);
    await mkdir(env.DSH_HOME, { recursive: true });
    await writeFile(join(env.DSH_HOME, 'rdsh.json'), JSON.stringify({ schema: 1,
      features: { compaction_policy: true, update_check: false, web_gzip_level: false } }));
    await writeFile(join(env.DSH_HOME, 'rdsh-compaction.json'), JSON.stringify({ schema: 1,
      instructions: 'Keep file paths.\nDo not call tools.',
      routes: [{ provider: 'test', model: 'model', method: 'off' }],
      policies: [{ provider: 'test', model: 'model', context_window: 100000, output_reserve: 4096,
        trigger_tokens: 50000, retain_tokens: 8000, max_tokens: 4000 }] }));
    for (const profile of ['headless', 'web']) {
      const dir = join(env.DSH_HOME, 'profiles', profile);
      await mkdir(join(dir, 'node_modules'), { recursive: true });
      await symlink(join(modules, '@deepseek-ai'), join(dir, 'node_modules/@deepseek-ai'), process.platform === 'win32' ? 'junction' : 'dir');
      await symlink(plugin, join(dir, 'node_modules/rdsh-compaction'), process.platform === 'win32' ? 'junction' : 'dir');
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `test-${profile}`, private: true, type: 'module',
        dependencies: { 'rdsh-compaction': `file:${plugin.replaceAll('\\', '/')}` },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', profile === 'web' ? '@deepseek-ai/dsh-web-app' : '@deepseek-ai/dsh-headless', 'rdsh-compaction'] } } }));
      await writeFile(join(dir, 'cordis.patch.yml'), '[]\n');
      const original = await exec(process.execPath, [dsh, '--profile', profile, '--dump-config'], { env, maxBuffer: 4e6 });
      const before = await readFile(join(dir, 'cordis.patch.yml'));
      const boot = await exec(binary, ['--no-slim', '--profile', profile, '--', '--help'], { env, timeout: 45000, maxBuffer: 4e6 });
      assert.match(boot.stderr, new RegExp(`policy overlay applied \\(${profile === 'web' ? 4 : 1} rows\\)`));
      assert.deepEqual(await readFile(join(dir, 'cordis.patch.yml')), before);
      const overlays = await readdir(join(env.DSH_HOME, 'compaction'));
      const patch = (await Promise.all(overlays.filter(p => p.endsWith('.yml')).map(async p => ({
        path: join(env.DSH_HOME, 'compaction', p), text: await readFile(join(env.DSH_HOME, 'compaction', p), 'utf8'),
      })))).find(p => profile === 'web' ? p.text.includes('preset-standard') : p.text.startsWith('- id: compaction-basic'));
      assert.ok(patch);
      const applied = await exec(process.execPath, [dsh, '--profile', profile, '--patch', patch.path, '--dump-config'], { env, maxBuffer: 4e6 });
      // DSH's !js tags are irrelevant to this structural comparison; preserve
      // their scalar values, comparing every unrelated row/key recursively.
      const parse = text => yaml.parseDocument(text, { logLevel: 'silent' }).toJS();
      const expected = parse(original.stdout);
      let changed = 0;
      let replacement;
      function update(value) {
        if (!value || typeof value !== 'object') return;
        if (value.id === 'compaction-basic' && value.disabled !== true) {
          if (profile === 'headless') {
            replacement = { ...value, id: 'rdsh-compaction' };
            value.disabled = true;
            value = replacement;
          }
          value.name = 'rdsh-compaction';
          value.config = { ...value.config, modelPolicies: [{ provider: 'test', model: 'model', thresholdRatio: 1,
            headroomTokens: 45904, retainTokens: 8000, maxTokens: 4000 }],
          instructions: 'Keep file paths.\nDo not call tools.', rdshRoutes: [{ provider: 'test', model: 'model', method: 'off' }] };
          changed++;
        } else for (const child of Object.values(value)) update(child);
      }
      update(expected);
      if (replacement) expected.push(replacement);
      assert.equal(changed, profile === 'web' ? 4 : 1);
      assert.deepEqual(parse(applied.stdout), expected);
      if (profile === 'headless') {
        const userPatch = join(root, 'user.patch.yml');
        await writeFile(userPatch, '- id: rdsh-compaction\n  config:\n    auto: false\n');
        const overridden = await exec(process.execPath, [dsh, '--profile', profile,
          '--patch', patch.path, '--patch', userPatch, '--dump-config'], { env, maxBuffer: 4e6 });
        assert.deepEqual(parse(overridden.stdout).find(row => row.id === 'rdsh-compaction').config,
          { auto: false });
      }
    }
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'rdsh-compaction-dsh-')));
    await rm(root, { recursive: true, force: true });
  }
});
