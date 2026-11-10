import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const environment = () => {
  const env = { ...process.env };
  delete env.NODE_PATH;
  return env;
};
const probe = specifier => `const m = await import(${JSON.stringify(specifier)}); if (m.contribution().invocations[0].namespace !== 'rdshTuiAdmin') process.exit(1); console.log('IMPORT_OK');`;

test('local path plugin imports without NODE_PATH or a local node_modules', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe(pathToFileURL(join(source, 'index.js')).href)],
    { cwd: tmpdir(), env: environment(), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /IMPORT_OK/);
});

test('packed dependency-free package installs and imports with the standard npm path offline',
  { skip: process.env.DSH_TEST_PACKAGE_INSTALL !== '1' }, async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'rdsh-tui-admin-package-'));
    try {
      const app = join(temporary, 'app');
      await mkdir(app);
      await writeFile(join(app, 'package.json'), '{"name":"rdsh-admin-fixture","private":true,"type":"module"}');
      const userconfig = join(temporary, 'npmrc');
      await writeFile(userconfig, '');
      const env = { ...environment(), npm_config_cache: join(temporary, 'cache'), npm_config_userconfig: userconfig,
        npm_config_update_notifier: 'false', npm_config_offline: 'true' };
      const packed = spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary],
        { cwd: source, env, encoding: 'utf8' });
      assert.equal(packed.status, 0, packed.stderr);
      const tarball = join(temporary, JSON.parse(packed.stdout)[0].filename);
      const installed = spawnSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
        { cwd: app, env, encoding: 'utf8' });
      assert.equal(installed.status, 0, installed.stderr);
      const imported = spawnSync(process.execPath, ['--input-type=module', '-e', probe('rdsh-tui-admin')],
        { cwd: app, env, encoding: 'utf8' });
      assert.equal(imported.status, 0, imported.stderr);
      assert.match(imported.stdout, /IMPORT_OK/);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
