import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactOutput, collectEvidence } from '../evidence.mjs';

test('public build diagnostics remove fixture auth values and emails while preserving integrity facts', () => {
  const hash = 'a'.repeat(64);
  const input = `dsh web: http://127.0.0.1:1234/?token=fixture-value&next=home\nAuthorization: Bearer fixture-bearer\nBasic Zml4dHVyZQ==\nhttps://fixture-user:fixture-pass@example.invalid/archive\n{"apiKey":"fixture-key","password":"fixture-password","sha256":"${hash}"}\nfixture@example.invalid\nPASS native runtime`;
  const output = redactOutput(input);
  for (const value of ['fixture-value', 'fixture-bearer', 'Zml4dHVyZQ==', 'fixture-key', 'fixture-password', 'fixture-user', 'fixture-pass', 'fixture@example.invalid']) assert.ok(!output.includes(value));
  assert.ok(output.includes(hash)); assert.ok(output.includes('&next=home')); assert.ok(output.includes('PASS native runtime'));
  assert.equal(JSON.parse(redactOutput(JSON.stringify({ password: 'fixture-quoted"value\\', count: 1 }))).password, '[redacted]');
});

test('evidence collection redacts an owned copy, preserves originals and refuses replacement', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rdsh-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'source'), output = join(root, 'output'); await mkdir(input);
  const original = 'http://127.0.0.1:1234/?token=fixture-secret\nPASS Office';
  await writeFile(join(input, 'stage.log'), original);
  await collectEvidence(input, output);
  assert.equal(await readFile(join(input, 'stage.log'), 'utf8'), original);
  assert.equal(await readFile(join(output, 'stage.log'), 'utf8'), 'http://127.0.0.1:1234/?token=[redacted]\nPASS Office');
  await assert.rejects(collectEvidence(input, output), { code: 'EEXIST' });
  await assert.rejects(collectEvidence(input, join(input, 'copy')), /outside/);
});

test('diagnostic collection never follows an outside link', { skip: process.platform === 'win32' && 'Windows CI does not grant symlink privileges' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'rdsh-evidence-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'outside.log'), 'fixture private value');
  await symlink(join(root, 'outside.log'), join(root, 'linked.log'));
  await assert.rejects(collectEvidence(join(root, 'linked.log'), join(root, 'copy.log')), /links/);
});
