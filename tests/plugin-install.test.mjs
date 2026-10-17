import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('..', import.meta.url));
const installer = join(repo, 'plugins', 'install.sh');

// The installer prompts only with a TTY on stdin, so 'ignore' keeps every
// observation non-interactive and deterministic. A hermetic DSH_HOME keeps the
// real ~/.dsh/rdsh.json from changing the selection.
const skip = process.platform === 'win32' ? { skip: 'needs a POSIX /bin/sh' } : {};

async function installerEnv(t, extra = {}, features) {
  const home = await mkdtemp(join(tmpdir(), 'rdsh-plugin-install-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  if (features !== undefined)
    await writeFile(join(home, 'rdsh.json'),
      typeof features === 'string' ? features : JSON.stringify({ features }));
  const env = { ...process.env, HOME: home, DSH_HOME: home, DRY_RUN: '1', PROFILE: 'headless', ...extra };
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  return { home, env };
}

async function runInstaller(env, args = []) {
  const { stdout } = await exec('sh', [installer, ...args], {
    cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return stdout;
}

const RECOMMENDED_BUNDLED = ['rdsh-translation', 'rdsh-compute', 'rdsh-easy-work', 'rdsh-subagent-optimizer', 'rdsh-ui-comfort'];
const RECOMMENDED_THIRD_PARTY = ['dsh-sound-notifications', 'dsh-gitview'];
// Opt-in only: never in the non-interactive per-profile defaults.
const RECOMMENDED_OPT_IN_THIRD_PARTY = ['dsh-intelligent-ui'];
const ALL_RECOMMENDED = [...RECOMMENDED_BUNDLED, ...RECOMMENDED_THIRD_PARTY, ...RECOMMENDED_OPT_IN_THIRD_PARTY];

test('non-interactive defaults keep the historical per-profile set', skip, async (t) => {
  const { env: headlessEnv } = await installerEnv(t, { PROFILE: 'headless' });
  const headless = await runInstaller(headlessEnv);
  assert.match(headless, /@deepseek-ai\/dsh-tool-present  # essential/);
  assert.doesNotMatch(headless, /# recommended/);
  assert.doesNotMatch(headless, /Install recommended plugins\?/);

  const { env: webEnv } = await installerEnv(t, { PROFILE: 'web' });
  const web = await runInstaller(webEnv);
  for (const name of ['rdsh-translation', ...RECOMMENDED_THIRD_PARTY])
    assert.match(web, new RegExp(name));
  assert.match(web, /rdsh-update-banner  # essential/); // web-only essential
  assert.doesNotMatch(web, /rdsh-compute|rdsh-easy-work|rdsh-subagent-optimizer|rdsh-ui-comfort/);
  assert.doesNotMatch(web, /dsh-intelligent-ui/); // opt-in only

  const { env: desktopEnv } = await installerEnv(t, { PROFILE: 'desktop', RDSH_BIN: process.execPath });
  const desktop = await runInstaller(desktopEnv);
  for (const name of ['rdsh-translation', ...RECOMMENDED_THIRD_PARTY])
    assert.match(desktop, new RegExp(name));
  assert.doesNotMatch(desktop, /rdsh-update-banner/); // web only
  assert.doesNotMatch(desktop, /rdsh-ui-comfort/); // off by default
  assert.doesNotMatch(desktop, /dsh-intelligent-ui/); // opt-in only
});

test('--recommended=all|none|id,id selects exactly that set', skip, async (t) => {
  const { env: webEnv } = await installerEnv(t, { PROFILE: 'web' });
  const none = await runInstaller(webEnv, ['--recommended=none']);
  assert.match(none, /dsh-tool-present  # essential/); // essential stays
  for (const name of ALL_RECOMMENDED)
    assert.doesNotMatch(none, new RegExp(name));

  const { env: headlessEnv } = await installerEnv(t, { PROFILE: 'headless' });
  const all = await runInstaller(headlessEnv, ['--recommended=all']);
  for (const name of ALL_RECOMMENDED)
    assert.match(all, new RegExp(name));

  const { env: pickEnv } = await installerEnv(t, { PROFILE: 'web' });
  const picked = await runInstaller(pickEnv, ['--recommended=compute,gitview']);
  assert.match(picked, /rdsh-compute  # recommended/);
  assert.match(picked, /dsh-gitview/);
  assert.doesNotMatch(picked, /rdsh-translation|dsh-sound-notifications|rdsh-easy-work|dsh-intelligent-ui/);
});

test('--recommended=intelligent-ui selects only the opt-in visual-answer plugin', skip, async (t) => {
  const { env } = await installerEnv(t, { PROFILE: 'web' });
  const picked = await runInstaller(env, ['--recommended=intelligent-ui']);
  assert.match(picked, /dsh-intelligent-ui  # recommended/);
  assert.doesNotMatch(picked,
    /rdsh-translation|rdsh-compute|rdsh-easy-work|rdsh-subagent-optimizer|rdsh-ui-comfort|dsh-sound-notifications|dsh-gitview/);

  const { env: aliasEnv } = await installerEnv(t, { PROFILE: 'web' });
  const alias = await runInstaller(aliasEnv, ['--recommended=intelligent_ui']);
  assert.match(alias, /dsh-intelligent-ui  # recommended/);

  const { env: envVarEnv } = await installerEnv(t, { PROFILE: 'headless', INTELLIGENT_UI: '1' });
  const envVar = await runInstaller(envVarEnv);
  assert.match(envVar, /dsh-intelligent-ui  # recommended/);
  assert.doesNotMatch(envVar, /dsh-sound-notifications|dsh-gitview/); // only the requested plugin

  const { env: webEnv } = await installerEnv(t, { PROFILE: 'web', INTELLIGENT_UI: '1' });
  const webVar = await runInstaller(webEnv);
  assert.match(webVar, /dsh-intelligent-ui  # recommended/);
  assert.match(webVar, /dsh-sound-notifications|dsh-gitview/); // web defaults stay unchanged
});

test('--recommended=ui-comfort selects only the comfort plugin', skip, async (t) => {
  const { env } = await installerEnv(t, { PROFILE: 'web' });
  const picked = await runInstaller(env, ['--recommended=ui-comfort']);
  assert.match(picked, /rdsh-ui-comfort  # recommended/);
  assert.doesNotMatch(picked,
    /rdsh-translation|rdsh-compute|rdsh-easy-work|rdsh-subagent-optimizer|dsh-sound-notifications|dsh-gitview/);

  const { env: aliasEnv } = await installerEnv(t, { PROFILE: 'web' });
  const alias = await runInstaller(aliasEnv, ['--recommended=ui_comfort']);
  assert.match(alias, /rdsh-ui-comfort  # recommended/);

  const { env: envVarEnv } = await installerEnv(t, { PROFILE: 'web', UI_COMFORT: '1' });
  const envVar = await runInstaller(envVarEnv);
  assert.match(envVar, /rdsh-ui-comfort  # recommended/);
});

test('RECOMMENDED mirrors the flag and arguments are optional', skip, async (t) => {
  const { env } = await installerEnv(t, { PROFILE: 'headless', RECOMMENDED: 'gitview' });
  const stdout = await runInstaller(env);
  assert.match(stdout, /dsh-gitview/);
  assert.doesNotMatch(stdout, /rdsh-translation|dsh-sound-notifications|rdsh-compute/);

  const { env: spacedEnv } = await installerEnv(t, { PROFILE: 'headless' });
  const spaced = await runInstaller(spacedEnv, ['--recommended', 'translation']);
  assert.match(spaced, /rdsh-translation  # recommended/);
  assert.doesNotMatch(spaced, /dsh-gitview|rdsh-compute/);
});

test('essential lines precede every recommended line', skip, async (t) => {
  const { env } = await installerEnv(t, { PROFILE: 'web' });
  const lines = (await runInstaller(env, ['--recommended=all'])).split('\n').filter(Boolean);
  const essential = lines.map((line, index) => [line, index]).filter(([line]) => line.endsWith('# essential'));
  const recommended = lines.map((line, index) => [line, index]).filter(([line]) => line.includes('# recommended'));
  assert.ok(essential.length > 0 && recommended.length > 0);
  assert.ok(essential.at(-1)[1] < recommended[0][1]);
});

test('--recommended=list prints the catalog, essential tier first, and installs nothing', skip, async (t) => {
  const { env } = await installerEnv(t, { PROFILE: 'web' });
  const stdout = await runInstaller(env, ['--recommended=list']);
  assert.ok(stdout.indexOf('Essential plugins (always installed, listed first)') >= 0);
  assert.ok(stdout.indexOf('Essential plugins') < stdout.indexOf('Recommended plugins'));
  assert.match(stdout, /@deepseek-ai\/dsh-tool-present/);
  assert.match(stdout, /github:cwd514\/dsh-sound-notifications/);
  assert.match(stdout, /intelligent-ui\s+github:cwd514\/dsh-intelligent-ui/);
  assert.match(stdout, /ui-comfort\s+rdsh-ui-comfort/);
  assert.doesNotMatch(stdout, /dsh plugin --profile/);

  const { env: aliasEnv } = await installerEnv(t, { PROFILE: 'web' });
  const alias = await runInstaller(aliasEnv, ['--list']);
  assert.match(alias, /Recommended plugins/);
});

test('a saved feature veto wins even under --recommended=all', skip, async (t) => {
  const { env } = await installerEnv(t, { PROFILE: 'web' }, { sound: false });
  const stdout = await runInstaller(env, ['--recommended=all']);
  assert.doesNotMatch(stdout, /dsh-sound-notifications/);
  assert.match(stdout, /dsh-gitview/);
});

test('an unknown or missing recommended value fails before installing', skip, async (t) => {
  const { env } = await installerEnv(t, { PROFILE: 'web' });
  await assert.rejects(runInstaller(env, ['--recommended=bogus']), (error) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /unknown recommended plugin 'bogus'/);
    assert.match(error.stderr, /ui-comfort/); // the id list names the new entry
    assert.match(error.stderr, /intelligent-ui/); // including the opt-in one
    assert.doesNotMatch(error.stdout, /dsh plugin --profile/);
    return true;
  });
  const { env: missingEnv } = await installerEnv(t, { PROFILE: 'web' });
  await assert.rejects(runInstaller(missingEnv, ['--recommended']), (error) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /--recommended needs a value/);
    return true;
  });
});

test('the desktop forwarder honors the recommended selection', skip, async (t) => {
  const { home, env } = await installerEnv(t, { PROFILE: 'desktop' });
  const stub = join(home, 'rdsh-stub');
  await writeFile(stub, '#!/bin/sh\nprintf "STUB %s\\n" "$*"\n', { mode: 0o755 });
  const desktopEnv = { ...env, RDSH_BIN: stub };

  const dry = await runInstaller(desktopEnv, ['--recommended=none']);
  assert.match(dry, /desktop install --no-bundled/);
  assert.match(dry, /rdsh-settings/);
  assert.doesNotMatch(dry, /rdsh-translation|dsh-sound-notifications|dsh-gitview|dsh-intelligent-ui/);

  const real = await runInstaller({ ...desktopEnv, DRY_RUN: '0' }, ['--recommended=all']);
  assert.match(real, /^STUB desktop install --no-bundled/);
  for (const name of ALL_RECOMMENDED)
    assert.match(real, new RegExp(name));
});
