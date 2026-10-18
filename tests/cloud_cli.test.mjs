// Offline CLI contracts. Node acts as the pinned external executable; no LLM or cluster.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const binary = path.resolve(process.env.BIN || `target/debug/rdsh${process.platform === 'win32' ? '.exe' : ''}`);
const digest = createHash('sha256').update(readFileSync(process.execPath)).digest('hex');

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rdsh-cloud-cli-'));
  t.after(() => rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}));
  const city = path.join(root, 'city with spaces');
  mkdirSync(city);
  const env = {...process.env, HOME: root, USERPROFILE: root, DSH_HOME: root,
    XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, RDSH_AUTH_AUTOSYNC: '0'};
  for (const key of Object.keys(env)) {
    if (/^(RDSH_GASCITY_|RDSH_CLOUD_|KUBERNETES_)/.test(key) ||
      ['RDSH_PASSTHROUGH', 'RDSH_DEFAULT_PROFILE', 'RDSH_ORIG_BIN', 'DSH_ORIG_BIN', 'NODE_OPTIONS'].includes(key)) delete env[key];
  }
  return {city, env};
}

function run(args, env) {
  const result = spawnSync(binary, ['--language', 'en', ...args], {env, encoding: 'utf8', timeout: 30000});
  assert.ifError(result.error);
  return result;
}

test('swarm delegates each action once and preserves child exit status and arguments', t => {
  const {city, env} = fixture(t);
  for (const [index, action] of ['doctor', 'init', 'start', 'status', 'stop'].entries()) {
    writeFileSync(path.join(city, action), `console.log(JSON.stringify({action:${JSON.stringify(action)},args:process.argv.slice(2)})); process.exit(${index});`);
    const result = run(['swarm', '--gc-binary', process.execPath, '--gc-sha256', digest, '--city', city, action], env);
    assert.equal(result.status, index, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {action, args: action === 'doctor' ? [] : [city]});
  }
});

test('swarm refuses a mismatched artifact before launching it', t => {
  const {city, env} = fixture(t);
  const result = run(['swarm', '--gc-binary', process.execPath, '--gc-sha256', '0'.repeat(64), '--city', city, 'start'], env);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /SHA-256/);
});

test('swarm and rustxng keep their own localized start and stop descriptions', t => {
  const {env} = fixture(t);
  for (const [command, expected] of [['swarm', /Gas Cityを起動/], ['rustxng', /サイドカーを起動/]]) {
    const result = spawnSync(binary, ['--language', 'ja', command, '--help'], {env, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, expected);
  }
});

test('cloud fake completes 10000 correlated execution results and releases every lease', t => {
  const {env} = fixture(t);
  const result = run(['cloud', '--backend', 'fake', 'load-test', '--jobs', '10000'], env);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.backend, 'fake');
  for (const key of ['jobs', 'simultaneous_leases', 'executed', 'released']) assert.equal(report[key], 10000, key);
  assert.equal(report.remaining_sandboxes, 0);
  assert.ok(report.elapsed_ms >= 0);
});

test('cloud rejects invalid counts and unconfigured Kubernetes without using credentials', t => {
  const {env} = fixture(t);
  for (const jobs of ['0', '100001']) assert.notEqual(run(['cloud', 'load-test', '--jobs', jobs], env).status, 0);
  assert.notEqual(run(['cloud', 'doctor'], env).status, 0);
  const fake = run(['cloud', '--backend', 'fake', 'doctor'], env);
  assert.equal(fake.status, 0, fake.stderr);
  assert.deepEqual(JSON.parse(fake.stdout), {backend: 'fake', available: true, persistent: false});
});
