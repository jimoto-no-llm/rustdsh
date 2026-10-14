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
import { redactOutput } from './evidence.mjs';

const { values } = parseArgs({ options: { checkout: { type: 'string' }, output: { type: 'string' } } });
if (!values.checkout || !values.output) throw new Error('Usage: node desktop/smoke-packaged.mjs --checkout <prepared source> --output <evidence directory>');
const paths = packagedPaths(values.checkout), output = resolve(values.output);
const temporary = await mkdtemp(join(tmpdir(), 'rdsh-native-app-'));
const home = join(temporary, 'harness'), userData = join(temporary, 'electron');
let application;
let diagnostics = '';
async function visibleWindow(pattern) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    for (const candidate of application.windows()) {
      if (!pattern.test(candidate.url())) continue;
      const native = await application.browserWindow(candidate);
      try { if (await native.evaluate(value => !value.isDestroyed() && value.isVisible())) return candidate; }
      finally { await native.dispose(); }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('A visible, usable Desktop window must open');
}
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
  Object.assign(environment, { DSH_TELEMETRY_DISABLED: '1', DSH_TELEMETRY_MODE: 'DISABLED', RDSH_DESKTOP_HOME: home,
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
  for (const stream of [application.process().stdout, application.process().stderr]) stream?.on('data', chunk => {
    diagnostics = (diagnostics + chunk.toString()).slice(-1048576);
  });
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
  // The official app first creates a hidden, empty workspace window. The
  // visible welcome document is the first usable screen of a fresh profile.
  const window = await visibleWindow(/^file:.*\/renderer\/welcome\.html(?:[?#]|$)/);
  await window.locator('#api-key').waitFor({ state: 'visible' });
  await window.screenshot({ path: join(output, 'rdsh-desktop-startup.png') });
  // Use the real first-run controls without saving credentials or invoking AI.
  await window.locator('#api-key').click();
  await window.locator('#key-input').waitFor({ state: 'visible' });
  assert.equal(await window.locator('#key-input').inputValue(), '');
  assert.equal(await window.locator('#save-key').isDisabled(), true);
  await window.locator('#skip-key').click();
  const workspace = await visibleWindow(/^dsh-app:/);
  await workspace.locator('[data-dsh-boot]').waitFor({ state: 'hidden', timeout: 120000 });
  for (const label of ['Continue', 'Configure later']) {
    const button = workspace.getByRole('button', { name: label, exact: true });
    if (await button.count() === 1 && await button.isVisible()) await button.click();
  }
  // A focusable, disabled placeholder is not an input-ready workspace. Pick
  // the fresh profile's own workspace through the shipped controls on both OSes.
  const workspacePicker = workspace.getByRole('button', { name: 'Choose workspace', exact: true });
  const composer = workspace.locator('[data-composer-input][contenteditable="true"]').first();
  // Boot chrome disappears before the default session's asynchronous selection
  // completes. Opening its menu during that handoff can close it again.
  await workspacePicker.filter({ hasText: 'Default workspace' }).waitFor({ state: 'visible', timeout: 120000 });
  await composer.waitFor({ state: 'visible', timeout: 120000 });
  await workspacePicker.click();
  await workspace.getByRole('menuitem', { name: 'Default workspace', exact: true }).click();
  await workspacePicker.filter({ hasText: 'Default workspace' }).waitFor({ state: 'visible' });
  await composer.waitFor({ state: 'visible', timeout: 120000 });
  await composer.click();
  assert.equal(await composer.evaluate(element => element === document.activeElement || element.contains(document.activeElement)), true);
  const draft = 'rdsh native smoke draft';
  await composer.fill(draft);
  assert.equal((await composer.textContent()).trim(), draft);
  await composer.fill('');
  assert.equal((await composer.textContent()).trim(), '');
  await workspace.screenshot({ path: join(output, 'rdsh-desktop-workspace.png') });
  const child = application.process();
  await application.close(); application = undefined;
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'Electron exit must be confirmed');
  assert.equal(child.exitCode, 0, 'the application must quit successfully');
  await writeFile(join(output, 'native-smoke.json'), JSON.stringify({ schemaVersion: 1, platform: process.platform,
    arch: process.arch, rdshVersion: build.rdshVersion, harnessVersion: build.harnessVersion, revision: build.revision,
    rustSha256: build.nativeSha256, electronExitCode: child.exitCode, checks: { nativeRust: true, delegatedCLI: true, appIdentity: true,
      isolatedHomes: true, packagedRecord: true, renderer: true, welcomeReady: true, workspaceReady: true, workspaceSelected: true,
      composerEditable: true, composerDraft: true, composerFocused: true, electronExit: true } }, null, 2) + '\n');
  console.log('PASS native Desktop: bundled Rust, exact CLI delegation, app identity, isolated homes, interactive welcome/workspace, editable draft and successful exit');
} catch (error) {
  const page = application?.windows().findLast(page => /^(?:file|dsh-app):/.test(page.url()));
  await page?.screenshot({ path: join(output, 'rdsh-desktop-failure.png') }).catch(() => {});
  console.error(redactOutput(error.stack || String(error))); process.exitCode = 1;
} finally {
  try {
    await application?.close();
    if (diagnostics) await writeFile(join(output, 'native-runtime.log'), redactOutput(diagnostics));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
