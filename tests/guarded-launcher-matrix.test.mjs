// Official profile launches exercise the Rust-selected embedded preload and kernel together.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const matrix = [
  ['RC2', '0.2.0-rc.2'],
  ['ALPHA1', '0.2.1-alpha.1'],
  ['ALPHA3', '0.2.1-alpha.3'],
];
const supportedHost = process.platform === 'linux' && process.arch === 'x64';
if (process.env.RDSH_GUARDED_MATRIX_REQUIRED === '1') {
  assert.ok(supportedHost, 'required matrix needs the supported Linux x86_64 host');
  for (const [label] of matrix) {
    assert.ok(process.env[`RDSH_AUDITED_DSH_${label}`], `${label} official DSH entry is required`);
    assert.ok(process.env[`RDSH_AUDITED_RUNTIME_${label}`], `${label} official runtime is required`);
  }
}
const bin = path.resolve(process.env.BIN || 'target/debug/rdsh');

for (const [label, version] of matrix) {
  const dsh = process.env[`RDSH_AUDITED_DSH_${label}`];
  const skip = !supportedHost ? 'protected delegation supports Linux x86_64 only'
    : !dsh ? 'official runtime entries are supplied by the security CI matrix' : false;
  test(`Rust launcher enforces the official ${version} profile through the kernel`, { skip }, t => {
    const root = mkdtempSync(path.join(tmpdir(), 'rdsh-launcher-matrix-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    mkdirSync(workspace); mkdirSync(home);
    writeFileSync(path.join(workspace, 'README.md'), 'DUMMY_SHARED_DOCUMENT');
    writeFileSync(path.join(workspace, '.env'), 'DUMMY_UNSHARED_SECRET');
    const credential = path.join(root, 'credentials.json');
    writeFileSync(credential, 'DUMMY_OUTSIDE_SECRET');
    const plugin = path.join(root, 'probe.mjs');
    const quote = value => `'${value.replaceAll("'", "'\"'\"'")}'`;
    writeFileSync(plugin, `
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
export const name = 'rdsh-guarded-launcher-probe';
export const inject = ['tools', 'appReady', 'appExit'];
export async function apply(ctx) {
  try {
  assert.equal(process.env.RDSH_TOOL_ADAPTER, ${JSON.stringify(`dsh-tools-${version}`)});
  assert.equal(ctx.tools.defaultMode, 'native');
  const run = command => ctx.tools.get('rdsh_inspect').execute({ command });
  const shared = await run('cat README.md');
  assert.equal(shared.exitCode, 0, shared.stderr);
  assert.equal(shared.stdout, 'DUMMY_SHARED_DOCUMENT');
  for (const command of ${JSON.stringify([`cat ${quote(credential)}`, 'cat .env', 'env'])}) {
    const result = await run(command);
    assert.doesNotMatch(result.stdout, /DUMMY_(OUTSIDE|UNSHARED|ENV)_SECRET/);
  }
  assert.notEqual((await run('printf CHANGED > README.md')).exitCode, 0);
  assert.equal(await readFile(${JSON.stringify(path.join(workspace, 'README.md'))}, 'utf8'), 'DUMMY_SHARED_DOCUMENT');
  for (const command of ['unshare -Ur true', 'python3 -c "import socket; socket.socket()"']) {
    const result = await run(command);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /Operation not permitted/);
  }
  // Use the launched registry and its matching scope package; the standalone
  // catalog probe has separate rc2 dependencies and cannot share this matrix.
  const { createScope } = await import(pathToFileURL(
    createRequire(process.env.RDSH_TOOL_RUNTIME).resolve('@deepseek-ai/dsh-scope')
  ).href);
  const agent = {};
  const scoped = createScope(ctx, agent);
  agent.ctx = scoped.ctx;
  try {
    scoped.ctx.tools.presentAs('ptc');
    assert.equal(ctx.tools.defaultMode, 'native');
    assert.equal(ctx.tools.modeFor(), 'native');
    assert.equal(ctx.tools.modeFor(agent), 'ptc');
    assert.ok(ctx.tools.get('rdsh_inspect', agent));
    assert.ok(ctx.tools.get('run_code', agent));
    for (const name of ['bash', 'run_code', 'rdsh_inspect'])
      assert.equal(ctx.tools.guardReason({ name, agent }), undefined);
    const dispatched = await ctx.tools.execute({
      name: 'rdsh_inspect', arguments: { command: 'printf DUMMY_MODEL_DISPATCH' },
      agent, callId: 'dummy-dispatch', signal: new AbortController().signal,
    });
    assert.equal(dispatched.isError, true);
    assert.match(JSON.stringify(dispatched), /only \\x60run_code\\x60 is callable directly/);
  } finally {
    await scoped.dispose();
  }
  assert.equal(ctx.tools.modeFor(agent), 'native');
  ctx.effect(() => ctx.appReady.onReady(() => {
    console.log('RDSH_LAUNCHER_KERNEL ' + JSON.stringify({ version: ${JSON.stringify(version)}, sharedRead: true, secretsDenied: true, writesDenied: true, namespaceDenied: true, networkDenied: true, dispatcherGuarded: true }));
    ctx.appExit(0);
  }));
  } catch (error) {
    console.error(error);
    ctx.appExit(1);
    throw error;
  }
}
`);
    const overlay = path.join(root, 'probe.yml');
    writeFileSync(overlay, [
      '- id: llm-deepseek', '  disabled: true',
      '- id: llm-pi-ai', '  config:', '    providers: {}',
      '- id: workspace-controller', '  config:', `    documentsDirectory: ${JSON.stringify(workspace)}`,
      '- insert:', '    - id: rdsh-guarded-launcher-probe', `      name: ${JSON.stringify(plugin)}`,
    ].join('\n') + '\n');
    const result = spawnSync(bin, ['--share-file', 'README.md', '--profile', 'web', '--patch', overlay, '--no-open', '--port', '0'], {
      cwd: workspace,
      env: {
        PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
        HOME: home, DSH_HOME: path.join(root, 'dsh'), DSH_AGENTS_HOME: path.join(root, 'agents'),
        XDG_CONFIG_HOME: path.join(root, 'config'), TMPDIR: '/tmp',
        RDSH_ORIG_BIN: dsh, RDSH_SECURITY: '1', RDSH_LANG: 'ja',
        RDSH_AUTH_AUTOSYNC: '0', RDSH_NODE_COMPILE_CACHE: '0',
        RDSH_SHARED_FILES: JSON.stringify(['README.md']),
        RDSH_TOOL_ADAPTER: 'untrusted-environment-adapter', RDSH_TOOL_RUNTIME: '/untrusted-runtime',
        RDSH_TEST_PRIVATE_KEY: 'DUMMY_ENV_SECRET', DSH_TELEMETRY_DISABLED: '1',
      },
      encoding: 'utf8', timeout: 90_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined, `profile did not finish: ${result.stderr}`);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    const report = result.stdout.split(/\r?\n/).find(line => line.startsWith('RDSH_LAUNCHER_KERNEL '));
    assert.ok(report, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(report.slice('RDSH_LAUNCHER_KERNEL '.length)), {
      version, sharedRead: true, secretsDenied: true, writesDenied: true,
      namespaceDenied: true, networkDenied: true, dispatcherGuarded: true,
    });
  });
}
