import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readSurface, surfacePath, writeSurface } from '../store.js';

const surface = (id) => ({
  surface_id: id,
  blocks: [{ id: 'text', kind: 'text', data: { text: id } }],
});

const fault = (code) => Object.assign(new Error(`injected ${code}`), { code });

async function fixture(t, platform = 'win32') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdsh-surface-windows-replace-'));
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
  t.after(async () => {
    t.mock.restoreAll();
    Object.defineProperty(process, 'platform', platformDescriptor);
    await fs.rm(root, { recursive: true, force: true });
  });
  const initial = await writeSurface(root, surface('initial'));
  return { root, initial, target: surfacePath(root) };
}

test('Windows retries transient EPERM against one completed temporary file', async (t) => {
  const { root, target } = await fixture(t);
  const rename = fs.rename;
  const calls = [];
  t.mock.method(performance, 'now', () => 0);
  t.mock.method(fs, 'rename', async (from, to) => {
    calls.push([from, to]);
    if (calls.length < 3) throw fault('EPERM');
    return rename(from, to);
  });
  const written = await writeSurface(root, surface('replacement'));
  assert.equal(written.ok, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(calls[0], calls[2]);
  assert.equal(calls[0][1], target);
  assert.equal((await readSurface(root)).surface.surface_id, 'replacement');
  assert.deepEqual(await fs.readdir(path.dirname(target)), ['surface.json']);
});

test('concurrent Windows publications both complete and keep the last completed replacement', async (t) => {
  const { root, target } = await fixture(t);
  const rename = fs.rename;
  const firstRename = Promise.withResolvers();
  const retryReached = Promise.withResolvers();
  const releaseRetry = Promise.withResolvers();
  let firstTemporary;
  let firstAttempts = 0;
  t.mock.method(performance, 'now', () => 0);
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to !== target) return rename(from, to);
    if (!firstTemporary) firstTemporary = from;
    if (from !== firstTemporary) return rename(from, to);
    if (++firstAttempts === 1) {
      firstRename.resolve();
      throw fault('EPERM');
    }
    retryReached.resolve();
    await releaseRetry.promise;
    return rename(from, to);
  });
  const first = writeSurface(root, surface('first'));
  await firstRename.promise;
  const second = await writeSurface(root, surface('second'));
  await retryReached.promise;
  releaseRetry.resolve();
  const firstResult = await first;
  assert.equal(second.ok, true);
  assert.equal(firstResult.ok, true);
  assert.equal((await readSurface(root)).surface.surface_id, 'first');
  assert.deepEqual(await fs.readdir(path.dirname(target)), ['surface.json']);
});

test('Windows permanently failing EPERM is bounded, preserves destination, and cleans its temporary file', async (t) => {
  const { root, initial, target } = await fixture(t);
  const failure = fault('EPERM');
  const unlink = fs.unlink;
  const unlinked = [];
  let attempts = 0;
  t.mock.method(performance, 'now', () => 0);
  t.mock.method(fs, 'unlink', async (file) => {
    unlinked.push(file);
    return unlink(file);
  });
  t.mock.method(fs, 'rename', async () => { attempts++; throw failure; });
  await assert.rejects(writeSurface(root, surface('replacement')), error => error === failure);
  assert.equal(attempts, 6);
  assert.deepEqual((await readSurface(root)).surface, initial.surface);
  assert.equal(unlinked.includes(target), false);
  assert.equal(unlinked.length, 1);
  assert.deepEqual(await fs.readdir(path.dirname(target)), ['surface.json']);
});

for (const [name, platform, code] of [
  ['POSIX does not retry EPERM', 'linux', 'EPERM'],
  ['Windows does not retry EACCES', 'win32', 'EACCES'],
]) {
  test(name, async (t) => {
    const { root, initial, target } = await fixture(t, platform);
    const failure = fault(code);
    let attempts = 0;
    t.mock.method(fs, 'rename', async () => { attempts++; throw failure; });
    await assert.rejects(writeSurface(root, surface('replacement')), error => error === failure);
    assert.equal(attempts, 1);
    assert.deepEqual((await readSurface(root)).surface, initial.surface);
    assert.deepEqual(await fs.readdir(path.dirname(target)), ['surface.json']);
  });
}

test('Windows does not start another rename after the deadline', async (t) => {
  const { root, target } = await fixture(t);
  const failure = fault('EPERM');
  let nowCalls = 0;
  let attempts = 0;
  t.mock.method(performance, 'now', () => ++nowCalls < 3 ? 0 : 100);
  t.mock.method(fs, 'rename', async () => { attempts++; throw failure; });
  await assert.rejects(writeSurface(root, surface('replacement')), error => error === failure);
  assert.equal(attempts, 1);
  assert.deepEqual(await fs.readdir(path.dirname(target)), ['surface.json']);
});
