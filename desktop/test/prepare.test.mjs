import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, symlinkSync, linkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { prepare } from '../prepare.mjs';
import { contentHash, PATCH_PATHS } from '../overlay.mjs';
import { source } from './fixtures/upstream-source.mjs';

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'rdsh-prepare-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const checkout = join(base, 'checkout'); mkdirSync(checkout);
  const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: join(base, 'empty-gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'rdsh test fixture', GIT_COMMITTER_NAME: 'rdsh test fixture',
      GIT_AUTHOR_EMAIL: 'fixture@users.noreply.github.com', GIT_COMMITTER_EMAIL: 'fixture@users.noreply.github.com' } }).trimEnd();
  writeFileSync(join(base, 'empty-gitconfig'), '');
  git('init'); git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'rdsh test fixture');
  git('config', 'user.email', 'fixture@users.noreply.github.com');
  const put = (path, value) => { mkdirSync(dirname(join(checkout, path)), { recursive: true }); writeFileSync(join(checkout, path), value); };
  for (const [path, contents] of Object.entries(source)) put(path, contents);
  for (const path of ['package.json', 'apps/desktop/package.json', 'packages/sdk/client/package.json']) put(path, '{"version":"0.2.1-alpha.2"}\n');
  put('.gitignore', 'apps/desktop/rdsh-*\n');
  git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-m', 'synthetic upstream fixture');
  const repository = 'https://github.com/deepseek-ai/deepseek-harness.git';
  git('remote', 'add', 'origin', repository);
  const lock = { schemaVersion: 1, repository, revision: git('rev-parse', 'HEAD'), harnessVersion: '0.2.1-alpha.2', sdkVersion: '0.2.1-alpha.2',
    patchInputs: Object.fromEntries(Object.entries(source).map(([path, value]) => [path, contentHash(value.replace(/\r\n/g, '\n'))])) };
  const lockPath = join(base, 'lock.json'); writeFileSync(lockPath, JSON.stringify(lock));
  const rdshBin = join(base, 'rdsh'); writeFileSync(rdshBin, Buffer.from('7f454c4600000000', 'hex'));
  return { base, checkout, rdshBin, lockPath, git, put, run: () => prepare({ checkout, rdshBin, lockPath }) };
}

test('real Git preparation is idempotent and preserves unrelated tracked and untracked edits', t => {
  const f = fixture(t); assert.equal(f.run().unchanged, false); assert.equal(f.run().unchanged, true);
  if (process.platform !== 'win32') {
    // A parent alias exercises Git/OS canonicalization without relaxing the
    // separate prohibition on the checkout root itself being a symlink.
    const alias = join(f.base, 'parent-alias'); symlinkSync(f.base, alias);
    assert.equal(prepare({ checkout: join(alias, 'checkout'), rdshBin: f.rdshBin, lockPath: f.lockPath }).unchanged, true);
  }
  const bootstrap = join(f.checkout, 'apps/desktop/rdsh-bootstrap.cjs');
  const expected = readFileSync(bootstrap);
  f.put('package.json', '{"version":"local edit"}');
  assert.throws(f.run, /unrelated local changes/);
  assert.deepEqual(readFileSync(bootstrap), expected);
  f.git('restore', 'package.json'); f.put('unrelated.txt', 'preserve me');
  assert.throws(f.run, /unrelated local changes/);
  assert.equal(readFileSync(join(f.checkout, 'unrelated.txt'), 'utf8'), 'preserve me');
});

test('first preparation refuses tracked edits and ignored generated destinations before writing', t => {
  const f = fixture(t); f.put(PATCH_PATHS[1], 'local edit');
  assert.throws(f.run, /clean official checkout/);
  assert.equal(readFileSync(join(f.checkout, PATCH_PATHS[0]), 'utf8'), source[PATCH_PATHS[0]]);
  f.git('restore', PATCH_PATHS[1]); f.put('apps/desktop/rdsh-bootstrap.cjs', 'ignored local file');
  assert.equal(f.git('status', '--porcelain'), '');
  assert.throws(f.run, /destination already exists/);
  assert.equal(readFileSync(join(f.checkout, 'apps/desktop/rdsh-bootstrap.cjs'), 'utf8'), 'ignored local file');
  assert.equal(readFileSync(join(f.checkout, PATCH_PATHS[0]), 'utf8'), source[PATCH_PATHS[0]]);
});

test('changed native binary, output hashes and marker inventories require a fresh checkout', t => {
  const f = fixture(t); f.run();
  const marker = join(f.checkout, '.rdsh-fork.json'), original = readFileSync(marker);
  writeFileSync(f.rdshBin, Buffer.from('7f454c4600000001', 'hex'));
  assert.throws(f.run, /fresh checkout/);
  writeFileSync(f.rdshBin, Buffer.from('7f454c4600000000', 'hex'));
  const state = JSON.parse(original); state.outputs['../../outside'] = '0'.repeat(64);
  writeFileSync(marker, JSON.stringify(state)); assert.throws(f.run, /inventory/);
  writeFileSync(marker, original);
  f.put('apps/desktop/rdsh-bootstrap.cjs', 'later edit');
  assert.throws(f.run, /local changes/);
  assert.equal(readFileSync(join(f.checkout, 'apps/desktop/rdsh-bootstrap.cjs'), 'utf8'), 'later edit');
  writeFileSync(marker, 'x'.repeat(65537)); assert.throws(f.run, /marker/);
});

test('dangling generated and marker symlinks cannot create files outside the checkout', { skip: process.platform === 'win32' }, t => {
  for (const path of ['apps/desktop/rdsh-bootstrap.cjs', '.rdsh-fork.json', 'apps/desktop/rdsh-build-assets']) {
    const f = fixture(t), output = join(f.checkout, path), outside = join(f.base, 'outside');
    symlinkSync(outside, output);
    assert.throws(f.run, /symlink|marker|local files/);
    assert.throws(() => lstatSync(outside), { code: 'ENOENT' });
    assert.equal(lstatSync(output).isSymbolicLink(), true);
    assert.equal(readFileSync(join(f.checkout, PATCH_PATHS[0]), 'utf8'), source[PATCH_PATHS[0]]);
  }
});

test('a hard-linked source cannot modify its alias outside the checkout', t => {
  const f = fixture(t), path = PATCH_PATHS[0], outside = join(f.base, 'source-alias.mjs');
  linkSync(join(f.checkout, path), outside);
  assert.equal(f.git('status', '--porcelain'), '');
  assert.throws(f.run, /source file|hard link/);
  assert.equal(readFileSync(outside, 'utf8'), source[path]);
  assert.equal(readFileSync(join(f.checkout, PATCH_PATHS[1]), 'utf8'), source[PATCH_PATHS[1]]);
});
