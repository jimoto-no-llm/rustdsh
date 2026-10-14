// Native-runner acceptance: no account, model call or personal profile.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { packagedPaths } from './build.mjs';

const { values } = parseArgs({ options: { checkout: { type: 'string' }, output: { type: 'string' } } });
if (!values.checkout || !values.output) throw new Error('Usage: node desktop/smoke-packaged.mjs --checkout <prepared source> --output <evidence directory>');
const paths = packagedPaths(values.checkout), output = resolve(values.output);
const temporary = await mkdtemp(join(tmpdir(), 'rdsh-native-app-'));
const home = join(temporary, 'harness'), userData = join(temporary, 'electron');
let application;
try {
  await mkdir(output, { recursive: true });
  await mkdir(home); await mkdir(userData);
  // Plain Node cannot read ASAR. Verify this source record against the actual
  // packaged record inside Electron before accepting the renderer.
  const build = JSON.parse(await readFile(join(resolve(values.checkout), 'apps/desktop/rdsh-build.json'), 'utf8'));
  const binary = join(paths.resources, 'rdsh', process.platform === 'win32' ? 'rdsh.exe' : 'rdsh');
  assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), build.nativeSha256);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^NODE_PATH$|^ELECTRON_RUN_AS_NODE$|^(?:DSH|RDSH)_/i.test(name)));
  Object.assign(environment, { DSH_TELEMETRY_DISABLED: '1', RDSH_DESKTOP_HOME: home,
    RDSH_DESKTOP_USER_DATA: userData, DSH_HOME: home, HOME: temporary, USERPROFILE: temporary,
    XDG_CONFIG_HOME: temporary, XDG_CACHE_HOME: temporary, XDG_STATE_HOME: temporary,
    APPDATA: temporary, LOCALAPPDATA: temporary });
  const { stdout } = await promisify(execFile)(binary, ['--version'], { env: environment, timeout: 30000 });
  assert.equal(stdout.trim(), `rdsh ${build.rdshVersion}`);
  // Invoke the Rust launcher under its documented drop-in dsh name, so
  // --version is forwarded verbatim rather than consumed by Rust's own CLI.
  const alias = join(temporary, process.platform === 'win32' ? 'dsh.exe' : 'dsh');
  await copyFile(binary, alias);
  const delegated = await promisify(execFile)(alias, ['--version'], { timeout: 60000, env: { ...environment,
    RDSH_PASSTHROUGH: '1', RDSH_ORIG_BIN: join(paths.resources, 'runtime/cli/bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh') } });
  assert.ok(delegated.stdout.includes(build.harnessVersion), 'the bundled CLI must report the pinned Harness version');
  const { _electron } = await import('../tests/e2e/node_modules/playwright/index.mjs');
  application = await _electron.launch({ executablePath: paths.executable, env: environment,
    args: ['--disable-gpu'], timeout: 120000 });
  const metadata = await application.evaluate(({ app }) => ({ name: app.getName(), version: app.getVersion(),
    home: process.env.DSH_HOME, userData: app.getPath('userData'), resources: process.resourcesPath,
    packaged: app.isPackaged }));
  assert.equal(metadata.name, 'rdsh Desktop'); assert.equal(metadata.version, build.rdshVersion);
  assert.equal(metadata.home, home); assert.equal(metadata.userData, userData); assert.equal(metadata.packaged, true);
  const packagedRecord = await application.evaluate(({ app }) => {
    // Playwright evaluates in an inspector realm without a dynamic-import
    // callback. Electron's Node 24 builtins still use its ASAR-aware filesystem.
    const { readFileSync } = process.getBuiltinModule('node:fs');
    const { join } = process.getBuiltinModule('node:path');
    return JSON.parse(readFileSync(join(app.getAppPath(), 'rdsh-build.json'), 'utf8'));
  });
  assert.deepEqual(packagedRecord, build);
  const window = await application.firstWindow({ timeout: 120000 });
  await window.locator('body').waitFor();
  await window.waitForFunction(() => document.body.innerText.trim().length > 0, null, { timeout: 60000 });
  assert.ok(/^(?:file|dsh-app):/.test(window.url()), 'the initial renderer must be a bundled document');
  await window.screenshot({ path: join(output, 'rdsh-desktop-startup.png') });
  const child = application.process();
  await application.close(); application = undefined;
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'Electron exit must be confirmed');
  await writeFile(join(output, 'native-smoke.json'), JSON.stringify({ schemaVersion: 1, platform: process.platform,
    arch: process.arch, rdshVersion: build.rdshVersion, harnessVersion: build.harnessVersion, revision: build.revision,
    rustSha256: build.nativeSha256, checks: { nativeRust: true, delegatedCLI: true, appIdentity: true,
      isolatedHomes: true, packagedRecord: true, renderer: true, electronExit: true } }, null, 2) + '\n');
  console.log('PASS native Desktop: bundled Rust, exact CLI delegation, app identity, isolated homes, first renderer and confirmed exit');
} finally {
  await application?.close();
  await rm(temporary, { recursive: true, force: true });
}
