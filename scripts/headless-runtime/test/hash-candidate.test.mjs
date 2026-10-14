import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const hashScript = path.resolve('scripts/headless-runtime/hash-candidate.mjs');

async function hash(candidate) {
  const { stdout } = await execFileAsync(process.execPath, [hashScript, candidate]);
  return JSON.parse(stdout);
}

test('candidate hash changes when a file or directory mode changes and records symlinks without following them', async () => {
  const candidate = await mkdtemp(path.join(tmpdir(), 'rdsh-candidate-hash-'));
  const nested = path.join(candidate, 'nested');
  const file = path.join(nested, 'runtime');
  await mkdir(nested);
  await writeFile(file, 'same bytes');
  await symlink(file, path.join(candidate, 'runtime-link'));
  await chmod(candidate, 0o500);
  await chmod(nested, 0o500);
  await chmod(file, 0o400);
  const initial = await hash(candidate);
  await chmod(file, 0o500);
  const fileModeChanged = await hash(candidate);
  await chmod(nested, 0o700);
  const directoryModeChanged = await hash(candidate);
  assert.notEqual(initial.sha256, fileModeChanged.sha256);
  assert.notEqual(fileModeChanged.sha256, directoryModeChanged.sha256);
  assert.equal(initial.links, 1);
  assert.equal(initial.directories, 2);
});
