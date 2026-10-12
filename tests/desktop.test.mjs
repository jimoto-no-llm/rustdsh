import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('..', import.meta.url));
const bin = join(repo, 'target', process.platform === 'win32' ? 'debug/rdsh.exe' : 'debug/rdsh');
const windows = process.platform === 'win32';

// Desktop (Electron) owns the reserved `desktop` profile; the npm dsh CLI
// cannot manage it, so `rdsh desktop install` only forwards
// `plugin --profile desktop add` to the Desktop-installed command. These tests
// drive that forwarding against a stub command and a hermetic DSH_HOME: no
// Electron, no real DSH profile, no model calls.
async function sandbox(t) {
  // The directory names contain a space on purpose: the packaged Windows path
  // (\u2026\Programs\DeepSeek Harness\resources\...) does too, and the stub launch has
  // to survive cmd.exe quoting.
  const root = await mkdtemp(join(tmpdir(), 'rdsh desktop '));
  const home = join(root, 'dsh');
  const checkout = join(root, 'rustdsh');
  for (const name of ['rdsh-settings', 'rdsh-compute']) {
    await mkdir(join(checkout, 'plugins', name), { recursive: true });
    await writeFile(join(checkout, 'plugins', name, 'package.json'), JSON.stringify({ name }));
  }
  await mkdir(join(home, 'profiles', 'desktop'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, home, checkout, profile: join(home, 'profiles', 'desktop', 'package.json'), log: join(root, 'calls.log') };
}

// Stub for resources/runtime/cli/bin/dsh. It records argv and, for `add`,
// enables the package the way the shared plugin manager does (dependency plus
// an appended dsh.profile.bundles entry). Windows gets a .cmd launcher (which
// rdsh must start through cmd /C) next to the same program body.
async function stubCommand(box, dir = join(box.root, 'desktop cli')) {
  await mkdir(dir, { recursive: true });
  const lines = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const args = process.argv.slice(2);',
    'fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(args) + "\\n");',
    "const at = args.indexOf('add');",
    'if (at >= 0 && args[at - 1] !== undefined) {',
    '  const source = args[at + 1];',
    '  const name = path.basename(source);',
    '  const profile = process.env.STUB_PROFILE;',
    "  const doc = JSON.parse(fs.readFileSync(profile, 'utf8'));",
    '  doc.dependencies = doc.dependencies || {};',
    "  doc.dependencies[name] = 'link:' + source;",
    '  const bundles = (doc.dsh && doc.dsh.profile && doc.dsh.profile.bundles) || [];',
    '  if (!bundles.includes(name)) bundles.push(name);',
    "  doc.dsh = { profile: { bundles } };",
    "  fs.writeFileSync(profile, JSON.stringify(doc, null, 2) + '\\n');",
    '}',
  ];
  await writeFile(join(dir, 'stub.cjs'), lines.join('\n') + '\n');
  if (windows) {
    const path = join(dir, 'dsh.cmd');
    await writeFile(path, '@echo off\r\nnode "%~dp0stub.cjs" %*\r\n');
    return path;
  }
  const path = join(dir, 'dsh');
  await writeFile(path, "#!/usr/bin/env node\nrequire('./stub.cjs');\n");
  await chmod(path, 0o755);
  return path;
}

