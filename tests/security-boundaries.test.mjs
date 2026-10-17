import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, rmSync, symlinkSync, linkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const bin = path.resolve(process.env.BIN || 'target/debug/rdsh');
const securityPreload = pathToFileURL(path.resolve('security/preload.mjs')).href;
function isolated(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rdsh-security-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  mkdirSync(home);
  return { dir, env: { PATH: process.env.PATH, HOME: home, DSH_HOME: path.join(dir, 'dsh') } };
}

function auditedRuntimeEnvironment() {
  return {
    rc2: process.env.RDSH_AUDITED_RUNTIME_RC2,
    alpha1: process.env.RDSH_AUDITED_RUNTIME_ALPHA1,
    alpha3: process.env.RDSH_AUDITED_RUNTIME_ALPHA3,
  };
}

function runPreload(runtime, adapter, extra = {}) {
  const env = {
    ...process.env,
    RDSH_TOOL_RUNTIME: runtime,
    RDSH_TOOL_ADAPTER: adapter,
    RDSH_SECURE_WORKSPACE: process.cwd(),
    RDSH_SHARED_FILES: '[]',
    ...extra,
  };
  delete env.RDSH_SECURITY_LANG;
  return spawnSync(process.execPath, [
    '--import', securityPreload,
    '--input-type=module',
    '--eval', `await import(${JSON.stringify(pathToFileURL(runtime).href)})`,
  ], { env, encoding: 'utf8' });
}

test('audited preload accepts registered versions and the legacy unset rc2 adapter', t => {
  const runtimes = auditedRuntimeEnvironment();
  if (Object.values(runtimes).some(value => !value)) {
    t.skip('official audited runtime paths are supplied by the Linux security matrix');
    return;
  }
  for (const [runtime, adapter] of [
    [runtimes.rc2, undefined],
    [runtimes.rc2, 'dsh-tools-0.2.0-rc.2'],
    [runtimes.alpha1, 'dsh-tools-0.2.1-alpha.1'],
    [runtimes.alpha3, 'dsh-tools-0.2.1-alpha.3'],
  ]) {
    const result = runPreload(runtime, adapter, { RDSH_LANG: 'en' });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('audited preload rejects unknown, modified and cross-version runtimes with localized codes', t => {
  const runtimes = auditedRuntimeEnvironment();
  if (Object.values(runtimes).some(value => !value)) {
    t.skip('official audited runtime paths are supplied by the Linux security matrix');
    return;
  }
  const { dir } = isolated(t);
  const modified = path.join(dir, 'modified-runtime.mjs');
  writeFileSync(modified, `${readFileSync(runtimes.rc2, 'utf8')}\n`);
  const cases = [
    ['en', 'unsupported tool runtime', 'UNSUPPORTED_RUNTIME'],
    ['zh', '不支持的工具运行时', 'UNSUPPORTED_RUNTIME'],
    ['ja', '対応していないツールランタイム', 'UNSUPPORTED_RUNTIME'],
  ];
  for (const [language, text, code] of cases) {
    const result = runPreload(modified, 'dsh-tools-0.2.0-rc.2', { RDSH_LANG: language });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`RDSH_SECURITY\\[${code}\\]`));
    assert.match(result.stderr, new RegExp(text));
  }
  for (const adapter of ['', 'dsh-tools-future']) {
    const unknown = runPreload(runtimes.rc2, adapter, { RDSH_LANG: 'en' });
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /RDSH_SECURITY\[UNKNOWN_ADAPTER\]/);
  }
  const crossVersion = runPreload(runtimes.alpha1, 'dsh-tools-0.2.0-rc.2', { RDSH_LANG: 'en' });
  assert.notEqual(crossVersion.status, 0);
  assert.match(crossVersion.stderr, /RDSH_SECURITY\[UNSUPPORTED_RUNTIME\]/);
});

