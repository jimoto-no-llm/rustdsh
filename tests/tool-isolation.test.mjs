import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeIsolated, installToolBoundary } from '../security/tool-isolation.mjs';

test('kernel isolation blocks credentials, network, writes and inherited environment', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdsh-tool-boundary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  const secret = path.join(root, 'credentials.json');
  await fs.writeFile(secret, 'DUMMY_OUTSIDE_SECRET');
  await fs.writeFile(path.join(workspace, 'README.md'), 'DUMMY_DOCUMENT');
  await fs.writeFile(path.join(workspace, '.env'), 'DUMMY_WORKSPACE_SECRET');
  await fs.link(path.join(workspace, '.env'), path.join(workspace, 'public-copy.txt'));
  await fs.writeFile(path.join(workspace, 'api-token.txt'), 'DUMMY_WORKSPACE_SECRET');
  await fs.symlink(secret, path.join(workspace, 'linked-secret'));
  const previous = process.env.RDSH_TEST_PRIVATE_KEY;
  process.env.RDSH_TEST_PRIVATE_KEY = 'DUMMY_ENV_SECRET';
  t.after(() => { if (previous === undefined) delete process.env.RDSH_TEST_PRIVATE_KEY; else process.env.RDSH_TEST_PRIVATE_KEY = previous; });
  const run = command => executeIsolated({ workspace, command, sharedFiles: ["README.md"] });
  assert.match((await run('cat README.md')).stdout, /DUMMY_DOCUMENT/);
  for (const command of [`cat '${secret}'`, 'cat linked-secret', 'cat .env', 'cat public-copy.txt api-token.txt', 'env']) {
    const result = await run(command);
    assert.doesNotMatch(result.stdout, /DUMMY_(OUTSIDE|WORKSPACE|ENV)_SECRET/);
  }
  assert.notEqual((await run('printf CHANGED > README.md')).exitCode, 0);
  assert.equal(await fs.readFile(path.join(workspace, 'README.md'), 'utf8'), 'DUMMY_DOCUMENT');
  const namespace = await run('unshare -Ur true');
  assert.notEqual(namespace.exitCode, 0);
  assert.match(namespace.stderr, /Operation not permitted/);
  const memory = await run('python3 -c \"bytearray(512 * 1024 * 1024)\"');
  assert.notEqual(memory.exitCode, 0);
  assert.match(memory.stderr, /MemoryError/);
  const network = await run('python3 -c "import socket; socket.socket()"');
  assert.notEqual(network.exitCode, 0);
  assert.match(network.stderr, /Operation not permitted/);
});

test('unavailable enforcement fails closed and never runs the requested command', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rdsh-missing-runner-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await assert.rejects(executeIsolated({ workspace, command: 'printf UNSANDBOXED' }, { bwrap: '/nonexistent-rdsh-bwrap' }), /sandbox|ENOENT/);
});

test('global monotonic guard denies every other tool and a scoped name replacement', () => {
  let guard, definition;
  const tools = {
    guard(fn) { guard = fn; return () => {}; },
    register(value) { definition = value; return () => {}; },
    get() { return definition; },
  };
  installToolBoundary(tools, { workspace: '/dummy' });
  for (const name of ['bash', 'read', 'write', 'edit', 'run_code', 'mcp/upload', 'plugin/install']) {
    assert.equal(typeof guard({ name }), 'string');
  }
  assert.equal(guard({ name: 'rdsh_inspect' }), undefined);
  tools.get = () => ({ ...definition, execute() {} });
  assert.equal(typeof guard({ name: 'rdsh_inspect' }), 'string');
});

test('explicit sharing rejects hard links and hidden credentials', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rdsh-share-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, '.env'), 'DUMMY');
  await fs.link(path.join(workspace, '.env'), path.join(workspace, 'public.txt'));
  for (const file of ['.env', 'public.txt']) await assert.rejects(executeIsolated({ workspace, sharedFiles: [file], command: 'cat *' }), /approved file/);
});
