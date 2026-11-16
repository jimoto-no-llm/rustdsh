import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const cli = new URL('./cli.mjs', import.meta.url).pathname;
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
async function event(root, e) {
  const file = join(root, 'input.json');
  await writeFile(file, JSON.stringify(e));
  return run('record', root, file);
}
const e = (case_id, kind, actor, outcome) => ({ case_id, kind, actor, outcome, evidence: { source: 'fixture', ref: `${kind}-${outcome}` } });

test('HOLD -> GO with independent oracle receipts; blind mode does not leak red', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blue-purple-'));
  try {
    assert.equal(run('init', dir).status, 0);
    assert.equal((await event(dir, e('case-1', 'red_attempt', 'red', 'succeeded'))).status, 0);
    assert.equal(run('report', dir).status, 2);
    assert.equal((await event(dir, e('case-1', 'sensor_observation', 'sensor', 'observed'))).status, 0);
    assert.equal(run('handoff', dir, '--case', 'case-1', '--mode', 'blind').status, 0);
    const blind = JSON.parse(await readFile(join(dir, 'case-1-blind-handoff.json'), 'utf8'));
    assert.deepEqual(blind.visible_evidence.map(x => x.kind), ['sensor_observation']);
    assert.equal((await event(dir, e('case-1', 'blue_detection', 'blue', 'detected'))).status, 0);
    assert.equal((await event(dir, e('case-1', 'blue_remediation', 'blue', 'applied'))).status, 0);
    assert.equal((await event(dir, e('case-1', 'oracle_retest', 'oracle', 'blocked'))).status, 0);
    assert.equal((await event(dir, e('case-1', 'oracle_regression', 'oracle', 'passed'))).status, 0);
    const res = run('report', dir);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).verdict, 'GO');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('invalid evidence/actor and tampered hash are rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blue-purple-'));
  try {
    assert.equal(run('init', dir).status, 0);
    assert.equal((await event(dir, e('a', 'red_attempt', 'blue', 'succeeded'))).status, 1);
    assert.equal((await event(dir, e('a', 'red_attempt', 'red', 'succeeded'))).status, 0);
    const path = join(dir, 'events.jsonl');
    const data = await readFile(path, 'utf8');
    await writeFile(path, data.replace('succeeded', 'failed'));
    assert.equal(run('report', dir).status, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('non-loopback models are blocked before network requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blue-purple-'));
  try {
    run('init', dir);
    await event(dir, e('a', 'sensor_observation', 'sensor', 'observed'));
    const res = run('analyze', dir, '--case', 'a', '--model', 'local', '--url', 'https://api.example.com/v1/chat/completions');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /loopback/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
