import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDiscordPresence } from '../plugins/rdsh-settings/discord.js';
import { apply as applyBudgetGuard } from '../plugins/rdsh-budget-guard/index.js';
import { apply as applyReleaseProbe } from '../plugins/rdsh-release-probe/index.js';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('..', import.meta.url));

// Feature switches live in $DSH_HOME/rdsh.json. Every test uses a hermetic temp
// home so the real ~/.dsh/rdsh.json never changes the result.
async function featureHome(t, features) {
  const home = await mkdtemp(join(tmpdir(), 'rdsh-features-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  if (features !== undefined)
    await writeFile(join(home, 'rdsh.json'), typeof features === 'string' ? features : JSON.stringify({ features }));
  return home;
}

function withEnv(t, values) {
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

// ---------------------------------------------------------------- Discord
function fakePresence(loadSettings) {
  const connects = [], activities = [];
  const connect = async (id) => {
    connects.push(id);
    return { closed: false, async setActivity(activity) { activities.push(activity); }, destroy() { this.closed = true; } };
  };
  const presence = createDiscordPresence({ loadSettings, connect, interval: 60000, minUpdateInterval: 0, throttle: 0 });
  return { presence, connects, activities };
}

test('discord switch false disables presence without connecting or sending activity', async (t) => {
  const { presence, connects, activities } = fakePresence(async () => ({ features: { discord: false } }));
  t.after(() => presence.stop());
  await presence.refresh();
  assert.equal(presence.status().state, 'disabled');
  assert.equal(connects.length, 0);
  assert.deepEqual(activities, []);
});

test('discord switch false stops a connected presence without SET_ACTIVITY', async (t) => {
  let document = {};
  const { presence, connects, activities } = fakePresence(async () => document);
  t.after(() => presence.stop());
  await presence.refresh();
  assert.equal(presence.status().state, 'connected');
  assert.equal(connects.length, 1);
  activities.length = 0;
  document = { features: { discord: false } };
  await presence.refresh();
  assert.equal(presence.status().state, 'disabled');
  assert.equal(connects.length, 1);
  assert.deepEqual(activities, []); // the kill switch never clears through the RPC
});

test('absent discord id keeps the existing connect path', async (t) => {
  const { presence, connects, activities } = fakePresence(async () => ({}));
  t.after(() => presence.stop());
  await presence.refresh();
  assert.equal(presence.status().state, 'connected');
  assert.equal(connects.length, 1);
  assert.equal(activities.length, 1);
});

test('legacy discord.enabled=false disables, and explicit true cannot resurrect it', async (t) => {
  for (const document of [{ discord: { enabled: false } }, { discord: { enabled: false }, features: { discord: true } }]) {
    const { presence, connects, activities } = fakePresence(async () => document);
    await presence.refresh();
    assert.equal(presence.status().state, 'disabled');
    assert.equal(connects.length, 0);
    assert.deepEqual(activities, []);
    await presence.stop();
  }
});

test('throwing loadSettings reports invalid_settings without rejection', async (t) => {
  const { presence, connects } = fakePresence(async () => { throw new Error('unreadable settings'); });
  t.after(() => presence.stop());
  await assert.doesNotReject(() => presence.refresh());
  assert.equal(presence.status().state, 'invalid_settings');
  assert.equal(connects.length, 0);
});

// ------------------------------------------------------------ budget guard
test('budget_guard=false is a no-op even with no environment', async (t) => {
  await featureHome(t, { budget_guard: false });
  withEnv(t, { RDSH_BUDGET_BASE: undefined, RDSH_BUDGET_KEY: undefined, RDSH_BUDGET_JOB: undefined });
  let subscriptions = 0;
  assert.doesNotThrow(() => applyBudgetGuard({ on() { subscriptions += 1; } }));
  assert.equal(subscriptions, 0);
});

test('absent budget_guard id keeps the scoped-credential failure', async (t) => {
  await featureHome(t, undefined); // no rdsh.json at all
  withEnv(t, { RDSH_BUDGET_BASE: 'http://127.0.0.1:9/', RDSH_BUDGET_KEY: undefined, RDSH_BUDGET_JOB: undefined });
  let subscriptions = 0;
  assert.throws(() => applyBudgetGuard({ on() { subscriptions += 1; } }), /scoped loopback credential/);
  assert.equal(subscriptions, 0);
});

// ---------------------------------------------------------- release probe
async function withFetchSpy(t) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => { calls.push({ url: String(url), options }); return { ok: true, json: async () => ({}) }; };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test('release_probe=false never fetches even without a callback URL', async (t) => {
  await featureHome(t, { release_probe: false });
  withEnv(t, { RDSH_RELEASE_PROBE_BASE: undefined, RDSH_RELEASE_PROBE_KEY: undefined });
  const calls = await withFetchSpy(t);
  assert.doesNotThrow(() => applyReleaseProbe());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);
});

test('release_probe=true posts ready to the scoped loopback callback', async (t) => {
  await featureHome(t, { release_probe: true });
  const key = 'a'.repeat(64);
  withEnv(t, { RDSH_RELEASE_PROBE_BASE: 'http://127.0.0.1:45999/', RDSH_RELEASE_PROBE_KEY: key });
  const calls = await withFetchSpy(t);
  applyReleaseProbe();
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url, 'http://127.0.0.1:45999/ready');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers['x-rdsh-release-token'], key);
  const body = JSON.parse(options.body);
  assert.equal(body.plugin, 'rdsh-release-probe');
  assert.equal(body.contract, 1);
});

test('release_probe=true keeps the loopback credential requirement', async (t) => {
  await featureHome(t, { release_probe: true });
  withEnv(t, { RDSH_RELEASE_PROBE_BASE: 'http://127.0.0.1:45999/', RDSH_RELEASE_PROBE_KEY: undefined });
  assert.throws(() => applyReleaseProbe(), /scoped loopback callback/);
});

// -------------------------------------------------------------- install.sh
test('install.sh offers sound with SOUND=1 unless features.sound is false', { skip: process.platform === 'win32' }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'rdsh-install-features-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const script = join(repo, 'plugins', 'install.sh');
  const base = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
    HOME: home, DSH_HOME: home, PROFILE: 'web', DRY_RUN: '1' };
  delete base.SOUND;
  const run = async (extra) => {
    const env = { ...base, ...extra };
    for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
    return (await exec('sh', [script], { cwd: repo, env })).stdout;
  };
  const sound = /dsh-sound-notifications/;
  // No rdsh.json yet: the SOUND=1 opt-in still offers it (legacy behavior).
  assert.match(await run({ SOUND: '1' }), sound);
  await writeFile(join(home, 'rdsh.json'), JSON.stringify({ features: { sound: false } }));
  assert.doesNotMatch(await run({ SOUND: '1' }), sound);
  // A corrupt file must not silently remove the offer.
  await writeFile(join(home, 'rdsh.json'), '{broken json');
  assert.match(await run({ SOUND: '1' }), sound);
  await writeFile(join(home, 'rdsh.json'), JSON.stringify({ features: { sound: true } }));
  const offered = await run({ SOUND: '1' });
  assert.match(offered, /dsh plugin --profile web add github:cwd514\/dsh-sound-notifications/);
  assert.doesNotMatch(await run({}), sound); // SOUND unset
  assert.match(offered, /@deepseek-ai\/dsh-tool-present/); // normal installs still run
});