async function run(args, env) {
  const options = { env: { ...process.env, ...env }, cwd: repo, maxBuffer: 4 * 1024 * 1024 };
  try {
    const { stdout, stderr } = await exec(bin, args, options);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function baseEnv(t) {
  const box = await sandbox(t);
  return { box, env: { DSH_HOME: box.home } };
}

async function initProfile(box, doc) {
  await writeFile(box.profile, JSON.stringify(doc, null, 2) + '\n');
}

test('status is truthful with no Desktop app and no profile', async (t) => {
  const { env } = await baseEnv(t);
  const { code, stdout } = await run(['desktop', 'status', '--json'], { ...env, DSH_DESKTOP_CLI: '' });
  assert.equal(code, 0);
  const status = JSON.parse(stdout);
  assert.equal(status.available, false);
  assert.equal(status.profile.initialized, false);
  assert.equal(status.command.path, null);
  assert.deepEqual(status.profile.plugins.map((p) => [p.name, p.enabled]), [['rdsh-settings', false], ['rdsh-compute', false]]);
});

test('status reports the Desktop command and enabled plugins', async (t) => {
  const { box, env } = await baseEnv(t);
  const command = await stubCommand(box);
  await initProfile(box, {
    name: 'dsh-profile-desktop',
    dependencies: { 'rdsh-settings': 'link:/repo/plugins/rdsh-settings' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@local/rdsh-settings'] } },
  });
  const { code, stdout } = await run(['desktop', 'status', '--json'], { ...env, DSH_DESKTOP_CLI: command });
  assert.equal(code, 0);
  const status = JSON.parse(stdout);
  assert.equal(status.command.source, 'DSH_DESKTOP_CLI');
  assert.equal(status.command.path, command);
  assert.equal(status.profile.initialized, true);
  const settings = status.profile.plugins.find((p) => p.name === 'rdsh-settings');
  assert.deepEqual([settings.installed, settings.enabled], [true, true], 'scoped bundle alias counts as enabled');
});

test('an extracted AppImage is detected through APPDIR', {
  skip: process.platform === 'darwin' || process.platform === 'win32'
    ? 'APPDIR is a Linux AppImage variable'
    : false,
}, async (t) => {
  const { box, env } = await baseEnv(t);
  const app = join(box.root, 'squashfs-root');
  const launcher = await stubCommand(box, join(app, 'resources', 'runtime', 'cli', 'bin'));
  await initProfile(box, { name: 'dsh-profile-desktop' });
  const status = await run(['desktop', 'status', '--json'], { ...env, APPDIR: app });
  assert.equal(status.code, 0, status.stderr);
  const report = JSON.parse(status.stdout);
  assert.equal(report.app.path, app);
  assert.equal(report.command.source, 'detected');
  assert.equal(report.command.path, launcher);
});

test('install --dry-run prints the forwarded command and changes nothing', async (t) => {
  const { box, env } = await baseEnv(t);
  const command = await stubCommand(box);
  await initProfile(box, { name: 'dsh-profile-desktop' });
  const before = await readFile(box.profile, 'utf8');
  const { code, stdout } = await run(['desktop', 'install', '--dry-run', '--json', '--plugins-dir', box.checkout], { ...env, DSH_DESKTOP_CLI: command });
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.dry_run, true);
  assert.equal(report.actions.length, 3);
  assert.equal(report.actions[0].plugin, 'rdsh-settings');
  assert.deepEqual(report.actions[0].args, ['plugin', '--profile', 'desktop', 'add', join(box.checkout, 'plugins', 'rdsh-settings')]);
  assert.equal(report.actions[1].plugin, 'dsh-sound-notifications');
  assert.deepEqual(report.actions[1].args, ['plugin', '--profile', 'desktop', 'add', 'github:cwd514/dsh-sound-notifications']);
  assert.equal(report.actions[2].plugin, 'dsh-gitview');
  assert.deepEqual(report.actions[2].args, ['plugin', '--profile', 'desktop', 'add', 'github:yugapor/dsh-gitview']);
  assert.equal(existsSync(box.log), false, 'the Desktop command must not run on --dry-run');
  assert.equal(await readFile(box.profile, 'utf8'), before);
});

test('install forwards to the Desktop command and verify then passes', async (t) => {
  const { box, env } = await baseEnv(t);
  const command = await stubCommand(box);
  await initProfile(box, { name: 'dsh-profile-desktop' });
  const { code, stdout } = await run(['desktop', 'install', '--json', '--plugins-dir', box.checkout], {
    ...env, DSH_DESKTOP_CLI: command, STUB_LOG: box.log, STUB_PROFILE: box.profile,
  });
  assert.equal(code, 0, stdout);
  const calls = (await readFile(box.log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(calls[0], [
    'plugin', '--profile', 'desktop', 'add', join(box.checkout, 'plugins', 'rdsh-settings'),
  ]);
  assert.deepEqual(calls[1], ['plugin', '--profile', 'desktop', 'add', 'github:cwd514/dsh-sound-notifications']);
  assert.deepEqual(calls[2], ['plugin', '--profile', 'desktop', 'add', 'github:yugapor/dsh-gitview']);
  const verify = await run(['desktop', 'verify', '--json'], { ...env, DSH_DESKTOP_CLI: command });
  assert.equal(verify.code, 0, verify.stderr);
  assert.deepEqual(JSON.parse(verify.stdout).missing, []);
});

test('install --compute also attaches the compute bridge', async (t) => {
  const { box, env } = await baseEnv(t);
  const command = await stubCommand(box);
  await initProfile(box, { name: 'dsh-profile-desktop' });
  const { code } = await run(['desktop', 'install', '--compute', '--json', '--plugins-dir', box.checkout], {
    ...env, DSH_DESKTOP_CLI: command, STUB_LOG: box.log, STUB_PROFILE: box.profile,
  });
  assert.equal(code, 0);
  const verify = await run(['desktop', 'verify', '--require', 'rdsh-compute', '--json'], { ...env, DSH_DESKTOP_CLI: command });
  assert.equal(verify.code, 0, verify.stderr);
});

test('install --no-sound --no-gitview skips the default third-party plugins', async (t) => {
  const { box, env } = await baseEnv(t);
  const command = await stubCommand(box);
  await initProfile(box, { name: 'dsh-profile-desktop' });
  const { code, stdout } = await run(['desktop', 'install', '--dry-run', '--json', '--plugins-dir', box.checkout, '--no-sound', '--no-gitview'], { ...env, DSH_DESKTOP_CLI: command });
  assert.equal(code, 0, stdout);
  const report = JSON.parse(stdout);
  assert.equal(report.actions.length, 1);
  assert.equal(report.actions[0].plugin, 'rdsh-settings');
});

test('install --no-sound keeps gitview and vice versa', async (t) => {
  const { box, env } = await baseEnv(t);
  const command = await stubCommand(box);
  await initProfile(box, { name: 'dsh-profile-desktop' });
  const onlyGit = await run(['desktop', 'install', '--dry-run', '--json', '--plugins-dir', box.checkout, '--no-sound'], { ...env, DSH_DESKTOP_CLI: command });
  assert.deepEqual(JSON.parse(onlyGit.stdout).actions.map((a) => a.plugin), ['rdsh-settings', 'dsh-gitview']);
  const onlySound = await run(['desktop', 'install', '--dry-run', '--json', '--plugins-dir', box.checkout, '--no-gitview'], { ...env, DSH_DESKTOP_CLI: command });
  assert.deepEqual(JSON.parse(onlySound.stdout).actions.map((a) => a.plugin), ['rdsh-settings', 'dsh-sound-notifications']);
});

test('install and verify refuse an uninitialized Desktop profile', async (t) => {
  const { box, env } = await baseEnv(t);
  const command = await stubCommand(box);
  const envWithCommand = { ...env, DSH_DESKTOP_CLI: command };
  const install = await run(['desktop', 'install', '--json', '--plugins-dir', box.checkout], envWithCommand);
  assert.notEqual(install.code, 0);
  assert.match(install.stderr, /Open DeepSeek Harness Desktop once/);
  const verify = await run(['desktop', 'verify', '--json'], envWithCommand);
  assert.notEqual(verify.code, 0);
  assert.equal(JSON.parse(verify.stdout).missing.length, 1);
});

test('a --plugins-dir without the plugins is skipped for a real checkout', async (t) => {
  const { box, env } = await baseEnv(t);
  const command = await stubCommand(box);
  await initProfile(box, { name: 'dsh-profile-desktop' });
  const { code, stdout } = await run(['desktop', 'install', '--dry-run', '--json', '--plugins-dir', join(box.root, 'nope')], {
    ...env, DSH_DESKTOP_CLI: command,
  });
  assert.equal(code, 0, stdout);
  const report = JSON.parse(stdout);
  const resolved = report.plugins_dir;
  assert.notEqual(resolved, join(box.root, 'nope'));
  assert.match(resolved, /plugins$/);
  assert.equal(existsSync(join(resolved, 'rdsh-settings', 'package.json')), true);
});

test('the packaged app layout is discovered without DSH_DESKTOP_CLI', async (t) => {
  const { box, env } = await baseEnv(t);
  // <app>/resources/runtime/cli/bin/dsh[.cmd] is the installed layout the
  // detection must find, so the stub is written exactly there.
  const app = join(box.root, 'DeepSeek Harness');
  const launcher = await stubCommand(box, join(app, 'resources', 'runtime', 'cli', 'bin'));
  await initProfile(box, { name: 'dsh-profile-desktop' });
  const appEnv = { ...env, DSH_DESKTOP_APP_DIR: app };

  const status = await run(['desktop', 'status', '--json'], appEnv);
  assert.equal(status.code, 0, status.stderr);
  const report = JSON.parse(status.stdout);
  assert.equal(report.app.path, app);
  assert.equal(report.command.source, 'detected');
  assert.equal(report.command.path, launcher);

  const install = await run(['desktop', 'install', '--json', '--plugins-dir', box.checkout], {
    ...appEnv, STUB_LOG: box.log, STUB_PROFILE: box.profile,
  });
  assert.equal(install.code, 0, install.stderr);
  assert.equal(JSON.parse((await readFile(box.log, 'utf8')).trim().split('\n')[0])[0], 'plugin');
});

test('the stub launcher matches the host platform', async (t) => {
  const { box } = await baseEnv(t);
  const command = await stubCommand(box);
  assert.equal(command.endsWith(windows ? 'dsh.cmd' : 'dsh'), true);
  assert.equal(existsSync(join(box.root, 'desktop cli', 'stub.cjs')), true);
});