test('audited preload rejects a different known runtime swapped in during loading', t => {
  const runtimes = auditedRuntimeEnvironment();
  if (Object.values(runtimes).some(value => !value)) {
    t.skip('official audited runtime paths are supplied by the Linux security matrix');
    return;
  }
  const { dir } = isolated(t);
  const selected = path.join(dir, 'selected-runtime.mjs');
  const entry = path.join(dir, 'swap-before-import.mjs');
  writeFileSync(selected, readFileSync(runtimes.rc2));
  writeFileSync(entry, [
    "import { copyFileSync } from 'node:fs';",
    `copyFileSync(${JSON.stringify(runtimes.alpha1)}, ${JSON.stringify(selected)});`,
    `await import(${JSON.stringify(pathToFileURL(selected).href)});`,
  ].join('\n'));
  const result = spawnSync(process.execPath, ['--import', securityPreload, entry], {
    env: {
      ...process.env,
      RDSH_TOOL_RUNTIME: selected,
      RDSH_TOOL_ADAPTER: 'dsh-tools-0.2.0-rc.2',
      RDSH_SECURE_WORKSPACE: process.cwd(),
      RDSH_SHARED_FILES: '[]',
      RDSH_SECURITY_LANG: 'en',
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RDSH_SECURITY\[RUNTIME_CHANGED\]/);
});

test('preload refuses a nested tool runtime selected by another importer', t => {
  const runtime = auditedRuntimeEnvironment().alpha3;
  if (!runtime) {
    t.skip('the official alpha3 runtime path is supplied by the Linux security matrix');
    return;
  }
  const { dir, env } = isolated(t);
  const importer = path.join(dir, 'importer');
  const nested = path.join(importer, 'node_modules/@deepseek-ai/dsh-tools');
  const marker = path.join(dir, 'nested-body-ran');
  mkdirSync(path.join(nested, 'lib'), { recursive: true });
  writeFileSync(path.join(nested, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-tools', type: 'module',
    exports: { '.': { default: './lib/index.js' } },
  }));
  const target = path.join(nested, 'lib/index.js');
  writeFileSync(target, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'NESTED_RAN');`);
  const oracle = path.join(importer, 'resolve.mjs');
  writeFileSync(oracle, "console.log(import.meta.resolve('@deepseek-ai/dsh-tools'));\n");
  const resolved = spawnSync(process.execPath, [oracle], { env, encoding: 'utf8' });
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(resolved.stdout.trim(), pathToFileURL(realpathSync(target)).href);
  assert.equal(existsSync(marker), false, 'resolution must not execute the nested body');
  const entry = path.join(importer, 'entry.mjs');
  writeFileSync(entry, "await import('@deepseek-ai/dsh-tools');\n");
  const result = spawnSync(process.execPath, ['--import', securityPreload, entry], {
    env: { ...env, RDSH_TOOL_RUNTIME: runtime, RDSH_TOOL_ADAPTER: 'dsh-tools-0.2.1-alpha.3',
      RDSH_SECURE_WORKSPACE: dir, RDSH_SHARED_FILES: '[]', RDSH_SECURITY_LANG: 'en' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RDSH_SECURITY\[RUNTIME_RESOLUTION_MISMATCH\]/);
  assert.equal(existsSync(marker), false, 'a mismatched runtime must not execute');
});
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
test('shell quoting, variable assembly and path traversal cannot bypass deny patterns', t => {
  const { dir, env } = isolated(t);
  for (const [command, pattern] of [
    ['r"m" -rf / x', 'rm -rf /*'],
    ["r'm' -rf / x", 'rm -rf /*'],
    ['A=rm; $A -rf / x', 'rm -rf /*'],
    ['A=rm; B=$A; $B -rf / x', 'rm -rf /*'],
    ['/bin/rm -rf / x', 'rm -rf /*'],
    ['sh -c "rm -rf /"', 'rm -rf /*'],
    ['rm -rf /tmp/../important/x', 'rm -rf /important*'],
  ]) {
    const input = JSON.stringify({ cwd: '/tmp', tool_name: 'Bash', tool_input: { command } });
    const result = spawnSync(bin, ['guard', '--deny', pattern], { env, input, encoding: 'utf8' });
    assert.equal(result.status, 2, command);
  }
  writeFileSync(path.join(dir, 'secret.txt'), 'never read this');
  symlinkSync(path.join(dir, 'secret.txt'), path.join(dir, 'safe.txt'));
  const linked = spawnSync(bin, ['guard', '--deny', '*secret.txt*'], {
    env, input: JSON.stringify({ cwd: dir, tool_name: 'Bash', tool_input: { command: 'cat safe.txt' } }), encoding: 'utf8',
  });
  assert.equal(linked.status, 2, linked.stderr);
});
test('harmless argument text is still not an anchored deny hit', t => {
  const { env } = isolated(t);
  const input = JSON.stringify({ cwd: '/tmp', tool_name: 'Bash', tool_input: { command: 'echo rm -rf / x' } });
  const result = spawnSync(bin, ['guard', '--deny', 'rm -rf /*'], { env, input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
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
  const bodyMarker = path.join(dir, 'delegated-body-ran');
  mkdirSync(path.join(pkg, 'lib'), { recursive: true });
  mkdirSync(path.join(pkg, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib'), { recursive: true });
  writeFileSync(path.join(pkg, 'lib', 'bin.js'), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(bodyMarker)}, 'BODY_RAN');\n`, { mode: 0o700 });
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' }));
  writeFileSync(path.join(pkg, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'), '');
  env.RDSH_ORIG_BIN = path.join(pkg, 'lib', 'bin.js');
  // The strict boundary is opt-in now, so refuse-as-unsupported is asserted
  // with RDSH_SECURITY=1; the default run is covered by the next test.
  const strict = spawnSync(bin, ['--profile', 'tui'], { env: { ...env, RDSH_SECURITY: '1' }, encoding: 'utf8' });
  assert.notEqual(strict.status, 0);
  assert.match(strict.stderr, /RDSH_SECURITY/);
  assert.equal(existsSync(bodyMarker), false, 'an invalid runtime must fail before delegated code runs');
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

test('forged tool exports fail before delegated code runs', t => {
  const runtime = process.env.RDSH_AUDITED_RUNTIME_ALPHA3;
  if (!runtime) {
    t.skip('the official alpha3 runtime path is supplied by the Linux security matrix');
    return;
  }
  const { dir, env } = isolated(t);
  const pkg = path.join(dir, 'pkg');
  const tools = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-tools');
  const bodyMarker = path.join(dir, 'forged-exports-body-ran');
  mkdirSync(path.join(pkg, 'lib'), { recursive: true });
  mkdirSync(path.join(tools, 'lib'), { recursive: true });
  writeFileSync(path.join(pkg, 'lib', 'bin.js'), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(bodyMarker)}, 'BODY_RAN');\n`, { mode: 0o700 });
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: '0.2.1-alpha.3',
    dependencies: { '@deepseek-ai/dsh-agent-instructions': '0.2.1-alpha.3' },
    devDependencies: { '@deepseek-ai/dsh-tools': '0.2.1-alpha.3' },
  }));
  writeFileSync(path.join(tools, 'lib', 'index.js'), readFileSync(runtime));
  writeFileSync(path.join(tools, 'lib', 'other.js'), `require('node:fs').writeFileSync(${JSON.stringify(bodyMarker)}, 'OTHER_RAN');\n`);
  const oracle = path.join(pkg, 'lib', 'resolve.mjs');
  writeFileSync(oracle, "console.log(import.meta.resolve('@deepseek-ai/dsh-tools'));\n");
  env.RDSH_ORIG_BIN = path.join(pkg, 'lib', 'bin.js');
  for (const condition of ['default', 'node', 'import', 'require']) {
    const exports = condition === 'default' ? { default: './lib/other.js' }
      : { types: './lib/types/index.d.ts', [condition]: './lib/other.js', default: './lib/index.js' };
    writeFileSync(path.join(tools, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-tools', version: '0.2.1-alpha.3',
      main: 'lib/index.js', exports: { '.': exports },
    }));
    const resolved = spawnSync(process.execPath, [oracle], { env, encoding: 'utf8' });
    assert.equal(resolved.status, 0, resolved.stderr);
    const expected = condition === 'require' ? 'index.js' : 'other.js';
    assert.equal(resolved.stdout.trim(), pathToFileURL(realpathSync(path.join(tools, 'lib', expected))).href);
    const result = spawnSync(bin, ['--profile', 'tui'], {
      env: { ...env, RDSH_SECURITY: '1' }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, condition);
    assert.match(result.stderr, /RDSH_SECURITY/);
    if (process.platform === 'linux' && process.arch === 'x64')
      assert.match(result.stderr, /unsupported DSH and tool runtime version pair/, condition);
    assert.equal(existsSync(bodyMarker), false, `${condition} exports must fail before either entry executes`);
  }
});
test('agent tools default to normal file access', t => {
  const { dir, env } = isolated(t);
  const pkg = path.join(dir, 'pkg');
  mkdirSync(path.join(pkg, 'lib'), { recursive: true });
  writeFileSync(path.join(pkg, 'lib', 'bin.js'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o700 });
  env.RDSH_ORIG_BIN = path.join(pkg, 'lib', 'bin.js');
  const boot = spawnSync(bin, ['--profile', 'tui'], { env, encoding: 'utf8' });
  assert.equal(boot.status, 0, boot.stderr);
  assert.doesNotMatch(boot.stderr, /RDSH_SECURITY/);
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
test('automatic updater verifies against the pinned registry, not a same-origin sidecar', t => {
  const { dir, env } = isolated(t);
  const version = 'v9.9.9';
  const assets = ['rdsh-linux-x64.tar.gz', 'rdsh-linux-x64-musl.tar.gz', 'rdsh-macos-arm64.tar.gz', 'rdsh-macos-x64.tar.gz'];
  const releaseRoot = path.join(dir, 'releases');
  const download = path.join(releaseRoot, 'download', version);
  const pkg = path.join(dir, 'pkg');
  const shim = path.join(dir, 'shim');
  mkdirSync(download, { recursive: true });
  mkdirSync(pkg);
  mkdirSync(shim);
  const payload = '#!/bin/sh\nexit 0\n';
  writeFileSync(path.join(pkg, 'rdsh'), payload, { mode: 0o755 });
  const asset = path.join(download, 'rdsh-linux-x64.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', asset, '-C', pkg, 'rdsh'], { env }).status, 0);
  const digest = createHash('sha256').update(readFileSync(asset)).digest('hex');
  for (const name of assets) if (name !== 'rdsh-linux-x64.tar.gz') writeFileSync(path.join(download, name), readFileSync(asset));
  const manifest = path.join(dir, 'release-digests.tsv');
  writeFileSync(manifest, ['# DUMMY fixture', `latest ${version}`, ...assets.map(name => `${version} ${name} ${digest}`)].join('\n') + '\n');
  // The fixture curl answers only the canonical registry URL and file:// URLs, so
  // a run that tries to fetch an <asset>.sha256 from the release base fails loudly.
  const registry = 'https://raw.githubusercontent.com/jimoto-no-llm/rustdsh/main/release-digests.tsv';
  const curlLog = path.join(dir, 'curl.log');
  writeFileSync(path.join(shim, 'curl'), `#!/bin/sh
out=""
prev=""
url=""
for arg in "$@"; do
  [ "$prev" = "-o" ] && out="$arg"
  prev="$arg"
  url="$arg"
done
[ -n "$out" ] || exit 2
printf '%s\\n' "$url" >> "${curlLog}"
if [ "$url" = "${registry}" ]; then cp "${manifest}" "$out"; exit 0; fi
if [ "\${url#file://}" != "$url" ]; then cp "\${url#file://}" "$out"; exit 0; fi
echo "unexpected URL: $url" >&2
exit 22
`, { mode: 0o755 });
  env.RDSH_RELEASE_BASE = 'file://' + releaseRoot;
  env.PATH = `${shim}${path.delimiter}${process.env.PATH}`;
  const dest = path.join(dir, 'installed');
  env.TEST_DEST = dest;
  // The fragment below ends before the fetch this test drives, so the
  // self-update step that runs earlier in the real script must stay off: it
  // would fetch the script's origin and make the first curl-log assertion
  // meaningless.
  env.RDSH_SYNC_SELF_UPDATE = '0';
  const source = readFileSync('sync-dsh.sh', 'utf8').replaceAll('\r\n', '\n').split('\nNPM=""')[0];
  const run = () => spawnSync('/bin/sh', ['-c', source + '\nfetch_rdsh_release "$TEST_DEST"'], { env, encoding: 'utf8' });
  // sync-dsh.sh logs through tee(1) on stdout, so both streams carry refusals.
  const output = result => result.stdout + result.stderr;
  const refused = run();
  assert.notEqual(refused.status, 0);
  assert.match(output(refused), /refusing non-https release base/);
  assert.equal(existsSync(curlLog), false);
  env.RDSH_TEST_INSECURE_BASE = '1';
  // A same-origin sidecar that matches different bytes cannot authorize them.
  const genuine = readFileSync(asset);
  writeFileSync(asset, Buffer.concat([genuine, Buffer.from('DUMMY tampered payload')]));
  const tampered = createHash('sha256').update(readFileSync(asset)).digest('hex');
  for (const name of assets) writeFileSync(path.join(download, name + '.sha256'), `${tampered}  ${name}\n`);
  const mismatch = run();
  assert.notEqual(mismatch.status, 0);
  assert.match(output(mismatch), /CHECKSUM MISMATCH/);
  assert.equal(existsSync(dest), false);
  // A version without a registry row is refused instead of trusted.
  env.RDSH_SYNC_VERSION = 'v9.9.8';
  const unpinned = run();
  assert.notEqual(unpinned.status, 0);
  assert.match(output(unpinned), /no pinned checksum for release v9\.9\.8/);
  delete env.RDSH_SYNC_VERSION;
  // Only the pinned bytes install, and no sidecar is ever requested.
  writeFileSync(asset, genuine);
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr + valid.stdout);
  assert.equal(readFileSync(dest, 'utf8'), payload);
  assert.doesNotMatch(readFileSync(curlLog, 'utf8'), /\.sha256/);
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
