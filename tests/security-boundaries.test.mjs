import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, linkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const bin = path.resolve(process.env.BIN || 'target/debug/rdsh');
function isolated(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rdsh-security-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  mkdirSync(home);
  return { dir, env: { PATH: process.env.PATH, HOME: home, DSH_HOME: path.join(dir, 'dsh') } };
}
test('deny hook never supplies an affirmative approval on a miss', t => {
  const { env } = isolated(t);
  const result = spawnSync(bin, ['guard', '--json', '--deny', '*blocked*'], { env, input: '{"tool_input":{"command":"echo safe"}}', encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {});
});
test('anchored deny cannot be bypassed by hook metadata', t => {
  const { env } = isolated(t);
  const result = spawnSync(bin, ['guard', '--deny', 'rm -rf /*'], { env, input: '{"cwd":"/tmp/repo","tool_input":{"command":"rm -rf / DUMMY"}}', encoding: 'utf8' });
  assert.equal(result.status, 2);
});
test('malformed or oversized hook input fails closed', t => {
  const { env } = isolated(t);
  for (const input of ['{"tool_input":', 'x'.repeat(1024 * 1024 + 1)]) {
    const result = spawnSync(bin, ['guard', '--deny', '*blocked*'], { env, input, encoding: 'utf8' });
    assert.equal(result.status, 2);
  }
});
test('unsupported runtime is refused without copying external login credentials', t => {
  const { dir, env } = isolated(t);
  mkdirSync(path.join(env.HOME, '.codex'));
  writeFileSync(path.join(env.HOME, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: 'DUMMY_ACCESS', refresh_token: 'DUMMY_REFRESH' } }));
  const pkg = path.join(dir, 'pkg');
  mkdirSync(path.join(pkg, 'lib'), { recursive: true });
  mkdirSync(path.join(pkg, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib'), { recursive: true });
  writeFileSync(path.join(pkg, 'lib', 'bin.js'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o700 });
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' }));
  writeFileSync(path.join(pkg, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'), '');
  env.RDSH_ORIG_BIN = path.join(pkg, 'lib', 'bin.js');
  const boot = spawnSync(bin, ['--profile', 'tui'], { env, encoding: 'utf8' });
  assert.notEqual(boot.status, 0);
  assert.match(boot.stderr, /RDSH_SECURITY/);
  assert.equal(existsSync(path.join(env.DSH_HOME, '.credentials.yaml')), false);
  const autoStatus = spawnSync(bin, ['setup', '--json'], { env: { ...env, RDSH_AUTH_AUTOSYNC: '1' }, encoding: 'utf8' });
  assert.equal(autoStatus.status, 0);
  assert.equal(JSON.parse(autoStatus.stdout).needed, true);
  assert.equal(existsSync(path.join(env.DSH_HOME, '.credentials.yaml')), false);
  const status = spawnSync(bin, ['setup', '--json'], { env, encoding: 'utf8' });
  assert.equal(status.status, 0);
  assert.equal(JSON.parse(status.stdout).needed, true);
  assert.equal(existsSync(path.join(env.DSH_HOME, '.credentials.yaml')), false);
  assert.equal(spawnSync(bin, ['auth', '--import', '--provider', 'openai-codex'], { env }).status, 0);
  assert.match(readFileSync(path.join(env.DSH_HOME, '.credentials.yaml'), 'utf8'), /DUMMY_ACCESS/);
  assert.equal(JSON.parse(spawnSync(bin, ['setup', '--json'], { env, encoding: 'utf8' }).stdout).needed, false);
});
test('context working files cannot read credentials outside the current repository', t => {
  const { dir, env } = isolated(t);
  const repo = path.join(dir, 'repo');
  mkdirSync(repo);
  mkdirSync(env.DSH_HOME);
  const secret = path.join(dir, 'credentials.json');
  writeFileSync(secret, 'DUMMY_PRIVATE_VALUE');
  writeFileSync(path.join(env.DSH_HOME, 'rdsh.json'), JSON.stringify({ beta: { context_engine: true }, context: { working_files: [secret], enable_retriever: false, include_git_diff: false } }));
  const result = spawnSync(bin, ['context', 'build'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /DUMMY_PRIVATE_VALUE/);
});

test('native search does not read hard links or symlinks to outside files', t => {
  const { dir, env } = isolated(t);
  const repo = path.join(dir, 'repo');
  mkdirSync(repo);
  const secret = path.join(dir, 'outside-search-secret');
  writeFileSync(secret, 'DUMMY_SEARCH_ESCAPE');
  symlinkSync(secret, path.join(repo, 'symlink.txt'));
  linkSync(secret, path.join(repo, 'hardlink.txt'));
  writeFileSync(path.join(repo, 'ordinary.txt'), 'DUMMY_SEARCH_EXPECTED');
  const result = spawnSync(bin, ['search', 'DUMMY_SEARCH', '--dir', repo], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DUMMY_SEARCH_EXPECTED/);
  assert.doesNotMatch(result.stdout, /DUMMY_SEARCH_ESCAPE/);
  const relative = spawnSync(bin, ['search', 'DUMMY_SEARCH', '--dir', '.'], { env, cwd: repo, encoding: 'utf8' });
  assert.equal(relative.status, 0, relative.stderr);
  assert.match(relative.stdout, /^\.\/ordinary\.txt:1: DUMMY_SEARCH_EXPECTED/m);
  assert.doesNotMatch(relative.stdout, /DUMMY_SEARCH_ESCAPE/);
});

test('context working files reject in-tree symlinks and hard links to outside files', t => {
  const { dir, env } = isolated(t);
  const repo = path.join(dir, 'repo');
  mkdirSync(repo);
  mkdirSync(env.DSH_HOME);
  const secret = path.join(dir, 'outside-context-secret');
  writeFileSync(secret, 'DUMMY_CONTEXT_ESCAPE');
  for (const [name, install] of [
    ['linked-file.txt', () => symlinkSync(secret, path.join(repo, 'linked-file.txt'))],
    ['hardlinked-file.txt', () => linkSync(secret, path.join(repo, 'hardlinked-file.txt'))],
  ]) {
    install();
    writeFileSync(path.join(env.DSH_HOME, 'rdsh.json'), JSON.stringify({ beta: { context_engine: true }, context: { working_files: [name], enable_retriever: false, include_git_diff: false } }));
    const result = spawnSync(bin, ['context', 'build'], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /DUMMY_CONTEXT_ESCAPE/);
    unlinkSync(path.join(repo, name));
  }
});
test('context rejects a FIFO without blocking while opening it', t => {
  const { dir, env } = isolated(t);
  const repo = path.join(dir, 'repo');
  mkdirSync(repo);
  const fifo = path.join(repo, 'blocked-pipe');
  assert.equal(spawnSync('mkfifo', [fifo], { env }).status, 0);
  mkdirSync(env.DSH_HOME);
  writeFileSync(path.join(env.DSH_HOME, 'rdsh.json'), JSON.stringify({ beta: { context_engine: true }, context: { working_files: [fifo], enable_retriever: false, include_git_diff: false } }));
  const result = spawnSync(bin, ['context', 'build'], { env, cwd: repo, timeout: 3000, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test('context does not retrieve other projects sessions by default', t => {
  const { dir, env } = isolated(t);
  const repo = path.join(dir, 'repo');
  mkdirSync(repo);
  const sessions = path.join(env.DSH_HOME, 'sessions', 'other-project', 'other-session');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(path.join(sessions, 'messages.json'), 'PRIVATE_SESSION_MARKER DUMMY_OTHER_PROJECT_SECRET');
  writeFileSync(path.join(env.DSH_HOME, 'rdsh.json'), JSON.stringify({ beta: { context_engine: true }, context: { include_git_diff: false } }));
  const result = spawnSync(bin, ['context', 'build', '--query', 'PRIVATE_SESSION_MARKER'], { env, cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /DUMMY_OTHER_PROJECT_SECRET/);
  writeFileSync(path.join(env.DSH_HOME, 'rdsh.json'), JSON.stringify({ beta: { context_engine: true }, context: { include_git_diff: false, max_sessions: 1 } }));
  const optedIn = spawnSync(bin, ['context', 'build', '--query', 'PRIVATE_SESSION_MARKER'], { env, cwd: repo, encoding: 'utf8' });
  assert.equal(optedIn.status, 0, optedIn.stderr);
  assert.doesNotMatch(optedIn.stdout, /DUMMY_OTHER_PROJECT_SECRET/);
});
test('automatic updater refuses bad or missing checksums before installing', t => {
  const { dir, env } = isolated(t);
  const pkg = path.join(dir, 'pkg');
  const download = path.join(dir, 'releases', 'latest', 'download');
  mkdirSync(pkg);
  mkdirSync(download, { recursive: true });
  writeFileSync(path.join(pkg, 'rdsh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const asset = path.join(download, 'rdsh-linux-x64.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', asset, '-C', pkg, 'rdsh'], { env }).status, 0);
  env.RDSH_RELEASE_BASE = 'file://' + path.join(dir, 'releases');
  const dest = path.join(dir, 'installed');
  env.TEST_DEST = dest;
  const source = readFileSync('sync-dsh.sh', 'utf8').replaceAll('\r\n', '\n').split('\nNPM=""')[0];
  const run = () => spawnSync('/bin/sh', ['-c', source + '\nfetch_rdsh_release "$TEST_DEST"'], { env, encoding: 'utf8' });
  assert.notEqual(run().status, 0);
  assert.equal(existsSync(dest), false);
  writeFileSync(asset + '.sha256', '0'.repeat(64) + '\n');
  assert.notEqual(run().status, 0);
  assert.equal(existsSync(dest), false);
  writeFileSync(asset + '.sha256', createHash('sha256').update(readFileSync(asset)).digest('hex') + '\n');
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr + valid.stdout);
  assert.equal(readFileSync(dest, 'utf8'), '#!/bin/sh\nexit 0\n');
});

test('imports require an explicit provider or ref and copy only the selected source', t => {
  const { env } = isolated(t);
  mkdirSync(path.join(env.HOME, '.codex'));
  writeFileSync(path.join(env.HOME, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'DUMMY_UNSELECTED_API', tokens: { access_token: 'DUMMY_SELECTED_OAUTH', refresh_token: 'DUMMY_REFRESH' } }));
  const refused = spawnSync(bin, ['auth', '--import'], { env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /requires --provider/);
  assert.equal(existsSync(path.join(env.DSH_HOME, '.credentials.yaml')), false);
  assert.equal(spawnSync(bin, ['setup', '--yes', '--json'], { env }).status, 0);
  assert.equal(existsSync(path.join(env.DSH_HOME, '.credentials.yaml')), false);
  const imported = spawnSync(bin, ['auth', '--import', '--source', 'codex', '--provider', 'openai-codex'], { env, encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  const credentials = readFileSync(path.join(env.DSH_HOME, '.credentials.yaml'), 'utf8');
  assert.match(credentials, /DUMMY_SELECTED_OAUTH/);
  assert.doesNotMatch(credentials, /DUMMY_UNSELECTED_API/);
});
